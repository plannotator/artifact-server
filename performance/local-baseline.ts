import {readdir, stat} from "node:fs/promises";
import {request} from "node:http";
import {availableParallelism, cpus, platform, release} from "node:os";
import path from "node:path";
import {
  monitorEventLoopDelay,
  performance,
} from "node:perf_hooks";

import {z} from "zod";

import {
  createTestInstallation,
  removeTestInstallation,
  startTestServer,
  type RunningTestServer,
} from "../tests/support/runtime-harness.js";
import {
  publishNew,
  publishVersion,
  type PublishResponse,
} from "../tests/support/publishing.js";

const maximumMeasuredPublishBytes = 134_217_728;
const maximumMeasuredReadBytes = 268_435_456;

const baselineConfigSchema = z.object({
  concurrency: z.number().int().min(1).max(16),
  payloadBytes: z.number().int().min(1_024).max(1_048_576),
  publications: z.number().int().min(1).max(500),
  reads: z.number().int().min(1).max(5_000),
  warmupPublications: z.number().int().min(1).max(20),
}).superRefine((configuration, context) => {
  if (configuration.payloadBytes * configuration.publications > maximumMeasuredPublishBytes) {
    context.addIssue({
      code: "custom",
      message: "The measured publication workload must stay at or below 128 MiB.",
      path: ["publications"],
    });
  }
  if (configuration.payloadBytes * configuration.reads > maximumMeasuredReadBytes) {
    context.addIssue({
      code: "custom",
      message: "The measured read workload must stay at or below 256 MiB.",
      path: ["reads"],
    });
  }
});

export type LocalBaselineConfig = z.infer<typeof baselineConfigSchema>;

export const defaultLocalBaselineConfig: LocalBaselineConfig = {
  concurrency: 6,
  payloadBytes: 16_384,
  publications: 40,
  reads: 120,
  warmupPublications: 3,
};

export const smokeBaselineConfig: LocalBaselineConfig = {
  concurrency: 4,
  payloadBytes: 4_096,
  publications: 8,
  reads: 16,
  warmupPublications: 1,
};

export interface LatencySummary {
  readonly count: number;
  readonly maximumMilliseconds: number;
  readonly meanMilliseconds: number;
  readonly minimumMilliseconds: number;
  readonly p50Milliseconds: number;
  readonly p95Milliseconds: number;
  readonly p99Milliseconds: number;
}

export interface OperationSummary {
  readonly latency: LatencySummary;
  readonly operationsPerSecond: number;
  readonly totalMilliseconds: number;
}

export interface LocalBaselineReport {
  readonly checks: {
    readonly comparisonEndpoint: "passed";
    readonly healthEndpoint: "passed";
    readonly listEndpoint: "passed";
    readonly previousVersionDeniedAfterRestart: "passed";
    readonly restartPersistence: "passed";
  };
  readonly configuration: LocalBaselineConfig;
  readonly environment: {
    readonly availableParallelism: number;
    readonly cpu: string;
    readonly node: string;
    readonly operatingSystem: string;
    readonly platform: NodeJS.Platform;
  };
  readonly eventLoop: {
    readonly maximumDelayMilliseconds: number;
    readonly meanDelayMilliseconds: number;
    readonly p95DelayMilliseconds: number;
    readonly utilization: number;
  };
  readonly generatedAt: string;
  readonly memory: {
    readonly arrayBuffersDeltaBytes: number;
    readonly externalDeltaBytes: number;
    readonly heapUsedDeltaBytes: number;
    readonly rssAfterBytes: number;
    readonly rssBeforeBytes: number;
    readonly rssDeltaBytes: number;
    readonly scope: "combined benchmark client and local server process";
  };
  readonly processCpu: {
    readonly systemMilliseconds: number;
    readonly userMilliseconds: number;
  };
  readonly comparison: OperationSummary;
  readonly artifactList: OperationSummary;
  readonly publish: OperationSummary;
  readonly read: OperationSummary;
  readonly restartMilliseconds: number;
  readonly storage: {
    readonly bytes: number;
    readonly files: number;
  };
  readonly totalMilliseconds: number;
  readonly warnings: readonly string[];
}

interface StorageUse {
  readonly bytes: number;
  readonly files: number;
}

export async function runLocalBaseline(
  input: LocalBaselineConfig,
): Promise<LocalBaselineReport> {
  const configuration = baselineConfigSchema.parse(input);
  const installation = await createTestInstallation();
  let server: RunningTestServer | null = null;
  const delay = monitorEventLoopDelay({resolution: 10});
  const memoryBefore = process.memoryUsage();
  const cpuBefore = process.cpuUsage();
  const eventLoopBefore = performance.eventLoopUtilization();
  const totalStartedAt = performance.now();
  delay.enable();

  try {
    server = await startTestServer(installation);
    await assertHealthy(server);
    await warmUp(server, installation, configuration);

    const publications = await measurePublications(
      server,
      installation,
      configuration,
    );
    const reads = await measureReads(server, publications.results, configuration);

    const anchor = publications.results[0];
    if (anchor === undefined) {
      throw new Error("The baseline did not create an artifact for restart verification.");
    }
    const previousVersionUrl = anchor.links.version;
    const updated = await publishVersion(server, installation, {
      artifactId: anchor.artifact.id,
      content: createPayload(configuration.payloadBytes, "restart-version"),
      expectedCurrentVersionId: anchor.version.id,
      idempotencyKey: "performance-restart-version-publish",
    });
    assertStatus(updated.response, 201, "restart version publication");

    const restartStartedAt = performance.now();
    await server.stop();
    server = null;
    server = await startTestServer(installation);
    const restartMilliseconds = round(performance.now() - restartStartedAt);
    await assertHealthy(server);
    await assertStableVersion(server, updated.body, configuration.payloadBytes);
    await assertDeniedVersion(server, previousVersionUrl);
    const comparisons = await measureComparisons(
      server,
      installation.apiToken,
      anchor,
      updated.body,
      Math.min(configuration.publications, 20),
      configuration.concurrency,
    );
    const artifactLists = await measureArtifactLists(
      server,
      installation.apiToken,
      Math.min(configuration.publications, 20),
      configuration.concurrency,
    );

    const storage = await measureStorage(installation.dataDirectory);
    const memoryAfter = process.memoryUsage();
    const cpu = process.cpuUsage(cpuBefore);
    const eventLoop = performance.eventLoopUtilization(eventLoopBefore);
    const totalMilliseconds = round(performance.now() - totalStartedAt);
    delay.disable();

    const reportWithoutWarnings = {
      checks: {
        comparisonEndpoint: "passed" as const,
        healthEndpoint: "passed" as const,
        listEndpoint: "passed" as const,
        previousVersionDeniedAfterRestart: "passed" as const,
        restartPersistence: "passed" as const,
      },
      configuration,
      environment: environmentSummary(),
      eventLoop: {
        maximumDelayMilliseconds: nanosecondsToMilliseconds(delay.max),
        meanDelayMilliseconds: nanosecondsToMilliseconds(delay.mean),
        p95DelayMilliseconds: nanosecondsToMilliseconds(delay.percentile(95)),
        utilization: round(eventLoop.utilization, 4),
      },
      generatedAt: new Date().toISOString(),
      memory: {
        arrayBuffersDeltaBytes: memoryAfter.arrayBuffers - memoryBefore.arrayBuffers,
        externalDeltaBytes: memoryAfter.external - memoryBefore.external,
        heapUsedDeltaBytes: memoryAfter.heapUsed - memoryBefore.heapUsed,
        rssAfterBytes: memoryAfter.rss,
        rssBeforeBytes: memoryBefore.rss,
        rssDeltaBytes: memoryAfter.rss - memoryBefore.rss,
        scope: "combined benchmark client and local server process" as const,
      },
      processCpu: {
        systemMilliseconds: round(cpu.system / 1_000),
        userMilliseconds: round(cpu.user / 1_000),
      },
      comparison: comparisons,
      artifactList: artifactLists,
      publish: publications.summary,
      read: reads,
      restartMilliseconds,
      storage,
      totalMilliseconds,
    };

    return {
      ...reportWithoutWarnings,
      warnings: baselineWarnings(reportWithoutWarnings),
    };
  } finally {
    delay.disable();
    if (server !== null) await server.stop();
    await removeTestInstallation(installation);
  }
}

async function measureArtifactLists(
  server: RunningTestServer,
  apiToken: string,
  count: number,
  concurrency: number,
): Promise<OperationSummary> {
  const latencies = Array.from<number>({length: count});
  const phaseStartedAt = performance.now();
  await runBounded(count, concurrency, async (index) => {
    const startedAt = performance.now();
    const response = await fetch(`${server.baseUrl}/api/v1/artifacts?limit=100`, {
      headers: {Authorization: `Bearer ${apiToken}`},
    });
    if (response.status !== 200) {
      throw new Error(`An artifact list request returned ${response.status}.`);
    }
    const page = z.object({
      artifacts: z.array(z.object({artifact: z.object({id: z.string()})})).min(1),
      nextCursor: z.string().nullable(),
    }).parse(await response.json());
    if (page.artifacts.length > 100) {
      throw new Error("An artifact list exceeded its requested page bound.");
    }
    latencies[index] = performance.now() - startedAt;
  });
  return summarizeOperations(
    z.array(z.number()).length(count).parse(latencies),
    performance.now() - phaseStartedAt,
  );
}

async function measureComparisons(
  server: RunningTestServer,
  apiToken: string,
  from: PublishResponse,
  to: PublishResponse,
  count: number,
  concurrency: number,
): Promise<OperationSummary> {
  const latencies = Array.from<number>({length: count});
  const query = new URLSearchParams({
    fromVersionId: from.version.id,
    toVersionId: to.version.id,
  });
  const url = `${server.baseUrl}/api/v1/artifacts/${from.artifact.id}/comparisons?${query}`;
  const phaseStartedAt = performance.now();
  await runBounded(count, concurrency, async (index) => {
    const startedAt = performance.now();
    const response = await fetch(url, {
      headers: {Authorization: `Bearer ${apiToken}`},
    });
    if (response.status !== 200) {
      throw new Error(`A comparison request returned ${response.status}.`);
    }
    const comparison = z.object({
      changed: z.array(z.object({detail: z.unknown()})).min(1),
      from: z.object({id: z.string()}),
      to: z.object({id: z.string()}),
    }).parse(await response.json());
    if (
      comparison.from.id !== from.version.id ||
      comparison.to.id !== to.version.id
    ) {
      throw new Error("A comparison response referenced the wrong versions.");
    }
    latencies[index] = performance.now() - startedAt;
  });
  return summarizeOperations(
    z.array(z.number()).length(count).parse(latencies),
    performance.now() - phaseStartedAt,
  );
}

async function assertHealthy(server: RunningTestServer): Promise<void> {
  const response = await fetch(`${server.baseUrl}/health`);
  if (response.status !== 200) {
    throw new Error(`The health endpoint returned ${response.status}.`);
  }
  await response.arrayBuffer();
}

async function warmUp(
  server: RunningTestServer,
  installation: Awaited<ReturnType<typeof createTestInstallation>>,
  configuration: LocalBaselineConfig,
): Promise<void> {
  await runSequential(configuration.warmupPublications, async (index) => {
    const published = await publishNew(server, installation, {
      accessSetting: "public_link",
      content: createPayload(configuration.payloadBytes, `warmup-${index}`),
      idempotencyKey: `performance-warmup-publication-${index}`,
      name: `Warmup artifact ${index}`,
    });
    assertStatus(published.response, 201, "warmup publication");
    await assertExactVersion(
      server,
      published.body.links.version,
      configuration.payloadBytes,
    );
  });
}

async function measurePublications(
  server: RunningTestServer,
  installation: Awaited<ReturnType<typeof createTestInstallation>>,
  configuration: LocalBaselineConfig,
): Promise<{
  readonly results: readonly PublishResponse[];
  readonly summary: OperationSummary;
}> {
  const latencies: number[] = [];
  const results: PublishResponse[] = [];
  const phaseStartedAt = performance.now();

  await runSequential(configuration.publications, async (index) => {
    const startedAt = performance.now();
    const published = await publishNew(server, installation, {
      accessSetting: "public_link",
      content: createPayload(configuration.payloadBytes, `measured-${index}`),
      idempotencyKey: `performance-measured-publication-${index}`,
      name: `Measured artifact ${index}`,
    });
    latencies.push(performance.now() - startedAt);
    assertStatus(published.response, 201, "measured publication");
    results.push(published.body);
  });

  return {
    results,
    summary: summarizeOperations(latencies, performance.now() - phaseStartedAt),
  };
}

async function measureReads(
  server: RunningTestServer,
  publications: readonly PublishResponse[],
  configuration: LocalBaselineConfig,
): Promise<OperationSummary> {
  const latencies = Array.from<number>({length: configuration.reads});
  const phaseStartedAt = performance.now();
  await runBounded(configuration.reads, configuration.concurrency, async (index) => {
    const publication = publications[index % publications.length];
    if (publication === undefined) {
      throw new Error("The read baseline could not select a published version.");
    }
    const startedAt = performance.now();
    await assertExactVersion(
      server,
      publication.links.version,
      configuration.payloadBytes,
    );
    latencies[index] = performance.now() - startedAt;
  });
  return summarizeOperations(
    z.array(z.number()).length(configuration.reads).parse(latencies),
    performance.now() - phaseStartedAt,
  );
}

async function assertStableVersion(
  server: RunningTestServer,
  publication: PublishResponse,
  expectedBytes: number,
): Promise<void> {
  const stable = await fetch(
    `${server.baseUrl}/artifacts/${publication.artifact.id}`,
    {redirect: "manual"},
  );
  if (stable.status !== 302) {
    throw new Error(`The stable artifact link returned ${stable.status} after restart.`);
  }
  const location = z.url().parse(stable.headers.get("location"));
  await assertExactVersion(
    server,
    location,
    expectedBytes,
  );
}

async function assertExactVersion(
  server: RunningTestServer,
  versionUrl: string,
  expectedBytes: number,
): Promise<void> {
  const target = new URL(versionUrl);
  const receivedBytes = await new Promise<number>((resolve, reject) => {
    const outgoing = request(
      {
        headers: {Host: `${target.hostname}:${server.port}`},
        hostname: "127.0.0.1",
        method: "GET",
        path: `${target.pathname}${target.search}`,
        port: server.port,
      },
      (incoming) => {
        let bytes = 0;
        incoming.on("data", (chunk: Buffer) => {
          bytes += chunk.byteLength;
        });
        incoming.on("end", () => {
          if (incoming.statusCode !== 200) {
            reject(new Error(`An exact version link returned ${incoming.statusCode ?? 500}.`));
            return;
          }
          resolve(bytes);
        });
      },
    );
    outgoing.on("error", reject);
    outgoing.end();
  });
  if (receivedBytes !== expectedBytes) {
    throw new Error(`An exact version returned ${receivedBytes} bytes instead of ${expectedBytes}.`);
  }
}

async function assertDeniedVersion(
  server: RunningTestServer,
  versionUrl: string,
): Promise<void> {
  const target = new URL(versionUrl);
  await new Promise<void>((resolve, reject) => {
    const outgoing = request(
      {
        headers: {Host: `${target.hostname}:${server.port}`},
        hostname: "127.0.0.1",
        method: "GET",
        path: `${target.pathname}${target.search}`,
        port: server.port,
      },
      (incoming) => {
        incoming.resume();
        incoming.on("end", () => {
          if (incoming.statusCode !== 401) {
            reject(
              new Error(
                `A previous version returned ${incoming.statusCode ?? 500} instead of 401.`,
              ),
            );
            return;
          }
          resolve();
        });
      },
    );
    outgoing.on("error", reject);
    outgoing.end();
  });
}

function assertStatus(response: Response, expected: number, operation: string): void {
  if (response.status !== expected) {
    throw new Error(`${operation} returned ${response.status} instead of ${expected}.`);
  }
}

async function runBounded(
  count: number,
  concurrency: number,
  operation: (index: number) => Promise<void>,
): Promise<void> {
  let nextIndex = 0;
  const worker = async (): Promise<void> => {
    if (nextIndex >= count) return;
    const index = nextIndex;
    nextIndex += 1;
    await operation(index);
    await worker();
  };
  await Promise.all(
    Array.from({length: Math.min(count, concurrency)}, async () => worker()),
  );
}

async function runSequential(
  count: number,
  operation: (index: number) => Promise<void>,
  index = 0,
): Promise<void> {
  if (index >= count) return;
  await operation(index);
  await runSequential(count, operation, index + 1);
}

function createPayload(bytes: number, label: string): string {
  const prefix = `<!doctype html><meta charset=utf-8><title>${label}</title><pre>`;
  const suffix = "</pre>";
  if (Buffer.byteLength(prefix + suffix) > bytes) {
    throw new Error("The configured payload is too small for the baseline document.");
  }
  return prefix + "x".repeat(bytes - Buffer.byteLength(prefix + suffix)) + suffix;
}

function summarizeOperations(
  samples: readonly number[],
  totalMilliseconds: number,
): OperationSummary {
  return {
    latency: summarizeLatency(samples),
    operationsPerSecond: round(samples.length / (totalMilliseconds / 1_000)),
    totalMilliseconds: round(totalMilliseconds),
  };
}

function summarizeLatency(samples: readonly number[]): LatencySummary {
  const sorted = samples.toSorted((left, right) => left - right);
  const first = sorted[0];
  const last = sorted.at(-1);
  if (first === undefined || last === undefined) {
    throw new Error("A latency summary requires at least one sample.");
  }
  const mean = sorted.reduce((sum, sample) => sum + sample, 0) / sorted.length;
  return {
    count: sorted.length,
    maximumMilliseconds: round(last),
    meanMilliseconds: round(mean),
    minimumMilliseconds: round(first),
    p50Milliseconds: round(percentile(sorted, 50)),
    p95Milliseconds: round(percentile(sorted, 95)),
    p99Milliseconds: round(percentile(sorted, 99)),
  };
}

function percentile(sorted: readonly number[], requested: number): number {
  const index = Math.max(0, Math.ceil((requested / 100) * sorted.length) - 1);
  const value = sorted[index];
  if (value === undefined) throw new Error("A percentile requires a populated sample.");
  return value;
}

async function measureStorage(directory: string): Promise<StorageUse> {
  const entries = await readdir(directory, {withFileTypes: true});
  const uses = await Promise.all(entries.map(async (entry): Promise<StorageUse> => {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      return measureStorage(entryPath);
    }
    if (entry.isFile()) {
      const metadata = await stat(entryPath);
      return {bytes: metadata.size, files: 1};
    }
    return {bytes: 0, files: 0};
  }));
  return uses.reduce<StorageUse>(
    (total, use) => ({bytes: total.bytes + use.bytes, files: total.files + use.files}),
    {bytes: 0, files: 0},
  );
}

function environmentSummary(): LocalBaselineReport["environment"] {
  return {
    availableParallelism: availableParallelism(),
    cpu: cpus()[0]?.model ?? "unreported",
    node: process.version,
    operatingSystem: `${platform()} ${release()}`,
    platform: process.platform,
  };
}

function baselineWarnings(report: {
  readonly artifactList: OperationSummary;
  readonly comparison: OperationSummary;
  readonly eventLoop: LocalBaselineReport["eventLoop"];
  readonly memory: LocalBaselineReport["memory"];
  readonly publish: OperationSummary;
  readonly read: OperationSummary;
}): readonly string[] {
  const warnings: string[] = [];
  if (report.artifactList.latency.p95Milliseconds > 100) {
    warnings.push("Artifact-list p95 exceeded the local investigation threshold of 100 ms.");
  }
  if (report.comparison.latency.p95Milliseconds > 250) {
    warnings.push("Comparison p95 exceeded the local investigation threshold of 250 ms.");
  }
  if (report.publish.latency.p95Milliseconds > 250) {
    warnings.push("Publish p95 exceeded the local investigation threshold of 250 ms.");
  }
  if (report.read.latency.p95Milliseconds > 100) {
    warnings.push("Read p95 exceeded the local investigation threshold of 100 ms.");
  }
  if (report.eventLoop.maximumDelayMilliseconds > 100) {
    warnings.push("Maximum event-loop delay exceeded 100 ms.");
  }
  if (report.memory.rssDeltaBytes > 134_217_728) {
    warnings.push("Combined benchmark-process RSS grew by more than 128 MiB during the bounded run.");
  }
  return warnings;
}

function nanosecondsToMilliseconds(value: number): number {
  return Number.isFinite(value) ? round(value / 1_000_000) : 0;
}

function round(value: number, places = 3): number {
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
}
