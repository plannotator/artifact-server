import type {Redacted} from "effect";

import type {McpOAuthResourceConfiguration} from "../http/create-http-app.js";
import type {InteractiveIdentityProvider} from "../application/interactive-login.js";
import type {ExternalMcpBearerVerifier} from "../application/authentication.js";
import {WorkOsIdentityProvider} from "./workos-identity-provider.js";
import {WorkOsMcpBearerVerifier} from "./workos-mcp-bearer-verifier.js";
import type {WorkOsMcpBearerVerifierConfig} from
  "./workos-mcp-bearer-verifier.js";
import {
  exactHttpsOrigin,
  loadWorkOsOAuthMetadata,
} from "./workos-oauth-metadata.js";

export interface WorkOsHostedAuthenticationConfig {
  readonly apiKey: Redacted.Redacted;
  readonly applicationOrigin: string;
  readonly clientId: string;
  readonly fetch?: typeof globalThis.fetch;
  readonly issuer: string;
}

export interface WorkOsHostedAuthentication {
  readonly externalMcpOAuthVerifier: ExternalMcpBearerVerifier;
  readonly interactiveIdentityProvider: InteractiveIdentityProvider;
  readonly mcpOAuthResource: McpOAuthResourceConfiguration;
}

/** Build browser and MCP authentication from one exact hosted configuration. */
export async function createWorkOsHostedAuthentication(
  config: WorkOsHostedAuthenticationConfig,
): Promise<WorkOsHostedAuthentication> {
  const applicationOrigin = exactHttpsOrigin(
    config.applicationOrigin,
    "Artifact Server application origin",
  );
  const issuer = exactHttpsOrigin(config.issuer, "WorkOS issuer");
  const metadataOptions = config.fetch === undefined
    ? {}
    : {fetch: config.fetch};
  const authorizationServerMetadata = await loadWorkOsOAuthMetadata(
    issuer,
    metadataOptions,
  );
  const resource = new URL("/mcp", applicationOrigin).toString();
  let verifierConfig: WorkOsMcpBearerVerifierConfig = {
    apiKey: config.apiKey,
    issuer,
    resource,
  };
  if (config.fetch !== undefined) {
    verifierConfig = {...verifierConfig, fetch: config.fetch};
  }
  return {
    externalMcpOAuthVerifier: new WorkOsMcpBearerVerifier(verifierConfig),
    interactiveIdentityProvider: new WorkOsIdentityProvider({
      apiKey: config.apiKey,
      clientId: config.clientId,
      redirectUri: new URL("/auth/callback", applicationOrigin).toString(),
    }),
    mcpOAuthResource: {
      authorizationServerMetadata,
      resource,
    },
  };
}
