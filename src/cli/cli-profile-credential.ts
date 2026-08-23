import {
  type StoredOAuthClientInformation,
  type StoredOAuthTokens,
} from "@modelcontextprotocol/client";
import {Effect, Redacted, Schema} from "effect";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";
import {z} from "zod";

import {
  membershipRoles,
  principalCapabilities,
  principalKinds,
  type Principal,
} from "../core/identity.js";

const oauthClientInformationSchema = z.object({
  client_id: z.string().min(1),
  client_id_issued_at: z.number().int().optional(),
  client_secret: z.string().min(1).optional(),
  client_secret_expires_at: z.number().int().optional(),
  issuer: z.url().optional(),
  redirect_uris: z.array(z.url()).optional(),
  token_endpoint_auth_method: z.string().optional(),
}).passthrough();
const oauthTokensSchema = z.object({
  access_token: z.string().min(1),
  expires_in: z.number().int().positive().optional(),
  issuer: z.url().optional(),
  refresh_token: z.string().min(1).optional(),
  scope: z.string().optional(),
  token_type: z.string().min(1),
}).passthrough();
const storedCredentialSchema = z.discriminatedUnion("kind", [
  z.object({
    apiKey: z.string().min(32).max(4_096),
    kind: z.literal("api_key"),
    schemaVersion: z.literal(1),
  }).strict(),
  z.object({
    clientInformation: oauthClientInformationSchema,
    kind: z.literal("oauth"),
    redirectUrl: z.url(),
    schemaVersion: z.literal(1),
    tokens: oauthTokensSchema,
    tokensSavedAt: z.iso.datetime(),
  }).strict(),
]);
const principalSchema = Schema.Struct({
  authorizedByPrincipalId: Schema.NullOr(Schema.String),
  capabilities: Schema.Array(Schema.Literals([
    principalCapabilities.connectAgents,
    principalCapabilities.createArtifact,
    principalCapabilities.issueContentSession,
    principalCapabilities.manageAnyArtifact,
    principalCapabilities.manageProjects,
    principalCapabilities.publishAnyArtifact,
    principalCapabilities.readArtifacts,
    principalCapabilities.writeComments,
  ])),
  displayName: Schema.String.pipe(
    Schema.withDecodingDefault(Effect.succeed("Agent")),
  ),
  id: Schema.String,
  installationId: Schema.String,
  kind: Schema.Literals([principalKinds.human, principalKinds.service]),
  membershipRole: Schema.Literals([
    membershipRoles.administrator,
    membershipRoles.member,
  ]),
});
const sessionResponseSchema = Schema.Struct({
  authenticationMethod: Schema.Literals(["bearer", "session"]),
  principal: principalSchema,
});

interface NormalizedOAuthClientInformation {
  client_id: string;
  client_id_issued_at?: number;
  client_secret?: string;
  client_secret_expires_at?: number;
  issuer?: string;
}

interface NormalizedOAuthTokens {
  access_token: string;
  expires_in?: number;
  issuer?: string;
  refresh_token?: string;
  scope?: string;
  token_type: string;
}

/** Expected failure while decoding or verifying a saved CLI credential. */
export class CliAuthenticationError extends Schema.TaggedError<CliAuthenticationError>()(
  "CliAuthenticationError",
  {
    message: Schema.String,
    reason: Schema.Literals([
      "browser_authorization_unavailable",
      "credential_invalid",
      "credential_revoked",
      "invalid_callback",
      "invalid_metadata",
      "oauth_failed",
      "server_unavailable",
    ]),
  },
) {}

/** Secret material stored as one operating-system credential. */
/** Scoped API key persisted behind a profile identifier. */
export interface StoredApiKeyCredential {
  readonly apiKey: string;
  readonly kind: "api_key";
  readonly schemaVersion: 1;
}

/** Renewable OAuth grant persisted behind a profile identifier. */
export interface StoredOAuthCredential {
  readonly clientInformation: StoredOAuthClientInformation;
  readonly kind: "oauth";
  readonly redirectUrl: string;
  readonly schemaVersion: 1;
  readonly tokens: StoredOAuthTokens;
  readonly tokensSavedAt: string;
}

export type StoredCliCredential =
  | StoredApiKeyCredential
  | StoredOAuthCredential;

/** Verified account information returned by one exact Artifact Server. */
export interface VerifiedCliAccount {
  readonly principal: Principal;
}

/** Build a stored scoped API-key credential. */
export function apiKeyCredential(apiKey: string): StoredApiKeyCredential {
  const parsed = storedCredentialSchema.parse({
    apiKey,
    kind: "api_key",
    schemaVersion: 1,
  });
  if (parsed.kind !== "api_key") {
    throw new Error("Artifact Server rejected an invalid API-key credential.");
  }
  return parsed;
}

/** Build a stored renewable OAuth credential. */
export function oauthCredential(input: {
  readonly clientInformation: StoredOAuthClientInformation;
  readonly redirectUrl: string;
  readonly tokens: StoredOAuthTokens;
  readonly tokensSavedAt?: string;
}): StoredOAuthCredential {
  const parsed = storedCredentialSchema.parse({
    clientInformation: input.clientInformation,
    kind: "oauth",
    redirectUrl: input.redirectUrl,
    schemaVersion: 1,
    tokens: input.tokens,
    tokensSavedAt: input.tokensSavedAt ?? new Date().toISOString(),
  });
  if (parsed.kind !== "oauth") {
    throw new Error("Artifact Server rejected an invalid OAuth credential.");
  }
  return {
    clientInformation: normalizeClientInformation(parsed.clientInformation),
    kind: "oauth",
    redirectUrl: parsed.redirectUrl,
    schemaVersion: 1,
    tokens: normalizeTokens(parsed.tokens),
    tokensSavedAt: parsed.tokensSavedAt,
  };
}

/** Encode one profile secret for the operating-system credential store. */
export function encodeStoredCliCredential(
  credential: StoredCliCredential,
): Redacted.Redacted {
  return Redacted.make(JSON.stringify(storedCredentialSchema.parse(credential)), {
    label: "artifact-server-cli-profile",
  });
}

/** Decode one opaque operating-system credential without exposing it in errors. */
export function decodeStoredCliCredential(
  credential: Redacted.Redacted,
): Effect.Effect<StoredCliCredential, CliAuthenticationError> {
  return Effect.try({
    try: () => {
      const parsed = storedCredentialSchema.parse(
        JSON.parse(Redacted.value(credential)),
      );
      return parsed.kind === "api_key"
        ? apiKeyCredential(parsed.apiKey)
        : oauthCredential({
          clientInformation: normalizeClientInformation(
            parsed.clientInformation,
          ),
          redirectUrl: parsed.redirectUrl,
          tokens: normalizeTokens(parsed.tokens),
          tokensSavedAt: parsed.tokensSavedAt,
        });
    },
    catch: () => new CliAuthenticationError({
      message: "The saved Artifact Server CLI credential is invalid.",
      reason: "credential_invalid",
    }),
  });
}

/** Return the current bearer without copying it into profile metadata. */
export function bearerFromStoredCredential(
  credential: StoredCliCredential,
): Redacted.Redacted {
  return Redacted.make(
    credential.kind === "api_key"
      ? credential.apiKey
      : credential.tokens.access_token,
    {label: "artifact-server-cli-bearer"},
  );
}

/** Verify a bearer against the remote server rather than trusting local claims. */
export const verifyCliCredential = Effect.fn("CliAuthentication.verifyCredential")(
  function*(
    origin: string,
    bearer: Redacted.Redacted,
  ): Effect.fn.Return<
    VerifiedCliAccount,
    CliAuthenticationError,
    HttpClient.HttpClient
  > {
    const request = HttpClientRequest.get(
      new URL("/api/v1/session", origin),
    ).pipe(HttpClientRequest.bearerToken(bearer));
    const response = yield* HttpClient.execute(request).pipe(
      Effect.mapError(() => new CliAuthenticationError({
        message: `Artifact Server at ${origin} could not be reached.`,
        reason: "server_unavailable",
      })),
    );
    if (response.status === 401 || response.status === 403) {
      return yield* new CliAuthenticationError({
        message: "The saved Artifact Server credential is invalid or no longer active.",
        reason: "credential_revoked",
      });
    }
    if (response.status < 200 || response.status >= 300) {
      return yield* new CliAuthenticationError({
        message: `Artifact Server rejected credential inspection with HTTP ${response.status}.`,
        reason: "server_unavailable",
      });
    }
    const decoded = yield* HttpClientResponse.schemaBodyJson(
      sessionResponseSchema,
    )(response).pipe(
      Effect.mapError(() => new CliAuthenticationError({
        message: "Artifact Server returned an invalid credential-inspection response.",
        reason: "invalid_metadata",
      })),
    );
    return {principal: decoded.principal};
  },
);

/** Determine whether the stored OAuth access token is still safely reusable. */
export function oauthAccessTokenIsFresh(
  credential: Extract<StoredCliCredential, {readonly kind: "oauth"}>,
  now = Date.now(),
): boolean {
  const expiresIn = credential.tokens.expires_in;
  if (expiresIn === undefined) return false;
  const savedAt = Date.parse(credential.tokensSavedAt);
  return Number.isFinite(savedAt)
    && savedAt + expiresIn * 1_000 - 60_000 > now;
}

/** Preserve the SDK client-information type after schema validation. */
function normalizeClientInformation(
  input: z.infer<typeof oauthClientInformationSchema>,
): StoredOAuthClientInformation {
  const normalized: NormalizedOAuthClientInformation = {
    client_id: input.client_id,
  };
  if (input.client_id_issued_at !== undefined) {
    normalized.client_id_issued_at = input.client_id_issued_at;
  }
  if (input.client_secret !== undefined) {
    normalized.client_secret = input.client_secret;
  }
  if (input.client_secret_expires_at !== undefined) {
    normalized.client_secret_expires_at = input.client_secret_expires_at;
  }
  if (input.issuer !== undefined) normalized.issuer = input.issuer;
  return normalized;
}

function normalizeTokens(
  input: z.infer<typeof oauthTokensSchema>,
): StoredOAuthTokens {
  const normalized: NormalizedOAuthTokens = {
    access_token: input.access_token,
    token_type: input.token_type,
  };
  if (input.expires_in !== undefined) normalized.expires_in = input.expires_in;
  if (input.issuer !== undefined) normalized.issuer = input.issuer;
  if (input.refresh_token !== undefined) {
    normalized.refresh_token = input.refresh_token;
  }
  if (input.scope !== undefined) normalized.scope = input.scope;
  return normalized;
}
