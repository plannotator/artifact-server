import {spawn} from "node:child_process";
import {mkdtemp, rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import path from "node:path";

import {afterAll, afterEach, beforeAll, beforeEach, describe, expect, test}
  from "vitest";
import {z} from "zod";

import {loadOidcConfiguration} from "../../src/cli/oidc-configuration.js";
import {createOidcIdentityProvider} from
  "../../src/identity/oidc-identity-provider.js";
import {
  browserLoginKinds,
  privateTeamBrowserAccess,
} from "../../src/core/browser-access.js";
import {
  createTestInstallation,
  removeTestInstallation,
  reserveLoopbackPort,
  startTestServer,
  type RunningTestServer,
  type TestInstallation,
} from "../support/runtime-harness.js";
import {
  startStubOidcLogin,
  startStubOidcProvider,
  type RunningStubOidcProvider,
} from "../support/stub-oidc-provider.js";

const administratorEmail = "administrator@example.test";
const repositoryRoot = path.resolve(import.meta.dirname, "../..");
const configurationCheckSchema = z.object({
  configuration: z.object({
    interactiveIdentityProvider: z.string(),
    status: z.literal("valid"),
  }),
  providers: z.object({status: z.string()}),
});
const failureSchema = z.object({
  error: z.object({code: z.string(), message: z.string()}),
});

interface CommandResult {
  readonly exitCode: number;
  readonly output: string;
}

describe("generic OIDC configuration", () => {
  let compactDirectory: string;
  let installation: TestInstallation;
  let provider: RunningStubOidcProvider;
  let server: RunningTestServer | null = null;

  beforeAll(async () => {
    compactDirectory = await mkdtemp(
      path.join(tmpdir(), "artifact-server-oidc-configuration-"),
    );
    const initialized = await runCli([
      "init",
      "--admin-email",
      administratorEmail,
      "--data",
      path.join(compactDirectory, "data"),
    ], {});
    if (initialized.exitCode !== 0) {
      throw new Error(
        `Compact initialization failed: ${initialized.output}`,
      );
    }
  });

  afterAll(async () => {
    await rm(compactDirectory, {force: true, recursive: true});
  });

  beforeEach(async () => {
    installation = await createTestInstallation();
    provider = await startStubOidcProvider({
      clientId: "artifact-server-oidc-configuration",
    });
    provider.claims.email = administratorEmail;
  });

  afterEach(async () => {
    if (server !== null) await server.stop();
    server = null;
    await provider.stop();
    await removeTestInstallation(installation);
  });

  test("AUTH-021-B: a complete OIDC configuration serves browser login and no configured provider keeps keys working", async () => {
    const port = await reserveLoopbackPort();
    const applicationOrigin = `http://127.0.0.1:${port}`;
    const configuration = await loadOidcConfiguration({
      ARTIFACT_SERVER_BOOTSTRAP_ADMIN_EMAIL: administratorEmail,
      ARTIFACT_SERVER_OIDC_CLIENT_ID: provider.clientId,
      ARTIFACT_SERVER_OIDC_ISSUER: `${provider.issuer}/`,
      ARTIFACT_SERVER_ORIGIN: applicationOrigin,
    });
    expect(configuration).toMatchObject({
      applicationOrigin,
      bootstrapAdministratorEmail: administratorEmail,
      clientId: provider.clientId,
      clientSecret: null,
      issuer: provider.issuer,
      scopes: "openid email profile",
    });
    if (configuration === null) throw new Error("The OIDC configuration is null.");
    server = await startTestServer(installation, {
      applicationOrigin,
      bootstrapAdministratorEmail: administratorEmail,
      browserAccess: privateTeamBrowserAccess(browserLoginKinds.oidc),
      interactiveIdentityProvider: createOidcIdentityProvider(configuration),
      port,
    });
    const authorization = await startStubOidcLogin(server.baseUrl);
    expect(authorization.loginResponse.status).toBe(302);
    expect(authorization.authorizationUrl.origin).toBe(provider.issuer);
    expect(authorization.authorizationUrl.searchParams.get("redirect_uri"))
      .toBe(`${applicationOrigin}/auth/callback`);
    const completed = await fetch(authorization.callbackUrl, {
      headers: {Cookie: authorization.handshakeCookie},
      redirect: "manual",
    });
    expect(completed.status).toBe(303);
    await server.stop();
    server = null;

    const inspected = await runCli([
      "config",
      "check",
      "--mode",
      "compact",
      "--data",
      path.join(compactDirectory, "data"),
    ], {
      ARTIFACT_SERVER_OIDC_CLIENT_ID: provider.clientId,
      ARTIFACT_SERVER_OIDC_ISSUER: provider.issuer,
    });
    expect(inspected.exitCode).toBe(0);
    expect(configurationCheckSchema.parse(JSON.parse(inspected.output)))
      .toMatchObject({
        configuration: {interactiveIdentityProvider: "oidc", status: "valid"},
        providers: {status: "ready"},
      });

    server = await startTestServer(installation, {
      bootstrapAdministratorEmail: administratorEmail,
    });
    const unavailable = await fetch(`${server.baseUrl}/auth/login`, {
      redirect: "manual",
    });
    expect(unavailable.status).toBe(404);
    expect(failureSchema.parse(await unavailable.json()).error.code)
      .toBe("INTERACTIVE_LOGIN_UNAVAILABLE");
    const keyed = await fetch(`${server.baseUrl}/api/v1/artifacts`, {
      headers: {Authorization: `Bearer ${installation.apiToken}`},
    });
    expect(keyed.status).toBe(200);
  });

  test("AUTH-021-F: partial, doubled, and malformed OIDC configuration fails startup or login without weakening the server", async () => {
    const dataDirectory = path.join(compactDirectory, "data");
    const partial = await runCli([
      "config",
      "check",
      "--mode",
      "compact",
      "--data",
      dataDirectory,
    ], {ARTIFACT_SERVER_OIDC_ISSUER: provider.issuer});
    expect(partial.exitCode).not.toBe(0);
    expect(partial.output).toContain("Generic OIDC authentication requires");
    expect(partial.output).toContain("ARTIFACT_SERVER_OIDC_CLIENT_ID");

    const doubled = await runCli([
      "config",
      "check",
      "--mode",
      "compact",
      "--data",
      dataDirectory,
    ], {
      ARTIFACT_SERVER_OIDC_CLIENT_ID: provider.clientId,
      ARTIFACT_SERVER_OIDC_ISSUER: provider.issuer,
      ARTIFACT_SERVER_WORKOS_API_KEY: "sk_test_workos_secret_value",
      ARTIFACT_SERVER_WORKOS_CLIENT_ID: "client_workos",
      ARTIFACT_SERVER_WORKOS_ISSUER: "https://workos.example.test",
    });
    expect(doubled.exitCode).not.toBe(0);
    expect(doubled.output).toContain(
      "One installation has one browser-login provider",
    );
    expect(doubled.output).not.toContain("sk_test_workos_secret_value");

    // A single leftover WorkOS variable is still two configured providers.
    const leftover = await runCli([
      "config",
      "check",
      "--mode",
      "compact",
      "--data",
      dataDirectory,
    ], {
      ARTIFACT_SERVER_OIDC_CLIENT_ID: provider.clientId,
      ARTIFACT_SERVER_OIDC_ISSUER: provider.issuer,
      ARTIFACT_SERVER_WORKOS_ISSUER: "https://workos.example.test",
    });
    expect(leftover.exitCode).not.toBe(0);
    expect(leftover.output).toContain(
      "One installation has one browser-login provider",
    );

    await expect(loadOidcConfiguration({
      ARTIFACT_SERVER_BOOTSTRAP_ADMIN_EMAIL: administratorEmail,
      ARTIFACT_SERVER_OIDC_CLIENT_ID: provider.clientId,
      ARTIFACT_SERVER_OIDC_ISSUER: "http://idp.example.test",
      ARTIFACT_SERVER_ORIGIN: "https://artifacts.example.test",
    })).rejects.toThrow("ARTIFACT_SERVER_OIDC_ISSUER must be an HTTPS URL");

    const port = await reserveLoopbackPort();
    const applicationOrigin = `http://127.0.0.1:${port}`;
    server = await startTestServer(installation, {
      applicationOrigin,
      bootstrapAdministratorEmail: administratorEmail,
      browserAccess: privateTeamBrowserAccess(browserLoginKinds.oidc),
      interactiveIdentityProvider: createOidcIdentityProvider({
        applicationOrigin,
        clientId: provider.clientId,
        clientSecret: null,
        issuer: provider.issuer,
        scopes: "openid email profile",
      }),
      port,
    });

    provider.defects.discoveryIssuer = "https://another-issuer.example.test";
    await expectDiscoveryRefusal(server);
    provider.defects.discoveryIssuer = null;

    provider.defects.tokenEndpoint =
      `http://operator:secret@127.0.0.1:${new URL(provider.issuer).port}/token`;
    await expectDiscoveryRefusal(server);
    provider.defects.tokenEndpoint = null;

    const keyed = await fetch(`${server.baseUrl}/api/v1/artifacts`, {
      headers: {Authorization: `Bearer ${installation.apiToken}`},
    });
    expect(keyed.status).toBe(200);
    const recovered = await startStubOidcLogin(server.baseUrl);
    expect((await fetch(recovered.callbackUrl, {
      headers: {Cookie: recovered.handshakeCookie},
      redirect: "manual",
    })).status).toBe(303);
  });
});

async function expectDiscoveryRefusal(server: RunningTestServer): Promise<void> {
  const refused = await fetch(`${server.baseUrl}/auth/login`, {
    redirect: "manual",
  });
  expect(refused.status).toBe(502);
  expect(refused.headers.getSetCookie()).toEqual([]);
  expect(failureSchema.parse(await refused.json()).error).toEqual({
    code: "IDENTITY_PROVIDER_FAILURE",
    message:
      "The configured identity provider could not complete browser login.",
  });
}

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
