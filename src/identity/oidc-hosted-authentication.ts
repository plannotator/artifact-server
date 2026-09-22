import type {Redacted} from "effect";

import type {ExternalMcpBearerVerifier} from "../application/authentication.js";
import type {InteractiveIdentityProvider} from "../application/interactive-login.js";
import type {McpOAuthResourceConfiguration} from "../http/create-http-app.js";
import {createOidcIdentityProvider} from "./oidc-identity-provider.js";
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
  readonly scopes: string;
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
    audience: resource,
    issuer,
    jwksUri: authorizationServer.jwksUri,
    userInfoEndpoint: authorizationServer.userInfoEndpoint,
  };
  if (config.fetch !== undefined) {
    verifierConfig = {...verifierConfig, fetch: config.fetch};
  }
  return {
    externalMcpOAuthVerifier: new OidcMcpBearerVerifier(verifierConfig),
    interactiveIdentityProvider: createOidcIdentityProvider({
      applicationOrigin: config.applicationOrigin,
      clientId: config.clientId,
      clientSecret: config.clientSecret,
      issuer,
      scopes: config.scopes,
    }),
    mcpOAuthResource: {
      authorizationServerMetadata: authorizationServer.metadata,
      resource,
    },
  };
}
