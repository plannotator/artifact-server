import { Context, type Effect, type Redacted } from "effect";

import type {
  AuthenticationRequired,
  IdentityRepositoryFailure,
} from "../core/errors.js";
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
  | IdentityRepositoryFailure;

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
  ) => Effect.Effect<Principal, AuthenticationFailure>;
}

/** Converts supported credentials once into a provider-neutral principal. */
export class AuthenticationService extends Context.Service<
  AuthenticationService,
  AuthenticationOperations
>()("artifact-server/application/AuthenticationService") {}
