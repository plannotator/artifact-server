import {createServer, type Server} from "node:http";

import {
  CLIENT_CAPABILITIES_META_KEY,
  CLIENT_INFO_META_KEY,
  PROTOCOL_VERSION_META_KEY,
} from "@modelcontextprotocol/server";
import {
  exportJWK,
  generateKeyPair,
  SignJWT,
  type CryptoKey,
  type JWK,
  type JWTPayload,
} from "jose";
import {Effect, Predicate, Redacted} from "effect";
import {afterEach, beforeEach, describe, expect, test} from "vitest";

import {createOidcHostedAuthentication} from
  "../../src/identity/oidc-hosted-authentication.js";
import {OidcMcpBearerVerifier} from
  "../../src/identity/oidc-mcp-bearer-verifier.js";
import {loadOidcAuthorizationServer} from
  "../../src/identity/oidc-oauth-metadata.js";
import type {ExternalMcpBearerVerifier} from
  "../../src/application/authentication.js";
import {
  createTestInstallation,
  removeTestInstallation,
  type RunningTestServer,
  startTestServer,
  type TestInstallation,
} from "../support/runtime-harness.js";

const protocolVersion = "2026-07-28";
const realmPath = "/realms/artifact";
const resource = "https://staging.artifactserver.test/mcp";
const subject = "9f1d2c3b-0000-4000-8000-artifactserver";
const userEmail = "administrator@example.test";

describe("generic OIDC MCP authorization", () => {
  let installation: TestInstallation;
  let issuer: string;
  let keyId: string;
  let privateKey: CryptoKey;
  let provider: ProviderBoundary;
  let server: RunningTestServer;

  beforeEach(async () => {
    const keys = await generateKeyPair("RS256");
    privateKey = keys.privateKey;
    keyId = crypto.randomUUID();
    const publicJwk = await exportJWK(keys.publicKey);
    provider = await startProviderBoundary({
      jwk: {...publicJwk, alg: "RS256", kid: keyId, use: "sig"},
    });
    issuer = provider.issuer;
    const authorizationServer = await loadOidcAuthorizationServer(issuer);
    installation = await createTestInstallation();
    server = await startTestServer(installation, {
      bootstrapAdministratorEmail: userEmail,
      externalMcpOAuthVerifier: new OidcMcpBearerVerifier({
        audience: resource,
        issuer,
        jwksUri: authorizationServer.jwksUri,
        userInfoEndpoint: authorizationServer.userInfoEndpoint,
      }),
      mcpOAuthResource: {
        authorizationServerMetadata: authorizationServer.metadata,
        resource,
      },
    });
  });

  afterEach(async () => {
    await server.stop();
    await provider.close();
    await removeTestInstallation(installation);
  });

  test("discovery accepts one realm-path issuer and refuses a weaker contract", async () => {
    expect.hasAssertions();
    const authorizationServer = await loadOidcAuthorizationServer(issuer);
    expect(authorizationServer.metadata).toMatchObject({issuer});
    expect(authorizationServer.jwksUri).toBe(
      `${issuer}/protocol/openid-connect/certs`,
    );
    expect(authorizationServer.userInfoEndpoint).toBe(
      `${issuer}/protocol/openid-connect/userinfo`,
    );

    await expect(loadOidcAuthorizationServer(issuer, {
      fetch: async () => documentResponse({
        ...discoveryDocument(issuer),
        issuer: "https://attacker.example",
      }),
    })).rejects.toThrow("different issuer");
    await expect(loadOidcAuthorizationServer(issuer, {
      fetch: async () => documentResponse({
        ...discoveryDocument(issuer),
        code_challenge_methods_supported: ["plain"],
      }),
    })).rejects.toThrow("S256 PKCE");
    await expect(loadOidcAuthorizationServer(issuer, {
      fetch: async () => documentResponse({
        ...discoveryDocument(issuer),
        response_types_supported: ["token"],
      }),
    })).rejects.toThrow("authorization code login");
    await expect(loadOidcAuthorizationServer(issuer, {
      fetch: async () => documentResponse({
        ...discoveryDocument(issuer),
        registration_endpoint: "http://attacker.example/register",
      }),
    })).rejects.toThrow("registration endpoint");
  });

  test("MCP-013-B: an end-user token authenticates once and keeps its own membership", async () => {
    expect.hasAssertions();
    const protectedMetadata = await fetch(
      `${server.baseUrl}/.well-known/oauth-protected-resource/mcp`,
    );
    expect(protectedMetadata.status).toBe(200);
    expect(await protectedMetadata.json()).toMatchObject({
      authorization_servers: [issuer],
      bearer_methods_supported: ["header"],
      resource,
    });

    const authorizationMetadata = await fetch(
      `${server.baseUrl}/.well-known/oauth-authorization-server`,
    );
    expect(authorizationMetadata.status).toBe(200);
    expect(await authorizationMetadata.json()).toMatchObject({issuer});

    const missing = await mcpDiscovery(null);
    expect(missing.status).toBe(401);
    expect(missing.headers.get("www-authenticate")).toContain(
      `resource_metadata="${resource.replace(
        "/mcp",
        "/.well-known/oauth-protected-resource/mcp",
      )}"`,
    );

    const token = await issueToken({});
    expect((await mcpDiscovery(token)).status).toBe(200);
    // The token carries the profile, so the issuer is never asked for it.
    expect(provider.userInfoRequests()).toBe(0);
    expect((await mcpDiscovery(token)).status).toBe(200);

    expect((await mcpDiscovery(installation.apiToken)).status).toBe(200);
  });

  test("a lean token resolves its profile through userinfo exactly once", async () => {
    expect.hasAssertions();
    const token = await issueToken({profile: false});
    expect((await mcpDiscovery(token)).status).toBe(200);
    expect(provider.userInfoRequests()).toBe(1);

    expect((await mcpDiscovery(token)).status).toBe(200);
    expect(provider.userInfoRequests()).toBe(1);
  });

  test("only this issuer, this algorithm, and these keys are accepted", async () => {
    expect.hasAssertions();
    const otherIssuer = await startProviderBoundary({
      jwk: await exportedJwk(keyId),
    });
    try {
      // A token another issuer signed with the same key material is still a
      // token for another issuer.
      expect((await mcpDiscovery(await issueToken({
        issuer: otherIssuer.issuer,
      }))).status).toBe(401);
    } finally {
      await otherIssuer.close();
    }

    const symmetric = await new SignJWT({azp: "artifact-server"})
      .setProtectedHeader({alg: "HS256", kid: keyId})
      .setIssuer(issuer)
      .setAudience(resource)
      .setIssuedAt()
      .setExpirationTime(Math.floor(Date.now() / 1_000) + 300)
      .setSubject(subject)
      .sign(new TextEncoder().encode("a shared secret is not a signing key"));
    expect((await mcpDiscovery(symmetric)).status).toBe(401);

    const unknownKey = await generateKeyPair("RS256");
    const unknownKid = await new SignJWT({azp: "artifact-server"})
      .setProtectedHeader({alg: "RS256", kid: crypto.randomUUID()})
      .setIssuer(issuer)
      .setAudience(resource)
      .setIssuedAt()
      .setExpirationTime(Math.floor(Date.now() / 1_000) + 300)
      .setSubject(subject)
      .sign(unknownKey.privateKey);
    expect((await mcpDiscovery(unknownKid)).status).toBe(401);

    // A fresh verifier has no cached keys, so the outage is the first thing it
    // meets and must not read as a bad token.
    const coldVerifier = new OidcMcpBearerVerifier({
      audience: resource,
      issuer,
      jwksUri: `${issuer}/protocol/openid-connect/certs`,
    });
    provider.setKeysStatus(503);
    try {
      await expect(verifiedSubject(coldVerifier, await issueToken({})))
        .rejects.toThrow("signing keys");
    } finally {
      provider.setKeysStatus(200);
    }
  });

  test("MCP-013-F: wrong token contracts fail closed and issuer outages stay distinct", async () => {
    expect.hasAssertions();
    expect((await mcpDiscovery(await issueToken({
      audience: "https://attacker.example/mcp",
    }))).status).toBe(401);

    expect((await mcpDiscovery(await issueToken({
      issuer: "https://attacker.example",
    }))).status).toBe(401);

    expect((await mcpDiscovery(await issueToken({
      expiresAt: Math.floor(Date.now() / 1_000) - 60,
    }))).status).toBe(401);

    expect((await mcpDiscovery(await issueToken({subject: null}))).status)
      .toBe(401);

    const untrusted = await generateKeyPair("RS256");
    expect((await mcpDiscovery(await issueToken({
      signingKey: untrusted.privateKey,
    }))).status).toBe(401);

    expect((await mcpDiscovery("not-a-jwt")).status).toBe(401);

    expect((await mcpDiscovery(await issueToken({idToken: true}))).status)
      .toBe(401);

    // An ID token from an issuer that does not mark it with a payload typ,
    // minted for a client whose ID happens to be the MCP URL, still carries
    // claims only an ID token has.
    const idTokenClaims = ["nonce", "at_hash", "c_hash"];
    expect(await discoveryStatuses(idTokenClaims.map((claim) => ({
      extraClaims: {auth_time: Math.floor(Date.now() / 1_000), [claim]: "x"},
      type: "JWT",
    })))).toEqual(idTokenClaims.map(() => 401));

    // Any other explicitly typed JWT from the same issuer is not an access
    // token either.
    const otherTypes = ["logout+jwt", "secevent+jwt", "oauth-id-jag+jwt", "id+jwt"];
    expect(await discoveryStatuses(otherTypes.map((type) => ({type}))))
      .toEqual(otherTypes.map(() => 401));

    provider.setUserInfoStatus(401);
    expect((await mcpDiscovery(await issueToken({profile: false}))).status)
      .toBe(401);
    provider.setUserInfoStatus(503);
    expect((await mcpDiscovery(await issueToken({profile: false}))).status)
      .toBe(500);
  });

  test("the access-token types issuers really send are accepted", async () => {
    expect.hasAssertions();
    // RFC 9068 says at+jwt; Keycloak and many others say JWT or nothing.
    // The first request binds the member, so the rest can run together.
    expect((await mcpDiscovery(await issueToken({}))).status).toBe(200);
    const types = ["at+jwt", "application/at+jwt", "AT+JWT", "JWT"];
    expect(await discoveryStatuses(types.map((type) => ({type}))))
      .toEqual(types.map(() => 200));
  });

  test("an unverified email cannot claim the administrator or link to a member", async () => {
    expect.hasAssertions();
    const intruder = "0b7e7f7c-0000-4000-8000-intruder";

    // On a fresh installation the bootstrap email would admit an administrator.
    expect((await mcpDiscovery(await issueToken({
      emailVerified: null,
      subject: intruder,
    }))).status).toBe(401);
    expect((await mcpDiscovery(await issueToken({
      emailVerified: false,
      subject: intruder,
    }))).status).toBe(401);

    // The real person arrives with a verified address and becomes the member.
    expect((await mcpDiscovery(await issueToken({}))).status).toBe(200);

    // The same unverified address still cannot link to that admitted member.
    expect((await mcpDiscovery(await issueToken({
      emailVerified: null,
      subject: intruder,
    }))).status).toBe(401);

    // A subject that is already bound is known by issuer and subject alone.
    expect((await mcpDiscovery(await issueToken({emailVerified: null})))
      .status).toBe(200);
    expect((await mcpDiscovery(await issueToken({profile: false}))).status)
      .toBe(200);
    expect(provider.userInfoRequests()).toBe(0);
  });

  test("a token that names several audiences is accepted", async () => {
    expect.hasAssertions();
    // Keycloak names account beside the requested audience, so membership of
    // the MCP resource is what grants access.
    expect((await mcpDiscovery(await issueToken({
      audience: [resource, "account"],
    }))).status).toBe(200);
  });

  test("the MCP resource follows the application origin and nothing else opens it", async () => {
    expect.hasAssertions();
    const hosted = await createOidcHostedAuthentication({
      applicationOrigin: "https://staging.artifactserver.test",
      clientId: "artifact-server",
      clientSecret: null,
      issuer,
      scopes: "openid email profile",
    });
    expect(hosted.mcpOAuthResource.resource).toBe(resource);
    expect(hosted.mcpOAuthResource.authorizationServerMetadata)
      .toMatchObject({issuer});
    await expect(verifiedSubject(hosted.externalMcpOAuthVerifier, await
      issueToken({}))).resolves.toBe(subject);
    await expect(verifiedSubject(hosted.externalMcpOAuthVerifier, await
      issueToken({audience: "artifact-server"})))
      .rejects.toThrow("for another resource");
    await expect(verifiedSubject(hosted.externalMcpOAuthVerifier, await
      issueToken({audience: ["account", "https://attacker.example/mcp"]})))
      .rejects.toThrow("for another resource");
    await expect(verifiedSubject(hosted.externalMcpOAuthVerifier, await
      issueToken({idToken: true}))).rejects.toThrow("ID token is not");
  });

  async function issueToken(options: {
    readonly audience?: string | string[];
    /** `null` leaves the claim out. */
    readonly emailVerified?: boolean | null;
    readonly expiresAt?: number;
    readonly extraClaims?: Readonly<Record<string, number | string>>;
    readonly idToken?: boolean;
    readonly issuer?: string;
    readonly profile?: boolean;
    readonly signingKey?: CryptoKey;
    readonly subject?: string | null;
    /** The JOSE header `typ`; left out unless given. */
    readonly type?: string;
  }): Promise<string> {
    const claims: JWTPayload = {
      azp: "artifact-server",
      scope: "openid profile email",
    };
    if (options.profile !== false) {
      Object.assign(claims, {
        email: userEmail,
        name: "Artifact Administrator",
        preferred_username: "administrator",
      });
      if (options.emailVerified !== null) {
        claims["email_verified"] = options.emailVerified ?? true;
      }
    }
    if (options.extraClaims !== undefined) {
      Object.assign(claims, options.extraClaims);
    }
    if (options.idToken === true) claims["typ"] = "ID";
    const token = new SignJWT(claims)
      .setProtectedHeader(options.type === undefined
        ? {alg: "RS256", kid: keyId}
        : {alg: "RS256", kid: keyId, typ: options.type})
      .setIssuer(options.issuer ?? issuer)
      .setAudience(options.audience ?? resource)
      .setIssuedAt()
      .setExpirationTime(
        options.expiresAt ?? Math.floor(Date.now() / 1_000) + 300,
      );
    if (options.subject !== null) token.setSubject(options.subject ?? subject);
    return token.sign(options.signingKey ?? privateKey);
  }

  /** Present one token per variant at once; each is judged on its own. */
  async function discoveryStatuses(
    variants: readonly Parameters<typeof issueToken>[0][],
  ): Promise<readonly number[]> {
    const tokens = await Promise.all(variants.map(issueToken));
    const responses = await Promise.all(tokens.map(mcpDiscovery));
    return responses.map((response) => response.status);
  }

  function mcpDiscovery(token: string | null): Promise<Response> {
    const headers = new Headers({
      Accept: "application/json, text/event-stream",
      "Content-Type": "application/json",
      "MCP-Protocol-Version": protocolVersion,
      "Mcp-Method": "server/discover",
    });
    if (token !== null) headers.set("Authorization", `Bearer ${token}`);
    return fetch(`${server.baseUrl}/mcp`, {
      body: JSON.stringify({
        id: crypto.randomUUID(),
        jsonrpc: "2.0",
        method: "server/discover",
        params: {
          _meta: {
            [CLIENT_CAPABILITIES_META_KEY]: {},
            [CLIENT_INFO_META_KEY]: {name: "oidc-auth-test", version: "1"},
            [PROTOCOL_VERSION_META_KEY]: protocolVersion,
          },
        },
      }),
      headers,
      method: "POST",
    });
  }
});

function verifiedSubject(
  verifier: ExternalMcpBearerVerifier,
  token: string,
): Promise<string> {
  return Effect.runPromise(
    verifier.verify(Redacted.make(token)).pipe(
      Effect.map((verified) => verified.subject),
    ),
  );
}

interface ProviderBoundary {
  readonly issuer: string;
  close(): Promise<void>;
  setKeysStatus(status: number): void;
  setUserInfoStatus(status: number): void;
  userInfoRequests(): number;
}

async function startProviderBoundary(options: {
  readonly jwk: JWK;
}): Promise<ProviderBoundary> {
  let keysStatus = 200;
  let userInfoRequestCount = 0;
  let userInfoStatus = 200;
  let issuer = "";
  const provider = createServer((request, response) => {
    if (request.url === `${realmPath}/.well-known/openid-configuration`) {
      response.setHeader("Content-Type", "application/json");
      response.end(JSON.stringify(discoveryDocument(issuer)));
      return;
    }
    if (request.url === `${realmPath}/protocol/openid-connect/certs`) {
      if (keysStatus !== 200) {
        response.statusCode = keysStatus;
        response.end();
        return;
      }
      response.setHeader("Content-Type", "application/json");
      response.end(JSON.stringify({keys: [options.jwk]}));
      return;
    }
    if (request.url === `${realmPath}/protocol/openid-connect/userinfo`) {
      userInfoRequestCount += 1;
      if (userInfoStatus !== 200) {
        response.statusCode = userInfoStatus;
        response.end();
        return;
      }
      if (request.headers.authorization?.startsWith("Bearer ") !== true) {
        response.statusCode = 401;
        response.end();
        return;
      }
      response.setHeader("Content-Type", "application/json");
      response.end(JSON.stringify({
        email: userEmail,
        email_verified: true,
        family_name: "Administrator",
        given_name: "Artifact",
        sub: subject,
      }));
      return;
    }
    response.statusCode = 404;
    response.end();
  });
  await listen(provider);
  const address = provider.address();
  if (address === null || Predicate.isString(address)) {
    throw new Error("The OIDC test boundary did not bind a TCP port.");
  }
  issuer = `http://127.0.0.1:${address.port}${realmPath}`;
  return {
    close: () => close(provider),
    issuer,
    setKeysStatus: (status) => {
      keysStatus = status;
    },
    setUserInfoStatus: (status) => {
      userInfoStatus = status;
    },
    userInfoRequests: () => userInfoRequestCount,
  };
}

async function exportedJwk(keyId: string): Promise<JWK> {
  const keys = await generateKeyPair("RS256");
  const publicJwk = await exportJWK(keys.publicKey);
  return {...publicJwk, alg: "RS256", kid: keyId, use: "sig"};
}

function discoveryDocument(issuer: string) {
  return {
    authorization_endpoint: `${issuer}/protocol/openid-connect/auth`,
    code_challenge_methods_supported: ["S256"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    issuer,
    jwks_uri: `${issuer}/protocol/openid-connect/certs`,
    registration_endpoint: `${issuer}/clients-registrations/openid-connect`,
    response_types_supported: ["code"],
    scopes_supported: ["openid", "profile", "email"],
    token_endpoint: `${issuer}/protocol/openid-connect/token`,
    userinfo_endpoint: `${issuer}/protocol/openid-connect/userinfo`,
  };
}

type DiscoveryDocument = ReturnType<typeof discoveryDocument>;

function documentResponse(document: DiscoveryDocument): Response {
  return new Response(JSON.stringify(document), {
    headers: {"Content-Type": "application/json"},
    status: 200,
  });
}

function listen(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
}

function close(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => error === undefined ? resolve() : reject(error));
  });
}
