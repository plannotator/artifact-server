import {spawn, type ChildProcessWithoutNullStreams} from "node:child_process";
import {
  mkdtemp,
  chmod,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import {createServer} from "node:net";
import {tmpdir} from "node:os";
import path from "node:path";
import {DatabaseSync} from "node:sqlite";

import {afterEach, describe, expect, test} from "vitest";
import {Effect} from "effect";
import {z} from "zod";

import {
  parseCompactRuntimeConfiguration,
  parseExternalStorageRuntimeConfiguration,
  summarizeRuntimeConfiguration,
} from "../../src/lifecycle/runtime-configuration.js";

const repositoryRoot = path.resolve(import.meta.dirname, "../..");
const runningProcesses = new Set<ChildProcessWithoutNullStreams>();
const assignedAddressSchema = z.object({port: z.number().int().positive()});
const initializedSchema = z.object({
  bootstrapCredential: z.string().min(32),
  dataDirectory: z.string(),
  installationId: z.string().startsWith("inst_"),
});
const publicationSchema = z.object({
  artifact: z.object({id: z.string()}),
  version: z.object({id: z.string()}),
});

afterEach(async () => {
  await Promise.all([...runningProcesses].map(stopProcess));
});

describe("Artifact Server lifecycle CLI", () => {
  test("foundation: initialization, configuration, and support diagnostics are stable and secret-free", async () => {
    const parent = await mkdtemp(path.join(tmpdir(), "artifact-server-lifecycle-"));
    const dataDirectory = path.join(parent, "data");
    try {
      const initialized = await runCli([
        "init",
        "--admin-email",
        "admin@example.test",
        "--data",
        dataDirectory,
      ]);
      expect(initialized.exitCode).toBe(0);
      const initialization = initializedSchema.parse(JSON.parse(initialized.output));
      const apiToken = (await readFile(
        path.join(dataDirectory, "secrets/api-token"),
        "utf8",
      )).trim();
      const browserToken = (await readFile(
        path.join(dataDirectory, "secrets/browser-bootstrap-token"),
        "utf8",
      )).trim();
      expect((await stat(dataDirectory)).mode & 0o777).toBe(0o700);
      expect((await stat(path.join(dataDirectory, "installation.json"))).mode & 0o777)
        .toBe(0o600);
      expect((await stat(path.join(dataDirectory, "secrets/api-token"))).mode & 0o777)
        .toBe(0o600);

      const environment = compactEnvironment();
      const checked = await runCli([
        "config",
        "check",
        "--mode",
        "compact",
        "--data",
        dataDirectory,
      ], environment);
      expect(checked.exitCode).toBe(0);
      expect(JSON.parse(checked.output)).toMatchObject({
        configuration: {
          credentialSources: {
            apiToken: "generated_file",
            browserBootstrapToken: "generated_file",
          },
          deploymentMode: "compact",
          interactiveIdentityProvider: "local",
          installationId: initialization.installationId,
          status: "valid",
        },
        providers: {status: "ready"},
      });
      expect(checked.output).not.toContain(apiToken);
      expect(checked.output).not.toContain(browserToken);
      expect(checked.output).not.toContain(initialization.bootstrapCredential);
      const incompleteWorkOs = await runCli([
        "config",
        "check",
        "--mode",
        "compact",
        "--data",
        dataDirectory,
      ], {
        ...environment,
        ARTIFACT_SERVER_WORKOS_API_KEY: "workos-secret-value",
      });
      expect(incompleteWorkOs.exitCode).not.toBe(0);
      expect(incompleteWorkOs.output).toContain("WorkOS login requires");
      expect(incompleteWorkOs.output).not.toContain("workos-secret-value");
      await chmod(path.join(dataDirectory, "secrets/api-token"), 0o644);
      const permissiveSecret = await runCli([
        "config",
        "check",
        "--mode",
        "compact",
        "--data",
        dataDirectory,
      ], environment);
      expect(permissiveSecret.exitCode).not.toBe(0);
      expect(permissiveSecret.output).toContain("cannot be read");
      expect(permissiveSecret.output).not.toContain(apiToken);
      await chmod(path.join(dataDirectory, "secrets/api-token"), 0o600);
      await expect(Effect.runPromise(parseCompactRuntimeConfiguration({
        dataDirectory,
        environment: {
          ...environment,
          ARTIFACT_SERVER_CONTENT_DOMAIN: "content.example.com",
        },
        hostname: "127.0.0.1",
        port: "8787",
      }))).rejects.toMatchObject({reason: "invalid_origin"});

      const support = await runCli([
        "support",
        "manifest",
        "--mode",
        "compact",
        "--data",
        dataDirectory,
      ], environment);
      expect(support.exitCode).toBe(0);
      expect(JSON.parse(support.output)).toMatchObject({
        adapters: {database: "sqlite", objectStorage: "filesystem"},
        installationId: initialization.installationId,
        product: "artifact-server",
        providers: {status: "ready"},
      });
      expect(support.output).not.toContain(apiToken);
      expect(support.output).not.toContain(browserToken);

      const repeated = await runCli([
        "init",
        "--admin-email",
        "other@example.test",
        "--data",
        dataDirectory,
      ]);
      expect(repeated.exitCode).not.toBe(0);
      expect(repeated.output).toContain("already contains files");
      expect(repeated.output).not.toContain(apiToken);
      expect(repeated.output).not.toContain(browserToken);

      const credentialFile = path.join(parent, "access-key");
      await writeFile(credentialFile, "file-secret\n", {mode: 0o600});
      const conflicting = await runCli([
        "config",
        "check",
        "--mode",
        "external-storage",
      ], {
        ...externalConfigurationEnvironment(),
        ARTIFACT_SERVER_S3_ACCESS_KEY_ID: "environment-secret",
        ARTIFACT_SERVER_S3_ACCESS_KEY_ID_FILE: credentialFile,
      });
      expect(conflicting.exitCode).not.toBe(0);
      expect(conflicting.output).toContain("cannot both be configured");
      expect(conflicting.output).not.toContain("environment-secret");
      expect(conflicting.output).not.toContain("file-secret");

      const secretFiles = {
        api: path.join(parent, "api-token"),
        database: path.join(parent, "database-url"),
        s3Access: path.join(parent, "s3-access"),
        s3Secret: path.join(parent, "s3-secret"),
      };
      await Promise.all([
        writeFile(secretFiles.api, `${"a".repeat(40)}\n`, {mode: 0o600}),
        writeFile(
          secretFiles.database,
          "postgres://user:password@database.example/artifacts\n",
          {mode: 0o600},
        ),
        writeFile(secretFiles.s3Access, "access-key\n", {mode: 0o600}),
        writeFile(secretFiles.s3Secret, "secret-key\n", {mode: 0o600}),
      ]);
      const fileBacked = await Effect.runPromise(
        parseExternalStorageRuntimeConfiguration({
          environment: {
            ...externalConfigurationEnvironment(),
            ARTIFACT_SERVER_API_TOKEN: undefined,
            ARTIFACT_SERVER_API_TOKEN_FILE: secretFiles.api,
            ARTIFACT_SERVER_DATABASE_URL: undefined,
            ARTIFACT_SERVER_DATABASE_URL_FILE: secretFiles.database,
            ARTIFACT_SERVER_S3_ACCESS_KEY_ID: undefined,
            ARTIFACT_SERVER_S3_ACCESS_KEY_ID_FILE: secretFiles.s3Access,
            ARTIFACT_SERVER_S3_SECRET_ACCESS_KEY: undefined,
            ARTIFACT_SERVER_S3_SECRET_ACCESS_KEY_FILE: secretFiles.s3Secret,
          },
          hostname: "127.0.0.1",
          port: "8787",
        }),
      );
      expect(summarizeRuntimeConfiguration(fileBacked).credentialSources)
        .toEqual({
          apiToken: "file",
          database: "file",
          objectStorageAccessKey: "file",
          objectStorageSecret: "file",
        });
      await expect(Effect.runPromise(parseExternalStorageRuntimeConfiguration({
        environment: {
          ...externalConfigurationEnvironment(),
          ARTIFACT_SERVER_S3_ENDPOINT: "https://user:password@storage.example",
        },
        hostname: "127.0.0.1",
        port: "8787",
      }))).rejects.toMatchObject({
        field: "ARTIFACT_SERVER_S3_ENDPOINT",
        reason: "invalid_value",
      });
      const providerChain = await Effect.runPromise(
        parseExternalStorageRuntimeConfiguration({
          environment: {
            ...externalConfigurationEnvironment(),
            ARTIFACT_SERVER_S3_ACCESS_KEY_ID: undefined,
            ARTIFACT_SERVER_S3_SECRET_ACCESS_KEY: undefined,
          },
          hostname: "127.0.0.1",
          port: "8787",
        }),
      );
      expect(summarizeRuntimeConfiguration(providerChain).credentialSources)
        .toMatchObject({
          objectStorageAccessKey: "provider_chain",
          objectStorageSecret: "provider_chain",
        });
      expect(providerChain.objectStorage).not.toHaveProperty("accessKeyId");
      await expect(Effect.runPromise(parseExternalStorageRuntimeConfiguration({
        environment: {
          ...externalConfigurationEnvironment(),
          ARTIFACT_SERVER_S3_SECRET_ACCESS_KEY: undefined,
        },
        hostname: "127.0.0.1",
        port: "8787",
      }))).rejects.toMatchObject({reason: "incomplete_configuration"});
    } finally {
      await rm(parent, {force: true, recursive: true});
    }
  });

  test("foundation: compact serving withdraws readiness and integrity scans real committed bytes", async () => {
    const parent = await mkdtemp(path.join(tmpdir(), "artifact-server-drain-"));
    const dataDirectory = path.join(parent, "data");
    const fixture = path.join(parent, "artifact.txt");
    await writeFile(fixture, "lifecycle integrity proof\n");
    const environment = compactEnvironment({
      ARTIFACT_SERVER_READINESS_WITHDRAWAL_MS: "300",
      ARTIFACT_SERVER_SHUTDOWN_DEADLINE_MS: "3000",
    });
    try {
      const initialized = await runCli([
        "init",
        "--admin-email",
        "admin@example.test",
        "--data",
        dataDirectory,
      ]);
      expect(initialized.exitCode).toBe(0);
      const port = await availablePort();
      const server = startCli([
        "start-compact",
        "--data",
        dataDirectory,
        "--port",
        String(port),
      ], environment);
      await waitForOutput(server, '"status":"ready"');

      const publication = await runCli([
        "publish",
        fixture,
        "--server",
        `http://127.0.0.1:${port}`,
        "--token-file",
        path.join(dataDirectory, "secrets/api-token"),
      ]);
      expect(publication.exitCode).toBe(0);
      publicationSchema.parse(JSON.parse(publication.output));

      const exited = processExit(server);
      server.kill("SIGTERM");
      await waitForReadinessState(port, "draining");
      await exited;
      runningProcesses.delete(server);

      const healthy = await runCli([
        "integrity",
        "check",
        "--mode",
        "compact",
        "--data",
        dataDirectory,
      ]);
      expect(healthy.exitCode).toBe(0);
      expect(JSON.parse(healthy.output)).toMatchObject({
        artifactsChecked: 1,
        blobsChecked: 1,
        problems: [],
        status: "healthy",
        versionsChecked: 1,
      });

      const databasePath = path.join(dataDirectory, "artifact-server.db");
      const database = new DatabaseSync(databasePath, {
        allowExtension: false,
        enableForeignKeyConstraints: false,
      });
      try {
        database.exec("DROP TRIGGER actions_project_update");
        database.prepare(`
          UPDATE actions SET project_id = 'prj_missing'
          WHERE id = (SELECT id FROM actions ORDER BY id LIMIT 1)
        `).run();
      } finally {
        database.close();
      }
      const crossProjectRecord = await runCli([
        "integrity",
        "check",
        "--mode",
        "compact",
        "--data",
        dataDirectory,
      ]);
      expect(crossProjectRecord.exitCode).toBe(2);
      expect(JSON.parse(crossProjectRecord.output)).toMatchObject({
        problems: [{code: "orphan_project"}],
        status: "corrupt",
      });
      const restoredDatabase = new DatabaseSync(databasePath, {
        allowExtension: false,
        enableForeignKeyConstraints: false,
      });
      try {
        restoredDatabase.exec(
          "UPDATE actions SET project_id = 'prj_default' WHERE project_id = 'prj_missing'",
        );
      } finally {
        restoredDatabase.close();
      }

      const blobPath = await firstBlobPath(path.join(dataDirectory, "blobs"));
      await writeFile(blobPath, "corrupted bytes\n");
      const corrupt = await runCli([
        "integrity",
        "check",
        "--mode",
        "compact",
        "--data",
        dataDirectory,
      ]);
      expect(corrupt.exitCode).toBe(2);
      expect(JSON.parse(corrupt.output)).toMatchObject({
        problems: [{code: "blob_size_mismatch"}],
        status: "corrupt",
      });
    } finally {
      await rm(parent, {force: true, recursive: true});
    }
  });
});

function compactEnvironment(
  overrides: NodeJS.ProcessEnv = {},
): NodeJS.ProcessEnv {
  return {
    ARTIFACT_SERVER_CONTENT_DOMAIN: "content.example.net",
    ARTIFACT_SERVER_ORIGIN: "https://artifacts.example.com",
    ARTIFACT_SERVER_REQUEST_LOG_SAMPLE_RATE: "0",
    ...overrides,
  };
}

function externalConfigurationEnvironment(): NodeJS.ProcessEnv {
  return {
    ARTIFACT_SERVER_API_TOKEN: "a".repeat(40),
    ARTIFACT_SERVER_BOOTSTRAP_ADMIN_EMAIL: "admin@example.test",
    ARTIFACT_SERVER_CONTENT_DOMAIN: "content.example.net",
    ARTIFACT_SERVER_DATABASE_URL: "postgres://user:secret@localhost/artifacts",
    ARTIFACT_SERVER_INSTALLATION_ID: "test-installation",
    ARTIFACT_SERVER_ORIGIN: "https://artifacts.example.com",
    ARTIFACT_SERVER_S3_BUCKET: "artifact-test-bucket",
    ARTIFACT_SERVER_S3_ACCESS_KEY_ID: "access-key",
    ARTIFACT_SERVER_S3_REGION: "us-east-1",
    ARTIFACT_SERVER_S3_SECRET_ACCESS_KEY: "secret-access-key",
  };
}

function startCli(
  arguments_: readonly string[],
  environment: NodeJS.ProcessEnv,
): ChildProcessWithoutNullStreams {
  const child = spawn(
    path.join(repositoryRoot, "node_modules/.bin/tsx"),
    [path.join(repositoryRoot, "src/cli/main.ts"), ...arguments_],
    {
      cwd: repositoryRoot,
      env: {...process.env, ...environment},
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  runningProcesses.add(child);
  return child;
}

function runCli(
  arguments_: readonly string[],
  environment: NodeJS.ProcessEnv = {},
): Promise<ProcessResult> {
  return new Promise((resolve, reject) => {
    const child = startCli(arguments_, environment);
    runningProcesses.delete(child);
    const output: Uint8Array[] = [];
    child.stdout.on("data", (chunk: Buffer) => output.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => output.push(chunk));
    child.on("error", reject);
    child.on("close", (exitCode) => {
      resolve({
        exitCode: exitCode ?? -1,
        output: Buffer.concat(output).toString("utf8").trim(),
      });
    });
  });
}

function waitForOutput(
  child: ChildProcessWithoutNullStreams,
  expected: string,
): Promise<void> {
  return new Promise((resolve, reject) => {
    let output = "";
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error(`Process did not emit ${expected}: ${output}`));
    }, 10_000);
    const receive = (chunk: Buffer) => {
      output += chunk.toString("utf8");
      if (!output.includes(expected)) return;
      cleanup();
      resolve();
    };
    const exit = () => {
      cleanup();
      reject(new Error(`Process exited before ${expected}: ${output}`));
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

async function waitForReadinessState(
  port: number,
  lifecycle: string,
): Promise<void> {
  const deadline = Date.now() + 1_000;
  const attempt = async (): Promise<void> => {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/ready`);
      const body = z.object({lifecycle: z.string()}).parse(await response.json());
      if (response.status === 503 && body.lifecycle === lifecycle) return;
    } catch {
      // The listener may close immediately after the withdrawal interval.
    }
    if (Date.now() >= deadline) {
      throw new Error(`Readiness never entered ${lifecycle}.`);
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
    return attempt();
  };
  return attempt();
}

function processExit(child: ChildProcessWithoutNullStreams): Promise<void> {
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", () => resolve());
  });
}

async function stopProcess(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (!runningProcesses.delete(child) || child.exitCode !== null) return;
  const exited = processExit(child);
  child.kill("SIGTERM");
  await exited;
}

async function firstBlobPath(directory: string): Promise<string> {
  const prefixes = await readdir(directory);
  const prefix = prefixes[0];
  if (prefix === undefined) throw new Error("No committed blob was found.");
  const prefixDirectory = path.join(directory, prefix);
  const entries = await readdir(prefixDirectory);
  const entry = entries[0];
  if (entry === undefined) throw new Error("No committed blob was found.");
  return path.join(prefixDirectory, entry);
}

function availablePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = assignedAddressSchema.parse(server.address());
      server.close((error) => {
        if (error === undefined) resolve(address.port);
        else reject(error);
      });
    });
  });
}

interface ProcessResult {
  readonly exitCode: number;
  readonly output: string;
}
