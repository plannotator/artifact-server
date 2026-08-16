import {
  createRemoteJWKSet,
  errors as joseErrors,
  jwtVerify,
  type JWTPayload,
} from "jose";
import {Effect, Predicate, Redacted, Schema} from "effect";

import type {
  ExternalMcpBearerVerifier,
  VerifiedExternalMcpBearer,
} from "../application/authentication.js";
import {
  AuthenticationRequired,
  IdentityProviderFailure,
} from "../core/errors.js";
import type {ExternalIdentity} from "../core/installation-identity.js";
import {exactHttpsOrigin} from "./workos-oauth-metadata.js";

const workOsProviderName = "workos";
const workOsUser = Schema.Struct({
  email: Schema.String,
  email_verified: Schema.Boolean,
  first_name: Schema.NullOr(Schema.String),
  id: Schema.String,
  last_name: Schema.NullOr(Schema.String),
  name: Schema.NullOr(Schema.String),
});
const decodeWorkOsUser = Schema.decodeUnknownEffect(workOsUser);
const workOsAccessTokenClaims = Schema.Struct({
  aud: Schema.Union([Schema.String, Schema.Array(Schema.String)]),
  client_id: Schema.optionalKey(Schema.String),
  exp: Schema.Number,
  scope: Schema.optionalKey(
    Schema.Union([Schema.String, Schema.Array(Schema.String)]),
  ),
  sub: Schema.NonEmptyString,
});
const decodeAccessTokenClaims = Schema.decodeUnknownEffect(
  workOsAccessTokenClaims,
);

export interface WorkOsMcpBearerVerifierConfig {
  readonly apiKey: Redacted.Redacted;
  readonly apiOrigin?: string;
  readonly fetch?: typeof globalThis.fetch;
  readonly issuer: string;
  readonly jwksUri?: string;
  readonly resource: string;
}

/** Verify WorkOS MCP JWTs and resolve first-use users without forwarding tokens. */
export class WorkOsMcpBearerVerifier implements ExternalMcpBearerVerifier {
  readonly #apiKey: Redacted.Redacted;
  readonly #apiOrigin: URL;
  readonly #fetch: typeof globalThis.fetch;
  readonly #issuer: string;
  readonly #jwks: ReturnType<typeof createRemoteJWKSet>;
  readonly #resource: string;

  constructor(config: WorkOsMcpBearerVerifierConfig) {
    this.#apiKey = config.apiKey;
    this.#apiOrigin = new URL(config.apiOrigin ?? "https://api.workos.com");
    const providerFetch = config.fetch ?? globalThis.fetch;
    this.#fetch = (input, init) => providerFetch(input, init);
    this.#issuer = exactHttpsOrigin(config.issuer, "WorkOS issuer");
    this.#resource = exactHttpsResource(config.resource);
    const jwksUri = config.jwksUri === undefined
      ? new URL("/oauth2/jwks", this.#issuer)
      : new URL(config.jwksUri);
    this.#jwks = createRemoteJWKSet(jwksUri, {
      cacheMaxAge: 10 * 60 * 1_000,
      cooldownDuration: 5 * 60 * 1_000,
      timeoutDuration: 5_000,
    });
  }

  readonly verify = Effect.fn("WorkOsMcpBearerVerifier.verify")(
    function*(this: WorkOsMcpBearerVerifier, credential: Redacted.Redacted) {
      const payload = yield* Effect.tryPromise({
        try: async () => {
          const result = await jwtVerify(
            Redacted.value(credential),
            this.#jwks,
            {
              algorithms: ["RS256"],
              audience: this.#resource,
              issuer: this.#issuer,
            },
          );
          return result.payload;
        },
        catch: (cause) => verificationFailure(cause),
      });
      return yield* validateClaims(payload, this.#resource);
    },
  );

  readonly resolveIdentity = Effect.fn(
    "WorkOsMcpBearerVerifier.resolveIdentity",
  )(function*(
    this: WorkOsMcpBearerVerifier,
    verified: VerifiedExternalMcpBearer,
  ) {
    if (verified.provider !== workOsProviderName) {
      return yield* invalidToken("The access token issuer is not supported.");
    }
    const url = new URL(
      `/user_management/users/${encodeURIComponent(verified.subject)}`,
      this.#apiOrigin,
    );
    const response = yield* Effect.tryPromise({
      try: (signal) => this.#fetch(url, {
        headers: {
          Accept: "application/json",
          Authorization: `Bearer ${Redacted.value(this.#apiKey)}`,
        },
        signal,
      }),
      catch: () => providerUnavailable(
        "WorkOS user lookup could not reach the provider.",
      ),
    });
    if (response.status === 404) {
      return yield* invalidToken(
        "The WorkOS user for this access token is not active.",
      );
    }
    if (response.status === 401 || response.status === 403) {
      return yield* providerUnavailable(
        "WorkOS rejected the Artifact Server API credential.",
      );
    }
    if (!response.ok) {
      return yield* providerUnavailable(
        "WorkOS user lookup returned an unexpected response.",
      );
    }
    const body = yield* Effect.tryPromise({
      try: () => response.json(),
      catch: () => providerUnavailable(
        "WorkOS user lookup returned invalid JSON.",
      ),
    });
    const user = yield* decodeWorkOsUser(body).pipe(
      Effect.mapError(() => providerUnavailable(
        "WorkOS user lookup returned an invalid user record.",
      )),
    );
    if (user.id !== verified.subject) {
      return yield* providerUnavailable(
        "WorkOS user lookup returned a different subject.",
      );
    }
    return workOsExternalIdentity(user);
  });
}

function validateClaims(
  payload: JWTPayload,
  resource: string,
): Effect.Effect<VerifiedExternalMcpBearer, AuthenticationRequired> {
  return Effect.gen(function*() {
    const claims = yield* decodeAccessTokenClaims(payload).pipe(
      Effect.mapError(() => invalidToken(
        "The WorkOS access token is missing required claims.",
      )),
    );
    if (!hasExactAudience(claims.aud, resource)) {
      return yield* invalidToken(
        "The WorkOS access token is for a different resource.",
      );
    }
    const scopes = tokenScopes(claims.scope);
    return {
      clientId: claims.client_id ?? null,
      expiresAt: claims.exp,
      provider: workOsProviderName,
      scopes,
      subject: claims.sub,
    };
  });
}

function hasExactAudience(
  audience: string | readonly string[],
  resource: string,
): boolean {
  return audience === resource || (
    Array.isArray(audience) && audience.length === 1 && audience[0] === resource
  );
}

function tokenScopes(
  value: string | readonly string[] | undefined,
): readonly string[] {
  if (value === undefined) return [];
  if (Predicate.isString(value)) {
    return [...new Set(value.split(/\s+/u).filter((scope) => scope !== ""))];
  }
  return [...new Set(value)];
}

function workOsExternalIdentity(
  user: typeof workOsUser.Type,
): ExternalIdentity {
  return {
    displayName: user.name?.trim() ||
      [user.first_name, user.last_name]
        .filter((part): part is string => part !== null && part.trim() !== "")
        .map((part) => part.trim())
        .join(" ") || user.email,
    email: user.email,
    emailVerified: user.email_verified,
    provider: workOsProviderName,
    subject: user.id,
  };
}

function verificationFailure(
  cause: unknown,
): AuthenticationRequired | IdentityProviderFailure {
  if (
    cause instanceof TypeError ||
    cause instanceof joseErrors.JWKSTimeout ||
    (
      Predicate.isObject(cause) && "code" in cause &&
      cause["code"] === "ERR_JWKS_FETCH_FAILED"
    )
  ) {
    return providerUnavailable(
      cause instanceof joseErrors.JWKSTimeout
        ? "WorkOS signing-key lookup timed out."
        : "WorkOS signing keys could not be loaded.",
    );
  }
  return new AuthenticationRequired({
    message: "The WorkOS MCP access token is invalid or no longer active.",
  });
}

function invalidToken(message: string): AuthenticationRequired {
  return new AuthenticationRequired({message});
}

function providerUnavailable(message: string): IdentityProviderFailure {
  return new IdentityProviderFailure({
    message,
  });
}

function exactHttpsResource(value: string): string {
  const url = new URL(value);
  if (
    url.protocol !== "https:" || url.pathname !== "/mcp" ||
    url.search !== "" || url.hash !== ""
  ) {
    throw new Error("The WorkOS MCP resource must be the exact HTTPS /mcp URL.");
  }
  return url.toString();
}
