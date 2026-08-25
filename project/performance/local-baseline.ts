import {randomUUID} from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import {request} from "node:http";
import {
  availableParallelism,
  cpus,
  platform,
  release,
  tmpdir,
} from "node:os";
import path from "node:path";
import {
  monitorEventLoopDelay,
  performance,
} from "node:perf_hooks";

import * as NodeFileSystem from "@effect/platform-node-shared/NodeFileSystem";
import {
  CLIENT_CAPABILITIES_META_KEY,
  CLIENT_INFO_META_KEY,
  PROTOCOL_VERSION_META_KEY,
} from "@modelcontextprotocol/server";
import {Effect, Redacted} from "effect";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import {z} from "zod";

import {
  type FilePublicationResult,
  publishPath,
} from "../../src/client/file-publication-client.js";

import {
  createTestInstallation,
  removeTestInstallation,
  startTestServer,
  type RunningTestServer,
} from "../../tests/support/runtime-harness.js";
import {
  publishNew,
  publishVersion,
  type PublishResponse,
} from "../../tests/support/publishing.js";

const maximumMeasuredPublishBytes = 134_217_728;
const maximumMeasuredReadBytes = 268_435_456;
const maximumMeasuredFileClientBytes = 33_554_432;
const mcpProtocolVersion = "2026-07-28";

const baselineConfigSchema = z.object({
  clientDirectoryFileBytes: z.number().int().min(1_024).max(65_536),
  clientDirectoryFiles: z.number().int().min(2).max(128),
  clientIterations: z.number().int().min(1).max(5),
  clientSingleFileBytes: z.number().int().min(1_024).max(8_388_608),
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
  const clientBytes = (
    configuration.clientDirectoryFileBytes * configuration.clientDirectoryFiles
    + configuration.clientSingleFileBytes
  ) * configuration.clientIterations;
  if (clientBytes > maximumMeasuredFileClientBytes) {
    context.addIssue({
      code: "custom",
      message: "The measured file-client workload must stay at or below 32 MiB.",
      path: ["clientIterations"],
    });
  }
});

export type LocalBaselineConfig = z.infer<typeof baselineConfigSchema>;

export const defaultLocalBaselineConfig: LocalBaselineConfig = {
  clientDirectoryFileBytes: 4_096,
  clientDirectoryFiles: 48,
  clientIterations: 3,
  clientSingleFileBytes: 2_097_152,
  concurrency: 6,
  payloadBytes: 16_384,
  publications: 40,
  reads: 120,
  warmupPublications: 3,
};

export const smokeBaselineConfig: LocalBaselineConfig = {
  clientDirectoryFileBytes: 2_048,
  clientDirectoryFiles: 12,
  clientIterations: 1,
  clientSingleFileBytes: 524_288,
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
    readonly fileClientDirectory: "passed";
    readonly fileClientSingleFile: "passed";
    readonly healthEndpoint: "passed";
    readonly listEndpoint: "passed";
    readonly mcpControlPlane: "passed";
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
  readonly fileClient: {
    readonly directory: OperationSummary;
    readonly singleFile: OperationSummary;
  };
  readonly generatedAt: string;
  readonly memory: {
    readonly arrayBuffersDeltaBytes: number;
    readonly externalDeltaBytes: number;
    readonly garbageCollection: "forced" | "unavailable";
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
  readonly mcpArtifactList: OperationSummary;
  readonly mcpDiscovery: OperationSummary;
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

interface McpPerformanceParameters {
  readonly [key: string]: McpPerformanceParameterValue;
}

type McpPerformanceParameterValue =
  | boolean
  | number
  | string
  | null
  | readonly McpPerformanceParameterValue[]
  | McpPerformanceParameters;

export async function runLocalBaseline(
  input: LocalBaselineConfig,
): Promise<LocalBaselineReport> {
  const configuration = baselineConfigSchema.parse(input);
  const installation = await createTestInstallation();
  let server: RunningTestServer | null = null;
  const delay = monitorEventLoopDelay({resolution: 10});
  const garbageCollectionAvailable = collectGarbage();
  const memoryBefore = process.memoryUsage();
  const cpuBefore = process.cpuUsage();
  const eventLoopBefore = performance.eventLoopUtilization();
  const totalStartedAt = performance.now();
  delay.enable();

  try {
    server = await startTestServer(installation, {observability: true});
    await assertHealthy(server);
    await warmUp(server, installation, configuration);

    const publications = await measurePublications(
      server,
      installation,
      configuration,
    );
    const reads = await measureReads(server, publications.results, configuration);
    const fileClient = await measureFileClient(
      server,
      installation.apiToken,
      configuration,
    );

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
    server = await startTestServer(installation, {observability: true});
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
    const mcpRequests = Math.min(configuration.publications, 20);
    const mcpDiscovery = await measureMcpDiscovery(
      server,
      installation.apiToken,
      mcpRequests,
      configuration.concurrency,
    );
    const mcpArtifactList = await measureMcpArtifactLists(
      server,
      installation.apiToken,
      mcpRequests,
      configuration.concurrency,
    );

    const storage = await measureStorage(installation.dataDirectory);
    collectGarbage();
    const memoryAfter = process.memoryUsage();
    const cpu = process.cpuUsage(cpuBefore);
    const eventLoop = performance.eventLoopUtilization(eventLoopBefore);
    const totalMilliseconds = round(performance.now() - totalStartedAt);
    delay.disable();

    const reportWithoutWarnings = {
      checks: {
        comparisonEndpoint: "passed" as const,
        fileClientDirectory: "passed" as const,
        fileClientSingleFile: "passed" as const,
        healthEndpoint: "passed" as const,
        listEndpoint: "passed" as const,
        mcpControlPlane: "passed" as const,
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
      fileClient,
      generatedAt: new Date().toISOString(),
      memory: {
        arrayBuffersDeltaBytes: memoryAfter.arrayBuffers - memoryBefore.arrayBuffers,
        externalDeltaBytes: memoryAfter.external - memoryBefore.external,
        garbageCollection: garbageCollectionAvailable ? "forced" as const : "unavailable" as const,
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
      mcpArtifactList,
      mcpDiscovery,
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

async function measureMcpDiscovery(
  server: RunningTestServer,
  apiToken: string,
  count: number,
  concurrency: number,
): Promise<OperationSummary> {
  return measureMcpOperation(count, concurrency, async () => {
    const response = await mcpPerformanceRequest(
      server,
      apiToken,
      "server/discover",
      {},
    );
    if (response.status !== 200) {
      throw new Error(`MCP discovery returned ${response.status}.`);
    }
    const result = z.object({
      result: z.object({
        resultType: z.literal("complete"),
        supportedVersions: z.array(z.literal(mcpProtocolVersion)).length(1),
      }).loose(),
    }).loose().parse(await response.json()).result;
    if (result.supportedVersions[0] !== mcpProtocolVersion) {
      throw new Error("MCP discovery returned the wrong protocol revision.");
    }
  });
}

async function measureMcpArtifactLists(
  server: RunningTestServer,
  apiToken: string,
  count: number,
  concurrency: number,
): Promise<OperationSummary> {
  return measureMcpOperation(count, concurrency, async () => {
    const response = await mcpPerformanceRequest(
      server,
      apiToken,
      "tools/call",
      {
        arguments: {cursor: null, limit: 100, tag: "performance"},
        name: "artifact_list",
      },
      "artifact_list",
    );
    if (response.status !== 200) {
      throw new Error(`MCP artifact_list returned ${response.status}.`);
    }
    const result = z.object({
      result: z.object({
        isError: z.boolean().optional(),
        resultType: z.literal("complete"),
        structuredContent: z.object({
          artifacts: z.array(z.object({id: z.string()}).loose()).min(1).max(100),
          nextCursor: z.string().nullable(),
        }),
      }).loose(),
    }).loose().parse(await response.json()).result;
    if (result.isError === true) {
      throw new Error("MCP artifact_list returned a tool error.");
    }
  });
}

async function measureMcpOperation(
  count: number,
  concurrency: number,
  operation: () => Promise<void>,
): Promise<OperationSummary> {
  const latencies = Array.from<number>({length: count});
  const phaseStartedAt = performance.now();
  await runBounded(count, concurrency, async (index) => {
    const startedAt = performance.now();
    await operation();
    latencies[index] = performance.now() - startedAt;
  });
  return summarizeOperations(
    z.array(z.number()).length(count).parse(latencies),
    performance.now() - phaseStartedAt,
  );
}

function mcpPerformanceRequest(
  server: RunningTestServer,
  apiToken: string,
  method: string,
  parameters: McpPerformanceParameters,
  name?: string,
): Promise<Response> {
  const headers = new Headers({
    Accept: "application/json, text/event-stream",
    Authorization: `Bearer ${apiToken}`,
    "Content-Type": "application/json",
    "MCP-Protocol-Version": mcpProtocolVersion,
    "Mcp-Method": method,
  });
  if (name !== undefined) headers.set("Mcp-Name", name);
  return fetch(`${server.baseUrl}/mcp`, {
    body: JSON.stringify({
      id: randomUUID(),
      jsonrpc: "2.0",
      method,
      params: {
        ...parameters,
        _meta: {
          [CLIENT_CAPABILITIES_META_KEY]: {},
          [CLIENT_INFO_META_KEY]: {
            name: "artifact-server-performance-baseline",
            version: "1",
          },
          [PROTOCOL_VERSION_META_KEY]: mcpProtocolVersion,
        },
      },
    }),
    headers,
    method: "POST",
  });
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
    const response = await fetch(
      `${server.baseUrl}/api/v1/artifacts?limit=100&tag=performance`, {
      headers: {Authorization: `Bearer ${apiToken}`},
      },
    );
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
      tags: ["performance"],
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

async function measureFileClient(
  server: RunningTestServer,
  apiToken: string,
  configuration: LocalBaselineConfig,
): Promise<LocalBaselineReport["fileClient"]> {
  const fixtureDirectory = await mkdtemp(
    path.join(tmpdir(), "artifact-server-file-client-baseline-"),
  );
  const siteDirectory = path.join(fixtureDirectory, "site");
  const assetDirectory = path.join(siteDirectory, "assets");
  const singleFilePath = path.join(fixtureDirectory, "large-file.bin");
  await mkdir(assetDirectory, {recursive: true});
  try {
    await runBounded(
      configuration.clientDirectoryFiles - 1,
      Math.min(configuration.concurrency, 8),
      async (index) => {
        await writeFile(
          path.join(assetDirectory, `asset-${index.toString().padStart(3, "0")}.bin`),
          sizedBuffer(configuration.clientDirectoryFileBytes, `asset-${index}`),
        );
      },
    );

    const directoryLatencies: number[] = [];
    const singleFileLatencies: number[] = [];
    await runSequential(configuration.clientIterations, async (index) => {
      await writeFile(
        path.join(siteDirectory, "index.html"),
        sizedBuffer(configuration.clientDirectoryFileBytes, `directory-${index}`),
      );
      const directoryStartedAt = performance.now();
      const directoryPublication = await executeFileClient(
        server,
        apiToken,
        siteDirectory,
        `File-client directory ${index}`,
      );
      directoryLatencies.push(performance.now() - directoryStartedAt);
      await assertExactVersion(
        server,
        directoryPublication.links.version.toString(),
        configuration.clientDirectoryFileBytes,
      );
      const lastAssetIndex = configuration.clientDirectoryFiles - 2;
      await assertExactVersion(
        server,
        new URL(
          `assets/asset-${lastAssetIndex.toString().padStart(3, "0")}.bin`,
          directoryPublication.links.version,
        ).toString(),
        configuration.clientDirectoryFileBytes,
      );

      await writeFile(
        singleFilePath,
        sizedBuffer(configuration.clientSingleFileBytes, `single-file-${index}`),
      );
      const singleFileStartedAt = performance.now();
      const singleFilePublication = await executeFileClient(
        server,
        apiToken,
        singleFilePath,
        `File-client single file ${index}`,
      );
      singleFileLatencies.push(performance.now() - singleFileStartedAt);
      await assertExactVersion(
        server,
        singleFilePublication.links.version.toString(),
        configuration.clientSingleFileBytes,
      );
    });

    return {
      directory: summarizeOperations(
        directoryLatencies,
        directoryLatencies.reduce((sum, sample) => sum + sample, 0),
      ),
      singleFile: summarizeOperations(
        singleFileLatencies,
        singleFileLatencies.reduce((sum, sample) => sum + sample, 0),
      ),
    };
  } finally {
    await rm(fixtureDirectory, {force: true, recursive: true});
  }
}

function executeFileClient(
  server: RunningTestServer,
  apiToken: string,
  inputPath: string,
  name: string,
): Promise<FilePublicationResult> {
  return Effect.runPromise(
    publishPath(
      {
        apiToken: Redacted.make(apiToken, {label: "performance-api-token"}),
        serverOrigin: server.baseUrl,
      },
      {
        idempotencyKey: randomUUID(),
        inputPath,
        target: {
          accessSetting: "public_link",
          kind: "new_artifact",
          name,
          tags: ["performance", "file-client"],
        },
      },
    ).pipe(
      Effect.provide(FetchHttpClient.layer),
      Effect.provide(NodeFileSystem.layer),
    ),
  );
}

function sizedBuffer(bytes: number, label: string): Buffer {
  const buffer = Buffer.alloc(bytes, 0x78);
  buffer.write(label, 0, "utf8");
  return buffer;
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
  readonly fileClient: LocalBaselineReport["fileClient"];
  readonly memory: LocalBaselineReport["memory"];
  readonly mcpArtifactList: OperationSummary;
  readonly mcpDiscovery: OperationSummary;
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
  if (report.fileClient.directory.latency.p95Milliseconds > 2_000) {
    warnings.push("File-client directory publication p95 exceeded 2,000 ms.");
  }
  if (report.fileClient.singleFile.latency.p95Milliseconds > 2_000) {
    warnings.push("File-client single-file publication p95 exceeded 2,000 ms.");
  }
  if (report.mcpArtifactList.latency.p95Milliseconds > 250) {
    warnings.push("MCP artifact_list p95 exceeded the local investigation threshold of 250 ms.");
  }
  if (report.mcpDiscovery.latency.p95Milliseconds > 250) {
    warnings.push("MCP discovery p95 exceeded the local investigation threshold of 250 ms.");
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
  if (
    report.memory.heapUsedDeltaBytes > 134_217_728 ||
    report.memory.externalDeltaBytes > 134_217_728
  ) {
    warnings.push("Retained heap or external memory grew by more than 128 MiB during the bounded run.");
  }
  return warnings;
}

function collectGarbage(): boolean {
  if (globalThis.gc === undefined) return false;
  globalThis.gc();
  return true;
}

function nanosecondsToMilliseconds(value: number): number {
  return Number.isFinite(value) ? round(value / 1_000_000) : 0;
}

function round(value: number, places = 3): number {
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
}
