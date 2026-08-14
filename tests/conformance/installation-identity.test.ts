import {afterEach, beforeEach, describe, expect, test} from "vitest";
import {createHash} from "node:crypto";
import {Effect, Redacted} from "effect";
import {z} from "zod";

import type {
  InteractiveAuthorization,
  InteractiveIdentityProvider,
} from "../../src/application/interactive-login.js";
import type {BearerCredentialVerifier} from "../../src/application/authentication.js";
import {
  AuthenticationRequired,
  IdentityProviderFailure,
} from "../../src/core/errors.js";
import type {ExternalIdentity} from "../../src/core/installation-identity.js";
import type {Clock} from "../../src/core/ports.js";
import {
  createTestInstallation,
  fetchVersion,
  type RunningTestServer,
  type TestInstallation,
  removeTestInstallation,
  startTestServer,
} from "../support/runtime-harness.js";

const sessionResponseSchema = z.object({
  authenticationMethod: z.literal("session"),
  principal: z.object({
    id: z.string(),
    kind: z.literal("human"),
    membershipRole: z.literal("administrator"),
  }),
});
const issuedKeySchema = z.object({
  apiKey: z.object({
    id: z.string(),
    revokedAt: z.string().nullable(),
  }),
  token: z.string().startsWith("as_key_"),
});
const issuedHumanKeySchema = z.object({
  apiKey: z.object({
    id: z.string(),
    principalId: z.string(),
    principalKind: z.literal("human"),
    revokedAt: z.string().nullable(),
  }),
  token: z.string().startsWith("as_key_"),
});

describe("installation identity and access", () => {
  let installation: TestInstallation;
  let server: RunningTestServer;
  let clock: MutableClock;

  beforeEach(async () => {
    installation = await createTestInstallation();
    clock = new MutableClock("2026-08-13T08:00:00.000Z");
    server = await startTestServer(installation, {clock});
  });

  afterEach(async () => {
    await server.stop();
    await removeTestInstallation(installation);
  });

  test("bootstrap membership and managed keys fail closed", async () => {
    const rejected = await fetch(
      `${server.baseUrl}/auth/local?token=${"x".repeat(43)}`,
      {redirect: "manual"},
    );
    expect(rejected.status).toBe(401);

    const login = await fetch(
      `${server.baseUrl}/auth/local?token=${installation.browserBootstrapToken}`,
      {redirect: "manual"},
    );
    expect(login.status).toBe(303);
    expect(login.headers.get("cache-control")).toBe("private, no-store");
    const cookies = applicationCookies(login.headers.getSetCookie());
    expect(cookies.sessionAttributes).toContain("HttpOnly");
    expect(cookies.sessionAttributes).toContain("SameSite=Lax");

    const session = await fetch(`${server.baseUrl}/api/v1/session`, {
      headers: {Cookie: cookies.header},
    });
    expect(session.status).toBe(200);
    const principal = sessionResponseSchema.parse(await session.json()).principal;

    const missingCsrf = await fetch(`${server.baseUrl}/api/v1/members`, {
      body: JSON.stringify({
        displayName: "Second member",
        email: "member@example.test",
      }),
      headers: {
        "Content-Type": "application/json",
        Cookie: cookies.header,
      },
      method: "POST",
    });
    expect(missingCsrf.status).toBe(403);

    const member = await fetch(`${server.baseUrl}/api/v1/members`, {
      body: JSON.stringify({
        displayName: "Second member",
        email: "member@example.test",
      }),
      headers: browserMutationHeaders(server.baseUrl, cookies),
      method: "POST",
    });
    expect(member.status).toBe(201);
    const admittedMember = z.object({
      member: z.object({id: z.string()}),
    }).parse(await member.json()).member;

    const cannotRemoveLastAdministrator = await fetch(
      `${server.baseUrl}/api/v1/members/${principal.id}/deactivate`,
      {
        headers: browserMutationHeaders(server.baseUrl, cookies),
        method: "POST",
      },
    );
    expect(cannotRemoveLastAdministrator.status).toBe(409);

    const pastExpiration = await fetch(`${server.baseUrl}/api/v1/api-keys`, {
      body: JSON.stringify({
        capabilities: ["artifact:read"],
        expiresAt: "2026-08-13T07:59:59.999Z",
        name: "Already expired automation",
      }),
      headers: browserMutationHeaders(server.baseUrl, cookies),
      method: "POST",
    });
    expect(pastExpiration.status).toBe(409);
    expect(await pastExpiration.json()).toEqual({
      error: {
        code: "IDENTITY_CONFLICT",
        message: "The API key expiration must be a future date and time.",
      },
    });

    const issuedResponse = await fetch(`${server.baseUrl}/api/v1/api-keys`, {
      body: JSON.stringify({
        capabilities: ["artifact:read"],
        expiresAt: "2099-01-01T00:00:00.000Z",
        name: "Read-only automation",
      }),
      headers: browserMutationHeaders(server.baseUrl, cookies),
      method: "POST",
    });
    expect(issuedResponse.status).toBe(201);
    const issued = issuedKeySchema.parse(await issuedResponse.json());

    const keyRead = await fetch(`${server.baseUrl}/api/v1/artifacts`, {
      headers: {Authorization: `Bearer ${issued.token}`},
    });
    expect(keyRead.status).toBe(200);

    expect(await publishStatus(
      server,
      issued.token,
    )).toBe(403);

    const rotatedResponse = await fetch(
      `${server.baseUrl}/api/v1/api-keys/${issued.apiKey.id}/rotate`,
      {
        headers: browserMutationHeaders(server.baseUrl, cookies),
        method: "POST",
      },
    );
    expect(rotatedResponse.status).toBe(201);
    const rotated = issuedKeySchema.parse(await rotatedResponse.json());
    expect(rotated.token).not.toBe(issued.token);
    expect(await bearerStatus(server, issued.token)).toBe(401);
    expect(await bearerStatus(server, rotated.token)).toBe(200);
    expect((await fetch(
      `${server.baseUrl}/api/v1/api-keys/${issued.apiKey.id}/rotate`,
      {
        headers: browserMutationHeaders(server.baseUrl, cookies),
        method: "POST",
      },
    )).status).toBe(409);
    expect(await bearerStatus(server, rotated.token)).toBe(200);

    const revokedResponse = await fetch(
      `${server.baseUrl}/api/v1/api-keys/${rotated.apiKey.id}/revoke`,
      {
        headers: browserMutationHeaders(server.baseUrl, cookies),
        method: "POST",
      },
    );
    expect(revokedResponse.status).toBe(200);
    expect(await bearerStatus(server, rotated.token)).toBe(401);

    const malformedManagedKey = `${rotated.token}tampered`;
    expect(await bearerStatus(server, malformedManagedKey)).toBe(401);
    expect(await bearerStatus(server, installation.apiToken)).toBe(200);

    const expiringKeyResponse = await fetch(`${server.baseUrl}/api/v1/api-keys`, {
      body: JSON.stringify({
        capabilities: ["artifact:read"],
        expiresAt: "2026-08-13T08:01:00.000Z",
        name: "Short-lived automation",
      }),
      headers: browserMutationHeaders(server.baseUrl, cookies),
      method: "POST",
    });
    const expiringKey = issuedKeySchema.parse(await expiringKeyResponse.json());
    expect(await bearerStatus(server, expiringKey.token)).toBe(200);
    clock.advance(60_001);
    expect(await bearerStatus(server, expiringKey.token)).toBe(401);

    const humanKeyResponse = await fetch(`${server.baseUrl}/api/v1/api-keys`, {
      body: JSON.stringify({
        capabilities: ["artifact:read"],
        expiresAt: "2099-01-01T00:00:00.000Z",
        memberId: admittedMember.id,
        name: "Second member personal key",
      }),
      headers: browserMutationHeaders(server.baseUrl, cookies),
      method: "POST",
    });
    expect(humanKeyResponse.status).toBe(201);
    const humanKey = issuedHumanKeySchema.parse(await humanKeyResponse.json());
    expect(humanKey.apiKey.principalId).toBe(admittedMember.id);
    expect(await bearerStatus(server, humanKey.token)).toBe(200);
    expect(await publishStatus(server, humanKey.token))
      .toBe(403);

    const deactivateMember = await fetch(
      `${server.baseUrl}/api/v1/members/${admittedMember.id}/deactivate`,
      {
        headers: browserMutationHeaders(server.baseUrl, cookies),
        method: "POST",
      },
    );
    expect(deactivateMember.status).toBe(200);
    expect(await bearerStatus(server, humanKey.token)).toBe(401);
  });

  test("AUTH-010-B AUTH-010-F AUTH-011-B AUTH-011-F AUTH-012-B AUTH-012-F AUTH-013-F: browser credentials stay on the application host and mutations require same-origin proof", async () => {
    const login = await fetch(
      `${server.baseUrl}/auth/local?token=${installation.browserBootstrapToken}`,
      {redirect: "manual"},
    );
    const cookies = applicationCookies(login.headers.getSetCookie());
    expect(cookies.sessionAttributes).toContain("Path=/");
    expect(cookies.sessionAttributes).not.toContain("Domain=");

    const staleCsrf = await fetch(`${server.baseUrl}/api/v1/members`, {
      body: JSON.stringify({
        displayName: "Must not exist",
        email: "stale-csrf@example.test",
      }),
      headers: {
        ...Object.fromEntries(browserMutationHeaders(server.baseUrl, cookies)),
        "X-CSRF-Token": "x".repeat(43),
      },
      method: "POST",
    });
    expect(staleCsrf.status).toBe(403);

    const hostileOrigin = await fetch(`${server.baseUrl}/api/v1/members`, {
      body: JSON.stringify({
        displayName: "Must not exist",
        email: "hostile@example.test",
      }),
      headers: {
        ...Object.fromEntries(browserMutationHeaders(server.baseUrl, cookies)),
        Origin: "https://hostile.example",
      },
      method: "POST",
    });
    expect(hostileOrigin.status).toBe(403);

    const crossSiteFetch = await fetch(`${server.baseUrl}/api/v1/members`, {
      body: JSON.stringify({
        displayName: "Must not exist",
        email: "cross-site@example.test",
      }),
      headers: {
        ...Object.fromEntries(browserMutationHeaders(server.baseUrl, cookies)),
        "Sec-Fetch-Site": "cross-site",
      },
      method: "POST",
    });
    expect(crossSiteFetch.status).toBe(403);

    const corsRead = await fetch(`${server.baseUrl}/api/v1/session`, {
      headers: {
        Cookie: cookies.header,
        Origin: `http://${"c".repeat(32)}.localhost:${server.port}`,
      },
    });
    expect(corsRead.status).toBe(200);
    expect(corsRead.headers.get("access-control-allow-origin")).toBeNull();
    expect(corsRead.headers.get("access-control-allow-credentials")).toBeNull();

    const corsPreflight = await fetch(`${server.baseUrl}/api/v1/session`, {
      headers: {
        "Access-Control-Request-Method": "GET",
        Origin: `http://${"c".repeat(32)}.localhost:${server.port}`,
      },
      method: "OPTIONS",
    });
    expect(corsPreflight.status).toBe(401);
    expect(corsPreflight.headers.get("access-control-allow-origin")).toBeNull();
    expect(corsPreflight.headers.get("access-control-allow-credentials")).toBeNull();

    const contentHostLogin = await fetchVersion(
      server,
      `http://${"c".repeat(32)}.localhost:${server.port}/auth/local?token=${installation.browserBootstrapToken}`,
    );
    expect(contentHostLogin.status).toBe(404);
    expect(contentHostLogin.headers.getSetCookie()).toEqual([]);

    const logout = await fetch(`${server.baseUrl}/api/v1/session/logout`, {
      headers: browserMutationHeaders(server.baseUrl, cookies),
      method: "POST",
    });
    expect(logout.status).toBe(204);
    const afterLogout = await fetch(`${server.baseUrl}/api/v1/session`, {
      headers: {Cookie: cookies.header},
    });
    expect(afterLogout.status).toBe(401);
  });

  test("AUTH-001-B AUTH-001-F: external login admits only the configured first administrator and consumes state once", async () => {
    await server.stop();
    const provider = new TestIdentityProvider({
      displayName: "Michael Ramos",
      email: "ramos@plannotator.ai",
      emailVerified: true,
      provider: "test-workos",
      subject: "workos-user-ramos",
    });
    server = await startTestServer(installation, {
      bootstrapAdministratorEmail: "ramos@plannotator.ai",
      interactiveIdentityProvider: provider,
    });

    const started = await fetch(
      `${server.baseUrl}/auth/login?returnTo=${encodeURIComponent("https://hostile.example")}`,
      {redirect: "manual"},
    );
    expect(started.status).toBe(302);
    expect(started.headers.get("location")).toBe(provider.authorizationUrl);

    const callbackUrl = new URL("/auth/callback", server.baseUrl);
    callbackUrl.searchParams.set("code", provider.authorizationCode);
    callbackUrl.searchParams.set("state", provider.authorization.state);
    const completed = await fetch(callbackUrl, {redirect: "manual"});
    expect(completed.status).toBe(303);
    expect(completed.headers.get("location")).toBe("/api/v1/session");
    expect(provider.completedCodeVerifier).toBe(provider.authorization.codeVerifier);
    const cookies = applicationCookies(completed.headers.getSetCookie());
    const signedInSession = await fetch(`${server.baseUrl}/api/v1/session`, {
      headers: {Cookie: cookies.header},
    });
    expect(signedInSession.status).toBe(200);
    const firstAdministrator = sessionResponseSchema.parse(
      await signedInSession.json(),
    ).principal;

    const replay = await fetch(callbackUrl, {redirect: "manual"});
    expect(replay.status).toBe(401);

    const replacementAdministratorResponse = await fetch(
      `${server.baseUrl}/api/v1/members`,
      {
        body: JSON.stringify({
          displayName: "Replacement administrator",
          email: "replacement@example.test",
          role: "administrator",
        }),
        headers: browserMutationHeaders(server.baseUrl, cookies),
        method: "POST",
      },
    );
    expect(replacementAdministratorResponse.status).toBe(201);
    const replacementAdministrator = z.object({
      member: z.object({email: z.string(), id: z.string()}),
    }).parse(await replacementAdministratorResponse.json()).member;
    expect((await fetch(
      `${server.baseUrl}/api/v1/members/${firstAdministrator.id}/deactivate`,
      {
        headers: browserMutationHeaders(server.baseUrl, cookies),
        method: "POST",
      },
    )).status).toBe(200);

    provider.identity = {
      ...provider.identity,
      email: replacementAdministrator.email,
    };
    expect((await fetch(`${server.baseUrl}/auth/login`, {
      redirect: "manual",
    })).status).toBe(302);
    const rebindCallback = new URL("/auth/callback", server.baseUrl);
    rebindCallback.searchParams.set("code", provider.authorizationCode);
    rebindCallback.searchParams.set("state", provider.authorization.state);
    expect((await fetch(rebindCallback, {redirect: "manual"})).status).toBe(409);

    provider.identity = {
      ...provider.identity,
      email: "outside@example.test",
      subject: "outside-user",
    };
    const outsideStart = await fetch(`${server.baseUrl}/auth/login`, {
      redirect: "manual",
    });
    expect(outsideStart.status).toBe(302);
    const outsideCallback = new URL("/auth/callback", server.baseUrl);
    outsideCallback.searchParams.set("code", provider.authorizationCode);
    outsideCallback.searchParams.set("state", provider.authorization.state);
    expect((await fetch(outsideCallback, {redirect: "manual"})).status).toBe(403);
  });

  test("external login reports a malformed verified identity as a typed conflict", async () => {
    await server.stop();
    const provider = new TestIdentityProvider({
      displayName: "Malformed identity",
      email: "not-an-email-address",
      emailVerified: true,
      provider: "test-workos",
      subject: "workos-user-malformed",
    });
    server = await startTestServer(installation, {
      bootstrapAdministratorEmail: "ramos@plannotator.ai",
      interactiveIdentityProvider: provider,
    });

    expect((await fetch(`${server.baseUrl}/auth/login`, {
      redirect: "manual",
    })).status).toBe(302);
    const callback = new URL("/auth/callback", server.baseUrl);
    callback.searchParams.set("code", provider.authorizationCode);
    callback.searchParams.set("state", provider.authorization.state);
    const response = await fetch(callback, {redirect: "manual"});

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: {
        code: "IDENTITY_CONFLICT",
        message: "A valid email address is required.",
      },
    });
  });

  test("a configured external bearer verifier shares the principal boundary without managed-key parser fallback", async () => {
    await server.stop();
    let verificationCount = 0;
    const externalBearerVerifier: BearerCredentialVerifier = {
      verify: (credential) => {
        verificationCount += 1;
        return Redacted.value(credential) === "trusted-external-access-token"
          ? Effect.succeed({
            authorizedByPrincipalId: "external-issuer",
            capabilities: ["artifact:read"],
            id: "external-service",
            installationId: "local",
            kind: "service",
            membershipRole: "member",
          })
          : Effect.fail(new AuthenticationRequired({
            message: "The external access token is invalid.",
          }));
      },
    };
    server = await startTestServer(installation, {externalBearerVerifier});

    expect(await bearerStatus(server, "trusted-external-access-token")).toBe(200);
    expect(verificationCount).toBe(1);

    const managedLookingToken =
      `as_key_key_00000000-0000-4000-8000-000000000000_${"x".repeat(43)}`;
    expect(await bearerStatus(server, managedLookingToken)).toBe(401);
    expect(verificationCount).toBe(1);
    expect(await bearerStatus(server, "wrong-external-access-token")).toBe(401);
    expect(verificationCount).toBe(2);
  });
});

class TestIdentityProvider implements InteractiveIdentityProvider {
  authorization: InteractiveAuthorization = {
    authorizationUrl: "https://identity.example/authorize",
    codeVerifier: "test-code-verifier-with-sufficient-entropy",
    state: "test-login-state-with-sufficient-entropy-0",
  };
  readonly authorizationCode = "test-authorization-code";
  readonly name = "test-workos";
  completedCodeVerifier: string | null = null;
  identity: ExternalIdentity;
  #startCount = 0;

  constructor(identity: ExternalIdentity) {
    this.identity = identity;
  }

  get authorizationUrl(): string {
    return this.authorization.authorizationUrl;
  }

  complete(
    code: string,
    codeVerifier: string,
  ): Effect.Effect<ExternalIdentity, IdentityProviderFailure> {
    if (code !== this.authorizationCode) {
      return Effect.fail(new IdentityProviderFailure({message: "Invalid code."}));
    }
    this.completedCodeVerifier = codeVerifier;
    return Effect.succeed(this.identity);
  }

  start(): Effect.Effect<InteractiveAuthorization, IdentityProviderFailure> {
    this.#startCount += 1;
    this.authorization = {
      ...this.authorization,
      state: `test-login-state-with-sufficient-entropy-${this.#startCount}`,
    };
    return Effect.succeed(this.authorization);
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

interface ApplicationCookies {
  readonly csrf: string;
  readonly header: string;
  readonly sessionAttributes: string;
}

function applicationCookies(setCookieHeaders: readonly string[]): ApplicationCookies {
  const session = setCookieHeaders.find((value) => value.startsWith("artifact_session="));
  const csrf = setCookieHeaders.find((value) => value.startsWith("artifact_csrf="));
  if (session === undefined || csrf === undefined) {
    throw new Error("The login response did not issue both application cookies.");
  }
  const sessionPair = session.split(";", 1)[0];
  const csrfPair = csrf.split(";", 1)[0];
  if (sessionPair === undefined || csrfPair === undefined) {
    throw new Error("The login response issued a malformed application cookie.");
  }
  const csrfToken = csrfPair.slice(csrfPair.indexOf("=") + 1);
  return {
    csrf: csrfToken,
    header: `${sessionPair}; ${csrfPair}`,
    sessionAttributes: session,
  };
}

function browserMutationHeaders(
  origin: string,
  cookies: ApplicationCookies,
): Headers {
  return new Headers({
    "Content-Type": "application/json",
    Cookie: cookies.header,
    Origin: origin,
    "Sec-Fetch-Mode": "cors",
    "Sec-Fetch-Site": "same-origin",
    "X-CSRF-Token": cookies.csrf,
  });
}

async function bearerStatus(
  server: RunningTestServer,
  token: string,
): Promise<number> {
  return fetch(`${server.baseUrl}/api/v1/artifacts`, {
    headers: {Authorization: `Bearer ${token}`},
  }).then((response) => response.status);
}

async function publishStatus(
  server: RunningTestServer,
  token: string,
): Promise<number> {
  const bytes = new TextEncoder().encode("denied");
  return fetch(`${server.baseUrl}/api/v1/uploads`, {
    body: JSON.stringify({
      entryPath: "denied.txt",
      files: [{
        mediaType: "text/plain",
        path: "denied.txt",
        sha256: createHash("sha256").update(bytes).digest("hex"),
        size: bytes.byteLength,
      }],
    }),
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    method: "POST",
  }).then((response) => response.status);
}
