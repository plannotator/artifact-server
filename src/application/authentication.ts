import { Context, Layer, type Effect, type Redacted } from "effect";

import type { AuthenticationRequired } from "../core/errors.js";
import type { Principal } from "../core/identity.js";

/** Credential verification required by provider-neutral authentication. */
export interface BearerCredentialVerifier {
  readonly verify: (
    credential: Redacted.Redacted,
  ) => Effect.Effect<Principal, AuthenticationRequired>;
}

/** Dependencies used to construct authentication. */
export interface AuthenticationDependencies {
  readonly bearerCredentials: BearerCredentialVerifier;
}

interface AuthenticationOperations {
  readonly authenticateBearer: (
    credential: Redacted.Redacted,
  ) => Effect.Effect<Principal, AuthenticationRequired>;
}

/** Converts supported credentials once into a provider-neutral principal. */
export class AuthenticationService extends Context.Service<
  AuthenticationService,
  AuthenticationOperations
>()("artifact-server/application/AuthenticationService") {
  /** Construct authentication from deployment-specific credential verification. */
  static readonly layer = (
    dependencies: AuthenticationDependencies,
  ): Layer.Layer<AuthenticationService> =>
    Layer.succeed(AuthenticationService, AuthenticationService.of({
      authenticateBearer: dependencies.bearerCredentials.verify,
    }));
}
