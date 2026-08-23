import {spawn} from "node:child_process";
import {mkdtemp, realpath, rm, writeFile} from "node:fs/promises";
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
});

function runLinkCli(
  commandArguments: readonly string[],
  options: {readonly cwd: string; readonly token: string},
): Promise<ProcessResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      cliExecutable,
      [cliEntrypoint, "link", ...commandArguments],
      {
        cwd: options.cwd,
        env: {
          ...process.env,
          ARTIFACT_SERVER_API_TOKEN: options.token,
        },
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
