import {spawn} from "node:child_process";
import {mkdtemp, rm, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import path from "node:path";

import {Redacted} from "effect";
import {afterAll, beforeAll, describe, expect, test} from "vitest";
import {z} from "zod";

import {loadOidcConfiguration} from "../../src/cli/oidc-configuration.js";

const administratorEmail = "administrator@example.test";
const repositoryRoot = path.resolve(import.meta.dirname, "../..");
const completeOidc = {
  ARTIFACT_SERVER_BOOTSTRAP_ADMIN_EMAIL: administratorEmail,
  ARTIFACT_SERVER_OIDC_CLIENT_ID: "artifact-server",
  ARTIFACT_SERVER_OIDC_ISSUER: "https://idp.example.test/realms/main",
  ARTIFACT_SERVER_ORIGIN: "https://artifacts.example.test",
};
const configurationCheckSchema = z.object({
  configuration: z.looseObject({
    interactiveIdentityProvider: z.string(),
    oidcGroupRoles: z.object({
      administratorGroups: z.array(z.string()),
      claim: z.string(),
      memberGroups: z.array(z.string()),
    }).optional(),
  }),
});

interface CommandResult {
  readonly exitCode: number;
  readonly output: string;
}

describe("generic OIDC group-role configuration", () => {
  let compactDirectory: string;

  beforeAll(async () => {
    compactDirectory = await mkdtemp(
      path.join(tmpdir(), "artifact-server-oidc-groups-"),
    );
    const initialized = await runCli([
      "init",
      "--admin-email",
      administratorEmail,
      "--data",
      path.join(compactDirectory, "data"),
    ], {});
    if (initialized.exitCode !== 0) {
      throw new Error(`Compact initialization failed: ${initialized.output}`);
    }
  });

  afterAll(async () => {
    await rm(compactDirectory, {force: true, recursive: true});
  });

  test("group roles stay off unless a group list names a group", async () => {
    const configuration = await loadOidcConfiguration(completeOidc);
    expect(configuration?.groupRoles).toBeNull();
  });

  test("lists are trimmed, deduplicated, case-preserving, and read the groups claim by default", async () => {
    const configuration = await loadOidcConfiguration({
      ...completeOidc,
      ARTIFACT_SERVER_OIDC_ADMINISTRATOR_GROUPS: " artifact-admins ,Platform Admins,",
      ARTIFACT_SERVER_OIDC_MEMBER_GROUPS: "artifact-users, artifact-users,Engineering",
    });
    expect(configuration?.groupRoles).toEqual({
      administratorGroups: ["artifact-admins", "Platform Admins"],
      claim: "groups",
      memberGroups: ["artifact-users", "Engineering"],
    });

    const memberOnly = await loadOidcConfiguration({
      ...completeOidc,
      ARTIFACT_SERVER_OIDC_GROUPS_CLAIM: " roles ",
      ARTIFACT_SERVER_OIDC_MEMBER_GROUPS: "artifact-users",
    });
    expect(memberOnly?.groupRoles).toEqual({
      administratorGroups: [],
      claim: "roles",
      memberGroups: ["artifact-users"],
    });
  });

  test("group settings without an issuer, a claim without lists, and empty lists are refused", async () => {
    await expect(loadOidcConfiguration({
      ARTIFACT_SERVER_BOOTSTRAP_ADMIN_EMAIL: administratorEmail,
      ARTIFACT_SERVER_OIDC_MEMBER_GROUPS: "artifact-users",
      ARTIFACT_SERVER_ORIGIN: "https://artifacts.example.test",
    })).rejects.toThrow("Generic OIDC authentication requires");
    await expect(loadOidcConfiguration({
      ARTIFACT_SERVER_BOOTSTRAP_ADMIN_EMAIL: administratorEmail,
      ARTIFACT_SERVER_OIDC_ADMINISTRATOR_GROUPS: "artifact-admins",
      ARTIFACT_SERVER_ORIGIN: "https://artifacts.example.test",
    })).rejects.toThrow("Generic OIDC authentication requires");
    await expect(loadOidcConfiguration({
      ...completeOidc,
      ARTIFACT_SERVER_OIDC_GROUPS_CLAIM: "groups",
    })).rejects.toThrow(
      "ARTIFACT_SERVER_OIDC_GROUPS_CLAIM requires ARTIFACT_SERVER_OIDC_MEMBER_GROUPS or ARTIFACT_SERVER_OIDC_ADMINISTRATOR_GROUPS.",
    );
    await expect(loadOidcConfiguration({
      ...completeOidc,
      ARTIFACT_SERVER_OIDC_MEMBER_GROUPS: " , ,",
    })).rejects.toThrow(
      "ARTIFACT_SERVER_OIDC_MEMBER_GROUPS must name at least one group.",
    );
  });

  test("directory sync settings parse with a file secret and derive the admin base", async () => {
    const secretFile = path.join(compactDirectory, "directory-secret");
    await writeFile(secretFile, "directory-secret-value\n");
    const configuration = await loadOidcConfiguration({
      ...completeOidc,
      ARTIFACT_SERVER_OIDC_DIRECTORY_CLIENT_ID: "artifact-server-directory",
      ARTIFACT_SERVER_OIDC_DIRECTORY_CLIENT_SECRET_FILE: secretFile,
      ARTIFACT_SERVER_OIDC_DIRECTORY_PROVIDER: "keycloak",
      ARTIFACT_SERVER_OIDC_MEMBER_GROUPS: "artifact-users",
    });
    expect(configuration?.directory).toMatchObject({
      adminBaseUrl: "https://idp.example.test/admin/realms/main",
      clientId: "artifact-server-directory",
      provider: "keycloak",
    });
    const secret = configuration?.directory?.clientSecret;
    expect(secret === undefined ? null : Redacted.value(secret))
      .toBe("directory-secret-value");
    expect((await loadOidcConfiguration(completeOidc))?.directory).toBeNull();
  });

  test("directory sync needs group roles, every setting, Keycloak, and a realm issuer", async () => {
    const directory = {
      ARTIFACT_SERVER_OIDC_DIRECTORY_CLIENT_ID: "artifact-server-directory",
      ARTIFACT_SERVER_OIDC_DIRECTORY_CLIENT_SECRET: "directory-secret-value",
      ARTIFACT_SERVER_OIDC_DIRECTORY_PROVIDER: "keycloak",
    };
    await expect(loadOidcConfiguration({...completeOidc, ...directory}))
      .rejects.toThrow(
        "The ARTIFACT_SERVER_OIDC_DIRECTORY_* settings require ARTIFACT_SERVER_OIDC_MEMBER_GROUPS or ARTIFACT_SERVER_OIDC_ADMINISTRATOR_GROUPS.",
      );
    const grouped = {
      ...completeOidc,
      ARTIFACT_SERVER_OIDC_ADMINISTRATOR_GROUPS: "artifact-admins",
    };
    await expect(loadOidcConfiguration({
      ...grouped,
      ARTIFACT_SERVER_OIDC_DIRECTORY_CLIENT_ID: "artifact-server-directory",
      ARTIFACT_SERVER_OIDC_DIRECTORY_PROVIDER: "keycloak",
    })).rejects.toThrow("Directory sync requires ARTIFACT_SERVER_OIDC_DIRECTORY_PROVIDER");
    await expect(loadOidcConfiguration({
      ...grouped,
      ...directory,
      ARTIFACT_SERVER_OIDC_DIRECTORY_PROVIDER: "okta",
    })).rejects.toThrow("supports only keycloak");
    await expect(loadOidcConfiguration({
      ...grouped,
      ...directory,
      ARTIFACT_SERVER_OIDC_ISSUER: "https://idp.example.test/oauth2/default",
    })).rejects.toThrow("<base>/realms/<realm>");
    await expect(loadOidcConfiguration({
      ARTIFACT_SERVER_BOOTSTRAP_ADMIN_EMAIL: administratorEmail,
      ARTIFACT_SERVER_ORIGIN: "https://artifacts.example.test",
      ...directory,
    })).rejects.toThrow("Generic OIDC authentication requires");
  });

  test("the configuration summary reports group roles only when they are configured", async () => {
    const dataDirectory = path.join(compactDirectory, "data");
    const environment = {
      ARTIFACT_SERVER_OIDC_CLIENT_ID: "artifact-server",
      ARTIFACT_SERVER_OIDC_ISSUER: "https://idp.example.test/realms/main",
    };
    const plain = await runCli(
      ["config", "check", "--mode", "compact", "--data", dataDirectory],
      environment,
    );
    const plainSummary = configurationCheckSchema.parse(JSON.parse(plain.output));
    expect(plainSummary.configuration.interactiveIdentityProvider).toBe("oidc");
    expect(plainSummary.configuration).not.toHaveProperty("oidcGroupRoles");

    const grouped = await runCli(
      ["config", "check", "--mode", "compact", "--data", dataDirectory],
      {
        ...environment,
        ARTIFACT_SERVER_OIDC_ADMINISTRATOR_GROUPS: "artifact-admins",
        ARTIFACT_SERVER_OIDC_MEMBER_GROUPS: "artifact-users",
      },
    );
    expect(configurationCheckSchema.parse(JSON.parse(grouped.output))
      .configuration.oidcGroupRoles).toEqual({
      administratorGroups: ["artifact-admins"],
      claim: "groups",
      memberGroups: ["artifact-users"],
    });

    const orphaned = await runCli(
      ["config", "check", "--mode", "compact", "--data", dataDirectory],
      {ARTIFACT_SERVER_OIDC_MEMBER_GROUPS: "artifact-users"},
    );
    expect(orphaned.exitCode).not.toBe(0);
    expect(orphaned.output).toContain("Generic OIDC authentication requires");
  });
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
