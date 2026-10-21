import {spawn} from "node:child_process";
import {mkdtemp, rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import path from "node:path";

import {afterAll, beforeAll, describe, expect, test} from "vitest";

import {
  startStubOidcProvider,
  type RunningStubOidcProvider,
} from "../support/stub-oidc-provider.js";

const repositoryRoot = path.resolve(import.meta.dirname, "../..");
const sameSiteEnvironment = {
  ARTIFACT_SERVER_CONTENT_DOMAIN: "content.example.com",
  ARTIFACT_SERVER_ORIGIN: "https://artifacts.example.com",
};

interface CommandResult {
  readonly exitCode: number;
  readonly output: string;
}

describe("same-site content domain", () => {
  let compactDirectory: string;
  let dataDirectory: string;
  let provider: RunningStubOidcProvider;

  beforeAll(async () => {
    compactDirectory = await mkdtemp(
      path.join(tmpdir(), "artifact-server-same-site-content-"),
    );
    dataDirectory = path.join(compactDirectory, "data");
    provider = await startStubOidcProvider();
    const initialized = await runCli([
      "init",
      "--admin-email",
      "administrator@example.test",
      "--data",
      dataDirectory,
    ], {});
    if (initialized.exitCode !== 0) {
      throw new Error(`Compact initialization failed: ${initialized.output}`);
    }
  });

  afterAll(async () => {
    await provider.stop();
    await rm(compactDirectory, {force: true, recursive: true});
  });

  test("CNT-003-F: a same-site content domain is rejected unless the operator explicitly accepts it", async () => {
    const rejected = await checkConfiguration(sameSiteEnvironment);
    expect(rejected.exitCode).not.toBe(0);
    expect(rejected.output).toContain("different registrable domains");

    const malformed = await checkConfiguration({
      ...sameSiteEnvironment,
      ARTIFACT_SERVER_ALLOW_SAME_SITE_CONTENT: "yes",
    });
    expect(malformed.exitCode).not.toBe(0);
    expect(malformed.output).toContain("ARTIFACT_SERVER_ALLOW_SAME_SITE_CONTENT");

    const accepted = await checkConfiguration({
      ...sameSiteEnvironment,
      ARTIFACT_SERVER_ALLOW_SAME_SITE_CONTENT: "true",
    });
    expect(accepted.output).not.toContain("different registrable domains");
    expect(accepted.exitCode).toBe(0);
  });

  function checkConfiguration(
    environment: NodeJS.ProcessEnv,
  ): Promise<CommandResult> {
    return runCli([
      "config",
      "check",
      "--mode",
      "compact",
      "--data",
      dataDirectory,
    ], {
      ARTIFACT_SERVER_OIDC_CLIENT_ID: provider.clientId,
      ARTIFACT_SERVER_OIDC_ISSUER: provider.issuer,
      ...environment,
    });
  }
});

function runCli(
  commandArguments: readonly string[],
  environment: NodeJS.ProcessEnv,
): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      path.join(repositoryRoot, "node_modules/.bin/tsx"),
      [path.join(repositoryRoot, "src/cli/main.ts"), ...commandArguments],
      {
        cwd: repositoryRoot,
        env: {
          ...process.env,
          ARTIFACT_SERVER_CONTENT_DOMAIN: "content.example.net",
          ARTIFACT_SERVER_ORIGIN: "https://artifacts.example.com",
          ARTIFACT_SERVER_REQUEST_LOG_SAMPLE_RATE: "0",
          ...environment,
        },
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
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
