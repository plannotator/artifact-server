import {spawn} from "node:child_process";
import {mkdtemp, realpath, rm, writeFile} from "node:fs/promises";
import {createServer, type Server} from "node:http";
import {tmpdir} from "node:os";
import path from "node:path";

import {afterEach, beforeEach, describe, expect, test} from "vitest";
import {z} from "zod";

import {
  createTestInstallation,
  removeTestInstallation,
  type RunningTestServer,
  startTestServer,
  type TestInstallation,
} from "../support/runtime-harness.js";

const repositoryRoot = path.resolve(import.meta.dirname, "../..");
const cliExecutable = path.join(repositoryRoot, "node_modules/.bin/tsx");
const cliEntrypoint = path.join(repositoryRoot, "src/cli/main.ts");
const assignedAddressSchema = z.object({port: z.number().int().positive()});
const linkedPublicationSchema = z.object({
  artifact: z.object({id: z.string(), name: z.string(), projectId: z.string()})
    .loose(),
  links: z.object({artifact: z.url(), version: z.url()}).loose(),
  replayed: z.boolean(),
  sourceBinding: z.object({
    lastVerifiedAt: z.iso.datetime(),
    path: z.string(),
    status: z.enum(["in-sync", "modified", "missing", "unreadable"]),
  }).loose(),
  version: z.object({id: z.string(), number: z.number().int().positive()})
    .loose(),
}).loose();

interface ProcessResult {
  readonly exitCode: number;
  readonly stderr: string;
  readonly stdout: string;
}

describe("artifactserver link", () => {
  let installation: TestInstallation;
  let linkRoot: string;
  let server: RunningTestServer | null = null;

  beforeEach(async () => {
    installation = await createTestInstallation();
    linkRoot = await realpath(
      await mkdtemp(path.join(tmpdir(), "artifact-server-link-cli-")),
    );
  });

  afterEach(async () => {
    if (server !== null) await server.stop();
    server = null;
    await removeTestInstallation(installation);
    await rm(linkRoot, {force: true, recursive: true});
  });

  test("links a file named by a relative path and prints the binding", async () => {
    server = await startTestServer(installation, {
      linkRoots: [linkRoot],
      linkedFiles: "on",
    });
    const sourcePath = path.join(linkRoot, "notes.md");
    await writeFile(sourcePath, "# linked from the CLI\n");

    const result = await runLinkCli(
      ["notes.md", "--server", server.baseUrl, "--name", "CLI linked notes"],
      {cwd: linkRoot, token: installation.apiToken},
    );

    expect({exitCode: result.exitCode, stderr: result.stderr}).toEqual({
      exitCode: 0,
      stderr: "",
    });
    const linked = linkedPublicationSchema.parse(JSON.parse(result.stdout));
    expect(linked.artifact.name).toBe("CLI linked notes");
    expect(linked.replayed).toBe(false);
    expect(linked.sourceBinding).toMatchObject({
      path: sourcePath,
      status: "in-sync",
    });
    expect(linked.version.number).toBe(1);
    expect(result.stdout).not.toContain(installation.apiToken);
  });

  test("explains the unavailable capability in one line and exits non-zero", async () => {
    server = await startTestServer(installation);
    const sourcePath = path.join(linkRoot, "notes.md");
    await writeFile(sourcePath, "# never linked\n");

    const result = await runLinkCli(
      [sourcePath, "--server", server.baseUrl],
      {cwd: repositoryRoot, token: installation.apiToken},
    );

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr.trim().split("\n")).toHaveLength(1);
    expect(result.stderr).toContain("This server does not link files.");
    expect(result.stderr).toContain("ARTIFACT_SERVER_LINKED_FILES=on");
  });

  test("refuses a path outside the configured link roots", async () => {
    server = await startTestServer(installation, {
      linkRoots: [linkRoot],
      linkedFiles: "on",
    });
    const outsideDirectory = await realpath(
      await mkdtemp(path.join(tmpdir(), "artifact-server-link-outside-")),
    );
    const outsidePath = path.join(outsideDirectory, "notes.md");
    await writeFile(outsidePath, "# outside every root\n");

    try {
      const result = await runLinkCli(
        [outsidePath, "--server", server.baseUrl],
        {cwd: repositoryRoot, token: installation.apiToken},
      );
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("LINK_PATH_OUTSIDE_ROOTS");
      expect(result.stderr).toContain("HTTP 403");
      expect(result.stderr).not.toContain(outsidePath);
    } finally {
      await rm(outsideDirectory, {force: true, recursive: true});
    }
  });

  test("CLI-SEC-001-F: never sends a local-owner token to an arbitrary explicit origin", async () => {
    const dataDirectory = await mkdtemp(
      path.join(tmpdir(), "artifact-server-link-credentials-"),
    );
    const localToken = "local-owner-token-that-must-never-leave-this-installation";
    const recorder = await startRequestRecorder();
    const sourcePath = path.join(linkRoot, "notes.md");
    await writeFile(path.join(dataDirectory, "local-api-token"), localToken);
    await writeFile(sourcePath, "# credential boundary\n");

    try {
      const result = await runLinkCli(
        [
          sourcePath,
          "--data",
          dataDirectory,
          "--server",
          recorder.origin,
        ],
        {cwd: repositoryRoot},
      );

      expect(result.exitCode).toBe(1);
      expect(recorder.requestCount()).toBe(0);
      expect(result.stdout).not.toContain(localToken);
      expect(result.stderr).not.toContain(localToken);
    } finally {
      await recorder.stop();
      await rm(dataDirectory, {force: true, recursive: true});
    }
  });

  test("CLI-SEC-002-F: refuses authenticated redirects", async () => {
    const target = await startRequestRecorder();
    const redirect = await startRequestRecorder(target.origin);
    const sourcePath = path.join(linkRoot, "notes.md");
    await writeFile(sourcePath, "# redirect boundary\n");

    try {
      const result = await runLinkCli(
        [sourcePath, "--server", redirect.origin],
        {cwd: repositoryRoot, token: installation.apiToken},
      );

      expect(result.exitCode).toBe(1);
      expect(redirect.requestCount()).toBe(1);
      expect(target.requestCount()).toBe(0);
      expect(result.stdout).not.toContain(installation.apiToken);
      expect(result.stderr).not.toContain(installation.apiToken);
    } finally {
      await Promise.all([redirect.stop(), target.stop()]);
    }
  });

  test("foundation: missing local credentials name real recovery commands", async () => {
    const dataDirectory = path.join(linkRoot, "missing local data");
    const sourcePath = path.join(linkRoot, "notes.md");
    await writeFile(sourcePath, "# local recovery\n");

    const result = await runLinkCli(
      [sourcePath, "--data", dataDirectory],
      {cwd: repositoryRoot},
    );

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("artifactserver open --data");
    expect(result.stderr).toContain("artifactserver start --data");
    expect(result.stderr).not.toContain("artifactserver up");
  });
});

function runLinkCli(
  commandArguments: readonly string[],
  options: {readonly cwd: string; readonly token?: string},
): Promise<ProcessResult> {
  return new Promise((resolve, reject) => {
    const environment = {...process.env};
    delete environment["ARTIFACT_SERVER_API_TOKEN"];
    delete environment["ARTIFACT_SERVER_URL"];
    if (options.token !== undefined) {
      environment["ARTIFACT_SERVER_API_TOKEN"] = options.token;
    }
    const child = spawn(
      cliExecutable,
      [cliEntrypoint, "link", ...commandArguments],
      {
        cwd: options.cwd,
        env: environment,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    const stdout: Uint8Array[] = [];
    const stderr: Uint8Array[] = [];
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.on("error", reject);
    child.on("close", (exitCode) => {
      resolve({
        exitCode: exitCode ?? -1,
        stderr: Buffer.concat(stderr).toString("utf8"),
        stdout: Buffer.concat(stdout).toString("utf8"),
      });
    });
  });
}

interface RequestRecorder {
  readonly origin: string;
  readonly requestCount: () => number;
  readonly stop: () => Promise<void>;
}

async function startRequestRecorder(
  redirectOrigin?: string,
): Promise<RequestRecorder> {
  let requests = 0;
  const server = createServer((request, response) => {
    requests += 1;
    request.resume();
    if (redirectOrigin !== undefined) {
      response.writeHead(307, {
        location: new URL(request.url ?? "/", redirectOrigin).toString(),
      });
      response.end();
      return;
    }
    response.writeHead(500);
    response.end();
  });
  const origin = await listen(server);
  return {
    origin,
    requestCount: () => requests,
    stop: () => close(server),
  };
}

function listen(server: Server): Promise<string> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = assignedAddressSchema.safeParse(server.address());
      if (!address.success) {
        reject(new Error("The request recorder did not receive a TCP port."));
        return;
      }
      resolve(`http://127.0.0.1:${address.data.port}`);
    });
  });
}

function close(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error !== undefined) reject(error);
      else resolve();
    });
  });
}
