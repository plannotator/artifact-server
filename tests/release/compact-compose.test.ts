import {execFile} from "node:child_process";
import {createHash, randomUUID} from "node:crypto";
import {
  chmod,
  cp,
  mkdir,
  mkdtemp,
  open,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import {request} from "node:http";
import {createServer} from "node:net";
import {tmpdir} from "node:os";
import path from "node:path";

import {afterEach, describe, expect, test} from "vitest";
import {z} from "zod";

const repositoryRoot = path.resolve(import.meta.dirname, "../..");
const composeFile = requiredEnvironment("ARTIFACT_SERVER_COMPOSE_FILE");
const composeImage = requiredEnvironment("ARTIFACT_SERVER_COMPOSE_IMAGE");
const composeRevision = requiredEnvironment("ARTIFACT_SERVER_COMPOSE_REVISION");
const backupScript = path.join(
  repositoryRoot,
  "packaging/compose/compact-backup.sh",
);
const restoreScript = path.join(
  repositoryRoot,
  "packaging/compose/compact-restore.sh",
);
const applicationOrigin = "https://artifacts.example.com";
const contentDomain = "content.example.net";
const runtimeResources = {
  directories: new Set<string>(),
  projects: new Map<string, NodeJS.ProcessEnv>(),
};
const sensitiveValues = new Set<string>();

const commandFailureSchema = z.object({
  code: z.coerce.number().int().optional(),
});
const addressSchema = z.object({port: z.number().int().positive()});
const initializationSchema = z.object({
  dataDirectory: z.string(),
  installationId: z.string().min(1),
});
const publicationSchema = z.object({
  artifact: z.object({
    id: z.string().min(1),
    name: z.string().min(1),
  }),
  links: z.object({
    artifact: z.string().url(),
    version: z.string().url(),
  }),
  version: z.object({
    id: z.string().min(1),
    number: z.number().int().positive(),
  }),
});
const jsonValueSchema = z.json();
const supportManifestSchema = z.object({
  adapters: z.object({
    database: z.literal("sqlite"),
    objectStorage: z.literal("filesystem"),
  }),
  imageRevision: z.string().nullable(),
  installationId: z.string().min(1),
  product: z.literal("artifact-server"),
});
const integritySchema = z.object({
  artifactsChecked: z.number().int().nonnegative(),
  blobsChecked: z.number().int().nonnegative(),
  problems: z.array(z.unknown()),
  status: z.literal("healthy"),
  versionsChecked: z.number().int().nonnegative(),
});
const composeConfigurationSchema = z.object({
  services: z.object({
    "artifact-server": z.object({
      cap_drop: z.array(z.string()),
      command: z.array(z.string()),
      container_name: z.string(),
      healthcheck: z.object({test: z.array(z.string())}),
      image: z.string(),
      init: z.boolean(),
      pids_limit: z.number().int().positive(),
      ports: z.array(z.object({
        host_ip: z.string(),
        published: z.string(),
        target: z.number().int(),
      })),
      read_only: z.boolean(),
      restart: z.string(),
      security_opt: z.array(z.string()),
      tmpfs: z.array(z.string()),
      user: z.string(),
      volumes: z.array(z.object({
        source: z.string(),
        target: z.string(),
        type: z.string(),
      })),
    }),
  }),
});
const containerInspectionSchema = z.array(z.object({
  Config: z.object({User: z.string()}),
  HostConfig: z.object({
    CapDrop: z.array(z.string()),
    PidsLimit: z.number().int().positive(),
    Privileged: z.boolean(),
    ReadonlyRootfs: z.boolean(),
    SecurityOpt: z.array(z.string()),
    Tmpfs: z.record(z.string(), z.string()),
  }),
  Mounts: z.array(z.object({
    Destination: z.string(),
    Source: z.string(),
    Type: z.string(),
  })),
})).length(1);

afterEach(async () => {
  const projects = [...runtimeResources.projects.values()];
  const directories = [...runtimeResources.directories];
  runtimeResources.projects.clear();
  runtimeResources.directories.clear();
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

describe.sequential("Compact Compose release", () => {
  test("DEP-005-B OPS-003-B: the packaged stack publishes, restarts, replaces, backs up, and restores exact state", async () => {
    const source = await createProject("compact-source");
    const initialization = await initialize(source);
    const apiToken = await readApiToken(source);
    registerSensitive(apiToken);

    const rendered = composeConfigurationSchema.parse(JSON.parse(
      (await compose(source.environment, ["config", "--format", "json"])).stdout,
    ));
    expect(rendered.services["artifact-server"]).toMatchObject({
      cap_drop: ["ALL"],
      command: [
        "start-compact",
        "--data",
        "/var/lib/artifact-server/data",
        "--host",
        "0.0.0.0",
        "--port",
        "8787",
      ],
      container_name: `${source.name}-app`,
      image: composeImage,
      init: true,
      pids_limit: 256,
      read_only: true,
      restart: "unless-stopped",
      security_opt: ["no-new-privileges:true"],
      user: "1000:1000",
    });
    expect(rendered.services["artifact-server"].ports).toEqual([{
      host_ip: "127.0.0.1",
      published: String(source.port),
      target: 8787,
    }]);
    expect(rendered.services["artifact-server"].volumes).toEqual([{
      source: "artifact-server-data",
      target: "/var/lib/artifact-server",
      type: "volume",
    }]);

    const startedAt = performance.now();
    await compose(source.environment, [
      "up", "--detach", "--wait", "--wait-timeout", "30", "artifact-server",
    ]);
    const startupMilliseconds = performance.now() - startedAt;
    await waitForReady(source.port);
    const firstContainerId = await serviceContainerId(source);
    const inspection = containerInspectionSchema.parse(JSON.parse(
      (await command("docker", ["inspect", firstContainerId])).stdout,
    ))[0];
    expect(inspection).toBeDefined();
    expect(inspection?.Config.User).toBe("1000:1000");
    expect(inspection?.HostConfig).toMatchObject({
      CapDrop: ["ALL"],
      PidsLimit: 256,
      Privileged: false,
      ReadonlyRootfs: true,
      SecurityOpt: ["no-new-privileges:true"],
    });
    expect(inspection?.Mounts).toEqual([expect.objectContaining({
      Destination: "/var/lib/artifact-server",
      Type: "volume",
    })]);
    expect(Object.keys(inspection?.HostConfig.Tmpfs ?? {})).toEqual(["/tmp"]);

    const filePublication = await publishFixture(source, apiToken, {
      kind: "file",
      text: "compact compose file bytes\n",
    });
    const sitePublication = await publishFixture(source, apiToken, {
      kind: "site",
      text: "compact compose site",
    });
    expect(await fetchContent(filePublication.links.version, source.port))
      .toBe("compact compose file bytes\n");
    expect(await fetchContent(sitePublication.links.version, source.port))
      .toContain("compact compose site");
    expect(await fetchContent(
      new URL("/assets/app.js", sitePublication.links.version).toString(),
      source.port,
    )).toContain("dataset.compose");
    const secondSitePublication = await publishFixture(
      source,
      apiToken,
      {kind: "site", text: "compact compose site version two"},
      {
        artifactId: sitePublication.artifact.id,
        expectedVersionId: sitePublication.version.id,
      },
    );
    expect(secondSitePublication.artifact.id).toBe(sitePublication.artifact.id);
    expect(secondSitePublication.version.number).toBe(2);

    await compose(source.environment, ["restart", "artifact-server"]);
    await waitForReady(source.port);
    expect(await fetchContent(filePublication.links.version, source.port))
      .toBe("compact compose file bytes\n");

    await compose(source.environment, [
      "up", "--detach", "--force-recreate", "--wait", "--wait-timeout", "30",
      "artifact-server",
    ]);
    const replacementContainerId = await serviceContainerId(source);
    expect(replacementContainerId).not.toBe(firstContainerId);
    expect(await fetchContent(secondSitePublication.links.version, source.port))
      .toContain("compact compose site version two");
    const sourceSnapshot = await fetchStateSnapshot(
      source,
      apiToken,
      [filePublication, sitePublication, secondSitePublication],
    );

    const workspace = await temporaryDirectory("artifact-server-compose-recovery-");
    const backupDirectory = path.join(workspace, "backup");
    const backupStartedAt = performance.now();
    await command("bash", [backupScript, backupDirectory], source.environment);
    const backupMilliseconds = performance.now() - backupStartedAt;
    await waitForReady(source.port);
    const backupSupport = supportManifestSchema.parse(JSON.parse(
      await readFile(path.join(backupDirectory, "support-manifest.json"), "utf8"),
    ));
    expect(backupSupport).toMatchObject({
      imageRevision: composeRevision,
      installationId: initialization.installationId,
    });

    await compose(source.environment, ["stop", "artifact-server"]);
    const restored = await createProject("compact-restored", {}, source.port);
    const restoreStartedAt = performance.now();
    await command("bash", [restoreScript, backupDirectory], restored.environment);
    const restoreMilliseconds = performance.now() - restoreStartedAt;
    const restoredIntegrity = integritySchema.parse(JSON.parse(
      (await compose(restored.environment, [
        "run", "--rm", "--no-deps", "artifact-server",
        "integrity", "check", "--mode", "compact",
        "--data", "/var/lib/artifact-server/data",
      ])).stdout,
    ));
    expect(restoredIntegrity).toMatchObject({
      artifactsChecked: 2,
      problems: [],
      status: "healthy",
      versionsChecked: 3,
    });
    await compose(restored.environment, [
      "up", "--detach", "--wait", "--wait-timeout", "30", "artifact-server",
    ]);
    expect(await fetchContent(filePublication.links.version, restored.port))
      .toBe("compact compose file bytes\n");
    expect(await fetchContent(secondSitePublication.links.version, restored.port))
      .toContain("compact compose site version two");
    const restoredSnapshot = await fetchStateSnapshot(
      restored,
      apiToken,
      [filePublication, sitePublication, secondSitePublication],
    );
    expect(restoredSnapshot).toEqual(sourceSnapshot);
    const restoredSupport = await supportManifest(restored);
    expect(restoredSupport.installationId).toBe(initialization.installationId);

    await writeFile(
      path.join(repositoryRoot, "evidence/compact-compose-runtime-baseline.json"),
      `${JSON.stringify({
        backupMilliseconds,
        measuredAt: new Date().toISOString(),
        platform: process.platform,
        restoreMilliseconds,
        startupMilliseconds,
      }, null, 2)}\n`,
    );
  });

  test("DEP-005-F: the package refuses scaling, missing durable state, broken permissions, missing secrets, and invalid isolation", async () => {
    const missingImage = await createProject("compact-no-image");
    const missingImageEnvironment = {
      ...missingImage.environment,
      ARTIFACT_SERVER_IMAGE: undefined,
    };
    const missingImageResult = await compose(
      missingImageEnvironment,
      ["config"],
      true,
    );
    expect(missingImageResult.exitCode).not.toBe(0);

    const scale = await createProject("compact-scale");
    const scaleResult = await compose(scale.environment, [
      "up", "--detach", "--scale", "artifact-server=2", "artifact-server",
    ], true);
    expect(scaleResult.exitCode).not.toBe(0);
    expect(scaleResult.stderr).toContain("custom container name");

    const uninitialized = await createProject("compact-uninitialized");
    const uninitializedResult = await compose(uninitialized.environment, [
      "up", "--detach", "--wait", "--wait-timeout", "10", "artifact-server",
    ], true);
    expect(uninitializedResult.exitCode).not.toBe(0);
    expect(await isReady(uninitialized.port)).toBe(false);

    const ephemeral = await createProject("compact-ephemeral");
    const workspace = await temporaryDirectory("artifact-server-compose-hostile-");
    const ephemeralOverride = path.join(workspace, "compose.ephemeral.yaml");
    await writeFile(
      ephemeralOverride,
      "services:\n  artifact-server:\n    volumes: !reset []\n",
    );
    const ephemeralResult = await command("docker", [
      "compose", "--file", composeFile, "--file", ephemeralOverride,
      "run", "--rm", "--no-deps", "artifact-server", "init",
      "--admin-email", "admin@example.test",
      "--data", "/var/lib/artifact-server/data",
    ], ephemeral.environment, true);
    expect(ephemeralResult.exitCode).not.toBe(0);
    expect(redact(ephemeralResult.stdout + ephemeralResult.stderr))
      .not.toContain("bootstrapCredential");

    const invalidIsolation = await createProject("compact-domain", {
      ARTIFACT_SERVER_CONTENT_DOMAIN: "content.example.com",
    });
    await initialize(invalidIsolation);
    const isolationResult = await compose(invalidIsolation.environment, [
      "up", "--detach", "--wait", "--wait-timeout", "10", "artifact-server",
    ], true);
    expect(isolationResult.exitCode).not.toBe(0);
    expect(await isReady(invalidIsolation.port)).toBe(false);

    const missingSecret = await createProject("compact-secret");
    await initialize(missingSecret);
    await compose(missingSecret.environment, [
      "run", "--rm", "--no-deps",
      "--entrypoint", "/bin/sh", "artifact-server", "-c",
      "rm /var/lib/artifact-server/data/secrets/api-token",
    ]);
    const secretResult = await compose(missingSecret.environment, [
      "up", "--detach", "--wait", "--wait-timeout", "10", "artifact-server",
    ], true);
    expect(secretResult.exitCode).not.toBe(0);
    expect(await isReady(missingSecret.port)).toBe(false);

    const denied = await createProject("compact-permissions");
    await initialize(denied);
    await compose(denied.environment, [
      "run", "--rm", "--no-deps",
      "--entrypoint", "/bin/sh", "artifact-server", "-c",
      "chmod 000 /var/lib/artifact-server/data",
    ]);
    const deniedResult = await compose(denied.environment, [
      "up", "--detach", "--wait", "--wait-timeout", "10", "artifact-server",
    ], true);
    expect(deniedResult.exitCode).not.toBe(0);
    expect(await isReady(denied.port)).toBe(false);

    const incompleteIdentity = await createProject("compact-identity", {
      ARTIFACT_SERVER_WORKOS_CLIENT_ID: "client_incomplete",
    });
    await initialize(incompleteIdentity);
    const identityResult = await compose(incompleteIdentity.environment, [
      "up", "--detach", "--wait", "--wait-timeout", "10", "artifact-server",
    ], true);
    expect(identityResult.exitCode).not.toBe(0);
    expect(await isReady(incompleteIdentity.port)).toBe(false);
  });

  test("OPS-003-F: restore rejects corruption, incomplete backups, running targets, and nonempty volumes", async () => {
    const source = await createProject("compact-backup-source");
    await initialize(source);
    const sourceApiToken = await readApiToken(source);
    registerSensitive(sourceApiToken);
    await compose(source.environment, [
      "up", "--detach", "--wait", "--wait-timeout", "30", "artifact-server",
    ]);
    await publishFixture(source, sourceApiToken, {
      kind: "file",
      text: "restore failure must remain unavailable\n",
    });
    const workspace = await temporaryDirectory("artifact-server-compose-backup-failure-");
    const backupDirectory = path.join(workspace, "backup");
    await command("bash", [backupScript, backupDirectory], source.environment);

    const incompleteDirectory = path.join(workspace, "incomplete");
    await cp(backupDirectory, incompleteDirectory, {recursive: true});
    await writeFile(path.join(incompleteDirectory, "INCOMPLETE"), "incomplete\n");
    const incompleteTarget = await createProject("compact-incomplete-target");
    const incompleteResult = await command(
      "bash",
      [restoreScript, incompleteDirectory],
      incompleteTarget.environment,
      true,
    );
    expect(incompleteResult.exitCode).not.toBe(0);
    expect(incompleteResult.stderr).toContain("marked incomplete");

    const corruptDirectory = path.join(workspace, "corrupt");
    await cp(backupDirectory, corruptDirectory, {recursive: true});
    const corruptArchive = await open(path.join(corruptDirectory, "data.tar"), "r+");
    try {
      await corruptArchive.write(Buffer.from([0x58]), 0, 1, 32);
    } finally {
      await corruptArchive.close();
    }
    const corruptTarget = await createProject("compact-corrupt-target");
    const corruptResult = await command(
      "bash",
      [restoreScript, corruptDirectory],
      corruptTarget.environment,
      true,
    );
    expect(corruptResult.exitCode).not.toBe(0);
    expect(corruptResult.stderr).toContain("checksum does not match");

    const linkedDirectory = path.join(workspace, "linked");
    await cp(backupDirectory, linkedDirectory, {recursive: true});
    const linkedFixture = path.join(workspace, "linked-fixture");
    await mkdir(path.join(linkedFixture, "data"), {recursive: true});
    await symlink(
      "/tmp/compact-restore-must-not-follow",
      path.join(linkedFixture, "data", "unsafe-link"),
    );
    await command("tar", [
      "-C", linkedFixture, "-cf", path.join(linkedDirectory, "data.tar"), "data",
    ]);
    await writeBackupChecksum(linkedDirectory);
    const linkedTarget = await createProject("compact-linked-target");
    const linkedResult = await command(
      "bash",
      [restoreScript, linkedDirectory],
      linkedTarget.environment,
      true,
    );
    expect(linkedResult.exitCode).not.toBe(0);
    expect(linkedResult.stderr).toContain("link or unsupported filesystem entry");

    const partialDirectory = path.join(workspace, "partial");
    await cp(backupDirectory, partialDirectory, {recursive: true});
    const partialFixture = path.join(workspace, "partial-fixture");
    await mkdir(partialFixture);
    await command("tar", [
      "-C", partialFixture, "-xf", path.join(partialDirectory, "data.tar"),
    ]);
    const blobSearch = await command("find", [
      path.join(partialFixture, "data", "blobs"), "-type", "f", "-print",
    ]);
    const [missingBlobPath] = blobSearch.stdout.trim().split("\n");
    if (missingBlobPath === undefined || missingBlobPath.length === 0) {
      throw new Error("The populated compact backup did not contain a blob.");
    }
    await rm(missingBlobPath);
    await command("tar", [
      "-C", partialFixture, "-cf", path.join(partialDirectory, "data.tar"), "data",
    ]);
    await writeBackupChecksum(partialDirectory);
    const partialTarget = await createProject("compact-partial-target");
    const partialResult = await command(
      "bash",
      [restoreScript, partialDirectory],
      partialTarget.environment,
      true,
    );
    expect(partialResult.exitCode).not.toBe(0);
    const partialStart = await compose(partialTarget.environment, [
      "up", "--detach", "--wait", "--wait-timeout", "10", "artifact-server",
    ], true);
    expect(partialStart.exitCode).not.toBe(0);
    expect(await isReady(partialTarget.port)).toBe(false);

    const runningTarget = await createProject("compact-running-target");
    await initialize(runningTarget);
    await compose(runningTarget.environment, [
      "up", "--detach", "--wait", "--wait-timeout", "30", "artifact-server",
    ]);
    const runningResult = await command(
      "bash",
      [restoreScript, backupDirectory],
      runningTarget.environment,
      true,
    );
    expect(runningResult.exitCode).not.toBe(0);
    expect(runningResult.stderr).toContain("Stop the target");

    const restored = await createProject("compact-nonempty-target");
    await command("bash", [restoreScript, backupDirectory], restored.environment);
    const repeatedResult = await command(
      "bash",
      [restoreScript, backupDirectory],
      restored.environment,
      true,
    );
    expect(repeatedResult.exitCode).not.toBe(0);
    expect(repeatedResult.stderr).toContain("not empty");
    expect(await isReady(restored.port)).toBe(false);
  });
});

interface ComposeProject {
  readonly environment: NodeJS.ProcessEnv;
  readonly name: string;
  readonly port: number;
}

type Fixture =
  | {readonly kind: "file"; readonly text: string}
  | {readonly kind: "site"; readonly text: string};

interface ExistingArtifactTarget {
  readonly artifactId: string;
  readonly expectedVersionId: string;
}

async function createProject(
  prefix: string,
  overrides: Readonly<Record<string, string | undefined>> = {},
  requestedPort?: number,
): Promise<ComposeProject> {
  const name = `${prefix}-${randomUUID().slice(0, 8)}`;
  const port = requestedPort ?? await availablePort();
  const environment: NodeJS.ProcessEnv = {
    ...process.env,
    ARTIFACT_SERVER_ALLOW_TEST_IMAGE_TAG: "true",
    ARTIFACT_SERVER_CONTENT_DOMAIN: contentDomain,
    ARTIFACT_SERVER_IMAGE: composeImage,
    ARTIFACT_SERVER_OIDC_CLIENT_ID: "compact-compose-integration",
    ARTIFACT_SERVER_OIDC_ISSUER: "https://identity.example.test",
    ARTIFACT_SERVER_ORIGIN: applicationOrigin,
    ARTIFACT_SERVER_PORT: String(port),
    ARTIFACT_SERVER_READINESS_WITHDRAWAL_MS: "0",
    ARTIFACT_SERVER_REQUEST_LOG_SAMPLE_RATE: "0",
    ARTIFACT_SERVER_SHUTDOWN_DEADLINE_MS: "5000",
    COMPOSE_PROJECT_NAME: name,
    ...overrides,
  };
  runtimeResources.projects.set(name, environment);
  return {environment, name, port};
}

async function initialize(
  project: ComposeProject,
): Promise<z.infer<typeof initializationSchema>> {
  const result = await compose(project.environment, [
    "run", "--rm", "--no-deps", "artifact-server", "init",
    "--admin-email", "admin@example.test",
    "--data", "/var/lib/artifact-server/data",
  ]);
  return initializationSchema.parse(JSON.parse(result.stdout));
}

async function readApiToken(project: ComposeProject): Promise<string> {
  return (await compose(project.environment, [
    "run", "--rm", "--no-deps", "--entrypoint", "/bin/sh",
    "artifact-server", "-c",
    "cat /var/lib/artifact-server/data/secrets/api-token",
  ])).stdout.trim();
}

async function publishFixture(
  project: ComposeProject,
  apiToken: string,
  fixture: Fixture,
  target?: ExistingArtifactTarget,
): Promise<z.infer<typeof publicationSchema>> {
  const directory = await temporaryDirectory("artifact-server-compose-fixture-");
  let inputPath: string;
  if (fixture.kind === "file") {
    inputPath = "/input/proof.txt";
    await writeFile(path.join(directory, "proof.txt"), fixture.text);
  } else {
    inputPath = "/input";
    await mkdir(path.join(directory, "assets"));
    await Promise.all([
      writeFile(
        path.join(directory, "index.html"),
        `<main>${fixture.text}</main><script src="/assets/app.js"></script>`,
      ),
      writeFile(
        path.join(directory, "assets/app.js"),
        "document.body.dataset.compose = 'ready';\n",
      ),
    ]);
  }
  await chmod(directory, 0o755);
  const environment = {
    ...project.environment,
    ARTIFACT_SERVER_API_TOKEN: apiToken,
  };
  const publicationArguments = [
    "run", "--rm", "--no-deps",
    "--env", "ARTIFACT_SERVER_API_TOKEN",
    "--volume", `${directory}:/input:ro`,
    "artifact-server", "publish", inputPath,
    "--server", "http://artifact-server:8787",
  ];
  if (target === undefined) {
    publicationArguments.push("--public");
  } else {
    publicationArguments.push(
      "--artifact",
      target.artifactId,
      "--expected-version",
      target.expectedVersionId,
    );
  }
  const result = await compose(environment, publicationArguments);
  return publicationSchema.parse(JSON.parse(result.stdout));
}

async function serviceContainerId(project: ComposeProject): Promise<string> {
  return (await compose(project.environment, ["ps", "--quiet", "artifact-server"]))
    .stdout.trim();
}

async function supportManifest(
  project: ComposeProject,
): Promise<z.infer<typeof supportManifestSchema>> {
  const result = await compose(project.environment, [
    "run", "--rm", "--no-deps", "artifact-server",
    "support", "manifest", "--mode", "compact",
    "--data", "/var/lib/artifact-server/data",
  ]);
  return supportManifestSchema.parse(JSON.parse(result.stdout));
}

async function fetchStateSnapshot(
  project: ComposeProject,
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
      `http://127.0.0.1:${project.port}${resourcePath}`,
      {headers: {Authorization: `Bearer ${apiToken}`}},
    );
    expect(response.status).toBe(200);
    return jsonValueSchema.parse(await response.json());
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

async function waitForReady(
  port: number,
  attemptsRemaining = 150,
): Promise<void> {
  if (await isReady(port)) return;
  if (attemptsRemaining <= 1) {
    throw new Error(`Compact Compose did not become ready on port ${port}.`);
  }
  await new Promise((resolve) => setTimeout(resolve, 100));
  return waitForReady(port, attemptsRemaining - 1);
}

async function isReady(port: number): Promise<boolean> {
  try {
    return (await fetch(`http://127.0.0.1:${port}/ready`)).status === 200;
  } catch {
    return false;
  }
}

async function availablePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = addressSchema.parse(server.address());
  await new Promise<void>((resolve, reject) => {
    server.close((error) => error === undefined ? resolve() : reject(error));
  });
  return address.port;
}

async function temporaryDirectory(prefix: string): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), prefix));
  runtimeResources.directories.add(directory);
  return directory;
}

async function writeBackupChecksum(backupDirectory: string): Promise<void> {
  const archive = await readFile(path.join(backupDirectory, "data.tar"));
  const digest = createHash("sha256").update(archive).digest("hex");
  await writeFile(
    path.join(backupDirectory, "data.tar.sha256"),
    `${digest}  data.tar\n`,
  );
}

function compose(
  environment: NodeJS.ProcessEnv,
  arguments_: readonly string[],
  allowFailure = false,
): Promise<CommandResult> {
  return command(
    "docker",
    ["compose", "--file", composeFile, ...arguments_],
    environment,
    allowFailure,
  );
}

interface CommandResult {
  readonly exitCode: number;
  readonly stderr: string;
  readonly stdout: string;
}

function command(
  executable: string,
  arguments_: readonly string[],
  environment: NodeJS.ProcessEnv = process.env,
  allowFailure = false,
): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    execFile(executable, arguments_, {
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
          `${executable} ${arguments_.join(" ")} failed (${exitCode}): ${result.stderr}`,
        ));
        return;
      }
      resolve(result);
    });
  });
}

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.length === 0) {
    throw new Error(`Run this test through pnpm test:compact-compose; ${name} is missing.`);
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
