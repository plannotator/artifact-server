import {execFile} from "node:child_process";
import {randomBytes, randomUUID} from "node:crypto";
import {mkdir, mkdtemp, rm, writeFile} from "node:fs/promises";
import {request} from "node:http";
import {tmpdir} from "node:os";
import path from "node:path";

import {CreateBucketCommand, S3Client} from "@aws-sdk/client-s3";
import {afterAll, afterEach, beforeAll, describe, expect, test} from "vitest";
import {z} from "zod";

const repositoryRoot = path.resolve(import.meta.dirname, "../..");
const composeFiles = [
  requiredEnvironment("ARTIFACT_SERVER_EXTERNAL_COMPOSE_BASE_FILE"),
  requiredEnvironment("ARTIFACT_SERVER_EXTERNAL_COMPOSE_FILE"),
  requiredEnvironment("ARTIFACT_SERVER_EXTERNAL_COMPOSE_S3_SECRETS_FILE"),
  requiredEnvironment("ARTIFACT_SERVER_EXTERNAL_COMPOSE_TEST_FILE"),
];
const composeImage = requiredEnvironment("ARTIFACT_SERVER_EXTERNAL_COMPOSE_IMAGE");
const composeRevision = requiredEnvironment("ARTIFACT_SERVER_EXTERNAL_COMPOSE_REVISION");
const dockerDatabaseUrl = requiredEnvironment(
  "ARTIFACT_SERVER_TEST_DOCKER_DATABASE_URL",
);
const providerNetwork = requiredEnvironment(
  "ARTIFACT_SERVER_TEST_DOCKER_NETWORK",
);
const dockerS3Endpoint = requiredEnvironment(
  "ARTIFACT_SERVER_TEST_DOCKER_S3_ENDPOINT",
);
const hostS3Endpoint = requiredEnvironment("ARTIFACT_SERVER_TEST_S3_ENDPOINT");
const s3AccessKey = requiredEnvironment("ARTIFACT_SERVER_TEST_S3_ACCESS_KEY");
const s3SecretKey = requiredEnvironment("ARTIFACT_SERVER_TEST_S3_SECRET_KEY");
const postgresContainer = requiredEnvironment(
  "ARTIFACT_SERVER_TEST_POSTGRES_CONTAINER",
);
const postgresUser = requiredEnvironment("ARTIFACT_SERVER_TEST_POSTGRES_USER");
const applicationOrigin = "https://artifacts.example.com";
const contentDomain = "content.example.net";
const region = "us-east-1";
const resources = {
  directories: new Set<string>(),
  projects: new Map<string, NodeJS.ProcessEnv>(),
};
const sensitiveValues = new Set<string>();

const commandFailureSchema = z.object({
  code: z.coerce.number().int().optional(),
});
const publicationSchema = z.object({
  artifact: z.object({
    accessSetting: z.string(),
    id: z.string().min(1),
    name: z.string().min(1),
  }),
  links: z.object({
    artifact: z.string().url(),
    version: z.string().url(),
  }),
  version: z.object({
    id: z.string().min(1),
    manifestDigest: z.string().min(1),
    number: z.number().int().positive(),
  }),
});
const jsonValueSchema = z.json();
const composeConfigurationSchema = z.object({
  services: z.object({
    "artifact-server": z.object({
      cap_drop: z.array(z.string()),
      command: z.array(z.string()),
      container_name: z.string().optional(),
      expose: z.array(z.string()),
      image: z.string(),
      init: z.boolean(),
      pids_limit: z.number().int().positive(),
      ports: z.array(z.object({
        host_ip: z.string(),
        published: z.string(),
        target: z.number().int(),
      })),
      read_only: z.boolean(),
      secrets: z.array(z.object({source: z.string(), target: z.string()})),
      security_opt: z.array(z.string()),
      tmpfs: z.array(z.string()),
      user: z.string(),
      volumes: z.array(z.unknown()).optional(),
    }),
  }),
});
const containerInspectionSchema = z.array(z.object({
  Config: z.object({User: z.string()}),
  HostConfig: z.object({
    CapDrop: z.array(z.string()),
    Privileged: z.boolean(),
    ReadonlyRootfs: z.boolean(),
  }),
  Mounts: z.array(z.object({
    Destination: z.string(),
    Type: z.string(),
  })),
  NetworkSettings: z.object({
    Ports: z.record(z.string(), z.array(z.object({
      HostIp: z.string(),
      HostPort: z.string(),
    })).nullable()),
  }),
})).length(1);

let s3Client: S3Client;

beforeAll(() => {
  s3Client = new S3Client({
    credentials: {accessKeyId: s3AccessKey, secretAccessKey: s3SecretKey},
    endpoint: hostS3Endpoint,
    forcePathStyle: true,
    region,
  });
});

afterEach(async () => {
  const projects = [...resources.projects.values()];
  const directories = [...resources.directories];
  resources.projects.clear();
  resources.directories.clear();
  await Promise.all([
    ...projects.map((environment) => compose(
      environment,
      ["down", "--volumes", "--remove-orphans"],
      true,
    )),
    ...directories.map((directory) => rm(
      directory,
      {force: true, recursive: true},
    )),
  ]);
});

afterAll(() => {
  s3Client.destroy();
});

describe.sequential("External-storage Compose release", () => {
  test("DEP-020-B: two packaged replicas publish, conflict safely, and survive complete replacement", async () => {
    const project = await createProject("external-compose");
    const rendered = composeConfigurationSchema.parse(JSON.parse(
      (await compose(project.environment, ["config", "--format", "json"])).stdout,
    ));
    const service = rendered.services["artifact-server"];
    expect(service).toMatchObject({
      cap_drop: ["ALL"],
      command: [
        "start-external-storage",
        "--host",
        "0.0.0.0",
        "--port",
        "8787",
      ],
      expose: ["8787"],
      image: composeImage,
      init: true,
      pids_limit: 256,
      read_only: true,
      security_opt: ["no-new-privileges:true"],
      user: "1000:1000",
    });
    expect(service.container_name).toBeUndefined();
    expect(service.volumes).toBeUndefined();
    expect(service.ports).toEqual([{
      host_ip: "127.0.0.1",
      published: "0",
      target: 8787,
    }]);
    expect(service.secrets.map((secret) => secret.target).toSorted()).toEqual([
      "/run/secrets/artifact-server-api-token",
      "/run/secrets/artifact-server-database-url",
      "/run/secrets/artifact-server-s3-access-key-id",
      "/run/secrets/artifact-server-s3-secret-access-key",
    ]);

    await migrate(project);
    const checked = await compose(project.environment, [
      "run", "--rm", "--no-deps", "artifact-server",
      "config", "check", "--mode", "external-storage",
    ]);
    expect(checked.stdout).toContain('"status": "ready"');
    expect(checked.stdout).not.toContain(project.apiToken);
    expect(checked.stdout).not.toContain(dockerDatabaseUrl);
    expect(checked.stdout).not.toContain(s3SecretKey);

    const startedAt = performance.now();
    await startReplicas(project, 2);
    const startupMilliseconds = performance.now() - startedAt;
    const firstContainers = await replicaContainers(project);
    expect(firstContainers).toHaveLength(2);
    const firstPorts = await replicaPorts(firstContainers);
    await Promise.all(firstPorts.map(waitForReady));

    const inspections = await Promise.all(firstContainers.map(inspectContainer));
    for (const inspection of inspections) {
      expect(inspection.Config.User).toBe("1000:1000");
      expect(inspection.HostConfig).toMatchObject({
        CapDrop: ["ALL"],
        Privileged: false,
        ReadonlyRootfs: true,
      });
      expect(inspection.Mounts.map((mount) => mount.Destination).toSorted()).toEqual([
        "/run/secrets/artifact-server-api-token",
        "/run/secrets/artifact-server-database-url",
        "/run/secrets/artifact-server-s3-access-key-id",
        "/run/secrets/artifact-server-s3-secret-access-key",
      ]);
      expect(inspection.Mounts.some((mount) =>
        mount.Destination.startsWith("/var/lib/artifact-server")
      )).toBe(false);
    }

    const firstPort = requiredItem(firstPorts, 0, "first replica port");
    const secondPort = requiredItem(firstPorts, 1, "second replica port");
    const filePublication = await publishFixture(
      project,
      firstPort,
      {kind: "file", text: "external compose file bytes\n"},
    );
    const sitePublication = await publishFixture(
      project,
      secondPort,
      {kind: "site", text: "external compose site version one"},
    );
    await Promise.all(firstPorts.map(async (port) => {
      await expect(fetchContent(filePublication.links.version, port))
        .resolves.toBe("external compose file bytes\n");
      await expect(fetchContent(sitePublication.links.version, port))
        .resolves.toContain("external compose site version one");
    }));

    const [firstRace, secondRace] = await Promise.all([
      publishFixtureResult(
        project,
        firstPort,
        {kind: "site", text: "replica one candidate"},
        {
          artifactId: sitePublication.artifact.id,
          expectedVersionId: sitePublication.version.id,
        },
      ),
      publishFixtureResult(
        project,
        secondPort,
        {kind: "site", text: "replica two candidate"},
        {
          artifactId: sitePublication.artifact.id,
          expectedVersionId: sitePublication.version.id,
        },
      ),
    ]);
    const raceResults = [firstRace, secondRace];
    const winnerResult = raceResults.find((result) => result.exitCode === 0);
    const loserResult = raceResults.find((result) => result.exitCode !== 0);
    expect(winnerResult).toBeDefined();
    expect(loserResult).toBeDefined();
    expect(redact(`${loserResult?.stdout}\n${loserResult?.stderr}`))
      .toMatch(/current version|conflict|409/iu);
    const winningPublication = publicationSchema.parse(
      JSON.parse(winnerResult?.stdout ?? "{}"),
    );
    expect(winningPublication.version.number).toBe(2);

    const firstSnapshot = await fetchStateSnapshot(
      firstPort,
      project.apiToken,
      [filePublication, sitePublication, winningPublication],
    );
    expect(await fetchStateSnapshot(
      secondPort,
      project.apiToken,
      [filePublication, sitePublication, winningPublication],
    )).toEqual(firstSnapshot);

    const readBaseline = await measureReads(
      winningPublication.links.version,
      firstPorts,
    );
    const replacementStartedAt = performance.now();
    await startReplicas(project, 2, true);
    const replacementMilliseconds = performance.now() - replacementStartedAt;
    const replacementContainers = await replicaContainers(project);
    expect(replacementContainers).toHaveLength(2);
    expect(replacementContainers.every((id) => !firstContainers.includes(id)))
      .toBe(true);
    const replacementPorts = await replicaPorts(replacementContainers);
    await Promise.all(replacementPorts.map(waitForReady));
    await Promise.all(replacementPorts.map(async (port) => {
      const snapshot = await fetchStateSnapshot(
        port,
        project.apiToken,
        [filePublication, sitePublication, winningPublication],
      );
      expect(snapshot).toEqual(firstSnapshot);
      await Promise.all([
        expect(fetchContent(filePublication.links.version, port))
          .resolves.toBe("external compose file bytes\n"),
        expect(fetchContent(winningPublication.links.version, port))
          .resolves.toMatch(/replica (one|two) candidate/u),
      ]);
    }));

    await writeFile(
      path.join(
        repositoryRoot,
        "evidence/external-storage-compose-runtime-baseline.json",
      ),
      `${JSON.stringify({
        composeVersion: await composeVersion(),
        imageRevision: composeRevision,
        measuredAt: new Date().toISOString(),
        platform: process.platform,
        providerReadyMilliseconds: Number(requiredEnvironment(
          "ARTIFACT_SERVER_TEST_PROVIDER_READY_MILLISECONDS",
        )),
        readBaseline,
        replacementMilliseconds,
        replicas: 2,
        startupMilliseconds,
      }, null, 2)}\n`,
    );
  });

  test("DEP-020-F: incomplete, unavailable, or unmigrated provider configuration never reports ready", async () => {
    const missingBucket = await createProject("external-missing-bucket");
    const missingBucketEnvironment = {
      ...missingBucket.environment,
      ARTIFACT_SERVER_S3_BUCKET: undefined,
    };
    const missingBucketResult = await compose(
      missingBucketEnvironment,
      ["config"],
      true,
    );
    expect(missingBucketResult.exitCode).not.toBe(0);

    const incompleteCredentials = await createProject(
      "external-incomplete-credentials",
    );
    const incompleteEnvironment = {
      ...incompleteCredentials.environment,
      ARTIFACT_SERVER_S3_SECRET_ACCESS_KEY_SECRET_FILE: undefined,
    };
    const incompleteResult = await compose(
      incompleteEnvironment,
      ["config"],
      true,
    );
    expect(incompleteResult.exitCode).not.toBe(0);

    const missingSecret = await createProject("external-missing-secret");
    const missingSecretEnvironment = {
      ...missingSecret.environment,
      ARTIFACT_SERVER_API_TOKEN_SECRET_FILE:
        path.join(missingSecret.secretDirectory, "absent-api-token"),
    };
    const missingSecretResult = await compose(
      missingSecretEnvironment,
      [
        "run", "--rm", "--no-deps", "artifact-server",
        "config", "check", "--mode", "external-storage",
      ],
      true,
    );
    expect(missingSecretResult.exitCode).not.toBe(0);
    expect(redact(missingSecretResult.stdout + missingSecretResult.stderr))
      .not.toContain(missingSecret.apiToken);

    const unmigratedDatabase = `unmigrated_${randomUUID().replaceAll("-", "")}`;
    await createDatabase(unmigratedDatabase);
    const unmigrated = await createProject("external-unmigrated", {
      databaseUrl: databaseUrlFor(unmigratedDatabase),
    });
    const unmigratedResult = await startReplicas(unmigrated, 1, false, true);
    expect(unmigratedResult.exitCode).not.toBe(0);
    expect(await projectHasReadyReplica(unmigrated)).toBe(false);

    const unavailableDatabase = await createProject("external-database-down", {
      databaseUrl: dockerDatabaseUrl.replace(":5432/", ":6543/"),
    });
    const databaseDownResult = await startReplicas(
      unavailableDatabase,
      1,
      false,
      true,
    );
    expect(databaseDownResult.exitCode).not.toBe(0);
    expect(await projectHasReadyReplica(unavailableDatabase)).toBe(false);

    const absentBucket = await createProject("external-absent-bucket", {
      createBucket: false,
    });
    await migrate(absentBucket);
    const absentBucketResult = await startReplicas(
      absentBucket,
      1,
      false,
      true,
    );
    expect(absentBucketResult.exitCode).not.toBe(0);
    expect(await projectHasReadyReplica(absentBucket)).toBe(false);

    const invalidIsolation = await createProject("external-invalid-isolation", {
      contentDomain: "content.example.com",
    });
    await migrate(invalidIsolation);
    const isolationResult = await startReplicas(
      invalidIsolation,
      1,
      false,
      true,
    );
    expect(isolationResult.exitCode).not.toBe(0);
    expect(await projectHasReadyReplica(invalidIsolation)).toBe(false);
  });
});

interface ExternalComposeProject {
  readonly apiToken: string;
  readonly bucket: string;
  readonly environment: NodeJS.ProcessEnv;
  readonly name: string;
  readonly secretDirectory: string;
}

interface CreateProjectOptions {
  readonly contentDomain?: string;
  readonly createBucket?: boolean;
  readonly databaseUrl?: string;
}

type Fixture =
  | {readonly kind: "file"; readonly text: string}
  | {readonly kind: "site"; readonly text: string};

interface ExistingArtifactTarget {
  readonly artifactId: string;
  readonly expectedVersionId: string;
}

interface CommandResult {
  readonly exitCode: number;
  readonly stderr: string;
  readonly stdout: string;
}

interface ReadBaseline {
  readonly completedRequests: number;
  readonly elapsedMilliseconds: number;
  readonly p95Milliseconds: number;
  readonly requestsPerSecond: number;
}

async function createProject(
  prefix: string,
  options: CreateProjectOptions = {},
): Promise<ExternalComposeProject> {
  const suffix = randomUUID().slice(0, 8);
  const name = `${prefix}-${suffix}`;
  const bucket = `${prefix}-${suffix}`.toLowerCase();
  const secretDirectory = await temporaryDirectory(
    "artifact-server-external-compose-secrets-",
  );
  const apiToken = randomBytes(32).toString("base64url");
  const databaseUrl = options.databaseUrl ?? dockerDatabaseUrl;
  const paths = {
    apiToken: path.join(secretDirectory, "api-token"),
    databaseUrl: path.join(secretDirectory, "database-url"),
    s3AccessKey: path.join(secretDirectory, "s3-access-key-id"),
    s3SecretKey: path.join(secretDirectory, "s3-secret-access-key"),
  };
  await Promise.all([
    writeFile(paths.apiToken, `${apiToken}\n`, {mode: 0o600}),
    writeFile(paths.databaseUrl, `${databaseUrl}\n`, {mode: 0o600}),
    writeFile(paths.s3AccessKey, `${s3AccessKey}\n`, {mode: 0o600}),
    writeFile(paths.s3SecretKey, `${s3SecretKey}\n`, {mode: 0o600}),
  ]);
  if (options.createBucket !== false) {
    await s3Client.send(new CreateBucketCommand({Bucket: bucket}));
  }
  registerSensitive(apiToken);
  registerSensitive(databaseUrl);
  registerSensitive(s3AccessKey);
  registerSensitive(s3SecretKey);
  const environment: NodeJS.ProcessEnv = {
    ...process.env,
    ARTIFACT_SERVER_ALLOW_TEST_IMAGE_TAG: "true",
    ARTIFACT_SERVER_API_TOKEN_SECRET_FILE: paths.apiToken,
    ARTIFACT_SERVER_BOOTSTRAP_ADMIN_EMAIL: "admin@example.test",
    ARTIFACT_SERVER_CONTENT_DOMAIN:
      options.contentDomain ?? contentDomain,
    ARTIFACT_SERVER_DATABASE_URL_SECRET_FILE: paths.databaseUrl,
    ARTIFACT_SERVER_IMAGE: composeImage,
    ARTIFACT_SERVER_INSTALLATION_ID: name,
    ARTIFACT_SERVER_ORIGIN: applicationOrigin,
    ARTIFACT_SERVER_READINESS_WITHDRAWAL_MS: "0",
    ARTIFACT_SERVER_REQUEST_LOG_SAMPLE_RATE: "0",
    ARTIFACT_SERVER_S3_ACCESS_KEY_ID_SECRET_FILE: paths.s3AccessKey,
    ARTIFACT_SERVER_S3_BUCKET: bucket,
    ARTIFACT_SERVER_S3_ENDPOINT: dockerS3Endpoint,
    ARTIFACT_SERVER_S3_FORCE_PATH_STYLE: "true",
    ARTIFACT_SERVER_S3_REGION: region,
    ARTIFACT_SERVER_S3_SECRET_ACCESS_KEY_SECRET_FILE: paths.s3SecretKey,
    ARTIFACT_SERVER_SHUTDOWN_DEADLINE_MS: "5000",
    ARTIFACT_SERVER_TEST_DOCKER_NETWORK: providerNetwork,
    COMPOSE_PROJECT_NAME: name,
  };
  resources.projects.set(name, environment);
  return {apiToken, bucket, environment, name, secretDirectory};
}

function migrate(project: ExternalComposeProject): Promise<CommandResult> {
  return compose(project.environment, [
    "run", "--rm", "--no-deps", "artifact-server", "migrate", "apply",
  ]);
}

function startReplicas(
  project: ExternalComposeProject,
  replicas: number,
  replace = false,
  allowFailure = false,
): Promise<CommandResult> {
  return compose(project.environment, [
    "up",
    "--detach",
    "--scale",
    `artifact-server=${replicas}`,
    ...(replace ? ["--force-recreate"] : []),
    "--wait",
    "--wait-timeout",
    "30",
    "artifact-server",
  ], allowFailure);
}

async function publishFixture(
  project: ExternalComposeProject,
  port: number,
  fixture: Fixture,
  target?: ExistingArtifactTarget,
): Promise<z.infer<typeof publicationSchema>> {
  const result = await publishFixtureResult(project, port, fixture, target);
  if (result.exitCode !== 0) {
    throw new Error(`Publication failed: ${result.stderr}`);
  }
  return publicationSchema.parse(JSON.parse(result.stdout));
}

async function publishFixtureResult(
  project: ExternalComposeProject,
  port: number,
  fixture: Fixture,
  target?: ExistingArtifactTarget,
): Promise<CommandResult> {
  const directory = await temporaryDirectory(
    "artifact-server-external-compose-fixture-",
  );
  let inputPath: string;
  if (fixture.kind === "file") {
    inputPath = path.join(directory, "proof.txt");
    await writeFile(inputPath, fixture.text);
  } else {
    inputPath = directory;
    await mkdir(path.join(directory, "assets"));
    await Promise.all([
      writeFile(
        path.join(directory, "index.html"),
        `<main>${fixture.text}</main><script src="/assets/app.js"></script>`,
      ),
      writeFile(
        path.join(directory, "assets/app.js"),
        "document.body.dataset.compose = 'external-ready';\n",
      ),
    ]);
  }
  const publishArguments = [
    path.join(repositoryRoot, "dist/cli/main.js"),
    "publish",
    inputPath,
    "--server",
    `http://127.0.0.1:${port}`,
    "--token-file",
    path.join(project.secretDirectory, "api-token"),
  ];
  if (target === undefined) {
    publishArguments.push("--public", "--tag", "compose-proof");
  } else {
    publishArguments.push(
      "--artifact",
      target.artifactId,
      "--expected-version",
      target.expectedVersionId,
    );
  }
  return command("node", publishArguments, process.env, true);
}

async function fetchStateSnapshot(
  port: number,
  apiToken: string,
  publications: readonly z.infer<typeof publicationSchema>[],
): Promise<readonly z.infer<typeof jsonValueSchema>[]> {
  const paths = publications.flatMap((publication) => [
    `/api/v1/artifacts/${publication.artifact.id}`,
    `/api/v1/artifacts/${publication.artifact.id}/versions`,
    `/api/v1/artifacts/${publication.artifact.id}/actions`,
    `/api/v1/artifacts/${publication.artifact.id}/versions/${publication.version.id}`,
  ]);
  return Promise.all(paths.map(async (resourcePath) => {
    const response = await fetch(
      `http://127.0.0.1:${port}${resourcePath}`,
      {headers: {
        Authorization: `Bearer ${apiToken}`,
        Host: new URL(applicationOrigin).host,
      }},
    );
    expect(response.status).toBe(200);
    const representation = jsonValueSchema.parse(await response.json());
    return jsonValueSchema.parse(JSON.parse(
      JSON.stringify(representation).replaceAll(`:${port}`, ""),
    ));
  }));
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
          reject(new Error(
            `Published content returned HTTP ${incoming.statusCode}.`,
          ));
          return;
        }
        resolve(Buffer.concat(chunks).toString("utf8"));
      });
    });
    outgoing.once("error", reject);
    outgoing.end();
  });
}

async function measureReads(
  link: string,
  ports: readonly number[],
): Promise<ReadBaseline> {
  const count = 40;
  if (ports.length === 0) {
    throw new Error("A read baseline requires at least one replica port.");
  }
  const latencies: number[] = [];
  const startedAt = performance.now();
  await Promise.all(Array.from({length: count}, async (_, index) => {
    const requestStartedAt = performance.now();
    await fetchContent(
      link,
      requiredItem(ports, index % ports.length, "baseline replica port"),
    );
    latencies.push(performance.now() - requestStartedAt);
  }));
  const elapsedMilliseconds = performance.now() - startedAt;
  const sortedLatencies = latencies.toSorted((first, second) => first - second);
  const p95Index = Math.max(0, Math.ceil(latencies.length * 0.95) - 1);
  return {
    completedRequests: count,
    elapsedMilliseconds,
    p95Milliseconds: sortedLatencies[p95Index] ?? 0,
    requestsPerSecond: count / (elapsedMilliseconds / 1_000),
  };
}

async function replicaContainers(
  project: ExternalComposeProject,
): Promise<readonly string[]> {
  const result = await compose(project.environment, [
    "ps", "--quiet", "artifact-server",
  ]);
  return result.stdout.trim().split("\n").filter((value) => value.length > 0);
}

async function replicaPorts(
  containerIds: readonly string[],
): Promise<readonly number[]> {
  return Promise.all(containerIds.map(async (containerId) => {
    const inspection = await inspectContainer(containerId);
    const bindings = inspection.NetworkSettings.Ports["8787/tcp"];
    const hostPort = bindings?.[0]?.HostPort;
    if (hostPort === undefined) {
      throw new Error(`Container ${containerId} has no published test port.`);
    }
    return Number(hostPort);
  }));
}

async function inspectContainer(containerId: string) {
  const inspections = containerInspectionSchema.parse(JSON.parse(
    (await command("docker", ["inspect", containerId])).stdout,
  ));
  return requiredItem(inspections, 0, "container inspection");
}

async function waitForReady(
  port: number,
  attemptsRemaining = 150,
): Promise<void> {
  if (await isReady(port)) return;
  if (attemptsRemaining <= 1) {
    throw new Error(
      `External-storage Compose did not become ready on port ${port}.`,
    );
  }
  await new Promise((resolve) => setTimeout(resolve, 100));
  return waitForReady(port, attemptsRemaining - 1);
}

async function anyReady(ports: readonly number[]): Promise<boolean> {
  return (await Promise.all(ports.map(isReady))).some(Boolean);
}

async function projectHasReadyReplica(
  project: ExternalComposeProject,
): Promise<boolean> {
  const containers = await replicaContainers(project);
  const ports = await Promise.all(containers.map(async (containerId) => {
    const inspection = await inspectContainer(containerId);
    return inspection.NetworkSettings.Ports["8787/tcp"]?.[0]?.HostPort;
  }));
  return anyReady(ports
    .filter((port): port is string => port !== undefined)
    .map(Number));
}

async function isReady(port: number): Promise<boolean> {
  try {
    return (await fetch(`http://127.0.0.1:${port}/ready`)).status === 200;
  } catch {
    return false;
  }
}

async function createDatabase(database: string): Promise<void> {
  await command("docker", [
    "exec",
    postgresContainer,
    "createdb",
    "--username",
    postgresUser,
    database,
  ]);
}

function databaseUrlFor(database: string): string {
  return dockerDatabaseUrl.replace(/\/[^/?]+(?=\?|$)/u, `/${database}`);
}

async function temporaryDirectory(prefix: string): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), prefix));
  resources.directories.add(directory);
  return directory;
}

function compose(
  environment: NodeJS.ProcessEnv,
  arguments_: readonly string[],
  allowFailure = false,
): Promise<CommandResult> {
  return command(
    "docker",
    [
      "compose",
      ...composeFiles.flatMap((file) => ["--file", file]),
      ...arguments_,
    ],
    environment,
    allowFailure,
  );
}

async function composeVersion(): Promise<string> {
  return (await command("docker", ["compose", "version", "--short"]))
    .stdout.trim();
}

function command(
  executable: string,
  commandArguments: readonly string[],
  environment: NodeJS.ProcessEnv = process.env,
  allowFailure = false,
): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    execFile(executable, commandArguments, {
      encoding: "utf8",
      env: environment,
      maxBuffer: 16 * 1024 * 1024,
    }, (error, stdout, stderr) => {
      const parsedFailure = commandFailureSchema.safeParse(error);
      const exitCode = parsedFailure.success
        ? parsedFailure.data.code ?? 1
        : error === null ? 0 : 1;
      const result = {
        exitCode,
        stderr: redact(stderr),
        stdout: redact(stdout),
      };
      if (error !== null && !allowFailure) {
        reject(new Error(
          `${executable} ${commandArguments.join(" ")} failed (${exitCode}): ${result.stderr}`,
        ));
        return;
      }
      resolve(result);
    });
  });
}

function requiredItem<T>(
  items: readonly T[],
  index: number,
  description: string,
): T {
  const item = items[index];
  if (item === undefined) {
    throw new Error(`Missing ${description} at index ${index}.`);
  }
  return item;
}

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.length === 0) {
    throw new Error(
      `Run this test through pnpm test:external-storage-compose; ${name} is missing.`,
    );
  }
  return value;
}

function registerSensitive(value: string): void {
  sensitiveValues.add(value);
}

function redact(value: string): string {
  let redacted = value;
  for (const sensitive of sensitiveValues) {
    redacted = redacted.replaceAll(sensitive, "[REDACTED]");
  }
  return redacted;
}
