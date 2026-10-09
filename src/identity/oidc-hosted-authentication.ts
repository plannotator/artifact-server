import type {Redacted} from "effect";

import type {ExternalMcpBearerVerifier} from "../application/authentication.js";
import type {InteractiveIdentityProvider} from "../application/interactive-login.js";
import type {McpOAuthResourceConfiguration} from "../http/create-http-app.js";
import {
  createOidcIdentityProvider,
  type OidcBrowserLoginSettings,
} from "./oidc-identity-provider.js";
import {requireOidcIssuer} from "./oidc-issuer.js";
import {
  OidcMcpBearerVerifier,
  type OidcMcpBearerVerifierConfig,
} from "./oidc-mcp-bearer-verifier.js";
import {loadOidcAuthorizationServer} from "./oidc-oauth-metadata.js";

export interface OidcHostedAuthenticationConfig {
  readonly applicationOrigin: string;
  readonly clientId: string;
  readonly clientSecret: Redacted.Redacted | null;
  readonly fetch?: typeof globalThis.fetch;
  readonly issuer: string;
  /**
   * The `aud` value MCP access tokens must carry; `<origin>/mcp` when left out.
   * Microsoft Entra ID v2.0 tokens name the API's client ID instead.
   */
  readonly mcpAudience?: string;
  /** Scopes MCP clients must request at the issuer, advertised to them. */
  readonly mcpScopes?: string;
  readonly scopes: string;
  /** The claim that binds a person on both paths; `sub` when left out. */
  readonly subjectClaim?: string;
}

export interface OidcHostedAuthentication {
  readonly externalMcpOAuthVerifier: ExternalMcpBearerVerifier;
  readonly interactiveIdentityProvider: InteractiveIdentityProvider;
  readonly mcpOAuthResource: McpOAuthResourceConfiguration;
}

/** Build browser and MCP authentication from one generic OIDC issuer. */
export async function createOidcHostedAuthentication(
  config: OidcHostedAuthenticationConfig,
): Promise<OidcHostedAuthentication> {
  const issuer = requireOidcIssuer(config.issuer, "ARTIFACT_SERVER_OIDC_ISSUER");
  const resource = new URL("/mcp", config.applicationOrigin).toString();
  const authorizationServer = await loadOidcAuthorizationServer(
    issuer,
    config.fetch === undefined ? {} : {fetch: config.fetch},
  );
  let verifierConfig: OidcMcpBearerVerifierConfig = {
    audience: config.mcpAudience ?? resource,
    issuer,
    jwksUri: authorizationServer.jwksUri,
    userInfoEndpoint: authorizationServer.userInfoEndpoint,
  };
  if (config.fetch !== undefined) {
    verifierConfig = {...verifierConfig, fetch: config.fetch};
  }
  if (config.subjectClaim !== undefined) {
    verifierConfig = {...verifierConfig, subjectClaim: config.subjectClaim};
  }
  let browserLogin: OidcBrowserLoginSettings = {
    applicationOrigin: config.applicationOrigin,
    clientId: config.clientId,
    clientSecret: config.clientSecret,
    issuer,
    scopes: config.scopes,
  };
  if (config.subjectClaim !== undefined) {
    browserLogin = {...browserLogin, subjectClaim: config.subjectClaim};
  }
  let mcpOAuthResource: McpOAuthResourceConfiguration = {
    authorizationServerMetadata: authorizationServer.metadata,
    resource,
  };
  const mcpScopes = config.mcpScopes?.split(/\s+/u)
    .filter((scope) => scope !== "") ?? [];
  if (mcpScopes.length > 0) {
    mcpOAuthResource = {...mcpOAuthResource, scopesSupported: mcpScopes};
  }
  return {
    externalMcpOAuthVerifier: new OidcMcpBearerVerifier(verifierConfig),
    interactiveIdentityProvider: createOidcIdentityProvider(browserLogin),
    mcpOAuthResource,
  };
}
