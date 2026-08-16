import { Context, type Effect, type Redacted } from "effect";

import type {
  AuthenticationRequired,
  AuthorizationDenied,
  IdentityAdmissionDenied,
  IdentityConflict,
  IdentityProviderFailure,
  IdentityRepositoryFailure,
} from "../core/errors.js";
import type { ExternalIdentity } from "../core/installation-identity.js";
import type { Principal } from "../core/identity.js";

/** Browser-session verification result required by the HTTP security boundary. */
export interface AuthenticatedApplicationSession {
  readonly csrfDigest: string;
  readonly expiresAt: string;
  readonly principal: Principal;
}

/** Expected failures while converting a credential into a principal. */
export type AuthenticationFailure =
  | AuthenticationRequired
  | AuthorizationDenied
  | IdentityAdmissionDenied
  | IdentityConflict
  | IdentityProviderFailure
  | IdentityRepositoryFailure;

/** Provider-neutral claims verified from one external MCP access token. */
export interface VerifiedExternalMcpBearer {
  readonly clientId: string | null;
  readonly expiresAt: number;
  readonly provider: string;
  readonly scopes: readonly string[];
  readonly subject: string;
}

/** External MCP token verification and first-use identity resolution. */
export interface ExternalMcpBearerVerifier {
  readonly resolveIdentity: (
    verified: VerifiedExternalMcpBearer,
  ) => Effect.Effect<
    ExternalIdentity,
    AuthenticationRequired | IdentityProviderFailure
  >;
  readonly verify: (
    credential: Redacted.Redacted,
  ) => Effect.Effect<
    VerifiedExternalMcpBearer,
    AuthenticationRequired | IdentityProviderFailure
  >;
}

/** Principal and OAuth facts attached to one authenticated MCP request. */
export interface AuthenticatedMcpBearer {
  readonly clientId: string;
  readonly expiresAt: number;
  readonly principal: Principal;
  readonly scopes: readonly string[];
}

/** Credential verification required by provider-neutral authentication. */
export interface BearerCredentialVerifier {
  readonly verify: (
    credential: Redacted.Redacted,
  ) => Effect.Effect<Principal, AuthenticationFailure>;
}

interface AuthenticationOperations {
  readonly authenticateApiBearer: (
    credential: Redacted.Redacted,
  ) => Effect.Effect<Principal, AuthenticationFailure>;
  readonly authenticateApplicationSession: (
    credential: Redacted.Redacted,
  ) => Effect.Effect<AuthenticatedApplicationSession, AuthenticationFailure>;
  readonly authenticateMcpBearer: (
    credential: Redacted.Redacted,
  ) => Effect.Effect<AuthenticatedMcpBearer, AuthenticationFailure>;
}

/** Converts supported credentials once into a provider-neutral principal. */
export class AuthenticationService extends Context.Service<
  AuthenticationService,
  AuthenticationOperations
>()("artifact-server/application/AuthenticationService") {}
