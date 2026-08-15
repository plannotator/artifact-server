import {spawn} from "node:child_process";
import {randomBytes} from "node:crypto";
import {createServer, type Server} from "node:http";
import path from "node:path";

import {
  auth,
  discoverOAuthServerInfo,
  type OAuthClientInformationContext,
  type OAuthClientMetadata,
  type OAuthClientProvider,
  type OAuthDiscoveryState,
  type StoredOAuthClientInformation,
  type StoredOAuthTokens,
} from "@modelcontextprotocol/client";
import {Effect} from "effect";
import {z} from "zod";

import {
  CliAuthenticationError,
  oauthAccessTokenIsFresh,
  oauthCredential,
  type StoredCliCredential,
} from "./cli-profile-credential.js";

const cliScope = "artifactserver";
const callbackTimeoutMilliseconds = 5 * 60 * 1_000;
const protectedResourceMetadataSchema = z.object({
  authorization_servers: z.array(z.url()).min(1),
  bearer_methods_supported: z.array(z.string()).optional(),
  resource: z.url(),
  scopes_supported: z.array(z.string()).optional(),
}).passthrough();
const callbackQuerySchema = z.object({
  code: z.string().min(1).max(4_096),
  iss: z.url().optional(),
  state: z.string().min(16).max(4_096),
});
const assignedAddressSchema = z.object({
  address: z.string(),
  port: z.number().int().positive(),
});
const revocationMetadataSchema = z.object({
  revocation_endpoint: z.url(),
}).passthrough();
const ignoreCallbackResult = (): void => undefined;

/** Result of one successful browser OAuth login. */
export interface CliOAuthLoginResult {
  readonly credential: Extract<StoredCliCredential, {readonly kind: "oauth"}>;
}

/** Complete protected-resource discovery and S256 PKCE in the system browser. */
export const loginWithBrowserOAuth = Effect.fn("CliOAuth.login")(
  function*(
    origin: string,
    environment: NodeJS.ProcessEnv = process.env,
  ): Effect.fn.Return<CliOAuthLoginResult, CliAuthenticationError> {
    const resource = new URL("/api", origin);
    const metadataUrl = protectedResourceMetadataUrl(origin);
    yield* verifyProtectedResourceMetadata(resource, metadataUrl);
    const state = randomBytes(32).toString("base64url");
    const callback = yield* openLoopbackCallback(state);
    const provider = new ArtifactServerOAuthProvider({
      environment,
      redirectUrl: callback.redirectUrl,
      state,
    });
    const result = yield* Effect.tryPromise({
      try: async () => {
        try {
          const started = await auth(provider, {
            resourceMetadataUrl: metadataUrl,
            scope: cliScope,
            serverUrl: resource,
          });
          if (started !== "REDIRECT") {
            throw new Error("OAuth login did not require browser authorization.");
          }
          const query = await callback.result;
          const completed = query.iss === undefined
            ? await auth(provider, {
              authorizationCode: query.code,
              resourceMetadataUrl: metadataUrl,
              scope: cliScope,
              serverUrl: resource,
            })
            : await auth(provider, {
              authorizationCode: query.code,
              iss: query.iss,
              resourceMetadataUrl: metadataUrl,
              scope: cliScope,
              serverUrl: resource,
            });
          if (completed !== "AUTHORIZED") {
            throw new Error("OAuth authorization did not complete.");
          }
          return provider.storedCredential();
        } finally {
          await callback.close();
        }
      },
      catch: (cause) => cause instanceof CliAuthenticationError
        ? cause
        : new CliAuthenticationError({
          message:
            "Browser authorization did not complete. Check the server's OAuth configuration and run auth login again.",
          reason: "oauth_failed",
        }),
    });
    return {credential: result};
  },
);

/** Refresh an OAuth profile without opening a browser. */
export const refreshCliOAuthCredential = Effect.fn("CliOAuth.refresh")(
  function*(
    origin: string,
    credential: Extract<StoredCliCredential, {readonly kind: "oauth"}>,
    environment: NodeJS.ProcessEnv = process.env,
    forceRefresh = false,
  ): Effect.fn.Return<
    Extract<StoredCliCredential, {readonly kind: "oauth"}>,
    CliAuthenticationError
  > {
    if (!forceRefresh && oauthAccessTokenIsFresh(credential)) return credential;
    const provider = new ArtifactServerOAuthProvider({
      environment,
      redirectUrl: credential.redirectUrl,
      state: randomBytes(32).toString("base64url"),
      stored: credential,
      rejectBrowserRedirect: true,
    });
    return yield* Effect.tryPromise({
      try: async () => {
        const result = await auth(provider, {
          resourceMetadataUrl: protectedResourceMetadataUrl(origin),
          scope: cliScope,
          serverUrl: new URL("/api", origin),
        });
        if (result !== "AUTHORIZED") {
          throw new Error("OAuth refresh requires a new login.");
        }
        return provider.storedCredential();
      },
      catch: () => new CliAuthenticationError({
        message:
          "The Artifact Server browser grant could not be renewed. Run artifactserver auth login again.",
        reason: "credential_revoked",
      }),
    });
  },
);

/** Best-effort remote OAuth revocation; local credential deletion remains separate. */
export const revokeCliOAuthCredential = Effect.fn("CliOAuth.revoke")(
  function*(
    origin: string,
    credential: Extract<StoredCliCredential, {readonly kind: "oauth"}>,
  ): Effect.fn.Return<boolean> {
    return yield* Effect.promise(async () => {
      try {
        const discovered = await discoverOAuthServerInfo(
          new URL("/api", origin),
          {resourceMetadataUrl: protectedResourceMetadataUrl(origin)},
        );
        const metadata = revocationMetadataSchema.safeParse(
          discovered.authorizationServerMetadata,
        );
        if (!metadata.success) return false;
        const token = credential.tokens.refresh_token
          ?? credential.tokens.access_token;
        const body = new URLSearchParams({
          client_id: credential.clientInformation.client_id,
          token,
          token_type_hint: credential.tokens.refresh_token === undefined
            ? "access_token"
            : "refresh_token",
        });
        const response = await fetch(metadata.data.revocation_endpoint, {
          body,
          headers: {"Content-Type": "application/x-www-form-urlencoded"},
          method: "POST",
          signal: AbortSignal.timeout(10_000),
        });
        return response.ok;
      } catch {
        return false;
      }
    });
  },
);

/** Exact RFC 9728 path for the Artifact Server HTTP API resource. */
export function protectedResourceMetadataUrl(origin: string): URL {
  return new URL("/.well-known/oauth-protected-resource/api", origin);
}

interface OAuthProviderOptions {
  readonly environment: NodeJS.ProcessEnv;
  readonly redirectUrl: string;
  readonly rejectBrowserRedirect?: boolean;
  readonly state: string;
  readonly stored?: Extract<StoredCliCredential, {readonly kind: "oauth"}>;
}

class ArtifactServerOAuthProvider implements OAuthClientProvider {
  readonly clientMetadataUrl = "https://artifactserver.com/oauth/client-metadata.json";
  readonly redirectUrl: string;
  readonly #environment: NodeJS.ProcessEnv;
  readonly #rejectBrowserRedirect: boolean;
  readonly #state: string;
  #clientInformation: StoredOAuthClientInformation | undefined;
  #codeVerifier: string | undefined;
  #discoveryState: OAuthDiscoveryState | undefined;
  #tokens: StoredOAuthTokens | undefined;
  #tokensSavedAt: string | undefined;

  constructor(options: OAuthProviderOptions) {
    this.#environment = options.environment;
    this.#rejectBrowserRedirect = options.rejectBrowserRedirect ?? false;
    this.#state = options.state;
    this.redirectUrl = options.redirectUrl;
    this.#clientInformation = options.stored?.clientInformation;
    this.#tokens = options.stored?.tokens;
    this.#tokensSavedAt = options.stored?.tokensSavedAt;
  }

  get clientMetadata(): OAuthClientMetadata {
    return {
      application_type: "native",
      client_name: "Artifact Server CLI",
      grant_types: ["authorization_code", "refresh_token"],
      redirect_uris: [this.redirectUrl],
      response_types: ["code"],
      scope: `${cliScope} offline_access`,
      token_endpoint_auth_method: "none",
    };
  }

  state(): string {
    return this.#state;
  }

  clientInformation(
    _context?: OAuthClientInformationContext,
  ): StoredOAuthClientInformation | undefined {
    return this.#clientInformation;
  }

  saveClientInformation(
    information: StoredOAuthClientInformation,
    _context?: OAuthClientInformationContext,
  ): void {
    this.#clientInformation = information;
  }

  tokens(
    _context?: OAuthClientInformationContext,
  ): StoredOAuthTokens | undefined {
    return this.#tokens;
  }

  saveTokens(
    tokens: StoredOAuthTokens,
    _context?: OAuthClientInformationContext,
  ): void {
    this.#tokens = tokens;
    this.#tokensSavedAt = new Date().toISOString();
  }

  redirectToAuthorization(url: URL): Promise<void> {
    if (this.#rejectBrowserRedirect) {
      return Promise.reject(new Error("A new browser login is required."));
    }
    return openSystemBrowser(url, this.#environment);
  }

  saveCodeVerifier(verifier: string): void {
    this.#codeVerifier = verifier;
  }

  codeVerifier(): string {
    if (this.#codeVerifier === undefined) {
      throw new Error("The OAuth PKCE verifier is unavailable.");
    }
    return this.#codeVerifier;
  }

  saveDiscoveryState(discovery: OAuthDiscoveryState): void {
    this.#discoveryState = discovery;
  }

  discoveryState(): OAuthDiscoveryState | undefined {
    return this.#discoveryState;
  }

  invalidateCredentials(
    scope: "all" | "client" | "tokens" | "verifier" | "discovery",
  ): void {
    if (scope === "all" || scope === "client") this.#clientInformation = undefined;
    if (scope === "all" || scope === "tokens") this.#tokens = undefined;
    if (scope === "all" || scope === "verifier") this.#codeVerifier = undefined;
    if (scope === "all" || scope === "discovery") this.#discoveryState = undefined;
  }

  storedCredential(): Extract<StoredCliCredential, {readonly kind: "oauth"}> {
    if (
      this.#clientInformation === undefined
      || this.#tokens === undefined
      || this.#tokensSavedAt === undefined
    ) {
      throw new Error("OAuth did not return complete reusable credentials.");
    }
    return oauthCredential({
      clientInformation: this.#clientInformation,
      redirectUrl: this.redirectUrl,
      tokens: this.#tokens,
      tokensSavedAt: this.#tokensSavedAt,
    });
  }
}

function verifyProtectedResourceMetadata(
  resource: URL,
  metadataUrl: URL,
): Effect.Effect<void, CliAuthenticationError> {
  return Effect.tryPromise({
    try: async () => {
      const response = await fetch(metadataUrl, {
        headers: {Accept: "application/json"},
        signal: AbortSignal.timeout(10_000),
      });
      if (response.status === 404) {
        throw new CliAuthenticationError({
          message:
            "This Artifact Server does not advertise browser authorization for the CLI. Use --api-key-stdin with an administrator-issued key.",
          reason: "browser_authorization_unavailable",
        });
      }
      if (!response.ok) throw new Error("metadata request failed");
      const metadata = protectedResourceMetadataSchema.parse(await response.json());
      if (
        metadata.resource !== resource.toString()
        || metadata.scopes_supported?.includes(cliScope) === false
      ) {
        throw new Error("metadata resource or scope mismatch");
      }
    },
    catch: (cause) => cause instanceof CliAuthenticationError
      ? cause
      : new CliAuthenticationError({
        message:
          "The Artifact Server CLI authorization metadata is invalid or unavailable.",
        reason: "invalid_metadata",
      }),
  });
}

interface LoopbackCallback {
  readonly close: () => Promise<void>;
  readonly redirectUrl: string;
  readonly result: Promise<z.infer<typeof callbackQuerySchema>>;
}

function openLoopbackCallback(
  expectedState: string,
): Effect.Effect<LoopbackCallback, CliAuthenticationError> {
  return Effect.tryPromise({
    try: () => createLoopbackCallback(expectedState),
    catch: () => new CliAuthenticationError({
      message: "Artifact Server could not open a private loopback OAuth callback.",
      reason: "oauth_failed",
    }),
  });
}

async function createLoopbackCallback(
  expectedState: string,
): Promise<LoopbackCallback> {
  let resolveResult: (value: z.infer<typeof callbackQuerySchema>) => void =
    ignoreCallbackResult;
  let rejectResult: (cause: Error) => void = ignoreCallbackResult;
  const result = new Promise<z.infer<typeof callbackQuerySchema>>(
    (resolve, reject) => {
      resolveResult = resolve;
      rejectResult = reject;
    },
  );
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (request.method !== "GET" || url.pathname !== "/oauth/callback") {
      response.writeHead(404).end();
      return;
    }
    const parsed = callbackQuerySchema.safeParse(Object.fromEntries(url.searchParams));
    if (!parsed.success || parsed.data.state !== expectedState) {
      response.writeHead(400, {"Content-Type": "text/plain; charset=utf-8"});
      response.end("Artifact Server rejected this authorization response.");
      rejectResult(new Error("The OAuth callback state was invalid."));
      return;
    }
    response.writeHead(200, {
      "Cache-Control": "no-store",
      "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'",
      "Content-Type": "text/html; charset=utf-8",
      "Referrer-Policy": "no-referrer",
    });
    response.end(
      "<!doctype html><meta charset=utf-8><title>Artifact Server connected</title><style>body{font:16px system-ui;margin:3rem;max-width:42rem}h1{font-size:1.5rem}</style><h1>Artifact Server is connected.</h1><p>You can close this tab.</p>",
    );
    resolveResult(parsed.data);
  });
  await listenLoopback(server);
  const address = assignedAddressSchema.parse(server.address());
  const timeout = setTimeout(() => {
    rejectResult(new Error("Browser authorization timed out."));
    server.close();
  }, callbackTimeoutMilliseconds);
  timeout.unref();
  return {
    close: async () => {
      clearTimeout(timeout);
      await closeServer(server);
    },
    redirectUrl: `http://127.0.0.1:${address.port}/oauth/callback`,
    result,
  };
}

function listenLoopback(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
}

function closeServer(server: Server): Promise<void> {
  if (!server.listening) return Promise.resolve();
  return new Promise((resolve, reject) => {
    server.close((error) => error === undefined ? resolve() : reject(error));
  });
}

function openSystemBrowser(
  url: URL,
  environment: NodeJS.ProcessEnv,
): Promise<void> {
  const configured = environment["ARTIFACT_SERVER_BROWSER_COMMAND"];
  if (configured !== undefined && !path.isAbsolute(configured)) {
    return Promise.reject(new Error(
      "ARTIFACT_SERVER_BROWSER_COMMAND must be an absolute executable path.",
    ));
  }
  const command = configured ?? browserCommand();
  const childArguments = process.platform === "win32" && configured === undefined
    ? ["url.dll,FileProtocolHandler", url.toString()]
    : [url.toString()];
  return new Promise((resolve, reject) => {
    const child = spawn(command, childArguments, {
      detached: configured === undefined,
      env: environment,
      stdio: "ignore",
      windowsHide: true,
    });
    child.once("error", reject);
    child.once("spawn", () => {
      child.unref();
      resolve();
    });
  });
}

function browserCommand(): string {
  switch (process.platform) {
    case "darwin":
      return "/usr/bin/open";
    case "win32":
      return "rundll32.exe";
    default:
      return "xdg-open";
  }
}
