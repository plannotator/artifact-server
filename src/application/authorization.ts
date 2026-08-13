import { Context, Effect, Layer } from "effect";

import { AuthorizationDenied } from "../core/errors.js";
import {
  hasCapability,
  isHumanAdministrator,
  principalCapabilities,
  principalKinds,
  type Principal,
} from "../core/identity.js";
import type { ArtifactRecord } from "../core/model.js";

/** Configuration trusted by standalone authorization policy. */
export interface AuthorizationDependencies {
  readonly installationId: string;
}

/** Persistence filter that follows a principal's standalone artifact read grant. */
export type ArtifactReadScope =
  | {readonly kind: "all"}
  | {readonly kind: "owned"; readonly ownerPrincipalId: string};

/** Authorization decisions shared by every application operation. */
export interface AuthorizationOperations {
  readonly artifactReadScope: (
    principal: Principal,
  ) => Effect.Effect<ArtifactReadScope, AuthorizationDenied>;
  readonly requireArtifactCreation: (
    principal: Principal,
  ) => Effect.Effect<void, AuthorizationDenied>;
  readonly requireArtifactManagement: (
    principal: Principal,
    artifact: ArtifactRecord,
  ) => Effect.Effect<void, AuthorizationDenied>;
  readonly requireArtifactRead: (
    principal: Principal,
    artifact: ArtifactRecord,
  ) => Effect.Effect<void, AuthorizationDenied>;
  readonly requireContentSession: (
    principal: Principal,
    artifact: ArtifactRecord,
  ) => Effect.Effect<void, AuthorizationDenied>;
  readonly requirePublicationPreparation: (
    principal: Principal,
  ) => Effect.Effect<void, AuthorizationDenied>;
  readonly requireVersionPublication: (
    principal: Principal,
    artifact: ArtifactRecord,
  ) => Effect.Effect<void, AuthorizationDenied>;
}

/** Applies installation, membership, ownership, and capability policy. */
export class AuthorizationService extends Context.Service<
  AuthorizationService,
  AuthorizationOperations
>()("artifact-server/application/AuthorizationService") {
  /** Construct standalone policy for one trusted installation. */
  static readonly layer = (
    dependencies: AuthorizationDependencies,
  ): Layer.Layer<AuthorizationService> =>
    Layer.succeed(
      AuthorizationService,
      makeAuthorizationService(dependencies),
    );
}

function makeAuthorizationService(
  dependencies: AuthorizationDependencies,
): AuthorizationOperations {
  const requireInstallation = (
    principal: Principal,
  ): Effect.Effect<void, AuthorizationDenied> =>
    principal.installationId === dependencies.installationId
      ? Effect.void
      : denied();

  const requireArtifactCreation = Effect.fn(
    "AuthorizationService.requireArtifactCreation",
  )(function*(principal: Principal) {
    yield* requireInstallation(principal);
    if (
      principal.kind === principalKinds.human ||
      hasCapability(principal, principalCapabilities.createArtifact)
    ) {
      return;
    }
    yield* denied();
  });

  const artifactReadScope = Effect.fn(
    "AuthorizationService.artifactReadScope",
  )(function*(principal: Principal) {
    yield* requireInstallation(principal);
    if (
      principal.kind === principalKinds.human ||
      hasCapability(principal, principalCapabilities.readArtifacts) ||
      hasCapability(principal, principalCapabilities.manageAnyArtifact)
    ) {
      return {kind: "all"} as const;
    }
    if (hasCapability(principal, principalCapabilities.manageOwnedArtifact)) {
      return {kind: "owned", ownerPrincipalId: principal.id} as const;
    }
    return yield* denied();
  });

  const requireContentSession = Effect.fn(
    "AuthorizationService.requireContentSession",
  )(function*(principal: Principal, _artifact: ArtifactRecord) {
    yield* requireInstallation(principal);
    if (
      principal.kind === principalKinds.human ||
      hasCapability(principal, principalCapabilities.issueContentSession)
    ) {
      return;
    }
    yield* denied();
  });

  const requireArtifactRead = Effect.fn(
    "AuthorizationService.requireArtifactRead",
  )(function*(principal: Principal, artifact: ArtifactRecord) {
    yield* requireInstallation(principal);
    if (
      principal.kind === principalKinds.human ||
      hasCapability(principal, principalCapabilities.readArtifacts) ||
      hasCapability(principal, principalCapabilities.manageAnyArtifact) ||
      (
        principal.id === artifact.ownerPrincipalId &&
        hasCapability(principal, principalCapabilities.manageOwnedArtifact)
      )
    ) {
      return;
    }
    yield* denied();
  });

  const requireArtifactManagement = Effect.fn(
    "AuthorizationService.requireArtifactManagement",
  )(function*(principal: Principal, artifact: ArtifactRecord) {
    yield* requireInstallation(principal);
    if (isHumanAdministrator(principal)) return;
    if (
      principal.kind === principalKinds.human &&
      principal.id === artifact.ownerPrincipalId
    ) {
      return;
    }
    if (
      hasCapability(principal, principalCapabilities.manageAnyArtifact) ||
      (
        principal.id === artifact.ownerPrincipalId &&
        hasCapability(principal, principalCapabilities.manageOwnedArtifact)
      )
    ) {
      return;
    }
    yield* denied();
  });

  const requirePublicationPreparation = Effect.fn(
    "AuthorizationService.requirePublicationPreparation",
  )(function*(principal: Principal) {
    yield* requireInstallation(principal);
    if (
      principal.kind === principalKinds.human ||
      hasCapability(principal, principalCapabilities.createArtifact) ||
      hasCapability(principal, principalCapabilities.publishAnyArtifact) ||
      hasCapability(principal, principalCapabilities.publishOwnedArtifact)
    ) {
      return;
    }
    yield* denied();
  });

  const requireVersionPublication = Effect.fn(
    "AuthorizationService.requireVersionPublication",
  )(function*(principal: Principal, artifact: ArtifactRecord) {
    yield* requireInstallation(principal);
    if (isHumanAdministrator(principal)) return;
    if (
      principal.kind === principalKinds.human &&
      principal.id === artifact.ownerPrincipalId
    ) {
      return;
    }
    if (
      hasCapability(principal, principalCapabilities.publishAnyArtifact) ||
      (
        principal.id === artifact.ownerPrincipalId &&
        hasCapability(principal, principalCapabilities.publishOwnedArtifact)
      )
    ) {
      return;
    }
    yield* denied();
  });

  return AuthorizationService.of({
    artifactReadScope,
    requireArtifactCreation,
    requireArtifactManagement,
    requireArtifactRead,
    requireContentSession,
    requirePublicationPreparation,
    requireVersionPublication,
  });
}

function denied(): Effect.Effect<never, AuthorizationDenied> {
  return Effect.fail(new AuthorizationDenied({
    message: "The authenticated principal is not permitted to perform this operation.",
  }));
}
