import {randomBytes} from "node:crypto";
import {spawn} from "node:child_process";
import {mkdtemp, rm, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import path from "node:path";

import {z} from "zod";

const environmentSchema = z.object({
  ARTIFACT_SERVER_CLOUDFLARE_ACCOUNT_ID: z.string().min(1),
  ARTIFACT_SERVER_CLOUDFLARE_ARTIFACTS_NAMESPACE: z.string().min(1),
  ARTIFACT_SERVER_CLOUDFLARE_D1_DATABASE_ID: z.string().min(1),
  ARTIFACT_SERVER_INSTALLATION_ID: z.string().min(1),
}).passthrough();
const purgeResultSchema = z.object({
  alreadyDeletedRepositories: z.number().int().nonnegative(),
  deletedDuringRun: z.number().int().nonnegative().optional(),
  installationId: z.string(),
  logicalCopiedBytes: z.number().int().nonnegative(),
  providerIdentity: z.object({
    accountId: z.string(),
    namespace: z.string(),
    provider: z.literal("cloudflare-artifacts"),
  }).strict(),
  repositories: z.number().int().nonnegative(),
  repositoriesToDelete: z.number().int().nonnegative(),
}).strict();

const environment = environmentSchema.parse(process.env);
const commandArguments = process.argv.slice(2);
const plan = commandArguments.includes("--plan");
const apply = commandArguments.includes("--apply");
if (plan === apply) throw new Error("Choose exactly one of --plan or --apply.");
const confirmationIndex = commandArguments.indexOf("--confirm-installation");
const confirmation = confirmationIndex < 0
  ? undefined
  : commandArguments[confirmationIndex + 1];
if (apply && confirmation === undefined) {
  throw new Error("--apply requires --confirm-installation <installation-id>.");
}

const port = 8801;
const origin = `http://127.0.0.1:${port}`;
const purgeKey = randomBytes(32).toString("base64url");
const temporaryDirectory = await mkdtemp(path.join(tmpdir(), "artifact-purge-"));
const configPath = path.join(temporaryDirectory, "wrangler.json");
await writeFile(configPath, JSON.stringify({
  artifacts: [{
    binding: "ARTIFACTS",
    namespace: environment.ARTIFACT_SERVER_CLOUDFLARE_ARTIFACTS_NAMESPACE,
    remote: true,
  }],
  compatibility_date: "2026-08-25",
  compatibility_flags: ["nodejs_compat"],
  d1_databases: [{
    binding: "ARTIFACT_SERVER_D1_DATABASE",
    database_id: environment.ARTIFACT_SERVER_CLOUDFLARE_D1_DATABASE_ID,
    database_name: "artifact-server-git-history-purge",
    remote: true,
  }],
  main: path.resolve(
    "deploy/cloudflare/scripts/git-history-purge-worker.ts",
  ),
  name: "artifact-server-git-history-purge",
}), "utf8");

const wrangler = spawn("pnpm", [
  "--dir",
  "deploy/cloudflare",
  "exec",
  "wrangler",
  "dev",
  "--config",
  configPath,
  "--remote",
  "--port",
  String(port),
  "--var",
  `PURGE_KEY:${purgeKey}`,
  "--var",
  `ARTIFACT_SERVER_ACCOUNT_ID:${environment.ARTIFACT_SERVER_CLOUDFLARE_ACCOUNT_ID}`,
  "--var",
  `ARTIFACT_SERVER_NAMESPACE:${environment.ARTIFACT_SERVER_CLOUDFLARE_ARTIFACTS_NAMESPACE}`,
  "--var",
  `ARTIFACT_SERVER_INSTALLATION_ID:${environment.ARTIFACT_SERVER_INSTALLATION_ID}`,
], {env: process.env, stdio: ["ignore", "pipe", "pipe"]});
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
  await probeReadiness(Date.now() + 45_000);
  const response = await fetch(origin, {
    body: JSON.stringify({
      confirmInstallationId: confirmation,
      mode: plan ? "plan" : "apply",
    }),
    headers: {
      Authorization: `Bearer ${purgeKey}`,
      "Content-Type": "application/json",
    },
    method: "POST",
    signal: AbortSignal.timeout(120_000),
  });
  if (!response.ok) {
    throw new Error(
      `Cloudflare purge returned HTTP ${response.status}: ${await response.text()}`,
    );
  }
  process.stdout.write(
    `${JSON.stringify(purgeResultSchema.parse(await response.json()), null, 2)}\n`,
  );
} finally {
  await stopWrangler();
  await rm(temporaryDirectory, {force: true, recursive: true});
}

async function probeReadiness(deadline: number): Promise<void> {
  if (Date.now() >= deadline) {
    throw new Error(`Wrangler did not become ready.\n${output}`);
  }
  if (wrangler.exitCode !== null) {
    throw new Error(`Wrangler exited before purge started.\n${output}`);
  }
  try {
    const response = await fetch(origin, {
      method: "GET",
      signal: AbortSignal.timeout(1_000),
    });
    if (response.status === 404) return;
  } catch {
    // Only the unauthenticated read probe repeats. Apply is sent once.
  }
  await new Promise((resolve) => setTimeout(resolve, 250));
  return probeReadiness(deadline);
}

async function stopWrangler(): Promise<void> {
  if (wrangler.exitCode !== null) return;
  wrangler.kill("SIGTERM");
  await Promise.race([
    new Promise<void>((resolve) => wrangler.once("exit", () => resolve())),
    new Promise<void>((resolve) => setTimeout(resolve, 10_000)),
  ]);
  if (wrangler.exitCode === null) wrangler.kill("SIGKILL");
}

function appendBounded(current: string, chunk: string): string {
  return `${current}${chunk}`.slice(-32_768);
}
