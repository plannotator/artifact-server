import { Context, Effect, Layer } from "effect";

import { AuthorizationDenied } from "../core/errors.js";
import {
  hasCapability,
  isDirectHumanPrincipal,
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

/** Authorization decisions shared by every application operation. */
export interface AuthorizationOperations {
  readonly requireAgentConnection: (
    principal: Principal,
  ) => Effect.Effect<void, AuthorizationDenied>;
  readonly requireDispatchSend: (
    principal: Principal,
  ) => Effect.Effect<void, AuthorizationDenied>;
  readonly requireInstallationAdministration: (
    principal: Principal,
  ) => Effect.Effect<void, AuthorizationDenied>;
  readonly requireArtifactListing: (
    principal: Principal,
  ) => Effect.Effect<void, AuthorizationDenied>;
  readonly requireArtifactCreation: (
    principal: Principal,
  ) => Effect.Effect<void, AuthorizationDenied>;
  readonly requireArtifactManagement: (
    principal: Principal,
  ) => Effect.Effect<void, AuthorizationDenied>;
  readonly requireArtifactRead: (
    principal: Principal,
  ) => Effect.Effect<void, AuthorizationDenied>;
  readonly requireCommentRead: (
    principal: Principal,
  ) => Effect.Effect<void, AuthorizationDenied>;
  readonly requireCommentWrite: (
    principal: Principal,
  ) => Effect.Effect<void, AuthorizationDenied>;
  readonly requireContentSession: (
    principal: Principal,
    artifact: ArtifactRecord,
  ) => Effect.Effect<void, AuthorizationDenied>;
  readonly requirePublicationPreparation: (
    principal: Principal,
  ) => Effect.Effect<void, AuthorizationDenied>;
  readonly requireProjectAccess: (
    principal: Principal,
  ) => Effect.Effect<void, AuthorizationDenied>;
  readonly requireProjectManagement: (
    principal: Principal,
  ) => Effect.Effect<void, AuthorizationDenied>;
  readonly requireVersionPublication: (
    principal: Principal,
  ) => Effect.Effect<void, AuthorizationDenied>;
}

/** Applies installation, membership, and capability policy. */
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
      isDirectHumanPrincipal(principal) ||
      hasCapability(principal, principalCapabilities.createArtifact)
    ) {
      return;
    }
    yield* denied();
  });

  // Direct humans are not agents: the registry, claim, and report surface is
  // reserved for service principals holding the agent connection capability.
  const requireAgentConnection = Effect.fn(
    "AuthorizationService.requireAgentConnection",
  )(function*(principal: Principal) {
    yield* requireInstallation(principal);
    if (
      principal.kind === principalKinds.service &&
      hasCapability(principal, principalCapabilities.connectAgents)
    ) {
      return;
    }
    yield* denied();
  });

  // Sending and canceling dispatches stays a human decision in v1; the only
  // service exception is the artifact-management capability.
  const requireDispatchSend = Effect.fn(
    "AuthorizationService.requireDispatchSend",
  )(function*(principal: Principal) {
    yield* requireInstallation(principal);
    if (
      isDirectHumanPrincipal(principal) ||
      hasCapability(principal, principalCapabilities.manageAnyArtifact)
    ) {
      return;
    }
    yield* denied();
  });

  const requireInstallationAdministration = Effect.fn(
    "AuthorizationService.requireInstallationAdministration",
  )(function*(principal: Principal) {
    yield* requireInstallation(principal);
    if (isHumanAdministrator(principal)) return;
    yield* denied();
  });

  const requireArtifactListing = Effect.fn(
    "AuthorizationService.requireArtifactListing",
  )(function*(principal: Principal) {
    yield* requireInstallation(principal);
    if (
      isDirectHumanPrincipal(principal) ||
      hasCapability(principal, principalCapabilities.readArtifacts) ||
      hasCapability(principal, principalCapabilities.manageAnyArtifact)
    ) {
      return;
    }
    yield* denied();
  });

  const requireContentSession = Effect.fn(
    "AuthorizationService.requireContentSession",
  )(function*(principal: Principal, _artifact: ArtifactRecord) {
    yield* requireInstallation(principal);
    if (
      isDirectHumanPrincipal(principal) ||
      hasCapability(principal, principalCapabilities.issueContentSession)
    ) {
      return;
    }
    yield* denied();
  });

  const requireArtifactRead = Effect.fn(
    "AuthorizationService.requireArtifactRead",
  )(function*(principal: Principal) {
    yield* requireInstallation(principal);
    if (
      isDirectHumanPrincipal(principal) ||
      hasCapability(principal, principalCapabilities.readArtifacts) ||
      hasCapability(principal, principalCapabilities.manageAnyArtifact)
    ) {
      return;
    }
    yield* denied();
  });

  const requireCommentRead = Effect.fn(
    "AuthorizationService.requireCommentRead",
  )(function*(principal: Principal) {
    yield* requireInstallation(principal);
    if (
      isDirectHumanPrincipal(principal) ||
      hasCapability(principal, principalCapabilities.readArtifacts) ||
      hasCapability(principal, principalCapabilities.manageAnyArtifact)
    ) {
      return;
    }
    yield* denied();
  });

  const requireCommentWrite = Effect.fn(
    "AuthorizationService.requireCommentWrite",
  )(function*(principal: Principal) {
    yield* requireInstallation(principal);
    if (
      isDirectHumanPrincipal(principal) ||
      hasCapability(principal, principalCapabilities.writeComments)
    ) {
      return;
    }
    yield* denied();
  });

  const requireArtifactManagement = Effect.fn(
    "AuthorizationService.requireArtifactManagement",
  )(function*(principal: Principal) {
    yield* requireInstallation(principal);
    if (isDirectHumanPrincipal(principal)) return;
    if (
      hasCapability(principal, principalCapabilities.manageAnyArtifact)
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
      isDirectHumanPrincipal(principal) ||
      hasCapability(principal, principalCapabilities.createArtifact) ||
      hasCapability(principal, principalCapabilities.publishAnyArtifact)
    ) {
      return;
    }
    yield* denied();
  });

  const requireProjectAccess = Effect.fn(
    "AuthorizationService.requireProjectAccess",
  )(function*(principal: Principal) {
    yield* requireInstallation(principal);
    if (
      isDirectHumanPrincipal(principal) ||
      hasCapability(principal, principalCapabilities.createArtifact) ||
      hasCapability(principal, principalCapabilities.issueContentSession) ||
      hasCapability(principal, principalCapabilities.manageAnyArtifact) ||
      hasCapability(principal, principalCapabilities.manageProjects) ||
      hasCapability(principal, principalCapabilities.publishAnyArtifact) ||
      hasCapability(principal, principalCapabilities.readArtifacts) ||
      hasCapability(principal, principalCapabilities.writeComments)
    ) {
      return;
    }
    yield* denied();
  });

  const requireProjectManagement = Effect.fn(
    "AuthorizationService.requireProjectManagement",
  )(function*(principal: Principal) {
    yield* requireInstallation(principal);
    if (
      isHumanAdministrator(principal) ||
      hasCapability(principal, principalCapabilities.manageProjects)
    ) {
      return;
    }
    yield* denied();
  });

  const requireVersionPublication = Effect.fn(
    "AuthorizationService.requireVersionPublication",
  )(function*(principal: Principal) {
    yield* requireInstallation(principal);
    if (isDirectHumanPrincipal(principal)) return;
    if (
      hasCapability(principal, principalCapabilities.publishAnyArtifact)
    ) {
      return;
    }
    yield* denied();
  });

  return AuthorizationService.of({
    requireAgentConnection,
    requireDispatchSend,
    requireInstallationAdministration,
    requireArtifactListing,
    requireArtifactCreation,
    requireArtifactManagement,
    requireArtifactRead,
    requireCommentRead,
    requireCommentWrite,
    requireContentSession,
    requirePublicationPreparation,
    requireProjectAccess,
    requireProjectManagement,
    requireVersionPublication,
  });
}

function denied(): Effect.Effect<never, AuthorizationDenied> {
  return Effect.fail(new AuthorizationDenied({
    message: "The authenticated principal is not permitted to perform this operation.",
  }));
}
