import {
  createRemoteJWKSet,
  customFetch,
  errors as joseErrors,
  jwtVerify,
  type JWTHeaderParameters,
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
import {requireOidcIssuer} from "./oidc-issuer.js";

const defaultAlgorithms = ["RS256", "ES256"];
const idTokenType = "ID";
// OIDC defines these for ID tokens only; an access token has no use for them.
const idTokenOnlyClaims = ["nonce", "at_hash", "c_hash"] as const;
// RFC 9068 access tokens say at+jwt. Many issuers, Keycloak among them, still
// say JWT or leave the header out, so those stay accepted too.
const accessTokenTypes = new Set(["at+jwt", "jwt"]);
const clockTolerance = "30s";
const jwksCacheMilliseconds = 10 * 60 * 1_000;
const jwksCooldownMilliseconds = 5 * 60 * 1_000;
const jwksTimeoutMilliseconds = 5_000;
const requestTimeoutMilliseconds = 5_000;

const profileClaims = {
  email: Schema.optionalKey(Schema.String),
  email_verified: Schema.optionalKey(Schema.Boolean),
  family_name: Schema.optionalKey(Schema.String),
  given_name: Schema.optionalKey(Schema.String),
  name: Schema.optionalKey(Schema.String),
  preferred_username: Schema.optionalKey(Schema.String),
};
const accessTokenClaims = Schema.Struct({
  ...profileClaims,
  azp: Schema.optionalKey(Schema.String),
  client_id: Schema.optionalKey(Schema.String),
  exp: Schema.Number,
  scope: Schema.optionalKey(
    Schema.Union([Schema.String, Schema.Array(Schema.String)]),
  ),
  sub: Schema.NonEmptyString,
  typ: Schema.optionalKey(Schema.String),
});
const userInfoClaims = Schema.Struct({
  ...profileClaims,
  sub: Schema.NonEmptyString,
});
const decodeAccessTokenClaims = Schema.decodeUnknownEffect(accessTokenClaims);
const decodeUserInfoClaims = Schema.decodeUnknownEffect(userInfoClaims);

type AccessTokenClaims = typeof accessTokenClaims.Type;
type ProfileClaims = typeof userInfoClaims.Type;

export interface OidcMcpBearerVerifierConfig {
  readonly algorithms?: readonly string[];
  /** The exact MCP resource URL the issuer must bind into `aud`. */
  readonly audience: string;
  readonly fetch?: typeof globalThis.fetch;
  readonly issuer: string;
  readonly jwksUri: string;
  readonly userInfoEndpoint?: string | null;
}

/** Verify end-user OIDC access tokens presented to the MCP endpoint. */
export class OidcMcpBearerVerifier implements ExternalMcpBearerVerifier {
  readonly #algorithms: string[];
  readonly #audience: string;
  readonly #fetch: typeof globalThis.fetch;
  readonly #issuer: string;
  readonly #jwks: ReturnType<typeof createRemoteJWKSet>;
  readonly #provider: string;
  readonly #userInfoEndpoint: string | null;

  constructor(config: OidcMcpBearerVerifierConfig) {
    this.#algorithms = [...(config.algorithms ?? defaultAlgorithms)];
    this.#audience = config.audience;
    const providerFetch = config.fetch ?? globalThis.fetch;
    this.#fetch = (input, init) => providerFetch(input, init);
    this.#issuer = requireOidcIssuer(config.issuer, "The OIDC issuer");
    // Browser login records the same provider name, so one person keeps one
    // membership whether they arrive through the interface or through MCP.
    this.#provider = `oidc:${this.#issuer}`;
    this.#userInfoEndpoint = config.userInfoEndpoint ?? null;
    this.#jwks = createRemoteJWKSet(new URL(config.jwksUri), {
      cacheMaxAge: jwksCacheMilliseconds,
      cooldownDuration: jwksCooldownMilliseconds,
      // An issuer that answers the key set with an error is unavailable, not a
      // reason to call the presented token invalid.
      [customFetch]: async (input, init) => {
        const response = await providerFetch(input, init);
        if (response.status !== 200) throw new KeySetUnavailable();
        return response;
      },
      timeoutDuration: jwksTimeoutMilliseconds,
    });
  }

  readonly verify = Effect.fn("OidcMcpBearerVerifier.verify")(
    function*(this: OidcMcpBearerVerifier, credential: Redacted.Redacted) {
      const claims = yield* this.#verifiedClaims(credential);
      const verified: VerifiedExternalMcpBearer = {
        clientId: claims.client_id ?? claims.azp ?? null,
        expiresAt: claims.exp,
        provider: this.#provider,
        scopes: tokenScopes(claims.scope),
        subject: claims.sub,
      };
      return verified;
    },
  );

  readonly resolveIdentity = Effect.fn("OidcMcpBearerVerifier.resolveIdentity")(
    function*(
      this: OidcMcpBearerVerifier,
      verified: VerifiedExternalMcpBearer,
      credential: Redacted.Redacted,
    ) {
      if (verified.provider !== this.#provider) {
        return yield* invalidToken("The access token issuer is not supported.");
      }
      const claims = yield* this.#verifiedClaims(credential);
      if (claims.sub !== verified.subject) {
        return yield* invalidToken(
          "The access token names a different subject than the verified one.",
        );
      }
      const email = emailOf(claims);
      if (email !== null) return this.#identityOf(claims, email);
      return yield* this.#userInfoIdentity(credential, claims.sub);
    },
  );

  /** Verify signature, issuer, audience, and expiry, then read the claims. */
  #verifiedClaims(
    credential: Redacted.Redacted,
  ): Effect.Effect<
    AccessTokenClaims,
    AuthenticationRequired | IdentityProviderFailure
  > {
    return Effect.tryPromise({
      try: async () => {
        const result = await jwtVerify(Redacted.value(credential), this.#jwks, {
          algorithms: this.#algorithms,
          audience: this.#audience,
          clockTolerance,
          issuer: this.#issuer,
        });
        return result;
      },
      catch: (cause) => verificationFailure(cause),
    }).pipe(
      Effect.flatMap(({payload, protectedHeader}) =>
        decodeClaims(payload, protectedHeader)
      ),
    );
  }

  readonly #userInfoIdentity = Effect.fn("OidcMcpBearerVerifier.userInfo")(
    function*(
      this: OidcMcpBearerVerifier,
      credential: Redacted.Redacted,
      subject: string,
    ) {
      const endpoint = this.#userInfoEndpoint;
      if (endpoint === null) {
        return yield* invalidToken(
          "The OIDC access token carries no email claim and the issuer offers no userinfo endpoint.",
        );
      }
      const response = yield* Effect.tryPromise({
        try: (signal) => this.#fetch(endpoint, {
          headers: {
            Accept: "application/json",
            Authorization: `Bearer ${Redacted.value(credential)}`,
          },
          redirect: "manual",
          signal: requestSignal(signal),
        }),
        catch: () => providerUnavailable(
          "The OIDC userinfo endpoint could not be reached.",
        ),
      });
      if (response.status === 401 || response.status === 403) {
        return yield* invalidToken(
          "The issuer rejected this access token at its userinfo endpoint.",
        );
      }
      if (!response.ok) {
        return yield* providerUnavailable(
          "The OIDC userinfo endpoint returned an unexpected response.",
        );
      }
      const body = yield* Effect.tryPromise({
        try: () => response.json(),
        catch: () => providerUnavailable(
          "The OIDC userinfo endpoint returned invalid JSON.",
        ),
      });
      const profile = yield* decodeUserInfoClaims(body).pipe(
        Effect.mapError(() => providerUnavailable(
          "The OIDC userinfo endpoint returned an invalid profile.",
        )),
      );
      if (profile.sub !== subject) {
        return yield* providerUnavailable(
          "The OIDC userinfo endpoint returned a different subject.",
        );
      }
      const email = emailOf(profile);
      if (email === null) {
        return yield* invalidToken(
          "The OIDC profile for this access token carries no email address.",
        );
      }
      return this.#identityOf(profile, email);
    },
  );

  #identityOf(claims: ProfileClaims, email: string): ExternalIdentity {
    return {
      displayName: displayName(claims, email),
      email,
      // Unlike browser login, a missing claim is not a verified address: an
      // access-token email may be a mutable profile field, and on first use it
      // can link an admitted member or claim the bootstrap administrator.
      emailVerified: claims.email_verified === true,
      provider: this.#provider,
      subject: claims.sub,
    };
  }
}

function decodeClaims(
  payload: JWTPayload,
  header: JWTHeaderParameters,
): Effect.Effect<AccessTokenClaims, AuthenticationRequired> {
  // An ID token, logout token, or any other JWT from the same issuer is not a
  // credential for this endpoint even when it names the same audience.
  if (!isAccessTokenType(header.typ)) {
    return Effect.fail(invalidToken("The JWT type is not an access token."));
  }
  if (idTokenOnlyClaims.some((claim) => claim in payload)) {
    return Effect.fail(invalidToken(
      "An ID token is not an Artifact Server MCP credential.",
    ));
  }
  return decodeAccessTokenClaims(payload).pipe(
    Effect.mapError(() => invalidToken(
      "The OIDC access token is missing required claims.",
    )),
    Effect.flatMap((claims) =>
      // Keycloak also marks its ID tokens with a payload typ of ID.
      claims.typ === idTokenType
        ? Effect.fail(invalidToken(
          "An ID token is not an Artifact Server MCP credential.",
        ))
        : Effect.succeed(claims)
    ),
  );
}

/** Media types compare case-insensitively, and `application/` is optional. */
function isAccessTokenType(typ: string | undefined): boolean {
  if (typ === undefined) return true;
  return accessTokenTypes.has(typ.toLowerCase().replace(/^application\//u, ""));
}

function emailOf(claims: ProfileClaims): string | null {
  const email = claims.email?.trim() ?? "";
  return email === "" ? null : email;
}

function displayName(claims: ProfileClaims, email: string): string {
  const name = claims.name?.trim() ?? "";
  if (name !== "") return name;
  const parts = [claims.given_name, claims.family_name]
    .map((part) => part?.trim() ?? "")
    .filter((part) => part !== "");
  if (parts.length > 0) return parts.join(" ");
  const username = claims.preferred_username?.trim() ?? "";
  return username === "" ? email : username;
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

/** The issuer answered the key set with something other than a key set. */
class KeySetUnavailable extends Error {}

function verificationFailure(
  cause: unknown,
): AuthenticationRequired | IdentityProviderFailure {
  if (
    cause instanceof KeySetUnavailable ||
    cause instanceof TypeError ||
    cause instanceof joseErrors.JWKSTimeout ||
    (
      Predicate.isObject(cause) && "code" in cause &&
      cause["code"] === "ERR_JWKS_FETCH_FAILED"
    )
  ) {
    return providerUnavailable(
      cause instanceof joseErrors.JWKSTimeout
        ? "The OIDC signing-key lookup timed out."
        : "The OIDC signing keys could not be loaded.",
    );
  }
  return new AuthenticationRequired({
    message: "The OIDC access token is invalid, expired, or for another resource.",
  });
}

function invalidToken(message: string): AuthenticationRequired {
  return new AuthenticationRequired({message});
}

function providerUnavailable(message: string): IdentityProviderFailure {
  return new IdentityProviderFailure({message});
}

/** Bound every userinfo request so one stalled issuer cannot pin a request. */
function requestSignal(interrupt: AbortSignal): AbortSignal {
  return AbortSignal.any([
    interrupt,
    AbortSignal.timeout(requestTimeoutMilliseconds),
  ]);
}
