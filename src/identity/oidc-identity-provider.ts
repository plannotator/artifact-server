import {base64url, createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey} from "jose";
import {Effect, Redacted} from "effect";
import {z} from "zod";

import type {
  InteractiveAuthorization,
  InteractiveIdentityProvider,
} from "../application/interactive-login.js";
import {IdentityProviderFailure} from "../core/errors.js";
import type {ExternalIdentity} from "../core/installation-identity.js";
import {
  isLocalOidcIssuer,
  normalizeOidcEndpoint,
  normalizeOidcIssuer,
  requireOidcIssuer,
} from "./oidc-issuer.js";

/** Scopes requested when a deployment does not configure its own. */
export const defaultOidcScopes = "openid email profile";

const openIdConfigurationPath = "/.well-known/openid-configuration";
const stateByteLength = 32;
const nonceByteLength = 16;
const codeVerifierByteLength = 32;
const idTokenClockTolerance = "30s";
const jwksCacheMilliseconds = 10 * 60 * 1_000;
const jwksCooldownMilliseconds = 5 * 60 * 1_000;
const jwksTimeoutMilliseconds = 5_000;
const requestTimeoutMilliseconds = 5_000;

const discoveryDocumentSchema = z.looseObject({
  authorization_endpoint: z.string().min(1),
  issuer: z.string().min(1),
  jwks_uri: z.string().min(1),
  token_endpoint: z.string().min(1),
});
const tokenResponseSchema = z.looseObject({
  id_token: z.string().min(1),
});
const idTokenClaimsSchema = z.looseObject({
  email: z.string().trim().min(1),
  email_verified: z.boolean().optional(),
  family_name: z.string().optional(),
  given_name: z.string().optional(),
  name: z.string().optional(),
  nonce: z.string().optional(),
  sub: z.string().trim().min(1),
});

/** Validated OpenID Connect discovery endpoints for one issuer. */
interface OidcDiscovery {
  readonly authorizationEndpoint: string;
  readonly issuer: string;
  readonly jwksUri: string;
  readonly tokenEndpoint: string;
}

interface OidcCodeExchange {
  readonly clientId: string;
  readonly clientSecret: Redacted.Redacted | null;
  readonly code: string;
  readonly codeVerifier: string;
  readonly redirectUri: string;
}

export interface OidcIdentityProviderConfig {
  readonly clientId: string;
  readonly clientSecret: Redacted.Redacted | null;
  readonly fetch?: typeof globalThis.fetch;
  readonly issuer: string;
  readonly redirectUri: string;
  readonly scopes: string;
}

/** Complete generic OIDC browser-login settings loaded by one deployment. */
export interface OidcBrowserLoginSettings {
  readonly applicationOrigin: string;
  readonly clientId: string;
  readonly clientSecret: Redacted.Redacted | null;
  readonly issuer: string;
  readonly scopes: string;
}

/** Generic OpenID Connect adapter for self-hosted browser login. */
export class OidcIdentityProvider implements InteractiveIdentityProvider {
  readonly name = "oidc";
  readonly #clientId: string;
  readonly #clientSecret: Redacted.Redacted | null;
  readonly #fetch: typeof globalThis.fetch;
  readonly #issuer: string;
  readonly #redirectUri: string;
  readonly #scopes: string;
  #discovered: OidcDiscovery | null = null;
  #keys: JWTVerifyGetKey | null = null;

  constructor(config: OidcIdentityProviderConfig) {
    this.#clientId = config.clientId;
    this.#clientSecret = config.clientSecret;
    const providerFetch = config.fetch ?? globalThis.fetch;
    this.#fetch = (input, init) => providerFetch(input, init);
    this.#issuer = requireOidcIssuer(config.issuer, "The OIDC issuer");
    this.#redirectUri = config.redirectUri;
    this.#scopes = config.scopes;
  }

  readonly start = Effect.fn("OidcIdentityProvider.start")(
    function*(this: OidcIdentityProvider) {
      const discovery = yield* this.#discovery();
      const codeVerifier = randomBase64Url(codeVerifierByteLength);
      const codeChallenge = yield* Effect.tryPromise({
        try: () => pkceChallenge(codeVerifier),
        catch: () => providerFailure(),
      });
      const state = randomBase64Url(stateByteLength);
      const nonce = randomBase64Url(nonceByteLength);
      const authorizationUrl = new URL(discovery.authorizationEndpoint);
      authorizationUrl.searchParams.set("response_type", "code");
      authorizationUrl.searchParams.set("client_id", this.#clientId);
      authorizationUrl.searchParams.set("redirect_uri", this.#redirectUri);
      authorizationUrl.searchParams.set("scope", this.#scopes);
      authorizationUrl.searchParams.set("state", state);
      authorizationUrl.searchParams.set("nonce", nonce);
      authorizationUrl.searchParams.set("code_challenge", codeChallenge);
      authorizationUrl.searchParams.set("code_challenge_method", "S256");
      const authorization: InteractiveAuthorization = {
        authorizationUrl: authorizationUrl.toString(),
        codeVerifier,
        nonce,
        state,
      };
      return authorization;
    },
  );

  readonly complete = Effect.fn("OidcIdentityProvider.complete")(
    function*(
      this: OidcIdentityProvider,
      code: string,
      codeVerifier: string,
      nonce: string | null,
    ) {
      const discovery = yield* this.#discovery();
      const idToken = yield* exchangeAuthorizationCode(
        discovery,
        {
          clientId: this.#clientId,
          clientSecret: this.#clientSecret,
          code,
          codeVerifier,
          redirectUri: this.#redirectUri,
        },
        this.#fetch,
      ).pipe(
        Effect.catch((reason) =>
          reportFailure("identity.oidc.exchange_failed", this.#issuer, reason)
        ),
      );
      const payload = yield* Effect.tryPromise({
        try: async () => {
          const verified = await jwtVerify(idToken, this.#keySource(discovery), {
            audience: this.#clientId,
            clockTolerance: idTokenClockTolerance,
            issuer: discovery.issuer,
          });
          return verified.payload;
        },
        catch: () => providerFailure(),
      });
      const claims = idTokenClaimsSchema.safeParse(payload);
      if (!claims.success) return yield* providerFailure();
      if (nonce === null || claims.data.nonce !== nonce) {
        return yield* providerFailure();
      }
      const identity: ExternalIdentity = {
        displayName: displayName(claims.data),
        email: claims.data.email,
        emailVerified: claims.data.email_verified !== false,
        provider: `oidc:${this.#issuer}`,
        subject: claims.data.sub,
      };
      return identity;
    },
  );

  #discovery(): Effect.Effect<OidcDiscovery, IdentityProviderFailure> {
    const cached = this.#discovered;
    if (cached !== null) return Effect.succeed(cached);
    const issuer = this.#issuer;
    return loadDiscovery(issuer, this.#fetch).pipe(
      Effect.tap((discovery) => Effect.sync(() => {
        this.#discovered = discovery;
      })),
      Effect.catch((reason) =>
        reportFailure("identity.oidc.discovery_failed", issuer, reason)
      ),
    );
  }

  #keySource(discovery: OidcDiscovery): JWTVerifyGetKey {
    const cached = this.#keys;
    if (cached !== null) return cached;
    const keys = createRemoteJWKSet(new URL(discovery.jwksUri), {
      cacheMaxAge: jwksCacheMilliseconds,
      cooldownDuration: jwksCooldownMilliseconds,
      timeoutDuration: jwksTimeoutMilliseconds,
    });
    this.#keys = keys;
    return keys;
  }
}

/** Build the generic OIDC browser-login provider from loaded settings. */
export function createOidcIdentityProvider(
  settings: OidcBrowserLoginSettings,
): OidcIdentityProvider {
  return new OidcIdentityProvider({
    clientId: settings.clientId,
    clientSecret: settings.clientSecret,
    issuer: settings.issuer,
    redirectUri: new URL("/auth/callback", settings.applicationOrigin).toString(),
    scopes: settings.scopes,
  });
}

const loadDiscovery = Effect.fn("OidcIdentityProvider.loadDiscovery")(
  function*(issuer: string, fetcher: typeof globalThis.fetch) {
    const response = yield* Effect.tryPromise({
      try: (signal) => fetcher(`${issuer}${openIdConfigurationPath}`, {
        headers: {Accept: "application/json"},
        // Never follow discovery off the validated issuer origin.
        redirect: "manual",
        signal: requestSignal(signal),
      }),
      catch: (cause) => causeReason(cause),
    });
    if (isRedirect(response)) {
      return yield* Effect.fail("discovery answered with a redirect");
    }
    if (!response.ok) {
      return yield* Effect.fail(`discovery returned HTTP ${response.status}`);
    }
    const body = yield* Effect.tryPromise({
      try: () => response.json(),
      catch: () => "the discovery document is not JSON",
    });
    const document = discoveryDocumentSchema.safeParse(body);
    if (!document.success) {
      return yield* Effect.fail(
        "the discovery document is missing required endpoints",
      );
    }
    if (normalizeOidcIssuer(document.data.issuer) !== issuer) {
      return yield* Effect.fail(
        "the discovery document reported a different issuer",
      );
    }
    const allowLocalHttp = isLocalOidcIssuer(issuer);
    const authorizationEndpoint = normalizeOidcEndpoint(
      document.data.authorization_endpoint,
      allowLocalHttp,
    );
    const tokenEndpoint = normalizeOidcEndpoint(
      document.data.token_endpoint,
      allowLocalHttp,
    );
    const jwksUri = normalizeOidcEndpoint(document.data.jwks_uri, allowLocalHttp);
    if (
      authorizationEndpoint === null || tokenEndpoint === null || jwksUri === null
    ) {
      return yield* Effect.fail(
        "the discovery document advertises an unusable endpoint URL",
      );
    }
    const discovery: OidcDiscovery = {
      authorizationEndpoint,
      issuer,
      jwksUri,
      tokenEndpoint,
    };
    return discovery;
  },
);

const exchangeAuthorizationCode = Effect.fn(
  "OidcIdentityProvider.exchangeAuthorizationCode",
)(function*(
  discovery: OidcDiscovery,
  exchange: OidcCodeExchange,
  fetcher: typeof globalThis.fetch,
) {
  const body = new URLSearchParams({
    client_id: exchange.clientId,
    code: exchange.code,
    code_verifier: exchange.codeVerifier,
    grant_type: "authorization_code",
    redirect_uri: exchange.redirectUri,
  });
  if (exchange.clientSecret !== null) {
    body.set("client_secret", Redacted.value(exchange.clientSecret));
  }
  const response = yield* Effect.tryPromise({
    try: (signal) => fetcher(discovery.tokenEndpoint, {
      body,
      headers: {
        Accept: "application/json",
        "Content-Type": "application/x-www-form-urlencoded",
      },
      method: "POST",
      // A followed redirect would replay the client secret, the authorization
      // code, and the PKCE verifier against an unvalidated host.
      redirect: "manual",
      signal: requestSignal(signal),
    }),
    catch: (cause) => causeReason(cause),
  });
  if (isRedirect(response)) {
    return yield* Effect.fail("the token endpoint answered with a redirect");
  }
  if (!response.ok) {
    return yield* Effect.fail(`token exchange returned HTTP ${response.status}`);
  }
  const payload = yield* Effect.tryPromise({
    try: () => response.json(),
    catch: () => "the token response is not JSON",
  });
  const tokens = tokenResponseSchema.safeParse(payload);
  if (!tokens.success) {
    return yield* Effect.fail("the token response did not include an id_token");
  }
  return tokens.data.id_token;
});

const reportFailure = Effect.fn("OidcIdentityProvider.reportFailure")(
  function*(event: string, issuer: string, reason: string) {
    yield* Effect.logError(event).pipe(Effect.annotateLogs({issuer, reason}));
    return yield* providerFailure();
  },
);

function displayName(claims: z.infer<typeof idTokenClaimsSchema>): string {
  const name = claims.name?.trim() ?? "";
  if (name !== "") return name;
  const parts = [claims.given_name, claims.family_name]
    .filter((part): part is string =>
      part !== undefined && part.trim() !== ""
    )
    .map((part) => part.trim());
  return parts.length === 0 ? claims.email : parts.join(" ");
}

async function pkceChallenge(codeVerifier: string): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(codeVerifier),
  );
  return base64url.encode(new Uint8Array(digest));
}

function randomBase64Url(byteLength: number): string {
  const bytes = new Uint8Array(byteLength);
  globalThis.crypto.getRandomValues(bytes);
  return base64url.encode(bytes);
}

function isRedirect(response: Response): boolean {
  return response.type === "opaqueredirect" ||
    (response.status >= 300 && response.status < 400);
}

/** Bound every provider request so one stalled issuer cannot pin a request. */
function requestSignal(interrupt: AbortSignal): AbortSignal {
  return AbortSignal.any([
    interrupt,
    AbortSignal.timeout(requestTimeoutMilliseconds),
  ]);
}

function causeReason(cause: unknown): string {
  if (cause instanceof Error && cause.name === "TimeoutError") {
    return `the issuer did not answer within ${
      requestTimeoutMilliseconds / 1_000
    } seconds`;
  }
  return cause instanceof Error ? cause.message : "the request failed";
}

function providerFailure(): IdentityProviderFailure {
  return new IdentityProviderFailure({
    message: "The configured identity provider could not complete browser login.",
  });
}
