import { WorkOS } from "@workos-inc/node";
import { Effect, Redacted } from "effect";

import type {
  InteractiveAuthorization,
  InteractiveIdentityProvider,
} from "../application/interactive-login.js";
import { IdentityProviderFailure } from "../core/errors.js";
import type { ExternalIdentity } from "../core/installation-identity.js";

export interface WorkOsIdentityProviderConfig {
  readonly apiKey: Redacted.Redacted;
  readonly clientId: string;
  readonly redirectUri: string;
}

/** WorkOS AuthKit PKCE adapter for hosted Artifact Server browser login. */
export class WorkOsIdentityProvider implements InteractiveIdentityProvider {
  readonly name = "workos";
  readonly #clientId: string;
  readonly #redirectUri: string;
  readonly #workos: WorkOS;

  constructor(config: WorkOsIdentityProviderConfig) {
    this.#clientId = config.clientId;
    this.#redirectUri = config.redirectUri;
    this.#workos = new WorkOS({
      apiKey: Redacted.value(config.apiKey),
      clientId: config.clientId,
    });
  }

  start(): Effect.Effect<InteractiveAuthorization, IdentityProviderFailure> {
    return Effect.tryPromise({
      try: async () => {
        const authorization = await this.#workos.userManagement
          .getAuthorizationUrlWithPKCE({
            clientId: this.#clientId,
            provider: "authkit",
            redirectUri: this.#redirectUri,
          });
        return {
          authorizationUrl: authorization.url,
          codeVerifier: authorization.codeVerifier,
          state: authorization.state,
        };
      },
      catch: () => providerFailure(),
    });
  }

  complete(
    code: string,
    codeVerifier: string,
  ): Effect.Effect<ExternalIdentity, IdentityProviderFailure> {
    return Effect.tryPromise({
      try: async () => {
        const {user} = await this.#workos.userManagement.authenticateWithCode({
          clientId: this.#clientId,
          code,
          codeVerifier,
        });
        return {
          displayName: displayName(user),
          email: user.email,
          emailVerified: user.emailVerified,
          provider: this.name,
          subject: user.id,
        };
      },
      catch: () => providerFailure(),
    });
  }
}

interface WorkOsUserName {
  readonly email: string;
  readonly firstName: string | null;
  readonly lastName: string | null;
  readonly name: string | null;
}

function displayName(user: WorkOsUserName): string {
  if (user.name !== null && user.name.trim() !== "") return user.name.trim();
  const parts = [user.firstName, user.lastName]
    .filter((part): part is string => part !== null && part.trim() !== "")
    .map((part) => part.trim());
  return parts.length === 0 ? user.email : parts.join(" ");
}

function providerFailure(): IdentityProviderFailure {
  return new IdentityProviderFailure({
    message: "The configured identity provider could not complete browser login.",
  });
}
