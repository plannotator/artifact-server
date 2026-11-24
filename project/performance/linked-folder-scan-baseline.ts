import {randomUUID} from "node:crypto";
import {mkdir, mkdtemp, realpath, rm, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import path from "node:path";
import {performance} from "node:perf_hooks";
import {DatabaseSync} from "node:sqlite";

import {z} from "zod";

import {scanPageEntries} from "../../src/core/folder-links.js";
import {publishNew, publishVersion} from "../../tests/support/publishing.js";
import {
  createTestInstallation, fetchVersion, removeTestInstallation, startTestServer,
  type RunningTestServer, type TestInstallation,
} from "../../tests/support/runtime-harness.js";
import {type LatencySummary, summarizeLatencies} from "./latency-summary.js";

const configSchema = z.object({
  files: z.number().int().min(2_000).max(20_000),
  directories: z.number().int().min(1).max(100),
  warmScans: z.number().int().min(1).max(10),
});

export type LinkedFolderScanBaselineConfig = z.infer<typeof configSchema>;

/** The section 13 linked-folder data set: one link holding 20,000 files. */
export const defaultLinkedFolderScanBaselineConfig: LinkedFolderScanBaselineConfig = {
  files: 20_000,
  directories: 20,
  warmScans: 5,
};

/** Section 13 budgets: a full warm scan within 5 s, request p95 within 10% of idle while it runs. */
export const linkedFolderScanBudgets = {
  fullScanMilliseconds: 5_000,
  requestRegressionRatio: 1.1,
} as const;

/** What a second connection observed while scans ran (FOV-003-F). */
export interface ScanTransactionObservation {
  /** Samples taken between server turns while a scan was in flight. */
  readonly samples: number;
  /** Samples in which another connection took and released the write lock with no wait. */
  readonly writeLockFree: number;
  /** Distinct partial counts of entries already stamped with the running scan's generation. */
  readonly partialPageCounts: readonly number[];
  readonly pageEntries: number;
}

export interface LinkedFolderScanBaselineReport {
  readonly configuration: LinkedFolderScanBaselineConfig;
  readonly environment: {readonly node: string; readonly platform: string; readonly arch: string};
  readonly firstScanMilliseconds: number;
  readonly inventoryEntries: number;
  readonly warmScan: LatencySummary;
  readonly idle: {readonly read: LatencySummary; readonly publish: LatencySummary};
  readonly duringScan: {readonly read: LatencySummary; readonly publish: LatencySummary};
  readonly transactions: ScanTransactionObservation;
  readonly budgets: typeof linkedFolderScanBudgets;
  readonly withinBudget: {
    readonly fullScan: boolean;
    readonly readDuringScan: boolean;
    readonly publishDuringScan: boolean;
    readonly onePagePerTransaction: boolean;
  };
}

const sampleIntervalMilliseconds = 10;

type Json = z.infer<ReturnType<typeof z.json>>;

/** Latency samples of one traffic window, by request kind. */
interface TrafficRecord {
  readonly reads: number[];
  readonly publishes: number[];
}

/** One observation from the second connection. */
interface ObserverSample {
  readonly writeLockFree: boolean;
  readonly stamped: number;
}

/** Settles once the watched promise does, whichever way. */
interface Settlement {
  settled: boolean;
}

function settlementOf(promise: Promise<unknown>): Settlement {
  const state: Settlement = {settled: false};
  const settle = () => {
    state.settled = true;
  };
  void promise.then(settle, settle);
  return state;
}

const folderLinkSchema = z.object({
  folderLink: z.object({
    entryCount: z.number().int(),
    id: z.string(),
    lastScanCompletedAt: z.string().nullable(),
    state: z.string(),
  }).loose(),
});

/**
 * Link a 20,000-file directory on a real local server and time warm full
 * scans, then compare read and publish latency while scans run against the
 * same operations on the idle server. A second SQLite connection samples the
 * database between server turns: it must always take the write lock without
 * waiting and must see each scan's pages land one committed page at a time.
 */
export async function runLinkedFolderScanBaseline(
  input: LinkedFolderScanBaselineConfig,
): Promise<LinkedFolderScanBaselineReport> {
  const config = configSchema.parse(input);
  const linkRoot = await mkdtemp(path.join(await realpath(tmpdir()), "artifact-server-scan-baseline-"));
  const installation = await createTestInstallation();
  let server: RunningTestServer | null = null;
  try {
    const directory = path.join(linkRoot, "output");
    await writeTree(directory, config);
    server = await startTestServer(installation, {
      linkedFiles: "on",
      linkedFolderReconcileIntervalMilliseconds: 3_600_000,
      linkedFolderWatch: "off",
      linkRoots: [linkRoot],
    });
    const running = server;
    const client = new ScanClient(running, installation);

    const linkStarted = performance.now();
    const link = await client.link(directory);
    const firstScanMilliseconds = round(performance.now() - linkStarted);
    if (link.entryCount !== config.files) {
      throw new Error(`The first scan indexed ${link.entryCount} of ${config.files} files.`);
    }

    const target = await client.seedArtifact();
    const traffic = new RequestTraffic(client, target);

    // Unmeasured warm scans: a second connection samples the database between
    // server turns. Its queries block the shared event loop, so it never runs
    // while latency is measured.
    const observer = new DatabaseSync(path.join(installation.dataDirectory, "artifact-server.db"), {timeout: 0});
    const sampled = {samples: 0, writeLockFree: 0, partial: new Set<number>()};
    let windowMilliseconds = 0;
    try {
      const sample = observerSample(observer, link.id);
      const warmUpStarted = performance.now();
      const observed = client.scan(link.id);
      await Promise.all([observed, sampleUntil(observed, () => {
        const result = sample();
        sampled.samples += 1;
        if (result.writeLockFree) sampled.writeLockFree += 1;
        if (result.stamped > 0 && result.stamped < config.files) sampled.partial.add(result.stamped);
      })]);
      windowMilliseconds = Math.max(250, performance.now() - warmUpStarted);
    } finally {
      observer.close();
    }
    await traffic.run(windowMilliseconds / 4, null);

    const scanDurations: number[] = [];
    const idleTraffic: TrafficRecord = {reads: [], publishes: []};
    const scanTraffic: TrafficRecord = {reads: [], publishes: []};
    for (let scan = 0; scan < config.warmScans; scan += 1) {
      // Each scan is paired with an idle window of the same length and
      // request mix just before it, so drift between windows cancels out.
      // eslint-disable-next-line no-await-in-loop
      await traffic.run(windowMilliseconds, idleTraffic);
      const scanStarted = performance.now();
      const scanRun = client.scan(link.id).finally(() => scanDurations.push(performance.now() - scanStarted));
      // eslint-disable-next-line no-await-in-loop
      await Promise.all([scanRun, traffic.until(scanRun, scanTraffic)]);
    }

    const idle = {read: summarizeLatencies(idleTraffic.reads), publish: summarizeLatencies(idleTraffic.publishes)};
    const during = {read: summarizeLatencies(scanTraffic.reads), publish: summarizeLatencies(scanTraffic.publishes)};
    const warmScan = summarizeLatencies(scanDurations);
    const transactions: ScanTransactionObservation = {
      samples: sampled.samples,
      writeLockFree: sampled.writeLockFree,
      partialPageCounts: [...sampled.partial].toSorted((left, right) => left - right),
      pageEntries: scanPageEntries,
    };
    return {
      configuration: config,
      environment: {node: process.version, platform: process.platform, arch: process.arch},
      firstScanMilliseconds,
      inventoryEntries: link.entryCount,
      warmScan,
      idle,
      duringScan: during,
      transactions,
      budgets: linkedFolderScanBudgets,
      withinBudget: {
        fullScan: warmScan.maximumMilliseconds <= linkedFolderScanBudgets.fullScanMilliseconds,
        readDuringScan: during.read.p95Milliseconds <= idle.read.p95Milliseconds * linkedFolderScanBudgets.requestRegressionRatio,
        publishDuringScan:
          during.publish.p95Milliseconds <= idle.publish.p95Milliseconds * linkedFolderScanBudgets.requestRegressionRatio,
        onePagePerTransaction: transactions.samples > 0 && transactions.writeLockFree === transactions.samples
          && transactions.partialPageCounts.length > 0,
      },
    };
  } finally {
    await server?.stop();
    await removeTestInstallation(installation);
    await rm(linkRoot, {force: true, recursive: true});
  }
}

async function writeTree(directory: string, config: LinkedFolderScanBaselineConfig): Promise<void> {
  const perDirectory = Math.ceil(config.files / config.directories);
  for (let group = 0; group < config.directories; group += 1) {
    const child = path.join(directory, `section-${group.toString().padStart(3, "0")}`);
    // Each directory is written as one bounded parallel burst.
    // eslint-disable-next-line no-await-in-loop
    await mkdir(child, {recursive: true});
    const first = group * perDirectory;
    const last = Math.min(config.files, first + perDirectory);
    // eslint-disable-next-line no-await-in-loop
    await Promise.all(Array.from({length: last - first}, (_, offset) => writeFile(
      path.join(child, `note-${(first + offset).toString().padStart(5, "0")}.md`),
      `# Note ${first + offset}\n`,
    )));
  }
}

interface SeededTarget {
  readonly artifactId: string;
  versionId: string;
  /** The current exact-version URL; probe publishes move it forward. */
  versionUrl: string;
}

class ScanClient {
  readonly #server: RunningTestServer;
  readonly #installation: TestInstallation;
  #publishes = 0;

  constructor(server: RunningTestServer, installation: TestInstallation) {
    this.#server = server;
    this.#installation = installation;
  }

  async #request(pathname: string, method: string, body?: Json): Promise<Response> {
    const headers = new Headers({
      Authorization: `Bearer ${this.#installation.apiToken}`,
      "Idempotency-Key": randomUUID(),
    });
    const init: RequestInit = {headers, method};
    if (body !== undefined) {
      headers.set("Content-Type", "application/json");
      init.body = JSON.stringify(body);
    }
    return fetch(new URL(pathname, this.#server.baseUrl), init);
  }

  async link(directory: string): Promise<z.infer<typeof folderLinkSchema>["folderLink"]> {
    const response = await this.#request("/api/v1/projects/prj_default/folder-links", "POST", {
      folderId: null, ignore: [], newFolderName: "Scan baseline", path: directory,
    });
    if (response.status !== 201) throw new Error(`link answered ${response.status}: ${await response.text()}`);
    return folderLinkSchema.parse(await response.json()).folderLink;
  }

  async scan(folderLinkId: string): Promise<void> {
    const response = await this.#request(`/api/v1/folder-links/${folderLinkId}/scan`, "POST");
    if (response.status !== 200) throw new Error(`scan answered ${response.status}: ${await response.text()}`);
    const {folderLink} = folderLinkSchema.parse(await response.json());
    if (folderLink.state !== "active") throw new Error(`scan left the link ${folderLink.state}`);
  }

  async seedArtifact(): Promise<SeededTarget> {
    const published = await publishNew(this.#server, this.#installation, {
      accessSetting: "public_link",
      content: "<!doctype html><title>Latency probe</title><p>probe</p>",
      idempotencyKey: randomUUID(),
      name: "Latency probe",
    });
    if (published.response.status !== 201) throw new Error(`seed publish answered ${published.response.status}`);
    return {
      artifactId: published.body.artifact.id,
      versionId: published.body.version.id,
      versionUrl: published.body.links.version,
    };
  }

  async read(versionUrl: string): Promise<number> {
    const started = performance.now();
    const response = await fetchVersion(this.#server, versionUrl);
    await response.arrayBuffer();
    const elapsed = performance.now() - started;
    if (response.status !== 200) throw new Error(`read answered ${response.status}`);
    return elapsed;
  }

  async publish(target: SeededTarget): Promise<number> {
    this.#publishes += 1;
    const started = performance.now();
    const published = await publishVersion(this.#server, this.#installation, {
      artifactId: target.artifactId,
      content: `<!doctype html><title>Latency probe</title><p>revision ${this.#publishes}</p>`,
      expectedCurrentVersionId: target.versionId,
      idempotencyKey: randomUUID(),
    });
    const elapsed = performance.now() - started;
    if (published.response.status !== 201) throw new Error(`publish answered ${published.response.status}`);
    target.versionId = published.body.version.id;
    target.versionUrl = published.body.links.version;
    return elapsed;
  }
}

/**
 * One sample from a second connection: take and release the write lock with
 * no busy wait, and count entries the running scan already stamped.
 */
function observerSample(observer: DatabaseSync, folderLinkId: string) {
  const stamped = observer.prepare(`
    SELECT COUNT(*) AS count FROM folder_inventory i JOIN folder_links l ON l.id = i.folder_link_id
    WHERE l.id = ? AND i.seen_generation = l.scan_generation
  `);
  const countSchema = z.object({count: z.number().int()});
  return (): ObserverSample => {
    let writeLockFree = true;
    try {
      observer.exec("BEGIN IMMEDIATE; ROLLBACK;");
    } catch {
      writeLockFree = false;
    }
    return {writeLockFree, stamped: countSchema.parse(stamped.get(folderLinkId)).count};
  };
}

/**
 * One interactive client: sequential requests, four reads of the current
 * version for every publish of a new one.
 */
class RequestTraffic {
  readonly #client: ScanClient;
  readonly #target: SeededTarget;
  #round = 0;

  constructor(client: ScanClient, target: SeededTarget) {
    this.#client = client;
    this.#target = target;
  }

  async #next(record: TrafficRecord | null): Promise<void> {
    const publishing = this.#round % 5 === 4;
    this.#round += 1;
    const elapsed = publishing ? await this.#client.publish(this.#target) : await this.#client.read(this.#target.versionUrl);
    if (record !== null) (publishing ? record.publishes : record.reads).push(elapsed);
  }

  /** Send requests for a fixed window; `null` discards the samples. */
  async run(milliseconds: number, record: TrafficRecord | null): Promise<void> {
    const deadline = performance.now() + milliseconds;
    while (performance.now() < deadline) {
      // Requests are sequential, like one interactive client.
      // eslint-disable-next-line no-await-in-loop
      await this.#next(record);
    }
  }

  /** Send requests until the scan settles. */
  async until(scan: Promise<unknown>, record: TrafficRecord): Promise<void> {
    const state = settlementOf(scan);
    while (!state.settled) {
      // eslint-disable-next-line no-await-in-loop
      await this.#next(record);
    }
  }
}

/** Sample on a short timer, so the observer does not slow the scan it observes. */
async function sampleUntil(scan: Promise<unknown>, onSample: () => void): Promise<void> {
  const state = settlementOf(scan);
  while (!state.settled) {
    onSample();
    // eslint-disable-next-line no-await-in-loop
    await new Promise((resolve) => setTimeout(resolve, sampleIntervalMilliseconds));
  }
}

function round(value: number): number {
  return Math.round(value * 1_000) / 1_000;
}
