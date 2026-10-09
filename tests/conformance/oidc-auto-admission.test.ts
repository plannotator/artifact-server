import path from "node:path";
import {DatabaseSync} from "node:sqlite";

import {Redacted} from "effect";
import {afterEach, beforeEach, describe, expect, test} from "vitest";
import {z} from "zod";

import {browserLoginKinds, privateTeamBrowserAccess} from "../../src/core/browser-access.js";
import {createOidcIdentityProvider} from "../../src/identity/oidc-identity-provider.js";
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
const clientSecret = "oidc-admission-test-client-secret";
const sessionSchema = z.object({
  principal: z.object({id: z.string(), membershipRole: z.enum(["administrator", "member"])}),
});
const memberSchema = z.object({member: z.object({id: z.string()})});
const countSchema = z.object({total: z.number()});

interface ApplicationCookies {
  readonly csrf: string;
  readonly header: string;
}

describe("OIDC automatic browser admission", () => {
  let installation: TestInstallation;
  let provider: RunningStubOidcProvider;
  let server: RunningTestServer | null = null;

  beforeEach(async () => {
    installation = await createTestInstallation();
    provider = await startStubOidcProvider({clientId: "oidc-admission-test", clientSecret});
  });

  afterEach(async () => {
    if (server !== null) await server.stop();
    await provider.stop();
    await removeTestInstallation(installation);
    server = null;
  });

  async function startServer(
    allowedEmailDomains: readonly string[] | null = [],
    policyProvider = `oidc:${provider.issuer}`,
  ): Promise<RunningTestServer> {
    const port = await reserveLoopbackPort();
    const applicationOrigin = `http://127.0.0.1:${port}`;
    const options = {
      applicationOrigin,
      bootstrapAdministratorEmail: administratorEmail,
      browserAccess: privateTeamBrowserAccess(browserLoginKinds.oidc),
      interactiveIdentityProvider: createOidcIdentityProvider({
        applicationOrigin,
        clientId: provider.clientId,
        clientSecret: Redacted.make(clientSecret),
        issuer: provider.issuer,
        scopes: "openid email profile",
      }),
      port,
    };
    if (allowedEmailDomains !== null) {
      Object.assign(options, {externalIdentityAdmissionPolicy: {provider: policyProvider, allowedEmailDomains}});
    }
    server = await startTestServer(installation, options);
    return server;
  }

  async function bootstrap(running: RunningTestServer): Promise<ApplicationCookies> {
    provider.claims.email = administratorEmail;
    provider.claims.subject = "administrator-subject";
    provider.claims.emailVerified = true;
    const completed = await login(running);
    expect(completed.status).toBe(303);
    return applicationCookies(completed);
  }

  async function principal(running: RunningTestServer, response: Response) {
    const session = await fetch(`${running.baseUrl}/api/v1/session`, {
      headers: {Cookie: applicationCookies(response).header},
    });
    expect(session.status).toBe(200);
    return sessionSchema.parse(await session.json()).principal;
  }

  test("AUTH-029-F: an unadmitted OIDC user remains denied by default", async () => {
    const running = await startServer(null);
    await bootstrap(running);
    provider.claims.email = "member@ackstorm.com";
    provider.claims.subject = "member-subject";
    const denied = await login(running);
    expect(denied.status).toBe(403);
    expect(denied.headers.getSetCookie()).toEqual([]);
    expect(rowCount(installation, "installation_members")).toBe(1);
  });

  test("AUTH-029-B: enabled browser admission creates a normal member and reuses its identity", async () => {
    const running = await startServer();
    await bootstrap(running);
    provider.claims.email = "member@ackstorm.com";
    provider.claims.subject = "member-subject";
    const admitted = await login(running);
    expect(admitted.status).toBe(303);
    const first = await principal(running, admitted);
    expect(first.membershipRole).toBe("member");
    const repeated = await login(running);
    expect(repeated.status).toBe(303);
    expect(await principal(running, repeated)).toEqual(first);
    expect(rowCount(installation, "installation_members")).toBe(2);
    expect(rowCount(installation, "external_identities")).toBe(2);
  });

  test("AUTH-029: automatic admission preserves first-administrator bootstrap", async () => {
    const running = await startServer();
    provider.claims.email = "member@ackstorm.com";
    provider.claims.subject = "member-subject";
    expect((await login(running)).status).toBe(403);
    expect(rowCount(installation, "installation_members")).toBe(0);
    const cookies = await bootstrap(running);
    const session = await fetch(`${running.baseUrl}/api/v1/session`, {headers: {Cookie: cookies.header}});
    expect(sessionSchema.parse(await session.json()).principal.membershipRole).toBe("administrator");
  });

  test.each([
    {email: "member@ackstorm.com", subject: "different-subject"},
    {email: "changed@ackstorm.com", subject: "member-subject"},
    {email: "other@ackstorm.com", subject: "member-subject"},
  ])("AUTH-029: inactive identity stays denied with $email and $subject", async ({email, subject}) => {
    const running = await startServer();
    const adminCookies = await bootstrap(running);
    provider.claims.email = "member@ackstorm.com";
    provider.claims.subject = "member-subject";
    const admitted = await login(running);
    expect(admitted.status).toBe(303);
    const member = await principal(running, admitted);
    const other = await fetch(`${running.baseUrl}/api/v1/members`, {
      body: JSON.stringify({displayName: "Other", email: "other@ackstorm.com", role: "member"}),
      headers: mutationHeaders(running.baseUrl, adminCookies),
      method: "POST",
    });
    expect(other.status).toBe(201);
    const deactivated = await fetch(`${running.baseUrl}/api/v1/members/${member.id}/deactivate`, {
      headers: mutationHeaders(running.baseUrl, adminCookies), method: "POST",
    });
    expect(deactivated.status).toBe(200);
    const sessionCount = rowCount(installation, "application_sessions");
    provider.claims.email = email;
    provider.claims.subject = subject;
    const denied = await login(running);
    expect(denied.status).toBe(403);
    expect(denied.headers.getSetCookie()).toEqual([]);
    expect(rowCount(installation, "installation_members")).toBe(3);
    expect(rowCount(installation, "application_sessions")).toBe(sessionCount);
    const revoked = await fetch(`${running.baseUrl}/api/v1/session`, {
      headers: {Cookie: applicationCookies(admitted).header},
    });
    expect(revoked.status).toBe(401);
  });

  test("AUTH-029: simultaneous first logins converge on one member", async () => {
    const running = await startServer();
    await bootstrap(running);
    provider.claims.email = "member@ackstorm.com";
    provider.claims.subject = "member-subject";
    const attempts = await Promise.all([
      startStubOidcLogin(running.baseUrl), startStubOidcLogin(running.baseUrl),
    ]);
    const completed = await Promise.all(attempts.map((attempt) => fetch(attempt.callbackUrl, {
      headers: {Cookie: attempt.handshakeCookie}, redirect: "manual",
    })));
    expect(completed.map((response) => response.status)).toEqual([303, 303]);
    const principals = await Promise.all(completed.map((response) => principal(running, response)));
    expect(principals[0]).toEqual(principals[1]);
    expect(principals[0]?.membershipRole).toBe("member");
    expect(rowCount(installation, "installation_members")).toBe(2);
    expect(rowCount(installation, "external_identities")).toBe(2);
  });

  test("AUTH-029: enabled admission still refuses an explicitly unverified email", async () => {
    const running = await startServer();
    await bootstrap(running);
    provider.claims.email = "member@ackstorm.com";
    provider.claims.subject = "member-subject";
    provider.claims.emailVerified = false;
    const denied = await login(running);
    expect(denied.status).toBe(403);
    expect(denied.headers.getSetCookie()).toEqual([]);
    expect(rowCount(installation, "installation_members")).toBe(1);
  });

  test("AUTH-029: a policy for another issuer cannot admit a verified user", async () => {
    const running = await startServer([], "oidc:https://another-issuer.example.test");
    await bootstrap(running);
    provider.claims.email = "member@ackstorm.com";
    provider.claims.subject = "member-subject";
    expect((await login(running)).status).toBe(403);
    expect(rowCount(installation, "installation_members")).toBe(1);
  });

  test("AUTH-029: a token with a foreign signature creates no member or session", async () => {
    const running = await startServer();
    await bootstrap(running);
    provider.claims.email = "member@ackstorm.com";
    provider.claims.subject = "member-subject";
    provider.defects.signWithForeignKey = true;
    const denied = await login(running);
    expect(denied.status).toBe(502);
    expect(denied.headers.getSetCookie()).toEqual([]);
    expect(rowCount(installation, "installation_members")).toBe(1);
    expect(rowCount(installation, "application_sessions")).toBe(1);
  });

  test("AUTH-029: explicitly admitted administrators keep their role", async () => {
    const running = await startServer();
    const cookies = await bootstrap(running);
    const admitted = await fetch(`${running.baseUrl}/api/v1/members`, {
      body: JSON.stringify({displayName: "Second admin", email: "admin@ackstorm.com", role: "administrator"}),
      headers: mutationHeaders(running.baseUrl, cookies), method: "POST",
    });
    expect(admitted.status).toBe(201);
    const member = memberSchema.parse(await admitted.json()).member;
    provider.claims.email = "admin@ackstorm.com";
    provider.claims.subject = "second-admin-subject";
    const completed = await login(running);
    expect(completed.status).toBe(303);
    expect(await principal(running, completed)).toEqual({id: member.id, membershipRole: "administrator"});
  });

  test("AUTH-029: a listed domain admits a member after email normalization", async () => {
    const running = await startServer(["ackstorm.com"]);
    await bootstrap(running);
    provider.claims.email = "Member@ACKSTORM.COM";
    provider.claims.subject = "domain-member-subject";
    const completed = await login(running);
    expect(completed.status).toBe(303);
    expect((await principal(running, completed)).membershipRole).toBe("member");
    expect(rowCount(installation, "installation_members")).toBe(2);
  });

  test.each(["member@gmail.com", "member@sub.ackstorm.com", "member@ackstorm.com.attacker.test"])(
    "AUTH-029: domain allowlisting refuses %s", async (email) => {
      const running = await startServer(["ackstorm.com"]);
      await bootstrap(running);
      provider.claims.email = email;
      provider.claims.subject = "domain-member-subject";
      const denied = await login(running);
      expect(denied.status).toBe(403);
      expect(denied.headers.getSetCookie()).toEqual([]);
      expect(rowCount(installation, "installation_members")).toBe(1);
      expect(rowCount(installation, "application_sessions")).toBe(1);
    },
  );

  test("AUTH-029: the domain allowlist preserves explicit admission outside its domains", async () => {
    const running = await startServer(["ackstorm.com"]);
    const cookies = await bootstrap(running);
    const admitted = await fetch(`${running.baseUrl}/api/v1/members`, {
      body: JSON.stringify({displayName: "Invited", email: "invited@example.net", role: "member"}),
      headers: mutationHeaders(running.baseUrl, cookies), method: "POST",
    });
    expect(admitted.status).toBe(201);
    provider.claims.email = "invited@example.net";
    provider.claims.subject = "invited-subject";
    const completed = await login(running);
    expect(completed.status).toBe(303);
    expect((await principal(running, completed)).membershipRole).toBe("member");
  });
});

async function login(running: RunningTestServer): Promise<Response> {
  const started = await startStubOidcLogin(running.baseUrl);
  return fetch(started.callbackUrl, {headers: {Cookie: started.handshakeCookie}, redirect: "manual"});
}

function applicationCookies(response: Response): ApplicationCookies {
  const pairs = response.headers.getSetCookie()
    .filter((value) => value.startsWith("artifact_session=") || value.startsWith("artifact_csrf="))
    .map((value) => value.split(";", 1)[0]);
  const csrfPair = pairs.find((value) => value?.startsWith("artifact_csrf="));
  if (pairs.length !== 2 || csrfPair === undefined) throw new Error("The response lacks application cookies.");
  return {header: pairs.join("; "), csrf: csrfPair.slice("artifact_csrf=".length)};
}

function mutationHeaders(origin: string, cookies: ApplicationCookies): Headers {
  return new Headers({
    "Content-Type": "application/json", Cookie: cookies.header, Origin: origin,
    "Sec-Fetch-Mode": "cors", "Sec-Fetch-Site": "same-origin", "X-CSRF-Token": cookies.csrf,
  });
}

function rowCount(installation: TestInstallation, table: string): number {
  const database = new DatabaseSync(path.join(installation.dataDirectory, "artifact-server.db"), {readOnly: true});
  try {
    return countSchema.parse(database.prepare(`SELECT COUNT(*) AS total FROM ${table}`).get()).total;
  } finally {
    database.close();
  }
}
