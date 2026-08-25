import {randomBytes} from "node:crypto";
import {spawn} from "node:child_process";

import {z} from "zod";

const qualificationPort = 8799;
const qualificationOrigin = `http://127.0.0.1:${qualificationPort}`;
const startupTimeoutMilliseconds = 45_000;
const requestTimeoutMilliseconds = 60_000;
const shutdownTimeoutMilliseconds = 10_000;

const environmentSchema = z.object({
  ARTIFACT_SERVER_CLOUDFLARE_ARTIFACTS_LIVE: z.literal("1").optional(),
}).passthrough();
const resultSchema = z.object({
  checks: z.object({
    bindingControlPlane: z.literal("pass"),
    deterministicCommits: z.literal("pass"),
    exactReadTokenLookup: z.literal("pass"),
    smartHttpDataPlane: z.literal("pass"),
  }).strict(),
  repositoryName: z.string().startsWith("artifact-server-test-"),
  runId: z.string().regex(/^[a-f0-9]{20}$/u),
}).strict();

const environment = environmentSchema.parse(process.env);
if (environment.ARTIFACT_SERVER_CLOUDFLARE_ARTIFACTS_LIVE !== "1") {
  throw new Error(
    "Set ARTIFACT_SERVER_CLOUDFLARE_ARTIFACTS_LIVE=1 to authorize the bounded live suite.",
  );
}

const qualificationKey = randomBytes(32).toString("base64url");
const wrangler = spawn("pnpm", [
  "--dir",
  "deploy/cloudflare",
  "exec",
  "wrangler",
  "dev",
  "--config",
  "wrangler.artifacts-qualification.jsonc",
  "--remote",
  "--port",
  String(qualificationPort),
  "--var",
  `QUALIFICATION_KEY:${qualificationKey}`,
], {
  env: process.env,
  stdio: ["ignore", "pipe", "pipe"],
});

let output = "";
wrangler.stdout.setEncoding("utf8");
wrangler.stderr.setEncoding("utf8");
wrangler.stdout.on("data", (chunk: string) => {
  output = appendBounded(output, chunk);
});
wrangler.stderr.on("data", (chunk: string) => {
  output = appendBounded(output, chunk);
});

try {
  await waitUntilReady();
  const response = await fetch(qualificationOrigin, {
    headers: {Authorization: `Bearer ${qualificationKey}`},
    method: "POST",
    signal: AbortSignal.timeout(requestTimeoutMilliseconds),
  });
  if (!response.ok) {
    throw new Error(`Workers binding qualification returned HTTP ${response.status}.`);
  }
  const result = resultSchema.parse(await response.json());
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
} finally {
  await stopWrangler();
}

async function waitUntilReady(): Promise<void> {
  const deadline = Date.now() + startupTimeoutMilliseconds;
  return probeReadiness(deadline);
}

async function probeReadiness(deadline: number): Promise<void> {
  if (Date.now() >= deadline) {
    throw new Error(`Wrangler did not become ready.\n${output}`);
  }
  if (wrangler.exitCode !== null) {
    throw new Error(`Wrangler exited before qualification started.\n${output}`);
  }
  try {
    const response = await fetch(qualificationOrigin, {
      method: "GET",
      signal: AbortSignal.timeout(1_000),
    });
    if (response.status === 404) return;
  } catch {
    // The unauthenticated readiness probe is intentionally retried. The
    // authorized mutation request below is sent exactly once.
  }
  await new Promise((resolve) => setTimeout(resolve, 250));
  return probeReadiness(deadline);
}

async function stopWrangler(): Promise<void> {
  if (wrangler.exitCode !== null) return;
  wrangler.kill("SIGTERM");
  await Promise.race([
    new Promise<void>((resolve) => wrangler.once("exit", () => resolve())),
    new Promise<void>((resolve) => setTimeout(resolve, shutdownTimeoutMilliseconds)),
  ]);
  if (wrangler.exitCode === null) wrangler.kill("SIGKILL");
}

function appendBounded(current: string, chunk: string): string {
  return `${current}${chunk}`.slice(-32_768);
}
