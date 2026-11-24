import {randomUUID} from "node:crypto";
import {mkdir, mkdtemp, realpath, rm, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import path from "node:path";

import {afterEach, beforeEach, describe, expect, test} from "vitest";

import {z} from "zod";

import {
  defaultProject, expectFailure, type FolderLink, folderLinkSchema, historyCounts, LinkedFolderClient, waitFor,
} from "../support/linked-folders.js";
import {
  createTestInstallation, removeTestInstallation, type RunningTestServer, startTestServer,
  type TestInstallation,
} from "../support/runtime-harness.js";

async function writeTree(root: string, directories: number, filesPerDirectory: number): Promise<void> {
  for (let directory = 0; directory < directories; directory += 1) {
    const parent = path.join(root, `batch-${String(directory).padStart(3, "0")}`);
    // Directories are filled one at a time to bound open file descriptors.
    // eslint-disable-next-line no-await-in-loop
    await mkdir(parent, {recursive: true});
    // eslint-disable-next-line no-await-in-loop
    await Promise.all(Array.from({length: filesPerDirectory}, (_, index) =>
      writeFile(path.join(parent, `file-${String(index).padStart(5, "0")}.txt`), `${directory}:${index}\n`)));
  }
}

describe("linked folders enforce bounded limits and stay responsive", () => {
  let installation: TestInstallation;
  let server: RunningTestServer | null = null;
  let sourceRoot: string;

  beforeEach(async () => {
    installation = await createTestInstallation();
    sourceRoot = await realpath(await mkdtemp(path.join(tmpdir(), "lfd-006-")));
  });

  afterEach(async () => {
    if (server !== null) await server.stop();
    server = null;
    await removeTestInstallation(installation);
    await rm(sourceRoot, {force: true, recursive: true});
  });

  test("LFD-006-B: a 20,000-file tree indexes in bounded pages, and files past the limit put the link over-limit with existing entries intact", async () => {
    let pages = 0;
    server = await startTestServer(installation, {
      linkRoots: [sourceRoot],
      linkedFiles: "on",
      linkedFolderHooks: {beforeScanPage: () => {
        pages += 1;
        return Promise.resolve();
      }},
      linkedFolderWatch: "off",
    });
    const client = new LinkedFolderClient(server, installation.apiToken);
    await writeTree(sourceRoot, 20, 1_000);

    const started = Date.now();
    const link = await client.linkOk(sourceRoot, {name: "Large output"});
    expect(link).toMatchObject({entryCount: 20_000, overLimitReason: null, pendingCount: 20_000, state: "active"});
    expect(pages).toBeGreaterThanOrEqual(10);
    expect(Date.now() - started).toBeLessThan(60_000);
    const inventory = await client.inventory(link.id);
    expect(inventory).toHaveLength(20_000);
    const sample = inventory.find((entry) => entry.relativePath === "batch-007/file-00123.txt");

    await writeTree(path.join(sourceRoot, "late"), 1, 5);
    const scanning = client.scan(link.id);
    // Reads stay responsive while a scan runs.
    const health = await fetch(new URL("/health", server.baseUrl));
    expect(health.status).toBe(200);
    const overLimit = await scanning;
    expect(overLimit).toMatchObject({entryCount: 20_000, overLimitReason: "entries", state: "over-limit"});
    const after = await client.inventory(link.id);
    expect(after).toHaveLength(20_000);
    expect(after.some((entry) => entry.relativePath.startsWith("late/"))).toBe(false);
    expect(after.find((entry) => entry.relativePath === "batch-007/file-00123.txt")).toEqual(sample);
    expect(historyCounts(installation)["artifacts"]).toBe(0);
  }, 180_000);

  test("LFD-006-F: a 51st link is refused, scans past the concurrency limit queue, and a capture above 100 entries is refused before any work", async () => {
    let gate: Promise<void> | null = null;
    const releases: Array<() => void> = [];
    server = await startTestServer(installation, {
      linkRoots: [sourceRoot],
      linkedFiles: "on",
      linkedFolderHooks: {beforeScanPage: () => gate ?? Promise.resolve()},
      linkedFolderWatch: "off",
    });
    const client = new LinkedFolderClient(server, installation.apiToken);
    const links: FolderLink[] = [];
    for (let index = 0; index < 50; index += 1) {
      const directory = path.join(sourceRoot, `link-${String(index).padStart(2, "0")}`);
      // Links are created sequentially so each first scan settles before the next.
      // eslint-disable-next-line no-await-in-loop
      await mkdir(directory);
      // eslint-disable-next-line no-await-in-loop
      await writeFile(path.join(directory, "file.md"), `# ${index}\n`);
      // eslint-disable-next-line no-await-in-loop
      links.push(await client.linkOk(directory, {name: `Link ${index}`}));
    }
    await mkdir(path.join(sourceRoot, "link-50"));
    await expectFailure(await client.link(path.join(sourceRoot, "link-50"), {name: "One too many"}), 409, "LINK_LIMIT");

    gate = new Promise((resolve) => {
      releases.push(resolve);
    });
    const targets = links.slice(0, 3);
    const scans = targets.map((link) => client.scan(link.id));
    try {
      // Indexer scans share the same installation queue, so count every link.
      const observed = await waitFor(
        async () => z.object({folderLinks: z.array(folderLinkSchema)}).parse(await (await client.request(
          `/api/v1/projects/${defaultProject}/folder-links`,
        )).json()).folderLinks,
        (states) => states.filter((link) => link.scanActivity === "scanning").length === 2
          && targets.some((target) => states.find((link) => link.id === target.id)?.scanActivity === "queued"),
      );
      expect(observed.filter((link) => link.scanActivity === "scanning")).toHaveLength(2);
    } finally {
      for (const release of releases) release();
      gate = null;
    }
    const finished = await Promise.all(scans);
    expect(finished.every((link) => link.state === "active")).toBe(true);

    const [first] = links;
    const entries = await client.inventory(first?.id ?? "");
    const before = historyCounts(installation);
    const tooMany = [...entries.map((entry) => entry.id), ...Array.from({length: 100}, () => `fle_${randomUUID()}`)];
    await expectFailure(await client.capture(first?.id ?? "", {entryIds: tooMany}), 422, "CAPTURE_BATCH_TOO_LARGE");
    await expectFailure(await client.capture(first?.id ?? "", {entryIds: [entries[0]?.id ?? "", entries[0]?.id ?? ""]}), 422, "CAPTURE_BATCH_TOO_LARGE");
    expect(historyCounts(installation)).toEqual(before);
    expect((await client.inventory(first?.id ?? "")).every((entry) => entry.state === "untracked")).toBe(true);
  }, 120_000);
});
