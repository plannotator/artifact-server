import { createHash } from "node:crypto";

import { Context, DateTime, Effect, Layer } from "effect";

import type { ApplicationClock } from "./application-clock.js";
import {
  type AuthorizationOperations,
  AuthorizationService,
} from "./authorization.js";
import { parseIdempotencyKey } from "./idempotency-key.js";
import {
  ArtifactNotFound,
  type ArtifactMutationConflict,
  type ArtifactRepositoryFailure,
  type AuthorizationDenied,
  type IdempotencyConflict,
  type InvalidIdempotencyKey,
  VersionNotFound,
} from "../core/errors.js";
import type { Principal } from "../core/identity.js";
import type {
  AccessSetting,
  ArtifactRecord,
  ArtifactState,
  ArtifactVersion,
  VersionRecord,
} from "../core/model.js";
import type {
  ChangeArtifactAccessSetting,
  RestoreArtifactVersion,
} from "../core/ports.js";

/** One artifact and the complete record for its current saved version. */
export interface ArtifactDetails {
  readonly artifact: ArtifactRecord;
  readonly current: ArtifactVersion;
}

/** Input for reading one artifact through authenticated application policy. */
export interface ReadArtifactCommand {
  readonly artifactId: string;
  readonly principal: Principal;
}

/** Input for reading one exact saved version. */
export interface ReadArtifactVersionCommand extends ReadArtifactCommand {
  readonly versionId: string;
}

/** Input for restoring one existing saved version as the current version. */
export interface RestoreArtifactVersionCommand extends ReadArtifactVersionCommand {
  readonly expectedCurrentVersionId: string;
  readonly idempotencyKey: string;
}

/** Input for changing one artifact's read setting. */
export interface ChangeArtifactAccessCommand extends ReadArtifactCommand {
  readonly accessSetting: AccessSetting;
  readonly expectedCurrentVersionId: string;
  readonly idempotencyKey: string;
}

/** Repository capabilities required by artifact management. */
export interface ArtifactManagementRepository {
  readonly changeAccessSetting: (
    command: ChangeArtifactAccessSetting,
  ) => Effect.Effect<
    ArtifactState,
    | ArtifactMutationConflict
    | ArtifactNotFound
    | IdempotencyConflict
    | ArtifactRepositoryFailure
  >;
  readonly findArtifact: (
    artifactId: string,
  ) => Effect.Effect<ArtifactRecord | null, ArtifactRepositoryFailure>;
  readonly findArtifactVersion: (
    artifactId: string,
    versionId: string,
  ) => Effect.Effect<ArtifactVersion | null, ArtifactRepositoryFailure>;
  readonly listArtifactVersions: (
    artifactId: string,
  ) => Effect.Effect<readonly VersionRecord[], ArtifactRepositoryFailure>;
  readonly restoreVersion: (
    command: RestoreArtifactVersion,
  ) => Effect.Effect<
    ArtifactState,
    | ArtifactMutationConflict
    | ArtifactNotFound
    | IdempotencyConflict
    | VersionNotFound
    | ArtifactRepositoryFailure
  >;
}

/** Dependencies used to construct artifact management operations. */
export interface ArtifactManagementDependencies {
  readonly clock: ApplicationClock;
  readonly repository: ArtifactManagementRepository;
}

/** Expected failures produced by artifact management. */
export type ArtifactManagementFailure =
  | ArtifactNotFound
  | VersionNotFound
  | ArtifactMutationConflict
  | IdempotencyConflict
  | InvalidIdempotencyKey
  | AuthorizationDenied
  | ArtifactRepositoryFailure;

interface ArtifactManagementOperations {
  readonly changeAccess: (
    command: ChangeArtifactAccessCommand,
  ) => Effect.Effect<ArtifactState, ArtifactManagementFailure>;
  readonly getArtifact: (
    command: ReadArtifactCommand,
  ) => Effect.Effect<ArtifactDetails, ArtifactManagementFailure>;
  readonly getVersion: (
    command: ReadArtifactVersionCommand,
  ) => Effect.Effect<ArtifactVersion, ArtifactManagementFailure>;
  readonly listVersions: (
    command: ReadArtifactCommand,
  ) => Effect.Effect<readonly VersionRecord[], ArtifactManagementFailure>;
  readonly restoreVersion: (
    command: RestoreArtifactVersionCommand,
  ) => Effect.Effect<ArtifactState, ArtifactManagementFailure>;
}

/** Reads and mutates artifact metadata without changing committed versions. */
export class ArtifactManagementService extends Context.Service<
  ArtifactManagementService,
  ArtifactManagementOperations
>()("artifact-server/application/ArtifactManagementService") {
  /** Construct artifact management from deployment-neutral persistence. */
  static readonly layer = (
    dependencies: ArtifactManagementDependencies,
  ): Layer.Layer<ArtifactManagementService, never, AuthorizationService> =>
    Layer.effect(
      ArtifactManagementService,
      Effect.gen(function*() {
        const authorization = yield* AuthorizationService;
        return makeArtifactManagementService(dependencies, authorization);
      }),
    );
}

function makeArtifactManagementService(
  dependencies: ArtifactManagementDependencies,
  authorization: AuthorizationOperations,
): ArtifactManagementOperations {
  const requireArtifact = Effect.fn("ArtifactManagementService.requireArtifact")(
    function*(artifactId: string): Effect.fn.Return<
      ArtifactRecord,
      ArtifactNotFound | ArtifactRepositoryFailure
    > {
      const artifact = yield* dependencies.repository.findArtifact(artifactId);
      if (artifact !== null) return artifact;
      return yield* new ArtifactNotFound({message: "The artifact does not exist."});
    },
  );

  const requireVersion = Effect.fn("ArtifactManagementService.requireVersion")(
    function*(
      artifactId: string,
      versionId: string,
    ): Effect.fn.Return<ArtifactVersion, VersionNotFound | ArtifactRepositoryFailure> {
      const version = yield* dependencies.repository.findArtifactVersion(
        artifactId,
        versionId,
      );
      if (version !== null) return version;
      return yield* new VersionNotFound({
        message: "The saved version does not exist on this artifact.",
      });
    },
  );

  const getArtifact = Effect.fn("ArtifactManagementService.getArtifact")(
    function*(command: ReadArtifactCommand) {
      const artifact = yield* requireArtifact(command.artifactId);
      yield* authorization.requireArtifactRead(command.principal, artifact);
      const current = yield* requireVersion(
        artifact.id,
        artifact.currentVersionId,
      );
      return {artifact, current};
    },
  );

  const getVersion = Effect.fn("ArtifactManagementService.getVersion")(
    function*(command: ReadArtifactVersionCommand) {
      const artifact = yield* requireArtifact(command.artifactId);
      yield* authorization.requireArtifactRead(command.principal, artifact);
      return yield* requireVersion(artifact.id, command.versionId);
    },
  );

  const listVersions = Effect.fn("ArtifactManagementService.listVersions")(
    function*(command: ReadArtifactCommand) {
      const artifact = yield* requireArtifact(command.artifactId);
      yield* authorization.requireArtifactRead(command.principal, artifact);
      return yield* dependencies.repository.listArtifactVersions(artifact.id);
    },
  );

  const restoreVersion = Effect.fn("ArtifactManagementService.restoreVersion")(
    function*(command: RestoreArtifactVersionCommand) {
      const artifact = yield* requireArtifact(command.artifactId);
      yield* authorization.requireArtifactManagement(command.principal, artifact);
      yield* requireVersion(artifact.id, command.versionId);
      const idempotencyKey = yield* parseIdempotencyKey(command.idempotencyKey);
      const createdAt = DateTime.formatIso(yield* dependencies.clock.now);
      return yield* dependencies.repository.restoreVersion({
        artifactId: artifact.id,
        authorizedByPrincipalId: command.principal.authorizedByPrincipalId,
        createdAt,
        expectedCurrentVersionId: command.expectedCurrentVersionId,
        idempotencyKey,
        inputDigest: managementInputDigest({
          artifactId: artifact.id,
          expectedCurrentVersionId: command.expectedCurrentVersionId,
          operation: "restore",
          principalId: command.principal.id,
          value: command.versionId,
        }),
        principalId: command.principal.id,
        versionId: command.versionId,
      });
    },
  );

  const changeAccess = Effect.fn("ArtifactManagementService.changeAccess")(
    function*(command: ChangeArtifactAccessCommand) {
      const artifact = yield* requireArtifact(command.artifactId);
      yield* authorization.requireArtifactManagement(command.principal, artifact);
      const idempotencyKey = yield* parseIdempotencyKey(command.idempotencyKey);
      const createdAt = DateTime.formatIso(yield* dependencies.clock.now);
      return yield* dependencies.repository.changeAccessSetting({
        accessSetting: command.accessSetting,
        artifactId: artifact.id,
        authorizedByPrincipalId: command.principal.authorizedByPrincipalId,
        createdAt,
        expectedCurrentVersionId: command.expectedCurrentVersionId,
        idempotencyKey,
        inputDigest: managementInputDigest({
          artifactId: artifact.id,
          expectedCurrentVersionId: command.expectedCurrentVersionId,
          operation: "change_access",
          principalId: command.principal.id,
          value: command.accessSetting,
        }),
        principalId: command.principal.id,
      });
    },
  );

  return ArtifactManagementService.of({
    changeAccess,
    getArtifact,
    getVersion,
    listVersions,
    restoreVersion,
  });
}

interface ManagementInputDigest {
  readonly artifactId: string;
  readonly expectedCurrentVersionId: string;
  readonly operation: "change_access" | "restore";
  readonly principalId: string;
  readonly value: string;
}

function managementInputDigest(input: ManagementInputDigest): string {
  return createHash("sha256").update(JSON.stringify(input)).digest("hex");
}
