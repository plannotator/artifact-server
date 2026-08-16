import type {OAuthMetadata} from "@modelcontextprotocol/server";
import {z} from "zod";

const oauthMetadataSchema = z.looseObject({
  authorization_endpoint: z.url(),
  authorization_response_iss_parameter_supported: z.boolean().optional(),
  client_id_metadata_document_supported: z.boolean().optional(),
  code_challenge_methods_supported: z.array(z.string()).optional(),
  grant_types_supported: z.array(z.string()).optional(),
  issuer: z.url(),
  registration_endpoint: z.url().optional(),
  response_modes_supported: z.array(z.string()).optional(),
  response_types_supported: z.array(z.string()),
  revocation_endpoint: z.url().optional(),
  revocation_endpoint_auth_methods_supported: z.array(z.string()).optional(),
  scopes_supported: z.array(z.string()).optional(),
  token_endpoint: z.url(),
  token_endpoint_auth_methods_supported: z.array(z.string()).optional(),
});

export interface WorkOsOAuthMetadataOptions {
  readonly fetch?: typeof globalThis.fetch;
  readonly timeoutMilliseconds?: number;
}

/** Fetch and validate the WorkOS authorization-server contract at startup. */
export async function loadWorkOsOAuthMetadata(
  issuer: string,
  options: WorkOsOAuthMetadataOptions = {},
): Promise<OAuthMetadata> {
  const exactIssuer = exactHttpsOrigin(issuer, "WorkOS issuer");
  const metadataUrl = new URL(
    "/.well-known/oauth-authorization-server",
    exactIssuer,
  );
  const response = await (options.fetch ?? globalThis.fetch)(metadataUrl, {
    headers: {Accept: "application/json"},
    signal: AbortSignal.timeout(options.timeoutMilliseconds ?? 5_000),
  });
  if (!response.ok) {
    throw new Error(
      `WorkOS authorization metadata returned HTTP ${response.status}.`,
    );
  }
  const metadata = oauthMetadataSchema.parse(await response.json());
  if (metadata.issuer !== exactIssuer) {
    throw new Error("WorkOS authorization metadata returned a different issuer.");
  }
  requireHttpsUrl(metadata.authorization_endpoint, "authorization endpoint");
  requireHttpsUrl(metadata.token_endpoint, "token endpoint");
  if (!metadata.response_types_supported.includes("code")) {
    throw new Error("WorkOS authorization metadata does not support authorization code login.");
  }
  if (!metadata.grant_types_supported?.includes("refresh_token")) {
    throw new Error("WorkOS authorization metadata does not support token refresh.");
  }
  if (!metadata.code_challenge_methods_supported?.includes("S256")) {
    throw new Error("WorkOS authorization metadata does not require S256 PKCE.");
  }
  return metadata;
}

export function exactHttpsOrigin(value: string, name: string): string {
  const url = new URL(value);
  if (
    url.protocol !== "https:" || url.pathname !== "/" ||
    url.search !== "" || url.hash !== ""
  ) {
    throw new Error(`${name} must be an exact HTTPS origin.`);
  }
  return url.origin;
}

function requireHttpsUrl(value: string, name: string): void {
  if (new URL(value).protocol !== "https:") {
    throw new Error(`The WorkOS ${name} must use HTTPS.`);
  }
}
