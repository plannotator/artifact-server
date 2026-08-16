import {createServer, type Server} from "node:http";

import {
  CLIENT_CAPABILITIES_META_KEY,
  CLIENT_INFO_META_KEY,
  PROTOCOL_VERSION_META_KEY,
  type OAuthMetadata,
} from "@modelcontextprotocol/server";
import {
  exportJWK,
  generateKeyPair,
  SignJWT,
  type CryptoKey,
  type JWK,
} from "jose";
import {Predicate, Redacted} from "effect";
import {afterEach, beforeEach, describe, expect, test} from "vitest";

import {WorkOsMcpBearerVerifier} from
  "../../src/identity/workos-mcp-bearer-verifier.js";
import {loadWorkOsOAuthMetadata} from
  "../../src/identity/workos-oauth-metadata.js";
import {
  createTestInstallation,
  removeTestInstallation,
  type RunningTestServer,
  startTestServer,
  type TestInstallation,
} from "../support/runtime-harness.js";

const protocolVersion = "2026-07-28";
const issuer = "https://artifact-server-staging.authkit.test";
const resource = "https://staging.artifactserver.test/mcp";
const userId = "user_01_artifact_server_test";
const userEmail = "administrator@example.test";

describe("hosted WorkOS MCP authorization", () => {
  let installation: TestInstallation;
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
    installation = await createTestInstallation();
    const verifier = new WorkOsMcpBearerVerifier({
      apiKey: Redacted.make("sk_test_artifact_server"),
      apiOrigin: provider.origin,
      issuer,
      jwksUri: `${provider.origin}/oauth2/jwks`,
      resource,
    });
    server = await startTestServer(installation, {
      bootstrapAdministratorEmail: userEmail,
      externalMcpOAuthVerifier: verifier,
      mcpOAuthResource: {
        authorizationServerMetadata: authorizationMetadata(),
        resource,
      },
    });
  });

  afterEach(async () => {
    await server.stop();
    await provider.close();
    await removeTestInstallation(installation);
  });

  test("hosted startup accepts only exact refreshable S256 authorization metadata", async () => {
    expect.hasAssertions();
    let requestedUrl = "";
    const metadata = await loadWorkOsOAuthMetadata(issuer, {
      fetch: async (input) => {
        requestedUrl = input instanceof URL
          ? input.href
          : input instanceof Request
            ? input.url
            : input;
        return metadataResponse(authorizationMetadata());
      },
    });
    expect(requestedUrl).toBe(
      `${issuer}/.well-known/oauth-authorization-server`,
    );
    expect(metadata).toMatchObject({issuer});

    await expect(loadWorkOsOAuthMetadata(issuer, {
      fetch: async () => metadataResponse({
        ...authorizationMetadata(),
        issuer: "https://attacker.example",
      }),
    })).rejects.toThrow("different issuer");
    await expect(loadWorkOsOAuthMetadata(issuer, {
      fetch: async () => metadataResponse({
        ...authorizationMetadata(),
        grant_types_supported: ["authorization_code"],
      }),
    })).rejects.toThrow("token refresh");
    await expect(loadWorkOsOAuthMetadata(issuer, {
      fetch: async () => metadataResponse({
        ...authorizationMetadata(),
        code_challenge_methods_supported: ["plain"],
      }),
    })).rejects.toThrow("S256 PKCE");
  });

  test("foundation: discovery, JWT verification, first-use identity binding, and API-key fallback share one live HTTP boundary", async () => {
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

    const authorizationMetadataResponse = await fetch(
      `${server.baseUrl}/.well-known/oauth-authorization-server`,
    );
    expect(authorizationMetadataResponse.status).toBe(200);
    expect(await authorizationMetadataResponse.json()).toMatchObject({issuer});

    const missing = await mcpDiscovery(null);
    expect(missing.status).toBe(401);
    expect(missing.headers.get("www-authenticate")).toContain(
      `resource_metadata="${resource.replace(
        "/mcp",
        "/.well-known/oauth-protected-resource/mcp",
      )}"`,
    );
    expect(missing.headers.get("www-authenticate")).not.toContain("scope=");

    const token = await issueToken({});
    const first = await mcpDiscovery(token);
    expect(first.status).toBe(200);
    expect(provider.userRequests()).toBe(1);

    const second = await mcpDiscovery(token);
    expect(second.status).toBe(200);
    expect(provider.userRequests()).toBe(1);

    const apiKeyFallback = await mcpDiscovery(installation.apiToken);
    expect(apiKeyFallback.status).toBe(200);
  });

  test("foundation: wrong token contracts fail closed and provider outages stay distinct", async () => {
    expect.hasAssertions();
    const wrongAudience = await mcpDiscovery(await issueToken({
      audience: "https://attacker.example/mcp",
    }));
    expect(wrongAudience.status).toBe(401);

    const multipleAudiences = await mcpDiscovery(await issueToken({
      audience: [resource, "https://attacker.example/mcp"],
    }));
    expect(multipleAudiences.status).toBe(401);

    const wrongIssuer = await mcpDiscovery(await issueToken({
      issuer: "https://attacker.example",
    }));
    expect(wrongIssuer.status).toBe(401);

    const expired = await mcpDiscovery(await issueToken({
      expiresAt: Math.floor(Date.now() / 1_000) - 60,
    }));
    expect(expired.status).toBe(401);

    const missingSubject = await mcpDiscovery(await issueToken({
      subject: null,
    }));
    expect(missingSubject.status).toBe(401);

    const untrustedKeys = await generateKeyPair("RS256");
    const wrongSignature = await mcpDiscovery(await issueToken({
      signingKey: untrustedKeys.privateKey,
    }));
    expect(wrongSignature.status).toBe(401);

    expect((await mcpDiscovery("not-a-jwt")).status).toBe(401);

    provider.setUserResponseStatus(401);
    expect((await mcpDiscovery(await issueToken({}))).status).toBe(500);
    expect(provider.userRequests()).toBe(1);
  });

  async function issueToken(options: {
    readonly audience?: string | string[];
    readonly expiresAt?: number;
    readonly issuer?: string;
    readonly signingKey?: CryptoKey;
    readonly scope?: string;
    readonly subject?: string | null;
  }): Promise<string> {
    const token = new SignJWT(options.scope === undefined
      ? {client_id: "client_test"}
      : {client_id: "client_test", scope: options.scope})
      .setProtectedHeader({alg: "RS256", kid: keyId})
      .setIssuer(options.issuer ?? issuer)
      .setAudience(options.audience ?? resource)
      .setIssuedAt()
      .setExpirationTime(
        options.expiresAt ?? Math.floor(Date.now() / 1_000) + 300,
      );
    if (options.subject !== null) token.setSubject(options.subject ?? userId);
    return token.sign(options.signingKey ?? privateKey);
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
            [CLIENT_INFO_META_KEY]: {name: "workos-auth-test", version: "1"},
            [PROTOCOL_VERSION_META_KEY]: protocolVersion,
          },
        },
      }),
      headers,
      method: "POST",
    });
  }
});

interface ProviderBoundary {
  readonly origin: string;
  close(): Promise<void>;
  setUserResponseStatus(status: number): void;
  userRequests(): number;
}

async function startProviderBoundary(options: {
  readonly jwk: JWK;
}): Promise<ProviderBoundary> {
  let userRequestCount = 0;
  let userResponseStatus = 200;
  const provider = createServer((request, response) => {
    if (request.url === "/oauth2/jwks") {
      response.setHeader("Content-Type", "application/json");
      response.end(JSON.stringify({keys: [options.jwk]}));
      return;
    }
    if (request.url === `/user_management/users/${userId}`) {
      userRequestCount += 1;
      if (userResponseStatus !== 200) {
        response.statusCode = userResponseStatus;
        response.end();
        return;
      }
      if (request.headers.authorization !== "Bearer sk_test_artifact_server") {
        response.statusCode = 401;
        response.end();
        return;
      }
      response.setHeader("Content-Type", "application/json");
      response.end(JSON.stringify({
        email: userEmail,
        email_verified: true,
        first_name: "Artifact",
        id: userId,
        last_name: "Administrator",
        name: "Artifact Administrator",
      }));
      return;
    }
    response.statusCode = 404;
    response.end();
  });
  await listen(provider);
  const address = provider.address();
  if (address === null || Predicate.isString(address)) {
    throw new Error("The WorkOS test boundary did not bind a TCP port.");
  }
  return {
    close: () => close(provider),
    origin: `http://127.0.0.1:${address.port}`,
    setUserResponseStatus: (status) => {
      userResponseStatus = status;
    },
    userRequests: () => userRequestCount,
  };
}

function authorizationMetadata(): OAuthMetadata {
  return {
    authorization_endpoint: `${issuer}/oauth2/authorize`,
    client_id_metadata_document_supported: true,
    code_challenge_methods_supported: ["S256"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    issuer,
    registration_endpoint: `${issuer}/oauth2/register`,
    response_types_supported: ["code"],
    scopes_supported: ["openid", "profile", "email", "offline_access"],
    token_endpoint: `${issuer}/oauth2/token`,
  };
}

function metadataResponse(metadata: OAuthMetadata): Response {
  return new Response(JSON.stringify(metadata), {
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
