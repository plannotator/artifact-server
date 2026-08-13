import { Context, DateTime, Effect, Layer } from "effect";

import {
  type ArtifactRepositoryFailure,
  type AuthorizationDenied,
  StagingStorageFailure,
  UploadClosed,
  UploadExpired,
  UploadFileNotFound,
  UploadIncomplete,
  UploadNotFound,
  type UploadedFileMismatch,
} from "../core/errors.js";
import type { Principal } from "../core/identity.js";
import {
  uploadStatuses,
  type AccessSetting,
  type PublishedVersion,
  type StagedUpload,
} from "../core/model.js";
import type {
  CreateStagedUpload,
  IdGenerator,
  OpenedStagedFile,
  StagedFileWrite,
  StoredBlob,
} from "../core/ports.js";
import type { DeclaredManifestFile } from "../manifest/create-manifest.js";
import {
  type PublicationFileSource,
  type PublishArtifactFailure,
  PublishArtifactService,
} from "./publish-artifact.js";
import type { ApplicationClock } from "./application-clock.js";
import {type ManifestFailure, parseManifest} from "./parse-manifest.js";
import {
  type AuthorizationOperations,
  AuthorizationService,
} from "./authorization.js";

const uploadLifetimeMilliseconds = 60 * 60 * 1_000;

/** Input for creating a principal-bound staged upload. */
export interface CreateStagedUploadCommand {
  readonly entryPath: string;
  readonly files: readonly DeclaredManifestFile[];
  readonly principal: Principal;
}

/** Input for streaming one file into a staged upload slot. */
export interface UploadStagedFileCommand {
  readonly body: ReadableStream<Uint8Array>;
  readonly principal: Principal;
  readonly storageToken: string;
  readonly uploadId: string;
}

/** Publication target selected when committing a staged upload. */
export type CommitStagedUploadTarget =
  | {
    readonly accessSetting: AccessSetting;
    readonly kind: "new_artifact";
    readonly name: string;
    readonly tags?: readonly string[];
  }
  | {
    readonly artifactId: string;
    readonly expectedCurrentVersionId: string;
    readonly kind: "new_version";
  };

/** Input for committing a complete staged upload. */
export interface CommitStagedUploadCommand {
  readonly idempotencyKey: string;
  readonly principal: Principal;
  readonly target: CommitStagedUploadTarget;
  readonly uploadId: string;
}

/** Repository capabilities required by the staged upload lifecycle. */
export interface StagedUploadRepositoryPort {
  createStagedUpload(
    command: CreateStagedUpload,
  ): Effect.Effect<StagedUpload, ArtifactRepositoryFailure>;
  findStagedUpload(
    uploadId: string,
    principalId: string,
  ): Effect.Effect<StagedUpload | null, ArtifactRepositoryFailure>;
  markStagedFileUploaded(
    uploadId: string,
    principalId: string,
    storageToken: string,
    uploadedAt: string,
  ): Effect.Effect<
    StagedUpload,
    | UploadNotFound
    | UploadClosed
    | UploadFileNotFound
    | ArtifactRepositoryFailure
  >;
}

/** Staging storage capabilities required before immutable publication. */
export interface StagingStoragePort {
  open(
    uploadId: string,
    storageToken: string,
  ): Effect.Effect<OpenedStagedFile, StagingStorageFailure>;
  put(
    write: StagedFileWrite,
  ): Effect.Effect<StoredBlob, UploadedFileMismatch | StagingStorageFailure>;
}

/** Dependencies used to construct the staged upload application service. */
export interface StagedUploadDependencies {
  readonly clock: ApplicationClock;
  readonly ids: IdGenerator;
  readonly staging: StagingStoragePort;
  readonly uploads: StagedUploadRepositoryPort;
}

/** Expected failures produced by the staged upload application service. */
export type StagedUploadFailure =
  | ManifestFailure
  | UploadNotFound
  | UploadClosed
  | UploadExpired
  | UploadFileNotFound
  | UploadIncomplete
  | UploadedFileMismatch
  | ArtifactRepositoryFailure
  | StagingStorageFailure
  | PublishArtifactFailure
  | AuthorizationDenied;

interface StagedUploadOperations {
  readonly commitUpload: (
    command: CommitStagedUploadCommand,
  ) => Effect.Effect<PublishedVersion, StagedUploadFailure>;
  readonly createUpload: (
    command: CreateStagedUploadCommand,
  ) => Effect.Effect<StagedUpload, StagedUploadFailure>;
  readonly uploadFile: (
    command: UploadStagedFileCommand,
  ) => Effect.Effect<StagedUpload, StagedUploadFailure>;
}

/** Owns the principal-bound upload lifecycle before immutable publication. */
export class StagedUploadService extends Context.Service<
  StagedUploadService,
  StagedUploadOperations
>()("artifact-server/application/StagedUploadService") {
  /** Construct the service using the shared publication service and staged ports. */
  static readonly layer = (
    dependencies: StagedUploadDependencies,
  ): Layer.Layer<
    StagedUploadService,
    never,
    PublishArtifactService | AuthorizationService
  > =>
    Layer.effect(
      StagedUploadService,
      Effect.gen(function*() {
        const authorization = yield* AuthorizationService;
        const publish = yield* PublishArtifactService;
        return makeStagedUploadService(dependencies, publish, authorization);
      }),
    );
}

function makeStagedUploadService(
  dependencies: StagedUploadDependencies,
  publish: PublishArtifactService["Service"],
  authorization: AuthorizationOperations,
): StagedUploadOperations {
  const requiredUpload = Effect.fn("StagedUploadService.requiredUpload")(
    function*(uploadId: string, principalId: string) {
      const upload = yield* dependencies.uploads.findStagedUpload(
        uploadId,
        principalId,
      );
      if (upload === null) {
        return yield* new UploadNotFound({
          message: "The staged upload does not exist.",
        });
      }
      return upload;
    },
  );

  const createUpload = Effect.fn("StagedUploadService.createUpload")(
    function*(
    command: CreateStagedUploadCommand,
  ): Effect.fn.Return<StagedUpload, StagedUploadFailure> {
      yield* authorization.requirePublicationPreparation(command.principal);
      const manifest = yield* parseManifest({
        entryPath: command.entryPath,
        files: command.files,
        routingMode: "static",
      });
      const created = yield* dependencies.clock.now;
      return yield* dependencies.uploads.createStagedUpload({
        createdAt: DateTime.formatIso(created),
        expiresAt: DateTime.formatIso(
          DateTime.addDuration(created, uploadLifetimeMilliseconds),
        ),
        files: manifest.entries.map((entry) => ({
          entry,
          storageToken: dependencies.ids.stagedFileToken(),
        })),
        id: dependencies.ids.uploadId(),
        manifest,
        principalId: command.principal.id,
      });
    },
  );

  const uploadFile = Effect.fn("StagedUploadService.uploadFile")(
    function*(
    command: UploadStagedFileCommand,
  ): Effect.fn.Return<StagedUpload, StagedUploadFailure> {
      yield* authorization.requirePublicationPreparation(command.principal);
      const upload = yield* requiredUpload(command.uploadId, command.principal.id);
      yield* ensureUploadAcceptsFiles(upload, yield* dependencies.clock.now);
      const file = upload.files.find(
        (candidate) => candidate.storageToken === command.storageToken,
      );
      if (file === undefined) {
        return yield* new UploadFileNotFound({
          message: "The staged upload file does not exist.",
        });
      }

      yield* dependencies.staging.put({
        body: command.body,
        sha256: file.entry.sha256,
        size: file.entry.size,
        storageToken: file.storageToken,
        uploadId: upload.id,
      });
      const uploadedAt = DateTime.formatIso(yield* dependencies.clock.now);
      return yield* dependencies.uploads.markStagedFileUploaded(
        upload.id,
        command.principal.id,
        file.storageToken,
        uploadedAt,
      );
    },
  );

  const publicationSource = (
    upload: StagedUpload,
    file: StagedUpload["files"][number],
  ): PublicationFileSource => ({
    open: Effect.fn("StagedUploadService.openPublicationSource")(
      function*(): Effect.fn.Return<
        ReadableStream<Uint8Array>,
        StagingStorageFailure
      > {
        const opened = yield* dependencies.staging.open(
          upload.id,
          file.storageToken,
        );
        if (opened.size !== file.entry.size) {
          yield* Effect.tryPromise({
            try: () => opened.body.cancel(),
            catch: (cause) =>
              new StagingStorageFailure({cause, operation: "open"}),
          });
          return yield* new StagingStorageFailure({
            cause: new Error(
              "A verified staged file changed before publication.",
            ),
            operation: "open",
          });
        }
        return opened.body;
      },
    ),
    path: file.entry.path,
    sha256: file.entry.sha256,
    size: file.entry.size,
  });

  const commitUpload = Effect.fn("StagedUploadService.commitUpload")(
    function*(
    command: CommitStagedUploadCommand,
  ): Effect.fn.Return<PublishedVersion, StagedUploadFailure> {
      yield* authorization.requirePublicationPreparation(command.principal);
      const upload = yield* requiredUpload(command.uploadId, command.principal.id);
      if (upload.status === uploadStatuses.open) {
        yield* ensureUploadNotExpired(upload, yield* dependencies.clock.now);
      }
      if (upload.files.some((file) => file.uploadedAt === null)) {
        return yield* new UploadIncomplete({
          message: "Every declared upload file must be verified before commit.",
        });
      }
      const files = upload.files.map((file) => publicationSource(upload, file));
      const source = {
        kind: "staged_upload" as const,
        principalId: command.principal.id,
        uploadId: upload.id,
      };
      switch (command.target.kind) {
        case "new_artifact":
          return yield* publish.publishPreparedNew({
            accessSetting: command.target.accessSetting,
            files,
            idempotencyKey: command.idempotencyKey,
            manifest: upload.manifest,
            name: command.target.name,
            principal: command.principal,
            source,
            tags: command.target.tags ?? [],
          });
        case "new_version":
          return yield* publish.publishPreparedVersion({
            artifactId: command.target.artifactId,
            expectedCurrentVersionId: command.target.expectedCurrentVersionId,
            files,
            idempotencyKey: command.idempotencyKey,
            manifest: upload.manifest,
            principal: command.principal,
            source,
          });
      }
      return yield* Effect.die(
        new Error(
          `Unreachable staged upload target: ${String(command.target)}`,
        ),
      );
    },
  );

  return StagedUploadService.of({commitUpload, createUpload, uploadFile});
}

function ensureUploadAcceptsFiles(
  upload: StagedUpload,
  now: DateTime.Utc,
): Effect.Effect<void, UploadClosed | UploadExpired> {
  if (upload.status !== uploadStatuses.open) {
    return new UploadClosed({
      message: "The staged upload is already committed.",
    });
  }
  return ensureUploadNotExpired(upload, now);
}

function ensureUploadNotExpired(
  upload: StagedUpload,
  now: DateTime.Utc,
): Effect.Effect<void, UploadExpired> {
  const expiresAt = DateTime.makeUnsafe(upload.expiresAt);
  return DateTime.isLessThanOrEqualTo(expiresAt, now)
    ? new UploadExpired({message: "The staged upload has expired."})
    : Effect.void;
}
