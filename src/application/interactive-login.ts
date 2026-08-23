import { Context, Effect, Layer } from "effect";

import {
  InteractiveLoginUnavailable,
  LoginAttemptRejected,
} from "../core/errors.js";
import type {
  IdentityAdmissionDenied,
  IdentityConflict,
  IdentityProviderFailure,
  IdentityRepositoryFailure,
} from "../core/errors.js";
import type {
  ExternalIdentity,
  IssuedApplicationSession,
  LoginAttempt,
} from "../core/installation-identity.js";
import {
  digestIdentitySecret,
  identitySecretsEqual,
  InstallationAccessService,
  type InstallationAccessOperations,
} from "./installation-access.js";

export interface InteractiveAuthorization {
  readonly authorizationUrl: string;
  readonly codeVerifier: string;
  readonly nonce: string | null;
  readonly state: string;
}

/** External browser-login provider isolated from Artifact Server policy. */
export interface InteractiveIdentityProvider {
  readonly complete: (
    code: string,
    codeVerifier: string,
    nonce: string | null,
  ) => Effect.Effect<ExternalIdentity, IdentityProviderFailure>;
  readonly name: string;
  readonly start: () => Effect.Effect<InteractiveAuthorization, IdentityProviderFailure>;
}

export interface LoginAttemptRepository {
  readonly consume: (
    stateDigest: string,
    provider: string,
    consumedAt: string,
  ) => Effect.Effect<LoginAttempt, LoginAttemptRejected | IdentityRepositoryFailure>;
  readonly create: (
    attempt: LoginAttempt,
  ) => Effect.Effect<void, IdentityRepositoryFailure>;
}

export interface InteractiveLoginDependencies {
  readonly attemptLifetimeMilliseconds: number;
  readonly clock: {readonly now: () => Date};
  readonly provider: InteractiveIdentityProvider | null;
  readonly repository: LoginAttemptRepository;
}

export interface CompleteInteractiveLoginCommand {
  readonly code: string;
  /** The handshake secret the browser carried back from `/auth/login`. */
  readonly handshake: string | null;
  readonly state: string;
}

/** The authorization redirect plus the handshake that binds it to one browser. */
export interface StartedInteractiveLogin {
  readonly authorizationUrl: string;
  readonly handshake: string;
}

interface InteractiveLoginOperations {
  readonly complete: (
    command: CompleteInteractiveLoginCommand,
  ) => Effect.Effect<
    {readonly issued: IssuedApplicationSession; readonly returnTo: string},
    | IdentityAdmissionDenied
    | IdentityConflict
    | IdentityProviderFailure
    | IdentityRepositoryFailure
    | InteractiveLoginUnavailable
    | LoginAttemptRejected
  >;
  readonly start: (
    returnTo: string,
  ) => Effect.Effect<
    StartedInteractiveLogin,
    IdentityProviderFailure | IdentityRepositoryFailure | InteractiveLoginUnavailable
  >;
}

/** Coordinates PKCE state without granting the provider authorization authority. */
export class InteractiveLoginService extends Context.Service<
  InteractiveLoginService,
  InteractiveLoginOperations
>()("artifact-server/application/InteractiveLoginService") {
  static readonly layer = (
    dependencies: InteractiveLoginDependencies,
  ): Layer.Layer<InteractiveLoginService, never, InstallationAccessService> =>
    Layer.effect(
      InteractiveLoginService,
      InstallationAccessService.use((access) =>
        Effect.succeed(makeInteractiveLoginService(dependencies, access))
      ),
    );
}

function makeInteractiveLoginService(
  dependencies: InteractiveLoginDependencies,
  installationAccess: InstallationAccessOperations,
): InteractiveLoginOperations {
  const start = Effect.fn("InteractiveLoginService.start")(
    function*(returnTo: string) {
      const provider = dependencies.provider;
      if (provider === null) return yield* unavailable();
      const authorization = yield* provider.start();
      const now = dependencies.clock.now();
      yield* dependencies.repository.create({
        codeVerifier: authorization.codeVerifier,
        createdAt: now.toISOString(),
        expiresAt: new Date(
          now.getTime() + dependencies.attemptLifetimeMilliseconds,
        ).toISOString(),
        nonce: authorization.nonce,
        provider: provider.name,
        returnTo: safeReturnTo(returnTo),
        stateDigest: digestIdentitySecret(authorization.state),
      });
      const started: StartedInteractiveLogin = {
        authorizationUrl: authorization.authorizationUrl,
        handshake: authorization.state,
      };
      return started;
    },
  );

  const complete = Effect.fn("InteractiveLoginService.complete")(
    function*(command: CompleteInteractiveLoginCommand) {
      const provider = dependencies.provider;
      if (provider === null) return yield* unavailable();
      if (
        command.handshake === null ||
        !identitySecretsEqual(command.handshake, command.state)
      ) {
        return yield* Effect.fail(new LoginAttemptRejected({
          message:
            "The browser login callback did not come from the browser that started it.",
        }));
      }
      const attempt = yield* dependencies.repository.consume(
        digestIdentitySecret(command.state),
        provider.name,
        dependencies.clock.now().toISOString(),
      );
      const identity = yield* provider.complete(
        command.code,
        attempt.codeVerifier,
        attempt.nonce,
      );
      const issued = yield* installationAccess.completeExternalIdentity(identity);
      return {issued, returnTo: attempt.returnTo};
    },
  );

  return InteractiveLoginService.of({complete, start});
}

function safeReturnTo(value: string): string {
  const fallback = "/api/v1/session";
  if (
    !value.startsWith("/") || value.startsWith("//") ||
    value.includes("\\") || value.length > 1_024 ||
    hasControlCharacter(value)
  ) {
    return fallback;
  }
  try {
    const base = new URL("https://artifactserver.invalid");
    const parsed = new URL(value, base);
    if (parsed.origin !== base.origin) return fallback;
    // Path normalization can resurrect a scheme-relative target: "/..//host"
    // normalizes to the pathname "//host", which browsers resolve off-origin.
    if (!parsed.pathname.startsWith("/") || parsed.pathname.startsWith("//")) {
      return fallback;
    }
    return `${parsed.pathname}${parsed.search}${parsed.hash}`;
  } catch {
    return fallback;
  }
}

function hasControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit < 32 || codeUnit === 127) return true;
  }
  return false;
}

function unavailable(): Effect.Effect<never, InteractiveLoginUnavailable> {
  return Effect.fail(new InteractiveLoginUnavailable({
    message: "Interactive browser login is not configured for this installation.",
  }));
}
