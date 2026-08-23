import path from "node:path";
import {DatabaseSync} from "node:sqlite";

import {afterEach, beforeEach, describe, expect, test} from "vitest";
import {Redacted} from "effect";
import {z} from "zod";

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
const clientSecret = "stub-oidc-client-secret-with-entropy";
const scopes = "openid email profile";
const sessionResponseSchema = z.object({
  authenticationMethod: z.literal("session"),
  principal: z.object({
    id: z.string(),
    kind: z.literal("human"),
    membershipRole: z.literal("administrator"),
  }),
});
const memberListSchema = z.object({
  members: z.array(z.object({
    displayName: z.string(),
    email: z.string(),
    id: z.string(),
    role: z.string(),
    status: z.string(),
  })),
});
const externalIdentityRowSchema = z.object({
  email: z.string(),
  member_id: z.string(),
  provider: z.string(),
  subject: z.string(),
});
const countRowSchema = z.object({total: z.number().int().nonnegative()});
const failureSchema = z.object({
  error: z.object({code: z.string(), message: z.string()}),
});

describe("generic OIDC browser login", () => {
  let installation: TestInstallation;
  let provider: RunningStubOidcProvider;
  let server: RunningTestServer | null = null;

  beforeEach(async () => {
    installation = await createTestInstallation();
    provider = await startStubOidcProvider({
      clientId: "artifact-server-oidc-test",
      clientSecret,
    });
  });

  afterEach(async () => {
    if (server !== null) await server.stop();
    server = null;
    await provider.stop();
    await removeTestInstallation(installation);
  });

  test("AUTH-019-B: a real OIDC round trip admits the bootstrap administrator and reuses the issuer-qualified binding", async () => {
    server = await startOidcServer(installation, provider, clientSecret);
    provider.claims.email = administratorEmail;
    provider.claims.name = "Ada Lovelace";
    // The stub omits email_verified entirely; an absent claim means verified.
    expect(provider.claims.emailVerified).toBeNull();

    const authorization = await startStubOidcLogin(server.baseUrl);
    expect(authorization.loginResponse.status).toBe(302);
    const query = authorization.authorizationUrl.searchParams;
    expect(authorization.authorizationUrl.origin).toBe(provider.issuer);
    expect(authorization.authorizationUrl.pathname).toBe("/authorize");
    expect(query.get("response_type")).toBe("code");
    expect(query.get("client_id")).toBe(provider.clientId);
    expect(query.get("redirect_uri")).toBe(`${server.baseUrl}/auth/callback`);
    expect(query.get("scope")).toBe(scopes);
    expect(query.get("code_challenge_method")).toBe("S256");
    expect(query.get("code_challenge")).not.toBeNull();
    expect(query.get("nonce")).not.toBeNull();
    const recorded = provider.authorizationRequests()[0];
    expect(recorded?.state).toBe(query.get("state"));
    expect(authorization.callbackUrl.searchParams.get("state"))
      .toBe(query.get("state"));
    expect(authorization.callbackUrl.searchParams.get("code")).not.toBeNull();

    const completed = await fetch(authorization.callbackUrl, {
      headers: {Cookie: authorization.handshakeCookie},
      redirect: "manual",
    });
    expect(completed.status).toBe(303);
    expect(completed.headers.get("location")).toBe("/api/v1/session");
    expect(provider.tokenRequests()).toEqual([{
      clientId: provider.clientId,
      presentedClientSecret: true,
      redirectUri: `${server.baseUrl}/auth/callback`,
    }]);

    const cookieHeader = applicationCookieHeader(completed.headers.getSetCookie());
    const session = await fetch(`${server.baseUrl}/api/v1/session`, {
      headers: {Cookie: cookieHeader},
    });
    expect(session.status).toBe(200);
    const principal = sessionResponseSchema.parse(await session.json()).principal;

    const members = await fetch(`${server.baseUrl}/api/v1/members`, {
      headers: {Cookie: cookieHeader},
    });
    expect(members.status).toBe(200);
    expect(memberListSchema.parse(await members.json()).members).toEqual([{
      displayName: "Ada Lovelace",
      email: administratorEmail,
      id: principal.id,
      role: "administrator",
      status: "active",
    }]);
    expect(externalIdentities(installation)).toEqual([{
      email: administratorEmail,
      member_id: principal.id,
      provider: `oidc:${provider.issuer}`,
      subject: provider.claims.subject,
    }]);

    const secondLogin = await startStubOidcLogin(server.baseUrl);
    const secondCompleted = await fetch(secondLogin.callbackUrl, {
      headers: {Cookie: secondLogin.handshakeCookie},
      redirect: "manual",
    });
    expect(secondCompleted.status).toBe(303);
    const secondCookieHeader = applicationCookieHeader(
      secondCompleted.headers.getSetCookie(),
    );
    expect(secondCookieHeader).not.toBe(cookieHeader);
    const reusedSession = await fetch(`${server.baseUrl}/api/v1/session`, {
      headers: {Cookie: secondCookieHeader},
    });
    expect(sessionResponseSchema.parse(await reusedSession.json()).principal.id)
      .toBe(principal.id);
    const [firstAttempt, secondAttempt] = provider.authorizationRequests();
    expect(secondAttempt?.state).not.toBe(firstAttempt?.state);
    expect(secondAttempt?.nonce).not.toBe(firstAttempt?.nonce);
    expect(rowCount(installation, "installation_members")).toBe(1);
    expect(rowCount(installation, "external_identities")).toBe(1);
  });

  test("AUTH-019-F: unadmitted, disavowed, and email-less OIDC identities are refused without members or sessions", async () => {
    server = await startOidcServer(installation, provider, clientSecret);

    provider.claims.email = "stranger@example.test";
    provider.claims.subject = "stub-oidc-subject-stranger";
    const unadmitted = await completeStubLogin(server.baseUrl);
    expect(unadmitted.status).toBe(403);
    expect(unadmitted.headers.getSetCookie()).toEqual([]);
    expect(failureSchema.parse(await unadmitted.json()).error.code)
      .toBe("IDENTITY_ADMISSION_DENIED");

    provider.claims.email = administratorEmail;
    provider.claims.subject = "stub-oidc-subject-unverified";
    provider.claims.emailVerified = false;
    const unverified = await completeStubLogin(server.baseUrl);
    expect(unverified.status).toBe(403);
    expect(unverified.headers.getSetCookie()).toEqual([]);
    expect(failureSchema.parse(await unverified.json()).error.message)
      .toBe("The login provider did not verify the email address.");

    provider.claims.emailVerified = null;
    provider.claims.email = null;
    const withoutEmail = await completeStubLogin(server.baseUrl);
    expect(withoutEmail.status).toBe(502);
    expect(withoutEmail.headers.getSetCookie()).toEqual([]);
    expect(failureSchema.parse(await withoutEmail.json()).error).toEqual({
      code: "IDENTITY_PROVIDER_FAILURE",
      message:
        "The configured identity provider could not complete browser login.",
    });

    expect(rowCount(installation, "installation_members")).toBe(0);
    expect(rowCount(installation, "external_identities")).toBe(0);
    expect(rowCount(installation, "application_sessions")).toBe(0);
  });
});

async function startOidcServer(
  installation: TestInstallation,
  provider: RunningStubOidcProvider,
  secret: string,
): Promise<RunningTestServer> {
  const port = await reserveLoopbackPort();
  const applicationOrigin = `http://127.0.0.1:${port}`;
  return startTestServer(installation, {
    applicationOrigin,
    bootstrapAdministratorEmail: administratorEmail,
    browserAccess: privateTeamBrowserAccess(browserLoginKinds.oidc),
    interactiveIdentityProvider: createOidcIdentityProvider({
      applicationOrigin,
      clientId: provider.clientId,
      clientSecret: Redacted.make(secret, {label: "oidc-client-secret"}),
      issuer: provider.issuer,
      scopes,
    }),
    port,
  });
}

async function completeStubLogin(baseUrl: string): Promise<Response> {
  const authorization = await startStubOidcLogin(baseUrl);
  return fetch(authorization.callbackUrl, {
    headers: {Cookie: authorization.handshakeCookie},
    redirect: "manual",
  });
}

function applicationCookieHeader(setCookieHeaders: readonly string[]): string {
  const pairs = setCookieHeaders
    .filter((value) =>
      value.startsWith("artifact_session=") || value.startsWith("artifact_csrf=")
    )
    .map((value) => value.split(";", 1)[0]);
  if (pairs.length !== 2) {
    throw new Error("The login response did not issue both application cookies.");
  }
  return pairs.join("; ");
}

function externalIdentities(
  installation: TestInstallation,
): readonly z.infer<typeof externalIdentityRowSchema>[] {
  const database = openIdentityDatabase(installation);
  try {
    return database
      .prepare(
        "SELECT provider, subject, member_id, email FROM external_identities ORDER BY subject",
      )
      .all()
      .map((row) => externalIdentityRowSchema.parse(row));
  } finally {
    database.close();
  }
}

function rowCount(installation: TestInstallation, table: string): number {
  const database = openIdentityDatabase(installation);
  try {
    return countRowSchema.parse(
      database.prepare(`SELECT COUNT(*) AS total FROM ${table}`).get(),
    ).total;
  } finally {
    database.close();
  }
}

function openIdentityDatabase(installation: TestInstallation): DatabaseSync {
  return new DatabaseSync(
    path.join(installation.dataDirectory, "artifact-server.db"),
    {readOnly: true},
  );
}
