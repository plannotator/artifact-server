import {
  spawn,
  type ChildProcessWithoutNullStreams,
} from "node:child_process";
import {createHash} from "node:crypto";
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import {request} from "node:http";
import {createServer} from "node:net";
import {tmpdir} from "node:os";
import path from "node:path";

import {afterEach, describe, expect, test} from "vitest";
import {z} from "zod";

const repositoryRoot = path.resolve(import.meta.dirname, "../..");
const runningProcesses = new Set<ChildProcessWithoutNullStreams>();
const assignedAddressSchema = z.object({port: z.number().int().positive()});
const packageMetadataSchema = z.object({
  engines: z.object({node: z.string()}),
  version: z.string().min(1),
});
const releaseManifestSchema = z.object({
  archive: z.string(),
  package: z.object({name: z.string(), version: z.string()}),
  runtime: z.object({
    nativeNodeExtensions: z.literal(false),
    node: z.string(),
  }),
  schemaVersion: z.literal(1),
  sha256: z.string().regex(/^[a-f0-9]{64}$/u),
  sizeBytes: z.number().int().positive(),
});
const publicationSchema = z.object({
  artifact: z.object({
    accessSetting: z.enum(["account_required", "public_link"]),
    id: z.string(),
    name: z.string(),
  }),
  links: z.object({artifact: z.url(), version: z.url()}),
  version: z.object({id: z.string(), number: z.number().int().positive()}),
});

afterEach(async () => {
  await Promise.all([...runningProcesses].map(stopProcess));
});

describe("direct local release package", () => {
  test("DEP-019-B DEP-019-F: installs without development tools and preserves published bytes across replacement and restore", async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), "artifact-server-release-test-"));
    const outputDirectory = path.join(workspace, "release");
    const firstInstallation = path.join(workspace, "installed-a");
    const secondInstallation = path.join(workspace, "installed-b");
    const dataDirectory = path.join(workspace, "data");
    const backupDirectory = path.join(workspace, "backup");
    const restoredDirectory = path.join(workspace, "restored");
    let server: ChildProcessWithoutNullStreams | undefined;

    try {
      await runCommand(
        "bash",
        [path.join(repositoryRoot, "scripts/build-local-package.sh"), outputDirectory],
        repositoryRoot,
      );
      const archive = await requireSingleArchive(outputDirectory);
      const archiveBytes = await readFile(archive);
      const archiveSha256 = createHash("sha256").update(archiveBytes).digest("hex");
      const releaseManifest = releaseManifestSchema.parse(JSON.parse(
        await readFile(`${archive}.manifest.json`, "utf8"),
      ));
      expect(archiveBytes.byteLength).toBeGreaterThan(1_000_000);
      expect(archiveSha256).toMatch(/^[a-f0-9]{64}$/u);
      expect(releaseManifest).toMatchObject({
        archive: path.basename(archive),
        runtime: {nativeNodeExtensions: false, node: ">=24.12.0"},
        sha256: archiveSha256,
        sizeBytes: archiveBytes.byteLength,
      });

      await extractPackage(archive, firstInstallation);
      await extractPackage(archive, secondInstallation);

      const executableA = path.join(firstInstallation, "artifactserver/bin/artifactserver");
      const executableB = path.join(secondInstallation, "artifactserver/bin/artifactserver");
      const windowsLauncher = await readFile(
        path.join(firstInstallation, "artifactserver/bin/artifactserver.cmd"),
        "utf8",
      );
      expect(windowsLauncher).toContain("node \"%~dp0\\..\\dist\\cli\\main.js\" %*");
      const packageMetadata = packageMetadataSchema.parse(JSON.parse(
        await readFile(path.join(firstInstallation, "artifactserver/package.json"), "utf8"),
      ));
      const version = await runCommand(executableA, ["--version"], workspace);
      expect(version.stdout.trim()).toBe(packageMetadata.version);
      expect(packageMetadata.engines.node).toBe(">=24.12.0");

      await expectMissing(path.join(firstInstallation, "artifactserver/src"));
      await expectMissing(path.join(firstInstallation, "artifactserver/tests"));
      await expectMissing(path.join(firstInstallation, "artifactserver/node_modules/typescript"));
      await expectMissing(path.join(firstInstallation, "artifactserver/node_modules/tsx"));
      await expectMissing(path.join(firstInstallation, "artifactserver/node_modules/vitest"));
      await expectMissing(path.join(firstInstallation, "artifactserver/node_modules/oxlint"));

      const fixturePath = path.join(workspace, "release-proof.html");
      const fixture = "<!doctype html><title>Packaged Artifact Server</title>";
      await writeFile(fixturePath, fixture);
      const port = await availablePort();
      server = startPackagedServer(executableA, dataDirectory, port, workspace);
      await waitForReady(server, port);

      const publicationResult = await runCommand(
        executableA,
        [
          "publish",
          fixturePath,
          "--data",
          dataDirectory,
          "--server",
          `http://127.0.0.1:${port}`,
          "--public",
        ],
        workspace,
      );
      const publication = publicationSchema.parse(JSON.parse(publicationResult.stdout));
      expect(publication.artifact).toMatchObject({
        accessSetting: "public_link",
        name: "release-proof.html",
      });
      expect(await fetchPublishedContent(publication.links.version, port)).toBe(fixture);
      expect((await stat(dataDirectory)).mode & 0o777).toBe(0o700);
      expect((await stat(path.join(dataDirectory, "local-api-token"))).mode & 0o777)
        .toBe(0o600);

      await stopProcess(server);
      server = undefined;
      await cp(dataDirectory, backupDirectory, {recursive: true});

      server = startPackagedServer(executableB, dataDirectory, port, workspace);
      await waitForReady(server, port);
      expect(await fetchPublishedContent(publication.links.version, port)).toBe(fixture);
      await stopProcess(server);
      server = undefined;

      await cp(backupDirectory, restoredDirectory, {recursive: true});
      server = startPackagedServer(executableB, restoredDirectory, port, workspace);
      await waitForReady(server, port);
      expect(await fetchPublishedContent(publication.links.version, port)).toBe(fixture);
      const restoredToken = (await readFile(
        path.join(restoredDirectory, "local-api-token"),
        "utf8",
      )).trim();
      const restoredArtifact = await fetch(
        `http://127.0.0.1:${port}/api/v1/artifacts/${publication.artifact.id}`,
        {headers: {Authorization: `Bearer ${restoredToken}`}},
      );
      expect(restoredArtifact.status).toBe(200);
      await expect(restoredArtifact.json()).resolves.toMatchObject({
        artifact: {
          currentVersionId: publication.version.id,
          id: publication.artifact.id,
        },
      });

      await writeFile(
        path.join(repositoryRoot, "evidence/local-package-build.json"),
        `${JSON.stringify({
          ...releaseManifest,
          verification: {
            node: process.version,
            platform: process.platform,
            result: "pass",
          },
        }, null, 2)}\n`,
      );
    } finally {
      if (server !== undefined) await stopProcess(server);
      await rm(workspace, {force: true, recursive: true});
    }
  });
});

async function requireSingleArchive(outputDirectory: string): Promise<string> {
  const entries = (await readdir(outputDirectory))
    .filter((entry) => entry.endsWith(".tar.gz"));
  if (entries.length !== 1) {
    throw new Error(`Expected one local release archive, received ${entries.length}.`);
  }
  const entry = entries[0];
  if (entry === undefined) throw new Error("The local release archive is missing.");
  return path.join(outputDirectory, entry);
}

async function extractPackage(archive: string, destination: string): Promise<void> {
  await mkdir(destination, {recursive: true});
  await runCommand("tar", ["-xzf", archive, "-C", destination], destination);
}

function startPackagedServer(
  executable: string,
  dataDirectory: string,
  port: number,
  cwd: string,
): ChildProcessWithoutNullStreams {
  const child = spawn(
    executable,
    ["start", "--data", dataDirectory, "--port", String(port)],
    {
      cwd,
      env: isolatedRuntimeEnvironment(),
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  runningProcesses.add(child);
  return child;
}

function isolatedRuntimeEnvironment(): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {
    ...process.env,
    ARTIFACT_SERVER_REQUEST_LOG_SAMPLE_RATE: "0",
    HTTP_PROXY: "http://127.0.0.1:1",
    HTTPS_PROXY: "http://127.0.0.1:1",
    NODE_PATH: "",
    NO_PROXY: "localhost,127.0.0.1",
  };
  for (const name of [
    "ARTIFACT_SERVER_API_TOKEN",
    "ARTIFACT_SERVER_BOOTSTRAP_ADMIN_EMAIL",
    "ARTIFACT_SERVER_ORIGIN",
    "ARTIFACT_SERVER_WORKOS_API_KEY",
    "ARTIFACT_SERVER_WORKOS_CLIENT_ID",
  ]) {
    delete environment[name];
  }
  return environment;
}

async function waitForReady(
  child: ChildProcessWithoutNullStreams,
  port: number,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    let output = "";
    const readyText = `Browser login: http://localhost:${port}/auth/local?token=`;
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error(`Packaged server did not become ready: ${redactTokens(output)}`));
    }, 15_000);
    const receive = (chunk: Buffer) => {
      output += chunk.toString("utf8");
      if (!output.includes(readyText)) return;
      cleanup();
      resolve();
    };
    const exit = () => {
      cleanup();
      reject(new Error(`Packaged server exited before readiness: ${redactTokens(output)}`));
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

async function stopProcess(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (!runningProcesses.delete(child) || child.exitCode !== null) return;
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error("Packaged server did not stop after SIGTERM."));
    }, 10_000);
    const exit = () => {
      cleanup();
      resolve();
    };
    const error = (cause: Error) => {
      cleanup();
      reject(cause);
    };
    const cleanup = () => {
      clearTimeout(timeout);
      child.off("error", error);
      child.off("exit", exit);
    };
    child.once("error", error);
    child.once("exit", exit);
    child.kill("SIGTERM");
  });
}

function runCommand(
  command: string,
  arguments_: readonly string[],
  cwd: string,
): Promise<ProcessResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, arguments_, {
      cwd,
      env: isolatedRuntimeEnvironment(),
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout: Uint8Array[] = [];
    const stderr: Uint8Array[] = [];
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.once("error", reject);
    child.once("close", (exitCode) => {
      const result = {
        exitCode: exitCode ?? -1,
        stderr: Buffer.concat(stderr).toString("utf8"),
        stdout: Buffer.concat(stdout).toString("utf8"),
      };
      if (result.exitCode === 0) resolve(result);
      else {
        const diagnostic = [result.stderr, result.stdout]
          .filter((output) => output.length > 0)
          .join("\n");
        reject(new Error(
          `${command} exited with ${result.exitCode}: ${redactTokens(diagnostic)}`,
        ));
      }
    });
  });
}

async function fetchPublishedContent(contentUrl: string, port: number): Promise<string> {
  const target = new URL(contentUrl);
  return new Promise((resolve, reject) => {
    const outgoing = request(
      {
        headers: {Host: `${target.hostname}:${port}`},
        hostname: "127.0.0.1",
        method: "GET",
        path: `${target.pathname}${target.search}`,
        port,
      },
      (incoming) => {
        const chunks: Uint8Array[] = [];
        incoming.on("data", (chunk: Buffer) => chunks.push(chunk));
        incoming.on("end", () => {
          if (incoming.statusCode !== 200) {
            reject(new Error(`Packaged content returned HTTP ${incoming.statusCode}.`));
            return;
          }
          resolve(Buffer.concat(chunks).toString("utf8"));
        });
      },
    );
    outgoing.once("error", reject);
    outgoing.end();
  });
}

function availablePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = assignedAddressSchema.safeParse(server.address());
      if (!address.success) {
        server.close();
        reject(new Error("The operating system did not assign a TCP port."));
        return;
      }
      server.close((error) => {
        if (error === undefined) resolve(address.data.port);
        else reject(error);
      });
    });
  });
}

async function expectMissing(candidate: string): Promise<void> {
  await expect(stat(candidate)).rejects.toMatchObject({code: "ENOENT"});
}

function redactTokens(output: string): string {
  return output
    .replace(/Local API token: [A-Za-z0-9_-]+/gu, "Local API token: [REDACTED]")
    .replace(/(Browser login: [^\s?]+\?token=)[A-Za-z0-9_-]+/gu, "$1[REDACTED]");
}

interface ProcessResult {
  readonly exitCode: number;
  readonly stderr: string;
  readonly stdout: string;
}
