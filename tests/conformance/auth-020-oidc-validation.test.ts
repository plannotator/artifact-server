import path from "node:path";
import {DatabaseSync} from "node:sqlite";

import {afterEach, beforeEach, describe, expect, test} from "vitest";
import {Effect, Logger} from "effect";
import {z} from "zod";

import {OidcIdentityProvider} from "../../src/identity/oidc-identity-provider.js";
import type {Clock} from "../../src/core/ports.js";
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
const scopes = "openid email profile";
const attemptLifetimeMilliseconds = 10 * 60 * 1_000;
const providerFailureMessage =
  "The configured identity provider could not complete browser login.";
const countRowSchema = z.object({total: z.number().int().nonnegative()});
const failureSchema = z.object({
  error: z.object({code: z.string(), message: z.string()}),
});
const sessionResponseSchema = z.object({
  principal: z.object({id: z.string(), membershipRole: z.literal("administrator")}),
});

describe("OIDC id_token validation", () => {
  let clock: MutableClock;
  let installation: TestInstallation;
  let provider: RunningStubOidcProvider;
  let server: RunningTestServer;
  let applicationOrigin: string;

  beforeEach(async () => {
    installation = await createTestInstallation();
    provider = await startStubOidcProvider({
      clientId: "artifact-server-oidc-validation",
    });
    provider.claims.email = administratorEmail;
    clock = new MutableClock("2026-08-18T09:00:00.000Z");
    const port = await reserveLoopbackPort();
    applicationOrigin = `http://127.0.0.1:${port}`;
    server = await startTestServer(installation, {
      applicationOrigin,
      bootstrapAdministratorEmail: administratorEmail,
      browserAccess: privateTeamBrowserAccess(browserLoginKinds.oidc),
      clock,
      interactiveIdentityProvider: new OidcIdentityProvider({
        clientId: provider.clientId,
        clientSecret: null,
        issuer: provider.issuer,
        redirectUri: `${applicationOrigin}/auth/callback`,
        scopes,
      }),
      port,
    });
  });

  afterEach(async () => {
    await server.stop();
    await provider.stop();
    await removeTestInstallation(installation);
  });

  test("AUTH-020-B: id_tokens skewed inside the thirty-second tolerance still complete login", async () => {
    provider.claims.issuedAtSkewSeconds = 20;
    const ahead = await completeStubLogin(server.baseUrl);
    expect(ahead.status).toBe(303);
    const aheadSession = await fetch(`${server.baseUrl}/api/v1/session`, {
      headers: {Cookie: applicationCookieHeader(ahead.headers.getSetCookie())},
    });
    expect(aheadSession.status).toBe(200);
    const admitted = sessionResponseSchema.parse(await aheadSession.json());

    provider.claims.expiresInSeconds = 300;
    provider.claims.issuedAtSkewSeconds = -320;
    const behind = await completeStubLogin(server.baseUrl);
    expect(behind.status).toBe(303);
    const behindSession = await fetch(`${server.baseUrl}/api/v1/session`, {
      headers: {Cookie: applicationCookieHeader(behind.headers.getSetCookie())},
    });
    expect(sessionResponseSchema.parse(await behindSession.json()).principal.id)
      .toBe(admitted.principal.id);

    provider.claims.issuedAtSkewSeconds = 0;
    provider.claims.expiresInSeconds = 300;
    // "/..//host" normalizes to the scheme-relative pathname "//host"; the
    // sanitizer must refuse it after normalization, not only before.
    const sanitized = await startStubOidcLogin(
      server.baseUrl,
      "/..//hostile.example/phish",
    );
    const redirected = await fetch(sanitized.callbackUrl, {
      headers: {Cookie: sanitized.handshakeCookie},
      redirect: "manual",
    });
    expect(redirected.status).toBe(303);
    expect(redirected.headers.get("location")).toBe("/api/v1/session");

    expect(rowCount(installation, "installation_members")).toBe(1);
  });

  test("AUTH-020-F: every token, state, and attempt defect is refused without a session, a member, or a leaked credential", async () => {
    provider.defects.signWithForeignKey = true;
    const tampered = await startStubOidcLogin(server.baseUrl);
    const tamperedCode = requiredParameter(tampered.callbackUrl, "code");
    const foreignSignature = await fetch(tampered.callbackUrl, {
      headers: {Cookie: tampered.handshakeCookie},
      redirect: "manual",
    });
    await expectProviderRefusal(foreignSignature, tamperedCode);
    provider.defects.signWithForeignKey = false;

    const replayed = await fetch(tampered.callbackUrl, {
      headers: {Cookie: tampered.handshakeCookie},
      redirect: "manual",
    });
    expect(replayed.status).toBe(401);
    expect(replayed.headers.getSetCookie()).toEqual([]);

    provider.claims.issuer = "https://issuer.example.test";
    await expectProviderRefusalFor(server.baseUrl);
    provider.claims.issuer = null;

    provider.claims.audience = "a-different-relying-party";
    await expectProviderRefusalFor(server.baseUrl);
    provider.claims.audience = null;

    provider.claims.issuedAtSkewSeconds = -400;
    provider.claims.expiresInSeconds = 300;
    await expectProviderRefusalFor(server.baseUrl);
    provider.claims.issuedAtSkewSeconds = 0;

    provider.claims.nonce = "a-nonce-the-attempt-never-minted";
    await expectProviderRefusalFor(server.baseUrl);
    provider.claims.nonce = null;

    provider.defects.withoutIdToken = true;
    await expectProviderRefusalFor(server.baseUrl);
    provider.defects.withoutIdToken = false;

    provider.defects.stateOverride = "an-unknown-login-state-value";
    const unknownState = await startStubOidcLogin(server.baseUrl);
    const unknown = await fetch(unknownState.callbackUrl, {
      // The browser replays a handshake matching the forged state, so only the
      // unknown attempt itself can refuse this callback.
      headers: {Cookie: "artifact_login=an-unknown-login-state-value"},
      redirect: "manual",
    });
    expect(unknown.status).toBe(401);
    expect(unknown.headers.getSetCookie()).toEqual([]);
    provider.defects.stateOverride = null;

    const unbound = await startStubOidcLogin(server.baseUrl);
    const withoutHandshake = await fetch(unbound.callbackUrl, {
      redirect: "manual",
    });
    expect(withoutHandshake.status).toBe(401);
    expect(withoutHandshake.headers.getSetCookie()).toEqual([]);
    const foreignHandshake = await fetch(unbound.callbackUrl, {
      headers: {Cookie: "artifact_login=a-handshake-from-another-browser"},
      redirect: "manual",
    });
    expect(foreignHandshake.status).toBe(401);
    expect(foreignHandshake.headers.getSetCookie()).toEqual([]);

    const expiring = await startStubOidcLogin(server.baseUrl);
    clock.advance(attemptLifetimeMilliseconds + 1_000);
    const expired = await fetch(expiring.callbackUrl, {
      headers: {Cookie: expiring.handshakeCookie},
      redirect: "manual",
    });
    expect(expired.status).toBe(401);
    expect(expired.headers.getSetCookie()).toEqual([]);

    expect(rowCount(installation, "installation_members")).toBe(0);
    expect(rowCount(installation, "external_identities")).toBe(0);
    expect(rowCount(installation, "application_sessions")).toBe(0);

    const exchangeFailureLogs = await captureProviderLogs(
      provider,
      applicationOrigin,
      () => {
        provider.defects.tokenStatus = 503;
      },
    );
    provider.defects.tokenStatus = 200;
    expect(exchangeFailureLogs.lines).toHaveLength(1);
    expect(exchangeFailureLogs.lines[0]).toContain("identity.oidc.exchange_failed");
    expect(exchangeFailureLogs.lines[0]).toContain(provider.issuer);
    expect(exchangeFailureLogs.lines[0]).toContain("token exchange returned HTTP 503");
    expect(exchangeFailureLogs.lines.join("\n")).not.toContain(
      exchangeFailureLogs.code,
    );
    expect(exchangeFailureLogs.lines.join("\n")).not.toContain(
      exchangeFailureLogs.codeVerifier,
    );

    const rejectedTokenLogs = await captureProviderLogs(
      provider,
      applicationOrigin,
      () => {
        provider.claims.nonce = "a-nonce-the-attempt-never-minted";
      },
    );
    provider.claims.nonce = null;
    expect(rejectedTokenLogs.lines).toEqual([]);
  });
});

interface CapturedProviderLogs {
  readonly code: string;
  readonly codeVerifier: string;
  readonly lines: readonly string[];
}

/** Run one real callback exchange against the stub under a capturing logger. */
async function captureProviderLogs(
  provider: RunningStubOidcProvider,
  applicationOrigin: string,
  injectDefect: () => void,
): Promise<CapturedProviderLogs> {
  const lines: string[] = [];
  const capturing = Logger.layer([
    Logger.map(Logger.formatJson, (line) => {
      lines.push(line);
    }),
  ]);
  const directProvider = new OidcIdentityProvider({
    clientId: provider.clientId,
    clientSecret: null,
    issuer: provider.issuer,
    redirectUri: `${applicationOrigin}/auth/callback`,
    scopes,
  });
  const authorization = await Effect.runPromise(
    directProvider.start().pipe(Effect.provide(capturing)),
  );
  const redirected = await fetch(authorization.authorizationUrl, {
    redirect: "manual",
  });
  const location = redirected.headers.get("location");
  if (location === null) throw new Error("The stub provider did not redirect.");
  const code = requiredParameter(new URL(location), "code");
  lines.length = 0;
  injectDefect();
  await Effect.runPromise(
    directProvider
      .complete(code, authorization.codeVerifier, authorization.nonce)
      .pipe(
        Effect.catch(() => Effect.succeed("refused")),
        Effect.provide(capturing),
      ),
  );
  return {code, codeVerifier: authorization.codeVerifier, lines};
}

async function expectProviderRefusalFor(baseUrl: string): Promise<void> {
  const authorization = await startStubOidcLogin(baseUrl);
  const code = requiredParameter(authorization.callbackUrl, "code");
  const response = await fetch(authorization.callbackUrl, {
    headers: {Cookie: authorization.handshakeCookie},
    redirect: "manual",
  });
  await expectProviderRefusal(response, code);
}

async function expectProviderRefusal(
  response: Response,
  code: string,
): Promise<void> {
  expect(response.status).toBe(502);
  expect(response.headers.getSetCookie()).toEqual([]);
  const body = await response.text();
  expect(body).not.toContain(code);
  expect(failureSchema.parse(JSON.parse(body)).error).toEqual({
    code: "IDENTITY_PROVIDER_FAILURE",
    message: providerFailureMessage,
  });
}

async function completeStubLogin(baseUrl: string): Promise<Response> {
  const authorization = await startStubOidcLogin(baseUrl);
  return fetch(authorization.callbackUrl, {
    headers: {Cookie: authorization.handshakeCookie},
    redirect: "manual",
  });
}

function requiredParameter(url: URL, name: string): string {
  const value = url.searchParams.get(name);
  if (value === null) {
    throw new Error(`The callback URL did not carry a ${name} parameter.`);
  }
  return value;
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

function rowCount(installation: TestInstallation, table: string): number {
  const database = new DatabaseSync(
    path.join(installation.dataDirectory, "artifact-server.db"),
    {readOnly: true},
  );
  try {
    return countRowSchema.parse(
      database.prepare(`SELECT COUNT(*) AS total FROM ${table}`).get(),
    ).total;
  } finally {
    database.close();
  }
}

class MutableClock implements Clock {
  #milliseconds: number;

  constructor(instant: string) {
    this.#milliseconds = new Date(instant).getTime();
  }

  advance(milliseconds: number): void {
    this.#milliseconds += milliseconds;
  }

  now(): Date {
    return new Date(this.#milliseconds);
  }
}
