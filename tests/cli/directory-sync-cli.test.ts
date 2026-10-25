import {spawn} from "node:child_process";
import {existsSync} from "node:fs";
import {mkdtemp, rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import path from "node:path";
import {DatabaseSync} from "node:sqlite";

import {afterAll, beforeAll, describe, expect, test} from "vitest";
import {z} from "zod";

import {
  keycloakUser,
  startStubKeycloak,
  type RunningStubKeycloak,
} from "../support/stub-keycloak-directory.js";

const administratorEmail = "bootstrap@example.test";
const repositoryRoot = path.resolve(import.meta.dirname, "../..");
const memberRowSchema = z.object({
  email: z.string(),
  role: z.string(),
  status: z.string(),
});

interface CommandResult {
  readonly exitCode: number;
  readonly stderr: string;
  readonly stdout: string;
}

describe("artifactserver maintenance sync-directory", () => {
  let compactDirectory: string;
  let dataDirectory: string;
  let keycloak: RunningStubKeycloak;

  beforeAll(async () => {
    compactDirectory = await mkdtemp(
      path.join(tmpdir(), "artifact-server-directory-sync-"),
    );
    dataDirectory = path.join(compactDirectory, "data");
    const initialized = await runCli([
      "init",
      "--admin-email",
      administratorEmail,
      "--data",
      dataDirectory,
    ], {});
    if (initialized.exitCode !== 0) {
      throw new Error(`Compact initialization failed: ${initialized.stderr}`);
    }
    keycloak = await startStubKeycloak();
  });

  afterAll(async () => {
    await keycloak.stop();
    await rm(compactDirectory, {force: true, recursive: true});
  });

  test("refuses to run without group roles and directory settings", async () => {
    const plain = await syncDirectory({});
    expect(plain.exitCode).not.toBe(0);
    expect(plain.stderr).toContain(
      "maintenance sync-directory requires OIDC group roles",
    );

    const withoutDirectory = await syncDirectory({
      ARTIFACT_SERVER_OIDC_CLIENT_ID: "artifact-server",
      ARTIFACT_SERVER_OIDC_ISSUER: keycloak.issuer,
      ARTIFACT_SERVER_OIDC_MEMBER_GROUPS: "artifact-users",
    });
    expect(withoutDirectory.exitCode).not.toBe(0);
    expect(withoutDirectory.stderr).toContain(
      "maintenance sync-directory requires OIDC group roles",
    );
    expect(members()).toEqual([]);
  });

  test("prints one summary line, and fails without writes on a missing group", async () => {
    keycloak.groups.set("artifact-admins", [keycloakUser("ada")]);
    keycloak.groups.set("artifact-users", [
      keycloakUser("bob"),
      keycloakUser("carol", {enabled: false}),
    ]);
    const synced = await syncDirectory(directoryEnvironment());
    expect(synced.exitCode).toBe(0);
    expect(synced.stdout.split("\n")).toEqual([JSON.stringify({
      groups: 2,
      directoryUsers: 3,
      admitted: 2,
      reactivated: 0,
      roleChanged: 0,
      deactivated: 0,
      unchanged: 0,
      skipped: 1,
    })]);
    expect(members()).toEqual([
      {email: "ada@example.test", role: "administrator", status: "active"},
      {email: "bob@example.test", role: "member", status: "active"},
    ]);
    expect(synced.stdout + synced.stderr).not.toContain(keycloak.clientSecret);

    keycloak.groups.delete("artifact-users");
    const failed = await syncDirectory(directoryEnvironment());
    expect(failed.exitCode).not.toBe(0);
    expect(failed.stderr).toContain(
      "The Keycloak group artifact-users does not exist.",
    );
    expect(failed.stdout).toBe("");
    expect(members()).toHaveLength(2);
  });

  function directoryEnvironment(): NodeJS.ProcessEnv {
    return {
      ARTIFACT_SERVER_OIDC_ADMINISTRATOR_GROUPS: "artifact-admins",
      ARTIFACT_SERVER_OIDC_CLIENT_ID: "artifact-server",
      ARTIFACT_SERVER_OIDC_DIRECTORY_CLIENT_ID: keycloak.clientId,
      ARTIFACT_SERVER_OIDC_DIRECTORY_CLIENT_SECRET: keycloak.clientSecret,
      ARTIFACT_SERVER_OIDC_DIRECTORY_PROVIDER: "keycloak",
      ARTIFACT_SERVER_OIDC_ISSUER: keycloak.issuer,
      ARTIFACT_SERVER_OIDC_MEMBER_GROUPS: "artifact-users",
    };
  }

  function syncDirectory(environment: NodeJS.ProcessEnv): Promise<CommandResult> {
    return runCli([
      "maintenance",
      "sync-directory",
      "--once",
      "--mode",
      "compact",
      "--data",
      dataDirectory,
    ], environment);
  }

  function members(): readonly z.infer<typeof memberRowSchema>[] {
    const databasePath = path.join(dataDirectory, "artifact-server.db");
    // The database appears with the first runtime; before it, nobody exists.
    if (!existsSync(databasePath)) return [];
    const database = new DatabaseSync(databasePath, {readOnly: true});
    try {
      return database
        .prepare("SELECT email, role, status FROM installation_members ORDER BY email")
        .all()
        .map((row) => memberRowSchema.parse(row));
    } finally {
      database.close();
    }
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
    const stdout: Uint8Array[] = [];
    const stderr: Uint8Array[] = [];
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.on("error", reject);
    child.on("close", (exitCode) => {
      resolve({
        exitCode: exitCode ?? -1,
        stderr: Buffer.concat(stderr).toString("utf8").trim(),
        stdout: Buffer.concat(stdout).toString("utf8").trim(),
      });
    });
  });
}
