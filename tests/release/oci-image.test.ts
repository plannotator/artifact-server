import {execFile} from "node:child_process";
import {randomBytes} from "node:crypto";
import {mkdtemp, readFile, rm, writeFile} from "node:fs/promises";
import {request} from "node:http";
import {tmpdir} from "node:os";
import path from "node:path";

import {CreateBucketCommand, S3Client} from "@aws-sdk/client-s3";
import {afterEach, describe, expect, test} from "vitest";
import {z} from "zod";

const repositoryRoot = path.resolve(import.meta.dirname, "../..");
const apiToken = "oci-api-token-abcdefghijklmnopqrstuvwxyz0123456789";
const browserToken = "oci-browser-token-abcdefghijklmnopqrstuvwxyz012345";
const applicationOrigin = "https://artifacts.example.com";
const contentDomain = "content.example.net";
const sensitiveValues = new Set([apiToken, browserToken]);
const runtimeResources = {
  containers: new Set<string>(),
  directories: new Set<string>(),
  networks: new Set<string>(),
  volumes: new Set<string>(),
};

const imageManifestSchema = z.object({
  archive: z.string().endsWith(".oci.tar"),
  archiveSha256: z.string().regex(/^[a-f0-9]{64}$/u),
  archiveSizeBytes: z.number().int().positive(),
  attestations: z.number().int().min(2),
  attestationPredicates: z.tuple([
    z.literal("https://spdx.dev/Document"),
    z.literal("https://slsa.dev/provenance/v1"),
  ]),
  imageIndexDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/u),
  platforms: z.array(z.object({
    architecture: z.enum(["amd64", "arm64"]),
    configDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/u),
    kind: z.literal("image"),
    manifestDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/u),
    operatingSystem: z.literal("linux"),
  })).length(2),
  product: z.literal("artifact-server"),
  revision: z.string().regex(/^[a-f0-9]{40}$/u),
  schemaVersion: z.literal(1),
  sourceTreeClean: z.boolean(),
  version: z.string().min(1),
});
const initializationSchema = z.object({
  bootstrapCredential: z.string().min(32),
  installationId: z.string().startsWith("inst_"),
});
const publicationSchema = z.object({
  artifact: z.object({id: z.string(), name: z.string()}),
  links: z.object({artifact: z.url(), version: z.url()}),
  version: z.object({id: z.string(), number: z.number().int().positive()}),
});
const supportManifestSchema = z.object({
  adapters: z.object({
    database: z.enum(["postgres", "sqlite"]),
    objectStorage: z.enum(["filesystem", "s3"]),
  }),
  imageRevision: z.string().regex(/^[a-f0-9]{40}$/u),
  installationId: z.string(),
  product: z.literal("artifact-server"),
  providers: z.object({status: z.literal("ready")}),
});
const runtimeMeasurementSchema = z.object({
  concurrentReads: z.number().int().positive(),
  providerStartupMilliseconds: z.number().nonnegative().optional(),
  readMilliseconds: z.number().nonnegative(),
  startupMilliseconds: z.number().nonnegative(),
});
const runtimeBaselineSchema = z.object({
  compact: runtimeMeasurementSchema.optional(),
  externalStorage: runtimeMeasurementSchema.optional(),
  measuredAt: z.string().optional(),
  node: z.string().optional(),
  platform: z.string().optional(),
});
type RuntimeMeasurement = z.infer<typeof runtimeMeasurementSchema>;

afterEach(async () => {
  await Promise.all([...runtimeResources.containers].map(removeContainer));
  await Promise.all([...runtimeResources.volumes].map(removeVolume));
  await Promise.all([...runtimeResources.networks].map(removeNetwork));
  await Promise.all([...runtimeResources.directories].map((directory) =>
    rm(directory, {force: true, recursive: true})
  ));
});

describe.sequential("production OCI image", () => {
  test("OCI foundation: the attested release runs as its fixed user on AMD64 and ARM64", async () => {
    const environment = ociEnvironment();
    const manifest = imageManifestSchema.parse(JSON.parse(
      await readFile(environment.manifestPath, "utf8"),
    ));
    expect(path.basename(environment.archivePath)).toBe(manifest.archive);
    expect(manifest.revision).toBe(environment.revision);
    expect(manifest.platforms.map(({architecture}) => architecture).toSorted())
      .toEqual(["amd64", "arm64"]);
    const loadedIndexId = (await docker([
      "image", "inspect", "--format", "{{.Id}}", environment.arm64Image,
    ])).stdout.trim();
    expect(loadedIndexId).toBe(manifest.imageIndexDigest);

    const runtimes = [
      {architecture: "arm64" as const, image: environment.arm64Image},
      {architecture: "amd64" as const, image: environment.amd64Image},
    ];
    await Promise.all(runtimes.map((runtime) => verifyArchitectureRuntime({
      expectedPlatform: manifest.platforms.find(
        ({architecture}) => architecture === runtime.architecture,
      ),
      image: runtime.image,
      platform: runtime.architecture,
      version: manifest.version,
    })));
  });

  test("OCI foundation: compact mode initializes, publishes, replaces, and stops cleanly", async () => {
    const environment = ociEnvironment();
    const nameSuffix = resourceSuffix();
    const volume = await createVolume(`artifact-server-oci-compact-${nameSuffix}`);
    const network = await createNetwork(`artifact-server-oci-compact-${nameSuffix}`);
    const dataRoot = "/var/lib/artifact-server";
    const dataDirectory = `${dataRoot}/data`;
    const initResult = await docker([
      "run", ...hardenedRunArguments("arm64"),
      "--volume", `${volume}:${dataRoot}`,
      environment.arm64Image,
      "init", "--admin-email", "admin@example.test", "--data", dataDirectory,
    ]);
    const initialization = initializationSchema.parse(JSON.parse(initResult.stdout));
    const storedApiToken = (await docker([
      "run", ...hardenedRunArguments("arm64"),
      "--volume", `${volume}:${dataRoot}:ro`,
      "--entrypoint", "/bin/sh",
      environment.arm64Image,
      "-c", `cat ${dataDirectory}/secrets/api-token`,
    ])).stdout.trim();
    expect(storedApiToken).toHaveLength(43);
    registerSensitiveValue(storedApiToken);

    const firstName = `artifact-server-oci-compact-first-${nameSuffix}`;
    const firstStartedAt = performance.now();
    const firstPort = await startCompactContainer({
      containerName: firstName,
      environment,
      network,
      volume,
    });
    const firstStartupMilliseconds = performance.now() - firstStartedAt;
    const publication = await publishFixture({
      apiToken: storedApiToken,
      containerImage: environment.arm64Image,
      network,
      serverOrigin: `http://${firstName}:8787`,
      text: "compact OCI bytes\n",
    });
    expect(publication.artifact.name).toBe("proof.txt");
    expect(await fetchContent(publication.links.version, firstPort))
      .toBe("compact OCI bytes\n");
    const firstReads = await boundedReadProbe(publication.links.version, firstPort);
    expect((await docker(["diff", firstName])).stdout.trim()).toBe("");
    expect(await stopContainer(firstName)).toBe(0);

    const secondName = `artifact-server-oci-compact-second-${nameSuffix}`;
    const secondPort = await startCompactContainer({
      containerName: secondName,
      environment,
      network,
      volume,
    });
    expect(await fetchContent(publication.links.version, secondPort))
      .toBe("compact OCI bytes\n");
    expect(await stopContainer(secondName)).toBe(0);

    const support = await runCompactSupportManifest({
      environment,
      volume,
    });
    expect(support).toMatchObject({
      adapters: {database: "sqlite", objectStorage: "filesystem"},
      imageRevision: environment.revision,
      installationId: initialization.installationId,
    });
    expect(JSON.stringify(support)).not.toContain(storedApiToken);
    expect(JSON.stringify(support)).not.toContain(initialization.bootstrapCredential);

    await recordRuntimeBaseline("compact", {
      concurrentReads: firstReads.count,
      readMilliseconds: firstReads.milliseconds,
      startupMilliseconds: firstStartupMilliseconds,
    });
  });

  test("OCI foundation: external-storage mode migrates, publishes, and replaces without local state", async () => {
    const environment = ociEnvironment();
    const providers = providerEnvironment();
    const nameSuffix = resourceSuffix();
    const bucket = `artifact-server-oci-${nameSuffix}`;
    const installationId = `oci-external-${nameSuffix}`;
    const s3Client = new S3Client({
      credentials: {
        accessKeyId: providers.accessKey,
        secretAccessKey: providers.secretKey,
      },
      endpoint: providers.hostS3Endpoint,
      forcePathStyle: true,
      region: "us-east-1",
    });
    try {
      await s3Client.send(new CreateBucketCommand({Bucket: bucket}));
    } finally {
      s3Client.destroy();
    }

    const externalEnvironment = externalRuntimeEnvironment({
      bucket,
      installationId,
      providers,
    });
    await docker([
      "run", ...hardenedRunArguments("arm64"),
      "--network", providers.dockerNetwork,
      ...containerEnvironmentArguments(externalEnvironment),
      environment.arm64Image,
      "migrate", "apply",
    ], externalEnvironment);

    const firstName = `artifact-server-oci-external-first-${nameSuffix}`;
    const firstStartedAt = performance.now();
    const firstPort = await startExternalContainer({
      containerName: firstName,
      environment,
      externalEnvironment,
      network: providers.dockerNetwork,
    });
    const firstStartupMilliseconds = performance.now() - firstStartedAt;
    const publication = await publishFixture({
      apiToken,
      containerImage: environment.arm64Image,
      network: providers.dockerNetwork,
      serverOrigin: `http://${firstName}:8787`,
      text: "external OCI bytes\n",
    });
    expect(await fetchContent(publication.links.version, firstPort))
      .toBe("external OCI bytes\n");
    const firstReads = await boundedReadProbe(publication.links.version, firstPort);
    expect((await docker(["diff", firstName])).stdout.trim()).toBe("");
    expect(await stopContainer(firstName)).toBe(0);

    const secondName = `artifact-server-oci-external-second-${nameSuffix}`;
    const secondPort = await startExternalContainer({
      containerName: secondName,
      environment,
      externalEnvironment,
      network: providers.dockerNetwork,
    });
    expect(await fetchContent(publication.links.version, secondPort))
      .toBe("external OCI bytes\n");
    expect(await stopContainer(secondName)).toBe(0);

    const supportResult = await docker([
      "run", ...hardenedRunArguments("arm64"),
      "--network", providers.dockerNetwork,
      ...containerEnvironmentArguments(externalEnvironment),
      environment.arm64Image,
      "support", "manifest", "--mode", "external-storage",
    ], externalEnvironment);
    const support = supportManifestSchema.parse(JSON.parse(supportResult.stdout));
    expect(support).toMatchObject({
      adapters: {database: "postgres", objectStorage: "s3"},
      imageRevision: environment.revision,
      installationId,
    });
    expect(supportResult.stdout).not.toContain(apiToken);
    expect(supportResult.stdout).not.toContain(providers.secretKey);

    await recordRuntimeBaseline("externalStorage", {
      concurrentReads: firstReads.count,
      providerStartupMilliseconds: providers.providerStartupMilliseconds,
      readMilliseconds: firstReads.milliseconds,
      startupMilliseconds: firstStartupMilliseconds,
    });
  });
});

interface OciEnvironment {
  readonly amd64Image: string;
  readonly archivePath: string;
  readonly arm64Image: string;
  readonly manifestPath: string;
  readonly revision: string;
}

interface ProviderEnvironment {
  readonly accessKey: string;
  readonly dockerDatabaseUrl: string;
  readonly dockerNetwork: string;
  readonly dockerS3Endpoint: string;
  readonly hostS3Endpoint: string;
  readonly providerStartupMilliseconds: number;
  readonly secretKey: string;
}

function ociEnvironment(): OciEnvironment {
  return {
    amd64Image: requiredEnvironment("ARTIFACT_SERVER_OCI_AMD64_IMAGE"),
    archivePath: requiredEnvironment("ARTIFACT_SERVER_OCI_ARCHIVE"),
    arm64Image: requiredEnvironment("ARTIFACT_SERVER_OCI_ARM64_IMAGE"),
    manifestPath: requiredEnvironment("ARTIFACT_SERVER_OCI_MANIFEST"),
    revision: requiredEnvironment("ARTIFACT_SERVER_OCI_REVISION"),
  };
}

function providerEnvironment(): ProviderEnvironment {
  const environment = {
    accessKey: requiredEnvironment("ARTIFACT_SERVER_TEST_S3_ACCESS_KEY"),
    dockerDatabaseUrl: requiredEnvironment("ARTIFACT_SERVER_TEST_DOCKER_DATABASE_URL"),
    dockerNetwork: requiredEnvironment("ARTIFACT_SERVER_TEST_DOCKER_NETWORK"),
    dockerS3Endpoint: requiredEnvironment("ARTIFACT_SERVER_TEST_DOCKER_S3_ENDPOINT"),
    hostS3Endpoint: requiredEnvironment("ARTIFACT_SERVER_TEST_S3_ENDPOINT"),
    providerStartupMilliseconds: Number(
      requiredEnvironment("ARTIFACT_SERVER_TEST_PROVIDER_READY_MILLISECONDS"),
    ),
    secretKey: requiredEnvironment("ARTIFACT_SERVER_TEST_S3_SECRET_KEY"),
  };
  registerSensitiveValue(environment.accessKey);
  registerSensitiveValue(environment.dockerDatabaseUrl);
  registerSensitiveValue(environment.secretKey);
  return environment;
}

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.length === 0) {
    throw new Error(`Run this test through pnpm test:oci-image; ${name} is missing.`);
  }
  return value;
}

function hardenedRunArguments(architecture: "amd64" | "arm64"): string[] {
  return [
    "--rm",
    "--platform", `linux/${architecture}`,
    "--read-only",
    "--tmpfs", "/tmp:rw,noexec,nosuid,size=32m",
  ];
}

async function verifyArchitectureRuntime(input: {
  readonly expectedPlatform: z.infer<typeof imageManifestSchema>["platforms"][number]
    | undefined;
  readonly image: string;
  readonly platform: "amd64" | "arm64";
  readonly version: string;
}): Promise<void> {
  if (input.expectedPlatform === undefined) {
    throw new Error(`The ${input.platform} image descriptor is missing.`);
  }
  const imageId = (await docker([
    "image", "inspect", "--platform", `linux/${input.platform}`,
    "--format", "{{.Id}}", input.image,
  ])).stdout.trim();
  expect(imageId).toBe(input.expectedPlatform.manifestDigest);

  const common = hardenedRunArguments(input.platform);
  const [version, identity, filesystem] = await Promise.all([
    docker(["run", ...common, input.image, "--version"]),
    docker([
      "run", ...common, "--entrypoint", "/usr/bin/id", input.image, "-u",
    ]),
    docker([
      "run", ...common, "--entrypoint", "/bin/sh", input.image, "-c",
      [
        "set -eu",
        "test ! -e src",
        "test ! -e tests",
        "test ! -e node_modules/typescript",
        "test ! -e node_modules/tsx",
        "test ! -e node_modules/vitest",
        "test ! -e node_modules/oxlint",
        "mount_options=$(awk '$2 == \"/\" {print $4}' /proc/mounts)",
        "case \"$mount_options\" in *ro*) ;; *) exit 42 ;; esac",
        "touch /tmp/runtime-write-proof",
      ].join("; "),
    ]),
  ]);
  expect(version.stdout.trim()).toBe(input.version);
  expect(identity.stdout.trim()).toBe("1000");
  expect(filesystem.stdout).toBe("");
}

function compactRuntimeEnvironment() {
  return {
    ARTIFACT_SERVER_CONTENT_DOMAIN: contentDomain,
    ARTIFACT_SERVER_ORIGIN: applicationOrigin,
    ARTIFACT_SERVER_READINESS_WITHDRAWAL_MS: "0",
    ARTIFACT_SERVER_REQUEST_LOG_SAMPLE_RATE: "0",
    ARTIFACT_SERVER_SHUTDOWN_DEADLINE_MS: "5000",
  } satisfies Readonly<Record<string, string>>;
}

function externalRuntimeEnvironment(input: {
  readonly bucket: string;
  readonly installationId: string;
  readonly providers: ProviderEnvironment;
}) {
  return {
    ARTIFACT_SERVER_API_TOKEN: apiToken,
    ARTIFACT_SERVER_BOOTSTRAP_ADMIN_EMAIL: "admin@example.test",
    ARTIFACT_SERVER_CONTENT_DOMAIN: contentDomain,
    ARTIFACT_SERVER_DATABASE_URL: input.providers.dockerDatabaseUrl,
    ARTIFACT_SERVER_INSTALLATION_ID: input.installationId,
    ARTIFACT_SERVER_LOCAL_BOOTSTRAP_TOKEN: browserToken,
    ARTIFACT_SERVER_ORIGIN: applicationOrigin,
    ARTIFACT_SERVER_READINESS_WITHDRAWAL_MS: "0",
    ARTIFACT_SERVER_REQUEST_LOG_SAMPLE_RATE: "0",
    ARTIFACT_SERVER_S3_ACCESS_KEY_ID: input.providers.accessKey,
    ARTIFACT_SERVER_S3_BUCKET: input.bucket,
    ARTIFACT_SERVER_S3_ENDPOINT: input.providers.dockerS3Endpoint,
    ARTIFACT_SERVER_S3_FORCE_PATH_STYLE: "true",
    ARTIFACT_SERVER_S3_REGION: "us-east-1",
    ARTIFACT_SERVER_S3_SECRET_ACCESS_KEY: input.providers.secretKey,
    ARTIFACT_SERVER_SHUTDOWN_DEADLINE_MS: "5000",
  } satisfies Readonly<Record<string, string>>;
}

async function startCompactContainer(input: {
  readonly containerName: string;
  readonly environment: OciEnvironment;
  readonly network: string;
  readonly volume: string;
}): Promise<number> {
  const runtimeEnvironment = compactRuntimeEnvironment();
  await startContainer({
    arguments: [
      "--volume", `${input.volume}:/var/lib/artifact-server`,
      input.environment.arm64Image,
      "start-compact", "--data", "/var/lib/artifact-server/data",
      "--host", "0.0.0.0", "--port", "8787",
    ],
    containerName: input.containerName,
    environment: runtimeEnvironment,
    network: input.network,
  });
  return waitForReady(input.containerName);
}

async function startExternalContainer(input: {
  readonly containerName: string;
  readonly environment: OciEnvironment;
  readonly externalEnvironment: Readonly<Record<string, string>>;
  readonly network: string;
}): Promise<number> {
  await startContainer({
    arguments: [
      input.environment.arm64Image,
      "start-external-storage", "--host", "0.0.0.0", "--port", "8787",
    ],
    containerName: input.containerName,
    environment: input.externalEnvironment,
    network: input.network,
  });
  return waitForReady(input.containerName);
}

async function startContainer(input: {
  readonly arguments: readonly string[];
  readonly containerName: string;
  readonly environment: Readonly<Record<string, string>>;
  readonly network: string;
}): Promise<void> {
  runtimeResources.containers.add(input.containerName);
  await docker([
    "run", "--detach",
    "--name", input.containerName,
    "--platform", "linux/arm64",
    "--read-only",
    "--tmpfs", "/tmp:rw,noexec,nosuid,size=32m",
    "--network", input.network,
    "--publish", "127.0.0.1::8787",
    ...containerEnvironmentArguments(input.environment),
    ...input.arguments,
  ], input.environment);
}

function containerEnvironmentArguments(
  environment: Readonly<Record<string, string>>,
): string[] {
  return Object.keys(environment).flatMap((name) => ["--env", name]);
}

async function waitForReady(containerName: string): Promise<number> {
  const portOutput = await docker(["port", containerName, "8787/tcp"]);
  const portMatch = /127\.0\.0\.1:(?<port>\d+)/u.exec(portOutput.stdout);
  const port = Number(portMatch?.groups?.["port"]);
  if (!Number.isInteger(port) || port < 1) {
    throw new Error(`Docker did not publish a valid port: ${portOutput.stdout}`);
  }
  await pollReadiness(containerName, port, 120);
  return port;
}

async function pollReadiness(
  containerName: string,
  port: number,
  attemptsRemaining: number,
): Promise<void> {
  const state = await containerState(containerName);
  if (!state.running) {
    const logs = await docker(["logs", containerName], {}, true);
    throw new Error(`Container exited before readiness: ${redact(logs.stdout + logs.stderr)}`);
  }
  try {
    const response = await fetch(`http://127.0.0.1:${port}/ready`);
    if (response.status === 200) return;
  } catch {
    // The mapped port may accept connections after the container starts listening.
  }
  if (attemptsRemaining <= 1) {
    const logs = await docker(["logs", containerName], {}, true);
    throw new Error(`Container did not become ready: ${redact(logs.stdout + logs.stderr)}`);
  }
  await new Promise((resolve) => setTimeout(resolve, 100));
  await pollReadiness(containerName, port, attemptsRemaining - 1);
}

async function publishFixture(input: {
  readonly apiToken: string;
  readonly containerImage: string;
  readonly network: string;
  readonly serverOrigin: string;
  readonly text: string;
}): Promise<z.infer<typeof publicationSchema>> {
  const fixtureDirectory = await mkdtemp(path.join(tmpdir(), "artifact-server-oci-fixture-"));
  runtimeResources.directories.add(fixtureDirectory);
  await writeFile(path.join(fixtureDirectory, "proof.txt"), input.text);
  const environment = {ARTIFACT_SERVER_API_TOKEN: input.apiToken};
  const result = await docker([
    "run", ...hardenedRunArguments("arm64"),
    "--network", input.network,
    "--volume", `${fixtureDirectory}:/input:ro`,
    ...containerEnvironmentArguments(environment),
    input.containerImage,
    "publish", "/input/proof.txt", "--server", input.serverOrigin, "--public",
  ], environment);
  return publicationSchema.parse(JSON.parse(result.stdout));
}

function fetchContent(link: string, port: number): Promise<string> {
  const target = new URL(link);
  return new Promise((resolve, reject) => {
    const outgoing = request({
      headers: {host: target.host},
      host: "127.0.0.1",
      method: "GET",
      path: `${target.pathname}${target.search}`,
      port,
    }, (incoming) => {
      const chunks: Uint8Array[] = [];
      incoming.on("data", (chunk: Buffer) => chunks.push(chunk));
      incoming.once("error", reject);
      incoming.once("end", () => {
        if (incoming.statusCode !== 200) {
          reject(new Error(`Published content returned HTTP ${incoming.statusCode}.`));
          return;
        }
        resolve(Buffer.concat(chunks).toString("utf8"));
      });
    });
    outgoing.once("error", reject);
    outgoing.end();
  });
}

async function boundedReadProbe(
  link: string,
  port: number,
): Promise<{readonly count: number; readonly milliseconds: number}> {
  const count = 24;
  const startedAt = performance.now();
  const responses = await Promise.all(
    Array.from({length: count}, () => fetchContent(link, port)),
  );
  const milliseconds = performance.now() - startedAt;
  expect(new Set(responses).size).toBe(1);
  expect(milliseconds).toBeLessThan(10_000);
  return {count, milliseconds};
}

async function runCompactSupportManifest(input: {
  readonly environment: OciEnvironment;
  readonly volume: string;
}): Promise<z.infer<typeof supportManifestSchema>> {
  const runtimeEnvironment = compactRuntimeEnvironment();
  const result = await docker([
    "run", ...hardenedRunArguments("arm64"),
    "--volume", `${input.volume}:/var/lib/artifact-server`,
    ...containerEnvironmentArguments(runtimeEnvironment),
    input.environment.arm64Image,
    "support", "manifest", "--mode", "compact",
    "--data", "/var/lib/artifact-server/data",
  ], runtimeEnvironment);
  return supportManifestSchema.parse(JSON.parse(result.stdout));
}

async function recordRuntimeBaseline(
  kind: "compact" | "externalStorage",
  measurement: RuntimeMeasurement,
): Promise<void> {
  const outputPath = path.join(repositoryRoot, "evidence/oci-runtime-baseline.json");
  let current: z.infer<typeof runtimeBaselineSchema> = {};
  try {
    current = runtimeBaselineSchema.parse(
      JSON.parse(await readFile(outputPath, "utf8")),
    );
  } catch {
    // The first result creates the evidence record.
  }
  await writeFile(outputPath, `${JSON.stringify({
    ...current,
    [kind]: measurement,
    measuredAt: new Date().toISOString(),
    node: process.version,
    platform: process.platform,
  }, null, 2)}\n`);
}

async function stopContainer(containerName: string): Promise<number> {
  await docker(["stop", "--time", "8", containerName]);
  const state = await containerState(containerName);
  await removeContainer(containerName);
  return state.exitCode;
}

async function containerState(
  containerName: string,
): Promise<{readonly exitCode: number; readonly running: boolean}> {
  const result = await docker([
    "inspect", "--format", "{{json .State}}", containerName,
  ]);
  const parsed = z.object({
    ExitCode: z.number().int(),
    Running: z.boolean(),
  }).parse(JSON.parse(result.stdout));
  return {exitCode: parsed.ExitCode, running: parsed.Running};
}

async function createVolume(name: string): Promise<string> {
  await docker(["volume", "create", name]);
  runtimeResources.volumes.add(name);
  return name;
}

async function createNetwork(name: string): Promise<string> {
  await docker(["network", "create", name]);
  runtimeResources.networks.add(name);
  return name;
}

async function removeContainer(name: string): Promise<void> {
  await docker(["rm", "--force", name], {}, true);
  runtimeResources.containers.delete(name);
}

async function removeVolume(name: string): Promise<void> {
  await docker(["volume", "rm", "--force", name], {}, true);
  runtimeResources.volumes.delete(name);
}

async function removeNetwork(name: string): Promise<void> {
  await docker(["network", "rm", name], {}, true);
  runtimeResources.networks.delete(name);
}

function resourceSuffix(): string {
  return `${process.pid}-${randomBytes(5).toString("hex")}`;
}

interface ProcessResult {
  readonly stderr: string;
  readonly stdout: string;
}

function docker(
  arguments_: readonly string[],
  environment: Readonly<Record<string, string>> = {},
  allowFailure = false,
): Promise<ProcessResult> {
  return new Promise((resolve, reject) => {
    execFile("docker", arguments_, {
      cwd: repositoryRoot,
      env: {...process.env, ...environment},
      maxBuffer: 10 * 1024 * 1024,
    }, (error, stdout, stderr) => {
      if (error !== null && !allowFailure) {
        reject(new Error(`Docker command failed: ${redact(stderr || stdout)}`));
        return;
      }
      resolve({stderr, stdout});
    });
  });
}

function redact(value: string): string {
  let redacted = value.replaceAll(
    /postgres(?:ql)?:\/\/[^\s]+/gu,
    "[REDACTED_DATABASE_URL]",
  );
  for (const sensitive of sensitiveValues) {
    redacted = redacted.replaceAll(sensitive, "[REDACTED]");
  }
  return redacted;
}

function registerSensitiveValue(value: string): void {
  if (value.length > 0) sensitiveValues.add(value);
}
