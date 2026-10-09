import {afterEach, describe, expect, test} from "vitest";

import {
  assertAtMostOneBrowserLoginProvider,
  loadOidcConfiguration,
} from "../../src/cli/oidc-configuration.js";
import {browserLoginKinds, privateTeamBrowserAccess} from
  "../../src/core/browser-access.js";
import {createOidcIdentityProvider} from
  "../../src/identity/oidc-identity-provider.js";
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

const environment = {
  ARTIFACT_SERVER_BOOTSTRAP_ADMIN_EMAIL: "administrator@example.test",
  ARTIFACT_SERVER_OIDC_CLIENT_ID: "artifact-server",
  ARTIFACT_SERVER_OIDC_ISSUER: "https://idp.example.test/dex/",
  ARTIFACT_SERVER_ORIGIN: "https://artifacts.example.test",
};

describe("OIDC automatic-admission configuration", () => {
  let installation: TestInstallation | null = null;
  let provider: RunningStubOidcProvider | null = null;
  let server: RunningTestServer | null = null;

  afterEach(async () => {
    if (server !== null) await server.stop();
    if (provider !== null) await provider.stop();
    if (installation !== null) await removeTestInstallation(installation);
    server = null;
    provider = null;
    installation = null;
  });

  test("AUTH-029: admission defaults off and an enabled policy normalizes its issuer and domains", async () => {
    expect(await loadOidcConfiguration({})).toBeNull();
    const configurations = await Promise.all([
      loadOidcConfiguration(environment),
      loadOidcConfiguration({
        ...environment, ARTIFACT_SERVER_OIDC_AUTO_ADMIT: "false",
      }),
    ]);
    for (const configuration of configurations) {
      expect(configuration).not.toHaveProperty("externalIdentityAdmissionPolicy");
    }
    expect(await loadOidcConfiguration({
      ...environment,
      ARTIFACT_SERVER_OIDC_AUTO_ADMIT: "true",
      ARTIFACT_SERVER_OIDC_ALLOWED_EMAIL_DOMAINS: " Example.COM,  EXAMPLE.test ",
    })).toMatchObject({
      externalIdentityAdmissionPolicy: {
        allowedEmailDomains: ["example.com", "example.test"],
        provider: "oidc:https://idp.example.test/dex",
      },
    });
    expect(await loadOidcConfiguration({
      ...environment,
      ARTIFACT_SERVER_OIDC_AUTO_ADMIT: "true",
      ARTIFACT_SERVER_OIDC_ALLOWED_EMAIL_DOMAINS: "  ",
    })).toMatchObject({
      externalIdentityAdmissionPolicy: {allowedEmailDomains: []},
    });
  });

  test.each(["TRUE", "False", "1", "yes", " true", ""])(
    "AUTH-029: rejects nonliteral auto-admission switch %j",
    async (switchValue) => {
      await expect(loadOidcConfiguration({
        ...environment,
        ARTIFACT_SERVER_OIDC_AUTO_ADMIT: switchValue,
      })).rejects.toThrow("ARTIFACT_SERVER_OIDC_AUTO_ADMIT");
    },
  );

  test.each([
    "*.example.test", "example.test,", ",example.test", "example..test",
    "-example.test", "example-.test", "https://example.test", "example.test:443",
    "user@example.test", "example_test", "example.test.", "example test",
    `${"a".repeat(64)}.test`,
  ])("AUTH-029: rejects malformed exact-domain list %j even when disabled", async (domains) => {
    await expect(loadOidcConfiguration({
      ...environment,
      ARTIFACT_SERVER_OIDC_AUTO_ADMIT: "false",
      ARTIFACT_SERVER_OIDC_ALLOWED_EMAIL_DOMAINS: domains,
    })).rejects.toThrow("ARTIFACT_SERVER_OIDC_ALLOWED_EMAIL_DOMAINS");
  });

  test.each([
    {ARTIFACT_SERVER_OIDC_AUTO_ADMIT: "false"},
    {ARTIFACT_SERVER_OIDC_AUTO_ADMIT: "true"},
    {ARTIFACT_SERVER_OIDC_ALLOWED_EMAIL_DOMAINS: ""},
  ])("AUTH-029: policy settings require complete OIDC configuration %j", async (settings) => {
    await expect(loadOidcConfiguration(settings)).rejects.toThrow(
      "Generic OIDC authentication requires",
    );
    expect(() => assertAtMostOneBrowserLoginProvider({
      ARTIFACT_SERVER_WORKOS_CLIENT_ID: "workos-client",
      ...settings,
    })).toThrow("One installation has one browser-login provider");
  });

  test("AUTH-029: the loaded policy admits a new member through real browser login", async () => {
    installation = await createTestInstallation();
    provider = await startStubOidcProvider({clientId: "artifact-server"});
    const port = await reserveLoopbackPort();
    const configuration = await loadOidcConfiguration({
      ...environment,
      ARTIFACT_SERVER_OIDC_AUTO_ADMIT: "true",
      ARTIFACT_SERVER_OIDC_ALLOWED_EMAIL_DOMAINS: " EXAMPLE.TEST ",
      ARTIFACT_SERVER_OIDC_ISSUER: provider.issuer,
      ARTIFACT_SERVER_ORIGIN: `http://127.0.0.1:${port}`,
    });
    if (configuration === null) throw new Error("Missing OIDC configuration.");
    server = await startTestServer(installation, {
      ...configuration,
      browserAccess: privateTeamBrowserAccess(browserLoginKinds.oidc),
      interactiveIdentityProvider: createOidcIdentityProvider(configuration),
      port,
    });
    provider.claims.email = "administrator@example.test";
    provider.claims.subject = "administrator";
    expect((await completeCallback(server)).status).toBe(303);
    provider.claims.email = "new-member@example.test";
    provider.claims.subject = "new-member";
    expect((await completeCallback(server)).status).toBe(303);
  });
});

async function completeCallback(
  server: RunningTestServer,
): Promise<Response> {
  const login = await startStubOidcLogin(server.baseUrl);
  return fetch(login.callbackUrl, {
    headers: {Cookie: login.handshakeCookie},
    redirect: "manual",
  });
}
