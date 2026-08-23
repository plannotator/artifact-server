/**
 * DOWNSTREAM COPY: Workspaces lifted this stub's protocol core into
 * apps/rooms/e2e-node/fixtures/stub-oidc-provider.ts (their main @ 7321f2ef,
 * 2026-08-18) for wire-level OIDC defect tests. If the protocol core here
 * evolves (discovery/authorize/token/jwks shapes, signing, PKCE handling),
 * ping the workspaces-ops session so the fixture stays in sync.
 */
import {createHash, randomUUID} from "node:crypto";
import {createServer, type IncomingMessage, type Server, type ServerResponse}
  from "node:http";

import {exportJWK, generateKeyPair, SignJWT, type JWTPayload} from "jose";
import {z} from "zod";

import {loginHandshakeCookie} from "./runtime-harness.js";

const discoveryPath = "/.well-known/openid-configuration";
const authorizePath = "/authorize";
const tokenPath = "/token";
const jwksPath = "/jwks";
const signingKeyId = "stub-oidc-signing-key";
const signingAlgorithm = "ES256";
const serverErrorBody = JSON.stringify({error: "server_error"});

const assignedAddressSchema = z.object({port: z.number().int().positive()});
const authorizeQuerySchema = z.object({
  client_id: z.string().min(1),
  code_challenge: z.string().min(1),
  code_challenge_method: z.literal("S256"),
  nonce: z.string().min(1),
  redirect_uri: z.string().min(1),
  response_type: z.literal("code"),
  scope: z.string().min(1),
  state: z.string().min(1),
});
const tokenFormSchema = z.object({
  client_id: z.string().min(1),
  client_secret: z.string().min(1).optional(),
  code: z.string().min(1),
  code_verifier: z.string().min(1),
  grant_type: z.literal("authorization_code"),
  redirect_uri: z.string().min(1),
});

/** One authorization request the stub provider answered. */
export interface StubAuthorizationRequest {
  readonly clientId: string;
  readonly codeChallenge: string;
  readonly nonce: string;
  readonly redirectUri: string;
  readonly scope: string;
  readonly state: string;
}

/** One token request the stub provider accepted after PKCE verification. */
export interface StubTokenRequest {
  readonly clientId: string;
  readonly presentedClientSecret: boolean;
  readonly redirectUri: string;
}

/** Mutable id_token claim knobs applied to the next minted token. */
export interface StubOidcClaims {
  audience: string | null;
  email: string | null;
  emailVerified: boolean | null;
  expiresInSeconds: number;
  familyName: string | null;
  givenName: string | null;
  issuedAtSkewSeconds: number;
  issuer: string | null;
  name: string | null;
  nonce: string | null;
  subject: string;
}

/** Mutable protocol misbehavior knobs for one stub provider. */
export interface StubOidcDefects {
  authorizationEndpoint: string | null;
  discoveryIssuer: string | null;
  discoveryStatus: number;
  jwksUri: string | null;
  signWithForeignKey: boolean;
  stateOverride: string | null;
  tokenEndpoint: string | null;
  tokenStatus: number;
  withoutIdToken: boolean;
}

/** A real OpenID Connect provider process boundary for conformance tests. */
export interface RunningStubOidcProvider {
  readonly claims: StubOidcClaims;
  readonly clientId: string;
  readonly defects: StubOidcDefects;
  readonly issuer: string;
  authorizationRequests(): readonly StubAuthorizationRequest[];
  stop(): Promise<void>;
  tokenRequests(): readonly StubTokenRequest[];
}

export interface StubOidcProviderOptions {
  readonly clientId?: string;
  readonly clientSecret?: string | null;
}

interface IssuedAuthorization {
  readonly codeChallenge: string;
  readonly nonce: string;
  readonly redirectUri: string;
  used: boolean;
}

interface StubTokenOutcome {
  readonly body: string;
  readonly status: number;
}

/** Start one in-process OpenID Connect provider that speaks the real protocol. */
export async function startStubOidcProvider(
  options: StubOidcProviderOptions = {},
): Promise<RunningStubOidcProvider> {
  const clientId = options.clientId ?? "artifact-server-stub-client";
  const clientSecret = options.clientSecret ?? null;
  const signing = await generateKeyPair(signingAlgorithm);
  const foreign = await generateKeyPair(signingAlgorithm);
  const publicJwk = {
    ...await exportJWK(signing.publicKey),
    alg: signingAlgorithm,
    kid: signingKeyId,
    use: "sig",
  };
  const claims: StubOidcClaims = {
    audience: null,
    email: "administrator@example.test",
    emailVerified: null,
    expiresInSeconds: 300,
    familyName: null,
    givenName: null,
    issuedAtSkewSeconds: 0,
    issuer: null,
    name: "Stub Administrator",
    nonce: null,
    subject: "stub-oidc-subject-1",
  };
  const defects: StubOidcDefects = {
    authorizationEndpoint: null,
    discoveryIssuer: null,
    discoveryStatus: 200,
    jwksUri: null,
    signWithForeignKey: false,
    stateOverride: null,
    tokenEndpoint: null,
    tokenStatus: 200,
    withoutIdToken: false,
  };
  const authorizations = new Map<string, IssuedAuthorization>();
  const authorizationRequests: StubAuthorizationRequest[] = [];
  const tokenRequests: StubTokenRequest[] = [];
  let issuer = "";

  const mintToken = async (body: string): Promise<StubTokenOutcome> => {
    const parsed = tokenFormSchema.safeParse(
      Object.fromEntries(new URLSearchParams(body)),
    );
    if (!parsed.success) return failedToken("invalid_request");
    const form = parsed.data;
    const issued = authorizations.get(form.code);
    if (issued === undefined || issued.used) {
      return failedToken("invalid_grant");
    }
    issued.used = true;
    if (
      form.client_id !== clientId ||
      form.redirect_uri !== issued.redirectUri ||
      (clientSecret !== null && form.client_secret !== clientSecret)
    ) {
      return failedToken("invalid_client");
    }
    if (pkceChallenge(form.code_verifier) !== issued.codeChallenge) {
      return failedToken("invalid_grant");
    }
    tokenRequests.push({
      clientId: form.client_id,
      presentedClientSecret: form.client_secret !== undefined,
      redirectUri: form.redirect_uri,
    });
    if (defects.tokenStatus !== 200) {
      return {body: serverErrorBody, status: defects.tokenStatus};
    }
    if (defects.withoutIdToken) {
      return {
        body: JSON.stringify({access_token: "stub-access-token", token_type: "Bearer"}),
        status: 200,
      };
    }
    const idToken = await new SignJWT(
      idTokenPayload(claims, issuer, clientId, issued.nonce),
    )
      .setProtectedHeader({alg: signingAlgorithm, kid: signingKeyId})
      .sign(defects.signWithForeignKey ? foreign.privateKey : signing.privateKey);
    return {
      body: JSON.stringify({
        access_token: "stub-access-token",
        expires_in: 300,
        id_token: idToken,
        token_type: "Bearer",
      }),
      status: 200,
    };
  };

  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", issuer);
    if (request.method === "GET" && url.pathname === discoveryPath) {
      if (defects.discoveryStatus !== 200) {
        response.writeHead(defects.discoveryStatus).end();
        return;
      }
      respondJson(response, 200, JSON.stringify({
        authorization_endpoint: defects.authorizationEndpoint ??
          `${issuer}${authorizePath}`,
        id_token_signing_alg_values_supported: [signingAlgorithm],
        issuer: defects.discoveryIssuer ?? issuer,
        jwks_uri: defects.jwksUri ?? `${issuer}${jwksPath}`,
        response_types_supported: ["code"],
        subject_types_supported: ["public"],
        token_endpoint: defects.tokenEndpoint ?? `${issuer}${tokenPath}`,
      }));
      return;
    }
    if (request.method === "GET" && url.pathname === jwksPath) {
      respondJson(response, 200, JSON.stringify({keys: [publicJwk]}));
      return;
    }
    if (request.method === "GET" && url.pathname === authorizePath) {
      const query = authorizeQuerySchema.safeParse(
        Object.fromEntries(url.searchParams),
      );
      if (!query.success) {
        respondJson(response, 400, JSON.stringify({error: "invalid_request"}));
        return;
      }
      const code = `stub-authorization-code-${randomUUID()}`;
      authorizations.set(code, {
        codeChallenge: query.data.code_challenge,
        nonce: query.data.nonce,
        redirectUri: query.data.redirect_uri,
        used: false,
      });
      authorizationRequests.push({
        clientId: query.data.client_id,
        codeChallenge: query.data.code_challenge,
        nonce: query.data.nonce,
        redirectUri: query.data.redirect_uri,
        scope: query.data.scope,
        state: query.data.state,
      });
      const location = new URL(query.data.redirect_uri);
      location.searchParams.set("code", code);
      location.searchParams.set(
        "state",
        defects.stateOverride ?? query.data.state,
      );
      response.writeHead(302, {Location: location.toString()}).end();
      return;
    }
    if (request.method === "POST" && url.pathname === tokenPath) {
      readRequestBody(request).then(
        (body) =>
          mintToken(body).then(
            (outcome) => respondJson(response, outcome.status, outcome.body),
            () => respondJson(response, 500, serverErrorBody),
          ),
        () => respondJson(response, 500, serverErrorBody),
      );
      return;
    }
    response.writeHead(404).end();
  });
  await listenLoopback(server);
  issuer = `http://127.0.0.1:${assignedAddressSchema.parse(server.address()).port}`;

  return {
    authorizationRequests: () => authorizationRequests,
    claims,
    clientId,
    defects,
    issuer,
    stop: () => closeServer(server),
    tokenRequests: () => tokenRequests,
  };
}

/** Compute the S256 PKCE challenge exactly as a provider verifies it. */
export function pkceChallenge(codeVerifier: string): string {
  return createHash("sha256").update(codeVerifier).digest("base64url");
}

function idTokenPayload(
  claims: StubOidcClaims,
  issuer: string,
  clientId: string,
  requestNonce: string,
): JWTPayload {
  const issuedAt = Math.floor(Date.now() / 1_000) + claims.issuedAtSkewSeconds;
  const payload: JWTPayload = {
    aud: claims.audience ?? clientId,
    exp: issuedAt + claims.expiresInSeconds,
    iat: issuedAt,
    iss: claims.issuer ?? issuer,
    nbf: issuedAt,
    nonce: claims.nonce ?? requestNonce,
    sub: claims.subject,
  };
  if (claims.email !== null) payload["email"] = claims.email;
  if (claims.emailVerified !== null) {
    payload["email_verified"] = claims.emailVerified;
  }
  if (claims.familyName !== null) payload["family_name"] = claims.familyName;
  if (claims.givenName !== null) payload["given_name"] = claims.givenName;
  if (claims.name !== null) payload["name"] = claims.name;
  return payload;
}

function failedToken(error: string): StubTokenOutcome {
  return {body: JSON.stringify({error}), status: 400};
}

function respondJson(
  response: ServerResponse,
  status: number,
  body: string,
): void {
  response.writeHead(status, {
    "Cache-Control": "no-store",
    "Content-Type": "application/json",
  });
  response.end(body);
}

function readRequestBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Uint8Array[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    request.on("error", reject);
  });
}

function listenLoopback(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.closeAllConnections();
    server.close((error) => error === undefined ? resolve() : reject(error));
  });
}

/** One browser authorization leg driven against a running stub provider. */
export interface StubOidcAuthorization {
  readonly authorizationUrl: URL;
  readonly callbackUrl: URL;
  /** `Cookie` header value binding the callback to this browser. */
  readonly handshakeCookie: string;
  readonly loginResponse: Response;
}

/**
 * Follow `/auth/login` to the stub provider and return the callback the browser
 * would visit next, without completing it.
 */
export async function startStubOidcLogin(
  baseUrl: string,
  returnTo: string | null = null,
): Promise<StubOidcAuthorization> {
  const loginUrl = new URL("/auth/login", baseUrl);
  if (returnTo !== null) loginUrl.searchParams.set("returnTo", returnTo);
  const loginResponse = await fetch(loginUrl, {redirect: "manual"});
  const authorizationUrl = redirectTarget(loginResponse, "/auth/login");
  const authorizationResponse = await fetch(authorizationUrl, {
    redirect: "manual",
  });
  return {
    authorizationUrl,
    callbackUrl: redirectTarget(authorizationResponse, "the stub authorization"),
    handshakeCookie: loginHandshakeCookie(loginResponse),
    loginResponse,
  };
}


function redirectTarget(response: Response, step: string): URL {
  const location = response.headers.get("location");
  if (location === null) {
    throw new Error(
      `${step} answered ${response.status} without a redirect location.`,
    );
  }
  return new URL(location);
}
