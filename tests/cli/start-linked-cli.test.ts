import {spawn, type ChildProcess} from "node:child_process";
import {randomBytes} from "node:crypto";
import {mkdir, mkdtemp, realpath, rm, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import path from "node:path";
import {once} from "node:events";

import {afterEach, beforeEach, describe, expect, test} from "vitest";
import {z} from "zod";

import {reserveLoopbackPort} from "../support/runtime-harness.js";

const repositoryRoot = path.resolve(import.meta.dirname, "../..");
const cliExecutable = path.join(repositoryRoot, "node_modules/.bin/tsx");
const cliEntrypoint = path.join(repositoryRoot, "src/cli/main.ts");

const sessionSchema = z.object({
  capabilities: z.object({
    gitHistory: z.object({
      limits: z.object({
        fileCopyBytes: z.number().int().nonnegative(),
        logicalCopiedBytes: z.number().int().nonnegative(),
        logicalReservedBytes: z.number().int().nonnegative(),
        storageBudgetBytes: z.number().int().nonnegative().nullable(),
        versionCopyBytes: z.number().int().nonnegative(),
      }).strict(),
      provider: z.literal("cloudflare-artifacts"),
      providerState: z.literal("misconfigured"),
    }).strict(),
    linkedArtifacts: z.boolean(),
  }).strict(),
}).loose();
const linkedPublicationSchema = z.object({
  artifact: z.object({id: z.string().min(1)}).loose(),
  sourceBinding: z.object({
    path: z.string().min(1),
    status: z.literal("in-sync"),
  }).loose(),
}).loose();

describe("artifactserver start with linked files enabled", () => {
  let child: ChildProcess | null = null;
  let dataDirectory: string;
  let linkRoot: string;

  beforeEach(async () => {
    dataDirectory = await mkdtemp(
      path.join(tmpdir(), "artifact-server-start-linked-"),
    );
    linkRoot = await realpath(
      await mkdtemp(path.join(tmpdir(), "artifact-server-start-sources-")),
    );
  });

  afterEach(async () => {
    if (child !== null && child.exitCode === null) {
      const exited = once(child, "exit");
      child.kill("SIGTERM");
      await exited;
    }
    child = null;
    await rm(dataDirectory, {force: true, recursive: true});
    await rm(linkRoot, {force: true, recursive: true});
  });

  test("the environment flags reach the direct-start server and linking works", async () => {
    const apiToken = randomBytes(32).toString("base64url");
    await mkdir(dataDirectory, {mode: 0o700, recursive: true});
    await writeFile(
      path.join(dataDirectory, "local-api-token"),
      `${apiToken}\n`,
      {encoding: "utf8", mode: 0o600},
    );
    const sourcePath = path.join(linkRoot, "notes.md");
    await writeFile(sourcePath, "# linked through the real CLI start\n");

    const port = await reserveLoopbackPort();
    child = spawn(
      cliExecutable,
      [cliEntrypoint, "start", "--data", dataDirectory, "--port", String(port)],
      {
        cwd: repositoryRoot,
        env: {
          ...process.env,
          ARTIFACT_SERVER_CLOUDFLARE_ARTIFACTS_ACCOUNT_ID: "test-account",
          ARTIFACT_SERVER_CLOUDFLARE_ARTIFACTS_NAMESPACE:
            "artifact-server-test-cli",
          ARTIFACT_SERVER_GIT_HISTORY_PROVIDER: "cloudflare-artifacts",
          ARTIFACT_SERVER_LINKED_FILES: "on",
          ARTIFACT_SERVER_LINK_ROOTS: linkRoot,
          ARTIFACT_SERVER_REQUEST_LOG_SAMPLE_RATE: "0",
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    const stderrChunks: string[] = [];
    child.stderr?.on("data", (chunk: Buffer) =>
      stderrChunks.push(chunk.toString("utf8")));
    await waitForReady(child, port, () => stderrChunks.join(""));

    const baseUrl = `http://127.0.0.1:${port}`;
    const headers = {
      Authorization: `Bearer ${apiToken}`,
      "Content-Type": "application/json",
      "Idempotency-Key": "start-linked-cli-000000001",
    };

    const session = await fetch(new URL("/api/v1/session", baseUrl), {headers});
    expect(session.status).toBe(200);
    const sessionBody = sessionSchema.parse(await session.json());
    expect(sessionBody.capabilities.linkedArtifacts).toBe(true);
    expect(sessionBody.capabilities.gitHistory).toMatchObject({
      provider: "cloudflare-artifacts",
      providerState: "misconfigured",
    });

    const linkResponse = await fetch(new URL("/api/v1/artifacts/link", baseUrl), {
      body: JSON.stringify({path: sourcePath}),
      headers,
      method: "POST",
    });
    expect(linkResponse.status).toBe(201);
    const linked = linkedPublicationSchema.parse(await linkResponse.json());
    expect(linked.sourceBinding.path).toBe(sourcePath);
  }, 90_000);
});

/** Poll the health route until the spawned server accepts requests. */
async function waitForReady(
  child: ChildProcess,
  port: number,
  stderrText: () => string,
): Promise<void> {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(
        `The CLI start process exited early (${child.exitCode}): ${stderrText()}`,
      );
    }
    try {
      // Readiness polling is inherently sequential: each probe decides
      // whether another is needed.
      // eslint-disable-next-line no-await-in-loop
      const health = await fetch(`http://127.0.0.1:${port}/health`);
      if (health.ok) return;
    } catch {
      // The server is still booting; poll again shortly.
    }
    // eslint-disable-next-line no-await-in-loop
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`The CLI start process never became ready: ${stderrText()}`);
}
