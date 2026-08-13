import {spawn, type ChildProcessWithoutNullStreams} from "node:child_process";
import {randomUUID} from "node:crypto";
import {
  mkdir,
  mkdtemp,
  rm,
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
import {performance} from "node:perf_hooks";

import * as NodeFileSystem from "@effect/platform-node-shared/NodeFileSystem";
import {
  CreateBucketCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import {Effect, Redacted} from "effect";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import {z} from "zod";

import {
  type FilePublicationResult,
  publishPath,
} from "../src/client/file-publication-client.js";

const repositoryRoot = path.resolve(import.meta.dirname, "..");
const sharedCli = path.join(repositoryRoot, "dist/cli/main.js");
const region = "us-east-1";
const maximumMeasuredPublishBytes = 67_108_864;
const maximumMeasuredReadBytes = 134_217_728;

const sharedBaselineConfigSchema = z.object({
  concurrentFileBytes: z.number().int().min(1_024).max(1_048_576),
  concurrentPublications: z.number().int().min(2).max(100),
  directoryFileBytes: z.number().int().min(1_024).max(65_536),
  directoryFiles: z.number().int().min(2).max(128),
  fileIterations: z.number().int().min(1).max(5),
  listReads: z.number().int().min(1).max(100),
  operationConcurrency: z.number().int().min(1).max(16),
  reads: z.number().int().min(1).max(1_000),
  singleFileBytes: z.number().int().min(1_024).max(8_388_608),
  warmupPublications: z.number().int().min(1).max(10),
}).superRefine((configuration, context) => {
  const publicationBytes = (
    configuration.concurrentFileBytes * configuration.concurrentPublications
    + configuration.directoryFileBytes * configuration.directoryFiles
      * configuration.fileIterations
    + configuration.singleFileBytes * configuration.fileIterations
  );
  if (publicationBytes > maximumMeasuredPublishBytes) {
    context.addIssue({
      code: "custom",
      message: "The measured shared publication workload must stay at or below 64 MiB.",
      path: ["concurrentPublications"],
    });
  }
  if (configuration.concurrentFileBytes * configuration.reads > maximumMeasuredReadBytes) {
    context.addIssue({
      code: "custom",
      message: "The measured shared read workload must stay at or below 128 MiB.",
      path: ["reads"],
    });
  }
});

const environmentSchema = z.object({
  ARTIFACT_SERVER_TEST_DATABASE_URL: z.url(),
  ARTIFACT_SERVER_TEST_MINIO_IMAGE: z.string().min(1),
  ARTIFACT_SERVER_TEST_POSTGRES_IMAGE: z.string().min(1),
  ARTIFACT_SERVER_TEST_PROVIDER_READY_MILLISECONDS: z.coerce.number().int().nonnegative(),
  ARTIFACT_SERVER_TEST_S3_ACCESS_KEY: z.string().min(1),
  ARTIFACT_SERVER_TEST_S3_ENDPOINT: z.url(),
  ARTIFACT_SERVER_TEST_S3_SECRET_KEY: z.string().min(1),
});

const artifactListSchema = z.object({
  artifacts: z.array(z.object({
    artifact: z.object({id: z.string()}),
  })),
});

/** Safe workload configuration for the shared Postgres and S3 baseline. */
export type SharedBaselineConfig = z.infer<typeof sharedBaselineConfigSchema>;

/** Default diagnostic workload for one developer machine. */
export const defaultSharedBaselineConfig: SharedBaselineConfig = {
  concurrentFileBytes: 16_384,
  concurrentPublications: 16,
  directoryFileBytes: 4_096,
  directoryFiles: 48,
  fileIterations: 3,
  listReads: 16,
  operationConcurrency: 4,
  reads: 80,
  singleFileBytes: 2_097_152,
  warmupPublications: 2,
};

/** Latency distribution for one measured operation. */
export interface SharedLatencySummary {
  readonly count: number;
  readonly maximumMilliseconds: number;
  readonly meanMilliseconds: number;
  readonly minimumMilliseconds: number;
  readonly p50Milliseconds: number;
  readonly p95Milliseconds: number;
  readonly p99Milliseconds: number;
}

/** Latency and throughput for one bounded phase. */
export interface SharedOperationSummary {
  readonly latency: SharedLatencySummary;
  readonly operationsPerSecond: number;
  readonly totalMilliseconds: number;
}

/** Durable diagnostic evidence from one real shared-runtime baseline. */
export interface SharedBaselineReport {
  readonly artifactList: SharedOperationSummary;
  readonly checks: {
    readonly compiledProcesses: "passed";
    readonly crossProcessDirectoryRead: "passed";
    readonly crossProcessSingleFileRead: "passed";
    readonly healthEndpoints: "passed";
    readonly processReplacement: "passed";
    readonly providerBackedPublication: "passed";
  };
  readonly concurrentPublish: SharedOperationSummary;
  readonly concurrentRead: SharedOperationSummary;
  readonly configuration: SharedBaselineConfig;
  readonly environment: {
    readonly availableParallelism: number;
    readonly cpu: string;
    readonly minioImage: string;
    readonly node: string;
    readonly operatingSystem: string;
    readonly platform: NodeJS.Platform;
    readonly postgresImage: string;
  };
  readonly fileClient: {
    readonly directory: SharedOperationSummary;
    readonly singleFile: SharedOperationSummary;
  };
  readonly generatedAt: string;
  readonly providerReadyMilliseconds: number;
  readonly serverReadyMilliseconds: {
    readonly initialProcesses: readonly [number, number];
    readonly replacementProcess: number;
  };
  readonly totalHarnessMilliseconds: number;
  readonly warnings: readonly string[];
}

interface SharedEnvironment {
  readonly accessKey: string;
  readonly databaseUrl: string;
  readonly minioImage: string;
  readonly postgresImage: string;
  readonly providerReadyMilliseconds: number;
  readonly s3Endpoint: string;
  readonly secretKey: string;
}

interface SharedProcess {
  readonly baseUrl: string;
  readonly child: ChildProcessWithoutNullStreams;
  readonly readyMilliseconds: number;
  stop(): Promise<void>;
}

interface MeasuredRecord<Value> {
  readonly index: number;
  readonly latencyMilliseconds: number;
  readonly value: Value;
}

interface MeasuredPhase<Value> {
  readonly results: readonly Value[];
  readonly summary: SharedOperationSummary;
}

interface SharedFixtures {
  readonly concurrentFilePath: string;
  readonly directoryPath: string;
  readonly lastDirectoryAssetPath: string;
  readonly root: string;
  readonly singleFilePath: string;
}

/** Run the bounded shared-runtime baseline against disposable configured providers. */
export async function runSharedBaseline(
  input: SharedBaselineConfig,
): Promise<SharedBaselineReport> {
  const configuration = sharedBaselineConfigSchema.parse(input);
  const environment = readSharedEnvironment();
  const installationId = `performance-${randomUUID()}`;
  const apiToken = `shared-performance-${randomUUID()}-${randomUUID()}`;
  const bucket = `artifact-perf-${randomUUID().replaceAll("-", "").slice(0, 24)}`;
  const s3Client = createS3Client(environment);
  const runningProcesses = new Set<SharedProcess>();
  const fixtures = await createFixtures(configuration);
  const totalStartedAt = performance.now();

  try {
    await s3Client.send(new CreateBucketCommand({Bucket: bucket}));
    const [first, second] = await Promise.all([
      startSharedProcess(environment, {apiToken, bucket, installationId}),
      startSharedProcess(environment, {apiToken, bucket, installationId}),
    ]);
    runningProcesses.add(first);
    runningProcesses.add(second);
    await Promise.all([assertHealthy(first), assertHealthy(second)]);
    const initialProcesses = [first, second] as const;

    await runMeasured(
      configuration.warmupPublications,
      1,
      (index) => publishFile(
        initialProcesses[index % initialProcesses.length] ?? first,
        apiToken,
        fixtures.concurrentFilePath,
        `Shared warmup ${index}`,
      ),
    );

    const singleFiles = await runMeasured(
      configuration.fileIterations,
      1,
      async (index) => {
        const writer = initialProcesses[index % initialProcesses.length] ?? first;
        const reader = writer === first ? second : first;
        const publication = await publishFile(
          writer,
          apiToken,
          fixtures.singleFilePath,
          `Shared single file ${index}`,
        );
        await assertExactContent(
          reader,
          publication.links.version.toString(),
          configuration.singleFileBytes,
        );
        return publication;
      },
    );

    const directories = await runMeasured(
      configuration.fileIterations,
      1,
      async (index) => {
        const writer = initialProcesses[index % initialProcesses.length] ?? first;
        const reader = writer === first ? second : first;
        const publication = await publishFile(
          writer,
          apiToken,
          fixtures.directoryPath,
          `Shared directory ${index}`,
        );
        const assetUrl = new URL(
          fixtures.lastDirectoryAssetPath,
          publication.links.version,
        );
        await assertExactContent(
          reader,
          assetUrl.toString(),
          configuration.directoryFileBytes,
        );
        return publication;
      },
    );

    const publications = await runMeasured(
      configuration.concurrentPublications,
      configuration.operationConcurrency,
      (index) => publishFile(
        initialProcesses[index % initialProcesses.length] ?? first,
        apiToken,
        fixtures.concurrentFilePath,
        `Shared concurrent publication ${index}`,
      ),
    );

    const reads = await runMeasured(
      configuration.reads,
      Math.min(configuration.operationConcurrency * 2, 16),
      async (index) => {
        const publication = publications.results[index % publications.results.length];
        if (publication === undefined) {
          throw new Error("The shared read phase could not select a publication.");
        }
        const reader = initialProcesses[(index + 1) % initialProcesses.length] ?? second;
        await assertExactContent(
          reader,
          publication.links.version.toString(),
          configuration.concurrentFileBytes,
        );
      },
    );

    const artifactLists = await runMeasured(
      configuration.listReads,
      configuration.operationConcurrency,
      async (index) => {
        const server = initialProcesses[index % initialProcesses.length] ?? first;
        await assertArtifactList(server, apiToken, publications.results[0]);
      },
    );

    await second.stop();
    runningProcesses.delete(second);
    const replacement = await startSharedProcess(
      environment,
      {apiToken, bucket, installationId},
    );
    runningProcesses.add(replacement);
    await assertHealthy(replacement);
    const restartAnchor = singleFiles.results[0] ?? directories.results[0];
    if (restartAnchor === undefined) {
      throw new Error("The shared baseline did not produce a replacement-read anchor.");
    }
    await assertExactContent(
      replacement,
      restartAnchor.links.version.toString(),
      configuration.singleFileBytes,
    );

    const reportWithoutWarnings = {
      artifactList: artifactLists.summary,
      checks: {
        compiledProcesses: "passed" as const,
        crossProcessDirectoryRead: "passed" as const,
        crossProcessSingleFileRead: "passed" as const,
        healthEndpoints: "passed" as const,
        processReplacement: "passed" as const,
        providerBackedPublication: "passed" as const,
      },
      concurrentPublish: publications.summary,
      concurrentRead: reads.summary,
      configuration,
      environment: environmentSummary(environment),
      fileClient: {
        directory: directories.summary,
        singleFile: singleFiles.summary,
      },
      generatedAt: new Date().toISOString(),
      providerReadyMilliseconds: environment.providerReadyMilliseconds,
      serverReadyMilliseconds: {
        initialProcesses: [
          first.readyMilliseconds,
          second.readyMilliseconds,
        ] as const,
        replacementProcess: replacement.readyMilliseconds,
      },
      totalHarnessMilliseconds: round(performance.now() - totalStartedAt),
    };
    return {
      ...reportWithoutWarnings,
      warnings: baselineWarnings(reportWithoutWarnings),
    };
  } finally {
    await Promise.all([...runningProcesses].map((server) => server.stop()));
    s3Client.destroy();
    await rm(fixtures.root, {force: true, recursive: true});
  }
}

function readSharedEnvironment(): SharedEnvironment {
  const parsed = environmentSchema.safeParse(process.env);
  if (!parsed.success) {
    throw new Error(
      "Run the shared performance baseline through pnpm perf:shared-baseline.",
    );
  }
  return {
    accessKey: parsed.data.ARTIFACT_SERVER_TEST_S3_ACCESS_KEY,
    databaseUrl: parsed.data.ARTIFACT_SERVER_TEST_DATABASE_URL,
    minioImage: parsed.data.ARTIFACT_SERVER_TEST_MINIO_IMAGE,
    postgresImage: parsed.data.ARTIFACT_SERVER_TEST_POSTGRES_IMAGE,
    providerReadyMilliseconds:
      parsed.data.ARTIFACT_SERVER_TEST_PROVIDER_READY_MILLISECONDS,
    s3Endpoint: parsed.data.ARTIFACT_SERVER_TEST_S3_ENDPOINT,
    secretKey: parsed.data.ARTIFACT_SERVER_TEST_S3_SECRET_KEY,
  };
}

function createS3Client(environment: SharedEnvironment): S3Client {
  return new S3Client({
    credentials: {
      accessKeyId: environment.accessKey,
      secretAccessKey: environment.secretKey,
    },
    endpoint: environment.s3Endpoint,
    forcePathStyle: true,
    region,
  });
}

async function createFixtures(
  configuration: SharedBaselineConfig,
): Promise<SharedFixtures> {
  const root = await mkdtemp(path.join(tmpdir(), "artifact-shared-performance-"));
  const directoryPath = path.join(root, "site");
  const assetDirectory = path.join(directoryPath, "assets");
  await mkdir(assetDirectory, {recursive: true});
  await writeFile(
    path.join(directoryPath, "index.html"),
    sizedBuffer(configuration.directoryFileBytes, "shared-directory-entry"),
  );
  const assetCount = configuration.directoryFiles - 1;
  await Promise.all(Array.from({length: assetCount}, async (_, index) => {
    const assetName = `asset-${index.toString().padStart(3, "0")}.bin`;
    await writeFile(
      path.join(assetDirectory, assetName),
      sizedBuffer(configuration.directoryFileBytes, assetName),
    );
  }));
  const lastAssetIndex = assetCount - 1;
  const lastDirectoryAssetPath =
    `assets/asset-${lastAssetIndex.toString().padStart(3, "0")}.bin`;
  const singleFilePath = path.join(root, "single-file.bin");
  const concurrentFilePath = path.join(root, "concurrent-file.html");
  await Promise.all([
    writeFile(
      singleFilePath,
      sizedBuffer(configuration.singleFileBytes, "shared-single-file"),
    ),
    writeFile(
      concurrentFilePath,
      sizedBuffer(configuration.concurrentFileBytes, "shared-concurrent-file"),
    ),
  ]);
  return {
    concurrentFilePath,
    directoryPath,
    lastDirectoryAssetPath,
    root,
    singleFilePath,
  };
}

function startSharedProcess(
  environment: SharedEnvironment,
  identity: {
    readonly apiToken: string;
    readonly bucket: string;
    readonly installationId: string;
  },
): Promise<SharedProcess> {
  const startedAt = performance.now();
  const child = spawn(
    process.execPath,
    [sharedCli, "start-shared", "--host", "127.0.0.1", "--port", "0"],
    {
      cwd: repositoryRoot,
      env: {
        ...process.env,
        ARTIFACT_SERVER_API_TOKEN: identity.apiToken,
        ARTIFACT_SERVER_BOOTSTRAP_ADMIN_EMAIL: "performance@example.test",
        ARTIFACT_SERVER_CONTENT_DOMAIN: "localhost",
        ARTIFACT_SERVER_DATABASE_URL: environment.databaseUrl,
        ARTIFACT_SERVER_INSTALLATION_ID: identity.installationId,
        ARTIFACT_SERVER_S3_ACCESS_KEY_ID: environment.accessKey,
        ARTIFACT_SERVER_S3_BUCKET: identity.bucket,
        ARTIFACT_SERVER_S3_ENDPOINT: environment.s3Endpoint,
        ARTIFACT_SERVER_S3_FORCE_PATH_STYLE: "true",
        ARTIFACT_SERVER_S3_REGION: region,
        ARTIFACT_SERVER_S3_SECRET_ACCESS_KEY: environment.secretKey,
      },
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  return waitForSharedProcess(child, startedAt);
}

function waitForSharedProcess(
  child: ChildProcessWithoutNullStreams,
  startedAt: number,
): Promise<SharedProcess> {
  return new Promise((resolve, reject) => {
    let output = "";
    const timeout = setTimeout(() => {
      cleanup();
      child.kill("SIGTERM");
      reject(new Error("A shared process did not become ready within 20 seconds."));
    }, 20_000);
    const receive = (chunk: Buffer) => {
      output += chunk.toString("utf8");
      const match = /Shared Artifact Server: (http:\/\/127\.0\.0\.1:\d+)/u.exec(
        output,
      );
      const baseUrl = match?.[1];
      if (baseUrl === undefined) return;
      cleanup();
      child.stdout.resume();
      child.stderr.resume();
      let stopped = false;
      resolve({
        baseUrl,
        child,
        readyMilliseconds: round(performance.now() - startedAt),
        stop: async () => {
          if (stopped) return;
          stopped = true;
          await stopChild(child);
        },
      });
    };
    const exit = () => {
      cleanup();
      reject(new Error("A shared process exited before readiness."));
    };
    const cleanup = () => {
      clearTimeout(timeout);
      child.stdout.off("data", receive);
      child.stderr.off("data", receive);
      child.off("exit", exit);
    };
    child.stdout.on("data", receive);
    child.stderr.on("data", receive);
    child.once("exit", exit);
  });
}

async function stopChild(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise<void>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", () => resolve());
  });
  child.kill("SIGTERM");
  await exited;
}

async function assertHealthy(server: SharedProcess): Promise<void> {
  const response = await fetch(`${server.baseUrl}/health`);
  if (response.status !== 200) {
    throw new Error(`A shared health endpoint returned ${response.status}.`);
  }
}

function publishFile(
  server: SharedProcess,
  apiToken: string,
  inputPath: string,
  name: string,
): Promise<FilePublicationResult> {
  return Effect.runPromise(
    publishPath(
      {
        apiToken: Redacted.make(apiToken, {label: "shared-performance-token"}),
        serverOrigin: server.baseUrl,
      },
      {
        idempotencyKey: randomUUID(),
        inputPath,
        target: {
          accessSetting: "public_link",
          kind: "new_artifact",
          name,
          tags: ["performance", "shared-runtime"],
        },
      },
    ).pipe(
      Effect.provide(FetchHttpClient.layer),
      Effect.provide(NodeFileSystem.layer),
    ),
  );
}

async function assertArtifactList(
  server: SharedProcess,
  apiToken: string,
  expected: FilePublicationResult | undefined,
): Promise<void> {
  if (expected === undefined) {
    throw new Error("The shared list phase did not receive an expected artifact.");
  }
  const response = await fetch(`${server.baseUrl}/api/v1/artifacts?limit=50`, {
    headers: {Authorization: `Bearer ${apiToken}`},
  });
  if (response.status !== 200) {
    throw new Error(`A shared artifact list returned ${response.status}.`);
  }
  const body = artifactListSchema.parse(await response.json());
  if (!body.artifacts.some(({artifact}) => artifact.id === expected.artifact.id)) {
    throw new Error("A shared artifact list omitted a cross-process publication.");
  }
}

function assertExactContent(
  server: SharedProcess,
  versionUrl: string,
  expectedBytes: number,
): Promise<void> {
  const target = new URL(versionUrl);
  const serverUrl = new URL(server.baseUrl);
  return new Promise((resolve, reject) => {
    const outgoing = request(
      {
        headers: {Host: `${target.hostname}:${serverUrl.port}`},
        hostname: serverUrl.hostname,
        method: "GET",
        path: `${target.pathname}${target.search}`,
        port: serverUrl.port,
      },
      (incoming) => {
        let receivedBytes = 0;
        incoming.on("data", (chunk: Buffer) => {
          receivedBytes += chunk.byteLength;
        });
        incoming.on("end", () => {
          if (incoming.statusCode !== 200) {
            reject(new Error(
              `A shared version read returned ${incoming.statusCode ?? 500}.`,
            ));
            return;
          }
          if (receivedBytes !== expectedBytes) {
            reject(new Error(
              `A shared version returned ${receivedBytes} bytes instead of ${expectedBytes}.`,
            ));
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

async function runMeasured<Value>(
  count: number,
  concurrency: number,
  operation: (index: number) => Promise<Value>,
): Promise<MeasuredPhase<Value>> {
  let nextIndex = 0;
  const phaseStartedAt = performance.now();
  const worker = async (
    records: MeasuredRecord<Value>[] = [],
  ): Promise<readonly MeasuredRecord<Value>[]> => {
    if (nextIndex >= count) return records;
    const index = nextIndex;
    nextIndex += 1;
    const startedAt = performance.now();
    const value = await operation(index);
    records.push({
      index,
      latencyMilliseconds: performance.now() - startedAt,
      value,
    });
    return worker(records);
  };
  const records = (await Promise.all(
    Array.from({length: Math.min(count, concurrency)}, worker),
  )).flat().toSorted((left, right) => left.index - right.index);
  const totalMilliseconds = performance.now() - phaseStartedAt;
  if (records.length !== count) {
    throw new Error(`A measured phase completed ${records.length} of ${count} operations.`);
  }
  return {
    results: records.map(({value}) => value),
    summary: summarizeOperations(
      records.map(({latencyMilliseconds}) => latencyMilliseconds),
      totalMilliseconds,
    ),
  };
}

function summarizeOperations(
  samples: readonly number[],
  totalMilliseconds: number,
): SharedOperationSummary {
  const sorted = samples.toSorted((left, right) => left - right);
  const first = sorted[0];
  const last = sorted.at(-1);
  if (first === undefined || last === undefined) {
    throw new Error("A shared operation summary requires at least one sample.");
  }
  const mean = sorted.reduce((sum, sample) => sum + sample, 0) / sorted.length;
  return {
    latency: {
      count: sorted.length,
      maximumMilliseconds: round(last),
      meanMilliseconds: round(mean),
      minimumMilliseconds: round(first),
      p50Milliseconds: round(percentile(sorted, 50)),
      p95Milliseconds: round(percentile(sorted, 95)),
      p99Milliseconds: round(percentile(sorted, 99)),
    },
    operationsPerSecond: round(samples.length / (totalMilliseconds / 1_000)),
    totalMilliseconds: round(totalMilliseconds),
  };
}

function percentile(sorted: readonly number[], requested: number): number {
  const index = Math.max(0, Math.ceil((requested / 100) * sorted.length) - 1);
  const value = sorted[index];
  if (value === undefined) {
    throw new Error("A shared percentile requires a populated sample.");
  }
  return value;
}

function sizedBuffer(bytes: number, label: string): Buffer {
  const buffer = Buffer.alloc(bytes, 0x78);
  buffer.write(label, 0, "utf8");
  return buffer;
}

function environmentSummary(
  environment: SharedEnvironment,
): SharedBaselineReport["environment"] {
  return {
    availableParallelism: availableParallelism(),
    cpu: cpus()[0]?.model ?? "unreported",
    minioImage: environment.minioImage,
    node: process.version,
    operatingSystem: `${platform()} ${release()}`,
    platform: process.platform,
    postgresImage: environment.postgresImage,
  };
}

function baselineWarnings(report: {
  readonly artifactList: SharedOperationSummary;
  readonly concurrentPublish: SharedOperationSummary;
  readonly concurrentRead: SharedOperationSummary;
  readonly fileClient: SharedBaselineReport["fileClient"];
  readonly serverReadyMilliseconds: SharedBaselineReport["serverReadyMilliseconds"];
}): readonly string[] {
  const warnings: string[] = [];
  if (report.artifactList.latency.p95Milliseconds > 250) {
    warnings.push("Artifact-list p95 exceeded the shared investigation threshold of 250 ms.");
  }
  if (report.concurrentPublish.latency.p95Milliseconds > 1_000) {
    warnings.push("Concurrent publication p95 exceeded the shared investigation threshold of 1,000 ms.");
  }
  if (report.concurrentRead.latency.p95Milliseconds > 250) {
    warnings.push("Concurrent content-read p95 exceeded the shared investigation threshold of 250 ms.");
  }
  if (report.fileClient.directory.latency.p95Milliseconds > 10_000) {
    warnings.push("Shared directory publication p95 exceeded 10,000 ms.");
  }
  if (report.fileClient.singleFile.latency.p95Milliseconds > 5_000) {
    warnings.push("Shared single-file publication p95 exceeded 5,000 ms.");
  }
  const startupTimes = [
    ...report.serverReadyMilliseconds.initialProcesses,
    report.serverReadyMilliseconds.replacementProcess,
  ];
  if (Math.max(...startupTimes) > 10_000) {
    warnings.push("A compiled shared process took more than 10,000 ms to become ready.");
  }
  return warnings;
}

function round(value: number, places = 3): number {
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
}
