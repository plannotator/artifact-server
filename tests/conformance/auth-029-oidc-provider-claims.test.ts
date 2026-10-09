import path from "node:path";
import {DatabaseSync} from "node:sqlite";

import {
  CLIENT_CAPABILITIES_META_KEY,
  CLIENT_INFO_META_KEY,
  PROTOCOL_VERSION_META_KEY,
} from "@modelcontextprotocol/server";
import {Redacted} from "effect";
import type {JWTPayload} from "jose";
import {afterEach, beforeEach, describe, expect, test} from "vitest";
import {z} from "zod";

import {loadOidcConfiguration} from "../../src/cli/oidc-configuration.js";
import {
  browserLoginKinds,
  privateTeamBrowserAccess,
} from "../../src/core/browser-access.js";
import {createOidcHostedAuthentication} from
  "../../src/identity/oidc-hosted-authentication.js";
import {loadOidcAuthorizationServer} from
  "../../src/identity/oidc-oauth-metadata.js";
import {
  createTestInstallation,
  removeTestInstallation,
  reserveLoopbackPort,
  type RunningTestServer,
  startTestServer,
  type TestInstallation,
} from "../support/runtime-harness.js";
import {
  type RunningStubOidcProvider,
  startStubOidcLogin,
  startStubOidcProvider,
} from "../support/stub-oidc-provider.js";

// Shaped after Microsoft Entra ID v2.0: discovery omits the PKCE methods, every
// app registration sees a different `sub`, the tenant-wide `oid` stays the same,
// and an access token for the API names its client ID in `aud`.
const administratorEmail = "administrator@example.test";
const clientId = "00000000-0000-4000-8000-0000000000a1";
const clientSecret = "stub-oidc-client-secret-with-entropy";
const objectId = "00000000-0000-4000-8000-00000000b0b0";
const protocolVersion = "2026-07-28";
const scopes = "openid email profile";
const externalIdentityRowSchema = z.object({
  member_id: z.string(),
  provider: z.string(),
  subject: z.string(),
});
const countRowSchema = z.object({total: z.number().int().nonnegative()});

describe("OIDC provider claim mapping", () => {
  let applicationOrigin: string;
  let installation: TestInstallation;
  let mcpScope: string;
  let provider: RunningStubOidcProvider;
  let server: RunningTestServer;

  beforeEach(async () => {
    installation = await createTestInstallation();
    provider = await startStubOidcProvider({clientId, clientSecret});
    const port = await reserveLoopbackPort();
    applicationOrigin = `http://127.0.0.1:${port}`;
    mcpScope = `${applicationOrigin}/mcp/access`;
    const hosted = await createOidcHostedAuthentication({
      applicationOrigin,
      clientId,
      clientSecret: Redacted.make(clientSecret),
      issuer: provider.issuer,
      mcpAudience: clientId,
      mcpScopes: `${mcpScope} offline_access`,
      scopes,
      subjectClaim: "oid",
    });
    server = await startTestServer(installation, {
      applicationOrigin,
      bootstrapAdministratorEmail: administratorEmail,
      browserAccess: privateTeamBrowserAccess(browserLoginKinds.oidc),
      externalMcpOAuthVerifier: hosted.externalMcpOAuthVerifier,
      interactiveIdentityProvider: hosted.interactiveIdentityProvider,
      mcpOAuthResource: hosted.mcpOAuthResource,
      port,
    });
  });

  afterEach(async () => {
    await server.stop();
    await provider.stop();
    await removeTestInstallation(installation);
  });

  test("AUTH-029-B: an issuer without advertised PKCE binds one person by the configured claim across browser login and MCP", async () => {
    expect.hasAssertions();
    const protectedMetadata = await fetch(
      `${server.baseUrl}/.well-known/oauth-protected-resource/mcp`,
    );
    expect(await protectedMetadata.json()).toMatchObject({
      authorization_servers: [provider.issuer],
      resource: `${applicationOrigin}/mcp`,
      scopes_supported: [mcpScope, "offline_access"],
    });

    provider.claims.email = administratorEmail;
    provider.claims.objectId = objectId;
    provider.claims.subject = "pairwise-subject-for-app-a";
    expect((await completeStubLogin(server.baseUrl)).status).toBe(303);
    const [binding] = externalIdentities(installation);
    expect(binding).toMatchObject({
      provider: `oidc:${provider.issuer}`,
      subject: objectId,
    });

    // A new app registration changes `sub`; the person keeps one membership.
    provider.claims.subject = "pairwise-subject-for-app-b";
    expect((await completeStubLogin(server.baseUrl)).status).toBe(303);
    expect(externalIdentities(installation)).toEqual([binding]);

    // The MCP access token carries no email at all, as Entra's does not; the
    // bound object ID alone recognizes the member.
    const accessToken = await provider.signJwt(accessTokenClaims({
      oid: objectId,
      sub: "pairwise-subject-for-the-api",
    }));
    expect((await mcpDiscovery(accessToken)).status).toBe(200);
    expect(rowCount(installation, "installation_members")).toBe(1);
    expect(externalIdentities(installation)).toEqual([binding]);
  });

  test("AUTH-029-F: the configured audience, subject claim, and PKCE rule refuse every other contract", async () => {
    expect.hasAssertions();
    provider.claims.email = administratorEmail;
    provider.claims.objectId = null;
    provider.claims.subject = "subject-without-object-id";
    const withoutObjectId = await completeStubLogin(server.baseUrl);
    expect(withoutObjectId.status).toBe(502);
    expect(withoutObjectId.headers.getSetCookie()).toEqual([]);
    expect(rowCount(installation, "installation_members")).toBe(0);
    expect(rowCount(installation, "external_identities")).toBe(0);

    const refused = await Promise.all([
      // The configured audience replaces the resource URL instead of adding to it.
      accessTokenClaims({aud: `${applicationOrigin}/mcp`, oid: objectId}),
      accessTokenClaims({oid: undefined}),
      accessTokenClaims({oid: "   "}),
      // An ID token for the same client names the same audience.
      accessTokenClaims({nonce: "browser-login-nonce", oid: objectId}),
    ].map(async (claims) =>
      (await mcpDiscovery(await provider.signJwt(claims))).status
    ));
    expect(refused).toEqual([401, 401, 401, 401]);
    expect(rowCount(installation, "installation_members")).toBe(0);

    await expect(loadOidcAuthorizationServer(provider.issuer, {
      fetch: async () => Response.json({
        authorization_endpoint: `${provider.issuer}/authorize`,
        code_challenge_methods_supported: ["plain"],
        issuer: provider.issuer,
        jwks_uri: `${provider.issuer}/jwks`,
        response_types_supported: ["code"],
        token_endpoint: `${provider.issuer}/token`,
      }),
    })).rejects.toThrow("S256 PKCE");

    await expect(loadOidcConfiguration({
      ARTIFACT_SERVER_OIDC_MCP_AUDIENCE: clientId,
    })).rejects.toThrow("Generic OIDC authentication requires");
    const complete = {
      ARTIFACT_SERVER_BOOTSTRAP_ADMIN_EMAIL: administratorEmail,
      ARTIFACT_SERVER_OIDC_CLIENT_ID: clientId,
      ARTIFACT_SERVER_OIDC_ISSUER: provider.issuer,
      ARTIFACT_SERVER_ORIGIN: applicationOrigin,
    };
    await expect(loadOidcConfiguration({
      ...complete,
      ARTIFACT_SERVER_OIDC_SUBJECT_CLAIM: "oid sub",
    })).rejects.toThrow("ARTIFACT_SERVER_OIDC_SUBJECT_CLAIM must name one JWT claim");
    await expect(loadOidcConfiguration({
      ...complete,
      ARTIFACT_SERVER_OIDC_MCP_AUDIENCE: `${clientId} other`,
    })).rejects.toThrow("must be one audience value");
    await expect(loadOidcConfiguration({
      ...complete,
      ARTIFACT_SERVER_OIDC_MCP_AUDIENCE: clientId,
      ARTIFACT_SERVER_OIDC_MCP_SCOPES: mcpScope,
      ARTIFACT_SERVER_OIDC_SUBJECT_CLAIM: "oid",
    })).resolves.toMatchObject({
      mcpAudience: clientId,
      mcpScopes: mcpScope,
      subjectClaim: "oid",
    });
  });

  function accessTokenClaims(
    overrides: Readonly<Record<string, string | undefined>>,
  ): JWTPayload {
    const now = Math.floor(Date.now() / 1_000);
    const claims: JWTPayload = {
      aud: clientId,
      azp: "claude-code",
      exp: now + 300,
      iat: now,
      iss: provider.issuer,
      name: "Artifact Administrator",
      preferred_username: administratorEmail,
      scp: "access",
      sub: "pairwise-subject-for-the-api",
      ver: "2.0",
    };
    for (const [claim, value] of Object.entries(overrides)) {
      if (value === undefined) delete claims[claim];
      else claims[claim] = value;
    }
    return claims;
  }

  function mcpDiscovery(token: string): Promise<Response> {
    return fetch(`${server.baseUrl}/mcp`, {
      body: JSON.stringify({
        id: crypto.randomUUID(),
        jsonrpc: "2.0",
        method: "server/discover",
        params: {
          _meta: {
            [CLIENT_CAPABILITIES_META_KEY]: {},
            [CLIENT_INFO_META_KEY]: {name: "oidc-claims-test", version: "1"},
            [PROTOCOL_VERSION_META_KEY]: protocolVersion,
          },
        },
      }),
      headers: {
        Accept: "application/json, text/event-stream",
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        "MCP-Protocol-Version": protocolVersion,
        "Mcp-Method": "server/discover",
      },
      method: "POST",
    });
  }
});

async function completeStubLogin(baseUrl: string): Promise<Response> {
  const authorization = await startStubOidcLogin(baseUrl);
  return fetch(authorization.callbackUrl, {
    headers: {Cookie: authorization.handshakeCookie},
    redirect: "manual",
  });
}

function externalIdentities(
  installation: TestInstallation,
): readonly z.infer<typeof externalIdentityRowSchema>[] {
  const database = openIdentityDatabase(installation);
  try {
    return database
      .prepare(
        "SELECT provider, subject, member_id FROM external_identities ORDER BY subject",
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
