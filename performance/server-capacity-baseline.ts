import {fork, type ChildProcess} from "node:child_process";
import {createHash, randomUUID} from "node:crypto";
import {once} from "node:events";
import {mkdtemp, readFile, rm} from "node:fs/promises";
import {request} from "node:http";
import {
  availableParallelism,
  cpus,
  platform,
  release,
  tmpdir,
} from "node:os";
import path from "node:path";
import {performance} from "node:perf_hooks";

import {
  CLIENT_CAPABILITIES_META_KEY,
  CLIENT_INFO_META_KEY,
  PROTOCOL_VERSION_META_KEY,
} from "@modelcontextprotocol/server";
import {z} from "zod";

import {readLocalApiCredential} from "../src/local/local-credentials.js";
import {inspectLocalServiceRecord} from "../src/local/local-service-record.js";

const repositoryRoot = path.resolve(import.meta.dirname, "..");
const profiledServerEntry = path.join(
  repositoryRoot,
  "performance/profiled-local-server.ts",
);
const mcpProtocolVersion = "2026-07-28";
const requestTimeoutMilliseconds = 30_000;
const serverStartupTimeoutMilliseconds = 20_000;
const maximumBrowseBytes = 536_870_912;
const maximumPublishBytes = 33_554_432;

const capacityConfigSchema = z.object({
  browseFileBytes: z.number().int().min(16_384).max(1_048_576),
  concurrencyLevels: z.array(z.number().int().min(1).max(100)).min(1).max(5),
  publishFileBytes: z.number().int().min(1_024).max(262_144),
  waves: z.number().int().min(1).max(5),
}).superRefine((configuration, context) => {
  const users = configuration.concurrencyLevels.reduce(
    (total, level) => total + level,
    0,
  ) * configuration.waves;
  if (users * configuration.browseFileBytes > maximumBrowseBytes) {
    context.addIssue({
      code: "custom",
      message: "The capacity browse workload must stay at or below 512 MiB.",
      path: ["browseFileBytes"],
    });
  }
  if (users * configuration.publishFileBytes > maximumPublishBytes) {
    context.addIssue({
      code: "custom",
      message: "The capacity publication workload must stay at or below 32 MiB.",
      path: ["publishFileBytes"],
    });
  }
  const uniqueLevels = new Set(configuration.concurrencyLevels);
  if (uniqueLevels.size !== configuration.concurrencyLevels.length) {
    context.addIssue({
      code: "custom",
      message: "Capacity concurrency levels must be unique.",
      path: ["concurrencyLevels"],
    });
  }
  for (let index = 1; index < configuration.concurrencyLevels.length; index += 1) {
    const previous = configuration.concurrencyLevels[index - 1];
    const current = configuration.concurrencyLevels[index];
    if (previous !== undefined && current !== undefined && current <= previous) {
      context.addIssue({
        code: "custom",
        message: "Capacity concurrency levels must be in ascending order.",
        path: ["concurrencyLevels", index],
      });
    }
  }
});

const memorySnapshotSchema = z.object({
  arrayBuffers: z.number().nonnegative(),
  external: z.number().nonnegative(),
  heapTotal: z.number().nonnegative(),
  heapUsed: z.number().nonnegative(),
  rss: z.number().nonnegative(),
}).strict();
const stageStartedSchema = z.object({
  garbageCollection: z.enum(["forced", "unavailable"]),
  kind: z.literal("capacity-stage-started"),
  memory: memorySnapshotSchema,
  requestId: z.string(),
}).strict();
const stageFinishedSchema = z.object({
  cpu: z.object({
    systemMilliseconds: z.number().nonnegative(),
    userMilliseconds: z.number().nonnegative(),
  }).strict(),
  eventLoop: z.object({
    maximumDelayMilliseconds: z.number().nonnegative(),
    meanDelayMilliseconds: z.number().nonnegative(),
    p95DelayMilliseconds: z.number().nonnegative(),
    utilization: z.number().min(0).max(1),
  }).strict(),
  garbageCollection: z.enum(["forced", "unavailable"]),
  kind: z.literal("capacity-stage-finished"),
  memory: z.object({
    peak: memorySnapshotSchema,
    settled: memorySnapshotSchema,
    started: memorySnapshotSchema,
  }).strict(),
  requestId: z.string(),
}).strict();
const controlErrorSchema = z.object({
  kind: z.literal("capacity-control-error"),
  message: z.string(),
  requestId: z.string(),
}).strict();
const controlResponseSchema = z.discriminatedUnion("kind", [
  stageStartedSchema,
  stageFinishedSchema,
  controlErrorSchema,
]);

const uploadPlanSchema = z.object({
  commitUrl: z.url(),
  files: z.array(z.object({
    method: z.literal("PUT"),
    path: z.string(),
    size: z.number().int().nonnegative(),
    uploadUrl: z.url(),
  }).strict()).length(1),
  uploadId: z.string(),
}).loose();
const publicationSchema = z.object({
  artifact: z.object({id: z.string()}).loose(),
  links: z.object({artifact: z.url(), version: z.url()}).strict(),
  version: z.object({
    artifactId: z.string(),
    id: z.string(),
  }).loose(),
}).loose();
const packageMetadataSchema = z.object({version: z.string().min(1)});

/** Bounded configuration for one server-only capacity baseline. */
export type ServerCapacityConfig = z.infer<typeof capacityConfigSchema>;

/** Default concurrency matrix repeated at the end of every backend iteration. */
export const defaultServerCapacityConfig: ServerCapacityConfig = {
  browseFileBytes: 262_144,
  concurrencyLevels: [1, 10, 25, 50, 100],
  publishFileBytes: 16_384,
  waves: 3,
};

/** One latency distribution measured by the load-generator process. */
export interface CapacityLatencySummary {
  readonly count: number;
  readonly maximumMilliseconds: number;
  readonly meanMilliseconds: number;
  readonly minimumMilliseconds: number;
  readonly p50Milliseconds: number;
  readonly p95Milliseconds: number;
  readonly p99Milliseconds: number;
}

/** Memory owned only by the compiled Artifact Server child process. */
export type ServerMemorySnapshot = z.infer<typeof memorySnapshotSchema>;

/** One measured browse or publish stage. */
export interface ServerCapacityStage {
  readonly completedJourneys: number;
  readonly concurrentUsers: number;
  readonly eventLoop: z.infer<typeof stageFinishedSchema>["eventLoop"];
  readonly garbageCollection: "forced" | "unavailable";
  readonly journeyLatency: CapacityLatencySummary;
  readonly journeysPerSecond: number;
  readonly memory: {
    readonly peak: ServerMemorySnapshot;
    readonly peakRssDeltaBytes: number;
    readonly retainedHeapDeltaBytes: number;
    readonly settled: ServerMemorySnapshot;
    readonly started: ServerMemorySnapshot;
  };
  readonly profile: "browse" | "publish";
  readonly serverCpu: z.infer<typeof stageFinishedSchema>["cpu"];
  readonly totalMilliseconds: number;
  readonly totalRequests: number;
  readonly waves: number;
}

/** Machine-readable result for the complete local server capacity matrix. */
export interface ServerCapacityReport {
  readonly checks: {
    readonly allJourneysCompleted: "passed";
    readonly healthAfterEveryStage: "passed";
    readonly serverProcessIsolated: "passed";
    readonly streamedBytesVerified: "passed";
  };
  readonly configuration: ServerCapacityConfig;
  readonly environment: {
    readonly availableParallelism: number;
    readonly cpu: string;
    readonly node: string;
    readonly operatingSystem: string;
    readonly platform: NodeJS.Platform;
    readonly productVersion: string;
  };
  readonly generatedAt: string;
  readonly levels: readonly {
    readonly browse: ServerCapacityStage;
    readonly concurrentUsers: number;
    readonly publish: ServerCapacityStage;
  }[];
  readonly server: {
    readonly measurementBoundary: "compiled child server process";
    readonly pid: number;
    readonly startupMilliseconds: number;
  };
  readonly summary: {
    readonly finalRetainedHeapDeltaBytes: number;
    readonly maximumPeakHeapUsedBytes: number;
    readonly maximumPeakRssBytes: number;
  };
  readonly warnings: readonly string[];
}

type ControlResponse = z.infer<typeof controlResponseSchema>;
type Publication = z.infer<typeof publicationSchema>;

interface PendingControlRequest {
  readonly reject: (cause: Error) => void;
  readonly resolve: (response: ControlResponse) => void;
  readonly timeout: NodeJS.Timeout;
}

interface ProfiledLocalServer {
  readonly apiToken: string;
  readonly baseUrl: string;
  readonly child: ChildProcess;
  readonly dataDirectory: string;
  readonly hostname: string;
  readonly pid: number;
  readonly port: number;
  readonly startupMilliseconds: number;
  readonly close: () => Promise<void>;
  readonly control: (kind: "capacity-stage-start" | "capacity-stage-finish") => Promise<ControlResponse>;
}

interface StageOperation {
  readonly requestsPerJourney: number;
  readonly run: (index: number) => Promise<void>;
}

/** Run the real compiled local server under the complete bounded concurrency matrix. */
export async function runServerCapacityBaseline(
  input: ServerCapacityConfig,
): Promise<ServerCapacityReport> {
  const configuration = capacityConfigSchema.parse(input);
  const dataDirectory = await mkdtemp(
    path.join(tmpdir(), "artifact-server-capacity-"),
  );
  let server: ProfiledLocalServer | null = null;
  try {
    const runningServer = await startProfiledLocalServer(dataDirectory);
    server = runningServer;
    const seedBytes = sizedDocument(
      configuration.browseFileBytes,
      "capacity-seed-one",
    );
    const first = await publishFile(runningServer, seedBytes, {
      accessSetting: "public_link",
      kind: "new_artifact",
      name: "Capacity baseline seed",
      tags: ["capacity"],
    });
    const second = await publishFile(
      runningServer,
      sizedDocument(configuration.browseFileBytes, "capacity-seed-two"),
      {
        artifactId: first.artifact.id,
        expectedCurrentVersionId: first.version.id,
        kind: "new_version",
      },
    );
    const levels = await measureCapacityLevels(
      runningServer,
      configuration,
      first,
      second,
    );

    const stages = levels.flatMap((level) => [level.browse, level.publish]);
    const initialHeap = stages[0]?.memory.started.heapUsed ?? 0;
    const finalHeap = stages.at(-1)?.memory.settled.heapUsed ?? initialHeap;
    const reportWithoutWarnings = {
      checks: {
        allJourneysCompleted: "passed" as const,
        healthAfterEveryStage: "passed" as const,
        serverProcessIsolated: "passed" as const,
        streamedBytesVerified: "passed" as const,
      },
      configuration,
      environment: await environmentSummary(),
      generatedAt: new Date().toISOString(),
      levels,
      server: {
        measurementBoundary: "compiled child server process" as const,
        pid: runningServer.pid,
        startupMilliseconds: runningServer.startupMilliseconds,
      },
      summary: {
        finalRetainedHeapDeltaBytes: finalHeap - initialHeap,
        maximumPeakHeapUsedBytes: Math.max(
          ...stages.map((stage) => stage.memory.peak.heapUsed),
        ),
        maximumPeakRssBytes: Math.max(
          ...stages.map((stage) => stage.memory.peak.rss),
        ),
      },
    };
    return {
      ...reportWithoutWarnings,
      warnings: capacityWarnings(reportWithoutWarnings),
    };
  } finally {
    if (server !== null) await server.close();
    await rm(dataDirectory, {force: true, recursive: true});
  }
}

async function measureCapacityLevels(
  server: ProfiledLocalServer,
  configuration: ServerCapacityConfig,
  first: Publication,
  second: Publication,
  index = 0,
  measured: readonly ServerCapacityReport["levels"][number][] = [],
): Promise<readonly ServerCapacityReport["levels"][number][]> {
  const concurrentUsers = configuration.concurrencyLevels[index];
  if (concurrentUsers === undefined) return measured;
  const browse = await measureStage(
    server,
    "browse",
    concurrentUsers,
    configuration.waves,
    {
      requestsPerJourney: 4,
      run: () => runBrowseJourney(
        server,
        first,
        second,
        configuration.browseFileBytes,
      ),
    },
  );
  await assertHealthy(server);
  const publishBytes = sizedDocument(
    configuration.publishFileBytes,
    `capacity-publish-${concurrentUsers}`,
  );
  const publish = await measureStage(
    server,
    "publish",
    concurrentUsers,
    configuration.waves,
    {
      requestsPerJourney: 3,
      run: (journeyIndex) => publishFile(server, publishBytes, {
        accessSetting: "public_link",
        kind: "new_artifact",
        name: `Capacity publication ${concurrentUsers}-${journeyIndex}`,
        tags: ["capacity", "capacity-publication"],
      }).then(() => undefined),
    },
  );
  await assertHealthy(server);
  return measureCapacityLevels(
    server,
    configuration,
    first,
    second,
    index + 1,
    [...measured, {browse, concurrentUsers, publish}],
  );
}

async function measureStage(
  server: ProfiledLocalServer,
  profile: "browse" | "publish",
  concurrentUsers: number,
  waves: number,
  operation: StageOperation,
): Promise<ServerCapacityStage> {
  const started = await server.control("capacity-stage-start");
  if (started.kind === "capacity-control-error") {
    throw new Error(started.message);
  }
  if (started.kind !== "capacity-stage-started") {
    throw new Error("The profiled server returned the wrong stage-start response.");
  }
  const journeyCount = concurrentUsers * waves;
  const latencies = Array.from<number>({length: journeyCount});
  const stageStartedAt = performance.now();
  const [operationResult] = await Promise.allSettled([
    runBounded(journeyCount, concurrentUsers, async (index) => {
      const journeyStartedAt = performance.now();
      await operation.run(index);
      latencies[index] = performance.now() - journeyStartedAt;
    }),
  ]);
  const totalMilliseconds = performance.now() - stageStartedAt;
  const finished = await server.control("capacity-stage-finish");
  if (operationResult?.status === "rejected") throw operationResult.reason;
  if (finished.kind === "capacity-control-error") {
    throw new Error(finished.message);
  }
  if (finished.kind !== "capacity-stage-finished") {
    throw new Error("The profiled server returned the wrong stage-finish response.");
  }
  const parsedLatencies = z.array(z.number()).length(journeyCount).parse(latencies);
  return {
    completedJourneys: journeyCount,
    concurrentUsers,
    eventLoop: roundedEventLoop(finished.eventLoop),
    garbageCollection:
      started.garbageCollection === "forced" && finished.garbageCollection === "forced"
        ? "forced"
        : "unavailable",
    journeyLatency: summarizeLatency(parsedLatencies),
    journeysPerSecond: round(journeyCount / (totalMilliseconds / 1_000), 2),
    memory: {
      peak: finished.memory.peak,
      peakRssDeltaBytes: finished.memory.peak.rss - finished.memory.started.rss,
      retainedHeapDeltaBytes:
        finished.memory.settled.heapUsed - finished.memory.started.heapUsed,
      settled: finished.memory.settled,
      started: finished.memory.started,
    },
    profile,
    serverCpu: {
      systemMilliseconds: round(finished.cpu.systemMilliseconds),
      userMilliseconds: round(finished.cpu.userMilliseconds),
    },
    totalMilliseconds: round(totalMilliseconds),
    totalRequests: journeyCount * operation.requestsPerJourney,
    waves,
  };
}

async function runBrowseJourney(
  server: ProfiledLocalServer,
  first: Publication,
  second: Publication,
  expectedBytes: number,
): Promise<void> {
  await streamExactVersion(server, second.links.version, expectedBytes);
  await listArtifacts(server);
  await compareVersions(server, first, second);
  await listArtifactsThroughMcp(server);
}

async function listArtifacts(server: ProfiledLocalServer): Promise<void> {
  const response = await fetch(
    `${server.baseUrl}/api/v1/artifacts?limit=100&tag=capacity`,
    {
      headers: {Authorization: `Bearer ${server.apiToken}`},
      signal: AbortSignal.timeout(requestTimeoutMilliseconds),
    },
  );
  requireStatus(response, 200, "artifact list");
  z.object({
    artifacts: z.array(z.object({artifact: z.object({id: z.string()})})).min(1).max(100),
    nextCursor: z.string().nullable(),
  }).parse(await response.json());
}

async function compareVersions(
  server: ProfiledLocalServer,
  first: Publication,
  second: Publication,
): Promise<void> {
  const query = new URLSearchParams({
    fromVersionId: first.version.id,
    toVersionId: second.version.id,
  });
  const response = await fetch(
    `${server.baseUrl}/api/v1/artifacts/${first.artifact.id}/comparisons?${query}`,
    {
      headers: {Authorization: `Bearer ${server.apiToken}`},
      signal: AbortSignal.timeout(requestTimeoutMilliseconds),
    },
  );
  requireStatus(response, 200, "artifact comparison");
  const comparison = z.object({
    changed: z.array(z.object({detail: z.unknown()})).min(1),
    from: z.object({id: z.literal(first.version.id)}),
    to: z.object({id: z.literal(second.version.id)}),
  }).parse(await response.json());
  if (comparison.changed.length < 1) {
    throw new Error("The capacity comparison did not report the changed file.");
  }
}

async function listArtifactsThroughMcp(
  server: ProfiledLocalServer,
): Promise<void> {
  const response = await fetch(`${server.baseUrl}/mcp`, {
    body: JSON.stringify({
      id: randomUUID(),
      jsonrpc: "2.0",
      method: "tools/call",
      params: {
        _meta: {
          [CLIENT_CAPABILITIES_META_KEY]: {},
          [CLIENT_INFO_META_KEY]: {
            name: "artifact-server-capacity-baseline",
            version: "1",
          },
          [PROTOCOL_VERSION_META_KEY]: mcpProtocolVersion,
        },
        arguments: {cursor: null, limit: 100, tag: "capacity"},
        name: "artifact_list",
      },
    }),
    headers: {
      Accept: "application/json, text/event-stream",
      Authorization: `Bearer ${server.apiToken}`,
      "Content-Type": "application/json",
      "MCP-Protocol-Version": mcpProtocolVersion,
      "Mcp-Method": "tools/call",
      "Mcp-Name": "artifact_list",
    },
    method: "POST",
    signal: AbortSignal.timeout(requestTimeoutMilliseconds),
  });
  requireStatus(response, 200, "MCP artifact_list");
  const result = z.object({
    result: z.object({
      isError: z.boolean().optional(),
      structuredContent: z.object({
        artifacts: z.array(z.object({id: z.string()}).loose()).min(1).max(100),
        nextCursor: z.string().nullable(),
      }),
    }).loose(),
  }).loose().parse(await response.json()).result;
  if (result.isError === true) {
    throw new Error("MCP artifact_list returned a tool error.");
  }
}

async function publishFile(
  server: ProfiledLocalServer,
  bytes: Uint8Array,
  target:
    | {
      readonly accessSetting: "account_required" | "public_link";
      readonly kind: "new_artifact";
      readonly name: string;
      readonly tags: readonly string[];
    }
    | {
      readonly artifactId: string;
      readonly expectedCurrentVersionId: string;
      readonly kind: "new_version";
    },
): Promise<Publication> {
  const uploadResponse = await fetch(`${server.baseUrl}/api/v1/uploads`, {
    body: JSON.stringify({
      entryPath: "index.html",
      files: [{
        mediaType: "text/html; charset=utf-8",
        path: "index.html",
        sha256: createHash("sha256").update(bytes).digest("hex"),
        size: bytes.byteLength,
      }],
    }),
    headers: {
      Authorization: `Bearer ${server.apiToken}`,
      "Content-Type": "application/json",
    },
    method: "POST",
    signal: AbortSignal.timeout(requestTimeoutMilliseconds),
  });
  requireStatus(uploadResponse, 201, "create upload plan");
  const upload = uploadPlanSchema.parse(await uploadResponse.json());
  const plannedFile = upload.files[0];
  if (plannedFile === undefined) {
    throw new Error("The capacity upload plan did not contain its file.");
  }
  const uploadFileResponse = await fetch(plannedFile.uploadUrl, {
    body: copiedArrayBuffer(bytes),
    headers: {Authorization: `Bearer ${server.apiToken}`},
    method: "PUT",
    signal: AbortSignal.timeout(requestTimeoutMilliseconds),
  });
  requireStatus(uploadFileResponse, 200, "upload staged file");
  await uploadFileResponse.arrayBuffer();
  const commitResponse = await fetch(upload.commitUrl, {
    body: JSON.stringify({target}),
    headers: {
      Authorization: `Bearer ${server.apiToken}`,
      "Content-Type": "application/json",
      "Idempotency-Key": randomUUID(),
    },
    method: "POST",
    signal: AbortSignal.timeout(requestTimeoutMilliseconds),
  });
  requireStatus(commitResponse, 201, "commit staged upload");
  return publicationSchema.parse(await commitResponse.json());
}

async function streamExactVersion(
  server: ProfiledLocalServer,
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
            reject(new Error(
              `A capacity content read returned ${incoming.statusCode ?? 500}.`,
            ));
            return;
          }
          resolve(bytes);
        });
      },
    );
    outgoing.setTimeout(requestTimeoutMilliseconds, () => {
      outgoing.destroy(new Error("A capacity content read timed out."));
    });
    outgoing.on("error", reject);
    outgoing.end();
  });
  if (receivedBytes !== expectedBytes) {
    throw new Error(
      `A capacity content read returned ${receivedBytes} bytes instead of ${expectedBytes}.`,
    );
  }
}

async function assertHealthy(server: ProfiledLocalServer): Promise<void> {
  const response = await fetch(`${server.baseUrl}/health`, {
    signal: AbortSignal.timeout(requestTimeoutMilliseconds),
  });
  requireStatus(response, 200, "health probe");
  await response.arrayBuffer();
}

async function startProfiledLocalServer(
  dataDirectory: string,
): Promise<ProfiledLocalServer> {
  const startupStartedAt = performance.now();
  const child = fork(
    profiledServerEntry,
    ["start", "--managed", "--data", dataDirectory, "--port", "0"],
    {
      cwd: repositoryRoot,
      env: {
        ...process.env,
        ARTIFACT_SERVER_REQUEST_LOG_SAMPLE_RATE: "0",
      },
      execArgv: ["--expose-gc"],
      stdio: ["ignore", "pipe", "pipe", "ipc"],
    },
  );
  const pid = child.pid;
  if (pid === undefined) {
    child.kill("SIGTERM");
    throw new Error("The profiled Artifact Server did not receive a process ID.");
  }
  let output = "";
  child.stdout?.setEncoding("utf8");
  child.stderr?.setEncoding("utf8");
  child.stdout?.on("data", (chunk: string) => {
    output = boundedOutput(output, chunk);
  });
  child.stderr?.on("data", (chunk: string) => {
    output = boundedOutput(output, chunk);
  });

  const pending = new Map<string, PendingControlRequest>();
  child.on("message", (input) => {
    const parsed = controlResponseSchema.safeParse(input);
    if (!parsed.success) return;
    const pendingRequest = pending.get(parsed.data.requestId);
    if (pendingRequest === undefined) return;
    pending.delete(parsed.data.requestId);
    clearTimeout(pendingRequest.timeout);
    pendingRequest.resolve(parsed.data);
  });
  const failPending = (message: string) => {
    for (const [requestId, pendingRequest] of pending) {
      pending.delete(requestId);
      clearTimeout(pendingRequest.timeout);
      pendingRequest.reject(new Error(message));
    }
  };
  child.once("exit", (code, signal) => {
    failPending(
      `The profiled Artifact Server exited with ${code ?? signal ?? "an unknown result"}. ${output}`,
    );
  });
  child.once("error", (cause) => {
    failPending(`The profiled Artifact Server failed: ${cause.message}`);
  });

  try {
    const record = await waitForServiceRecord(child, dataDirectory, () => output);
    const apiToken = await readLocalApiCredential(dataDirectory);
    const url = new URL(record.origin);
    const control = (
      kind: "capacity-stage-start" | "capacity-stage-finish",
    ): Promise<ControlResponse> => {
      const requestId = randomUUID();
      return new Promise<ControlResponse>((resolve, reject) => {
        const timeout = setTimeout(() => {
          pending.delete(requestId);
          reject(new Error(`The profiled server did not answer ${kind}.`));
        }, requestTimeoutMilliseconds);
        pending.set(requestId, {reject, resolve, timeout});
        child.send({kind, requestId}, (cause) => {
          if (cause === null) return;
          const pendingRequest = pending.get(requestId);
          if (pendingRequest === undefined) return;
          pending.delete(requestId);
          clearTimeout(pendingRequest.timeout);
          pendingRequest.reject(cause);
        });
      });
    };
    return {
      apiToken,
      baseUrl: record.origin,
      child,
      close: () => closeChild(child),
      control,
      dataDirectory,
      hostname: url.hostname,
      pid,
      port: Number(url.port),
      startupMilliseconds: round(performance.now() - startupStartedAt),
    };
  } catch (cause) {
    await closeChild(child);
    throw cause;
  }
}

async function waitForServiceRecord(
  child: ChildProcess,
  dataDirectory: string,
  output: () => string,
): Promise<{readonly origin: string}> {
  const deadline = performance.now() + serverStartupTimeoutMilliseconds;
  const inspect = async (): Promise<{readonly origin: string}> => {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`The profiled Artifact Server exited before readiness. ${output()}`);
    }
    const inspected = await inspectLocalServiceRecord(dataDirectory);
    if (inspected.state === "valid") return inspected.record;
    if (performance.now() >= deadline) {
      throw new Error(`The profiled Artifact Server did not become ready. ${output()}`);
    }
    await wait(20);
    return inspect();
  };
  return inspect();
}

async function closeChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exit = once(child, "exit").then(() => true);
  child.kill("SIGTERM");
  const graceful = await Promise.race([exit, wait(10_000).then(() => false)]);
  if (graceful) return;
  child.kill("SIGKILL");
  await Promise.race([exit, wait(5_000)]);
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
    Array.from({length: Math.min(count, concurrency)}, () => worker()),
  );
}

function summarizeLatency(samples: readonly number[]): CapacityLatencySummary {
  const sorted = samples.toSorted((left, right) => left - right);
  const total = sorted.reduce((sum, sample) => sum + sample, 0);
  return {
    count: sorted.length,
    maximumMilliseconds: round(sorted.at(-1) ?? 0),
    meanMilliseconds: round(total / sorted.length),
    minimumMilliseconds: round(sorted[0] ?? 0),
    p50Milliseconds: percentile(sorted, 50),
    p95Milliseconds: percentile(sorted, 95),
    p99Milliseconds: percentile(sorted, 99),
  };
}

function percentile(sorted: readonly number[], percentage: number): number {
  const index = Math.max(
    0,
    Math.ceil((percentage / 100) * sorted.length) - 1,
  );
  return round(sorted[index] ?? 0);
}

function capacityWarnings(
  report: Omit<ServerCapacityReport, "warnings">,
): readonly string[] {
  const warnings: string[] = [];
  const stages = report.levels.flatMap((level) => [level.browse, level.publish]);
  if (report.summary.finalRetainedHeapDeltaBytes > 67_108_864) {
    warnings.push(
      "Server live heap retained more than 64 MiB across the complete concurrency matrix.",
    );
  }
  if (report.summary.maximumPeakRssBytes > 536_870_912) {
    warnings.push(
      "Server peak RSS exceeded 512 MiB; do not size a production process below the measured workload without a provider-specific capacity run.",
    );
  }
  for (const stage of stages) {
    if (stage.memory.retainedHeapDeltaBytes > 67_108_864) {
      warnings.push(
        `${stage.profile} at concurrency ${stage.concurrentUsers} retained more than 64 MiB of heap.`,
      );
    }
    if (stage.memory.peakRssDeltaBytes > 268_435_456) {
      warnings.push(
        `${stage.profile} at concurrency ${stage.concurrentUsers} added more than 256 MiB of peak RSS.`,
      );
    }
    if (stage.eventLoop.maximumDelayMilliseconds > 1_000) {
      warnings.push(
        `${stage.profile} at concurrency ${stage.concurrentUsers} blocked the event loop for more than one second.`,
      );
    }
    if (stage.journeyLatency.p95Milliseconds > 15_000) {
      warnings.push(
        `${stage.profile} at concurrency ${stage.concurrentUsers} exceeded 15 seconds at p95.`,
      );
    }
  }
  return warnings;
}

async function environmentSummary(): Promise<ServerCapacityReport["environment"]> {
  const packageMetadata = packageMetadataSchema.parse(
    JSON.parse(await readFile(path.join(repositoryRoot, "package.json"), "utf8")),
  );
  return {
    availableParallelism: availableParallelism(),
    cpu: cpus()[0]?.model ?? "unknown",
    node: process.version,
    operatingSystem: release(),
    platform: platform(),
    productVersion: packageMetadata.version,
  };
}

function roundedEventLoop(
  eventLoop: z.infer<typeof stageFinishedSchema>["eventLoop"],
): z.infer<typeof stageFinishedSchema>["eventLoop"] {
  return {
    maximumDelayMilliseconds: round(eventLoop.maximumDelayMilliseconds),
    meanDelayMilliseconds: round(eventLoop.meanDelayMilliseconds),
    p95DelayMilliseconds: round(eventLoop.p95DelayMilliseconds),
    utilization: round(eventLoop.utilization, 4),
  };
}

function sizedDocument(bytes: number, label: string): Uint8Array {
  const prefix = `<!doctype html><meta charset=utf-8><title>${label}</title><pre>`;
  const suffix = "</pre>";
  const fixedBytes = Buffer.byteLength(prefix + suffix);
  if (fixedBytes > bytes) {
    throw new Error("The capacity payload is too small for its document.");
  }
  return new TextEncoder().encode(
    prefix + "x".repeat(bytes - fixedBytes) + suffix,
  );
}

function copiedArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

function requireStatus(
  response: Response,
  expected: number,
  operation: string,
): void {
  if (response.status !== expected) {
    throw new Error(
      `The capacity ${operation} returned ${response.status} instead of ${expected}.`,
    );
  }
}

function boundedOutput(current: string, chunk: string): string {
  return `${current}${chunk}`.slice(-16_384);
}

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function round(value: number, digits = 2): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}
