import { Context, DateTime, Effect, Layer, type Redacted } from "effect";

import {
  type ArtifactRepositoryFailure,
  AuthenticationRequired,
  type AuthorizationDenied,
  StagingStorageFailure,
  type ProjectArchived,
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
  type RoutingMode,
  type StagedUpload,
} from "../core/model.js";
import type {
  CreateStagedUpload,
  ExpiredStagedUpload,
  IdGenerator,
  OpenedStagedFile,
  StagedFileWrite,
  StagedUploadGrantRecord,
  StoredBlob,
} from "../core/ports.js";
import { uploadGrantDigestsEqual } from "../core/upload-grant.js";
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
import {
  type ProjectManagementFailure,
  ProjectManagementService,
} from "./project-management.js";

const uploadLifetimeMilliseconds = 60 * 60 * 1_000;

/** Input for creating a principal-bound staged upload. */
export interface CreateStagedUploadCommand {
  readonly entryPath: string;
  readonly files: readonly DeclaredManifestFile[];
  readonly principal: Principal;
  readonly projectId?: string | null;
  readonly routingMode?: RoutingMode;
}

/** Input for streaming one file into a staged upload slot. */
export interface UploadStagedFileCommand {
  readonly body: ReadableStream<Uint8Array>;
  readonly principal: Principal;
  readonly projectId?: string | null;
  readonly storageToken: string;
  readonly uploadId: string;
}

/** Input for streaming one file into a staged upload with its upload grant. */
export interface UploadStagedFileWithGrantCommand {
  readonly body: ReadableStream<Uint8Array>;
  readonly grant: Redacted.Redacted;
  readonly projectId: string | null;
  readonly storageToken: string;
  readonly uploadId: string;
}

/** A staged upload together with the grant that may append its files. */
export interface CreatedStagedUploadWithGrant {
  readonly grant: Redacted.Redacted;
  readonly upload: StagedUpload;
}

/** Issues upload grants and digests presented ones; only digests are stored. */
export interface UploadGrantSecretProvider {
  readonly digest: (token: Redacted.Redacted) => string;
  readonly issue: () => {
    readonly digest: string;
    readonly token: Redacted.Redacted;
  };
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
  readonly projectId?: string | null;
  readonly target: CommitStagedUploadTarget;
  readonly uploadId: string;
}

/** Repository capabilities required by the staged upload lifecycle. */
export interface StagedUploadRepositoryPort {
  createStagedUpload(
    command: CreateStagedUpload,
  ): Effect.Effect<StagedUpload, ArtifactRepositoryFailure | ProjectArchived>;
  findStagedUpload(
    projectId: string,
    uploadId: string,
    principalId: string,
  ): Effect.Effect<StagedUpload | null, ArtifactRepositoryFailure>;
  findStagedUploadGrant(
    uploadId: string,
  ): Effect.Effect<StagedUploadGrantRecord | null, ArtifactRepositoryFailure>;
  markStagedFileUploaded(
    projectId: string,
    uploadId: string,
    principalId: string,
    storageToken: string,
    uploadedAt: string,
  ): Effect.Effect<
    StagedUpload,
    | UploadNotFound
    | UploadClosed
    | UploadFileNotFound
    | UploadExpired
    | ProjectArchived
    | ArtifactRepositoryFailure
  >;
  listExpiredStagedUploads(
    expiredBefore: string,
    limit: number,
  ): Effect.Effect<readonly ExpiredStagedUpload[], ArtifactRepositoryFailure>;
  removeExpiredStagedUpload(
    uploadId: string,
    expiredBefore: string,
  ): Effect.Effect<boolean, ArtifactRepositoryFailure>;
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
  remove(
    uploadId: string,
    storageToken: string,
  ): Effect.Effect<void, StagingStorageFailure>;
}

/** Dependencies used to construct the staged upload application service. */
export interface StagedUploadDependencies {
  readonly clock: ApplicationClock;
  readonly ids: IdGenerator;
  readonly secrets: UploadGrantSecretProvider;
  readonly staging: StagingStoragePort;
  readonly uploads: StagedUploadRepositoryPort;
}

/** Expected failures produced by the staged upload application service. */
export type StagedUploadFailure =
  | AuthenticationRequired
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
  | ProjectManagementFailure
  | AuthorizationDenied;

interface StagedUploadOperations {
  readonly commitUpload: (
    command: CommitStagedUploadCommand,
  ) => Effect.Effect<PublishedVersion, StagedUploadFailure>;
  readonly createUpload: (
    command: CreateStagedUploadCommand,
  ) => Effect.Effect<StagedUpload, StagedUploadFailure>;
  readonly createUploadWithGrant: (
    command: CreateStagedUploadCommand,
  ) => Effect.Effect<CreatedStagedUploadWithGrant, StagedUploadFailure>;
  readonly uploadFile: (
    command: UploadStagedFileCommand,
  ) => Effect.Effect<StagedUpload, StagedUploadFailure>;
  readonly uploadFileWithGrant: (
    command: UploadStagedFileWithGrantCommand,
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
      | ProjectManagementService
  > =>
    Layer.effect(
      StagedUploadService,
      Effect.gen(function*() {
        const authorization = yield* AuthorizationService;
        const publish = yield* PublishArtifactService;
        const projects = yield* ProjectManagementService;
        return makeStagedUploadService(
          dependencies,
          publish,
          authorization,
          projects,
        );
      }),
    );
}

function makeStagedUploadService(
  dependencies: StagedUploadDependencies,
  publish: PublishArtifactService["Service"],
  authorization: AuthorizationOperations,
  projects: ProjectManagementService["Service"],
): StagedUploadOperations {
  const requiredUpload = Effect.fn("StagedUploadService.requiredUpload")(
    function*(projectId: string, uploadId: string, principalId: string) {
      const upload = yield* dependencies.uploads.findStagedUpload(
        projectId,
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

  const create = Effect.fn("StagedUploadService.create")(
    function*(
    command: CreateStagedUploadCommand,
    grantDigest: string | null,
  ): Effect.fn.Return<StagedUpload, StagedUploadFailure> {
      yield* authorization.requirePublicationPreparation(command.principal);
      const project = yield* projects.resolveActiveProject({
        principal: command.principal,
        projectId: command.projectId ?? null,
      });
      const manifest = yield* parseManifest({
        entryPath: command.entryPath,
        files: command.files,
        routingMode: command.routingMode ?? "static",
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
        grantDigest,
        id: dependencies.ids.uploadId(),
        manifest,
        principalId: command.principal.id,
        projectId: project.id,
      });
    },
  );

  const createUpload = Effect.fn("StagedUploadService.createUpload")(
    function*(
    command: CreateStagedUploadCommand,
  ): Effect.fn.Return<StagedUpload, StagedUploadFailure> {
      return yield* create(command, null);
    },
  );

  const createUploadWithGrant = Effect.fn(
    "StagedUploadService.createUploadWithGrant",
  )(function*(
    command: CreateStagedUploadCommand,
  ): Effect.fn.Return<CreatedStagedUploadWithGrant, StagedUploadFailure> {
    const issued = dependencies.secrets.issue();
    const upload = yield* create(command, issued.digest);
    return {grant: issued.token, upload};
  });

  const storeFile = Effect.fn("StagedUploadService.storeFile")(
    function*(
    upload: StagedUpload,
    principalId: string,
    projectId: string,
    storageToken: string,
    body: ReadableStream<Uint8Array>,
  ): Effect.fn.Return<StagedUpload, StagedUploadFailure> {
      const uploadStartedAt = yield* dependencies.clock.now;
      yield* ensureUploadAcceptsFiles(upload, uploadStartedAt);
      const file = upload.files.find(
        (candidate) => candidate.storageToken === storageToken,
      );
      if (file === undefined) {
        return yield* new UploadFileNotFound({
          message: "The staged upload file does not exist.",
        });
      }

      const signal = abortSignalUntil(upload.expiresAt, uploadStartedAt);
      yield* dependencies.staging.put({
        body,
        sha256: file.entry.sha256,
        signal,
        size: file.entry.size,
        storageToken: file.storageToken,
        uploadId: upload.id,
      }).pipe(Effect.catch((error) => Effect.fail(signal.aborted
        ? new UploadExpired({message: "The staged upload has expired."})
        : error)));
      const uploadedAt = DateTime.formatIso(yield* dependencies.clock.now);
      return yield* dependencies.uploads.markStagedFileUploaded(
        projectId,
        upload.id,
        principalId,
        file.storageToken,
        uploadedAt,
      );
    },
  );

  const uploadFile = Effect.fn("StagedUploadService.uploadFile")(
    function*(
    command: UploadStagedFileCommand,
  ): Effect.fn.Return<StagedUpload, StagedUploadFailure> {
      yield* authorization.requirePublicationPreparation(command.principal);
      const project = yield* projects.resolveActiveProject({
        principal: command.principal,
        projectId: command.projectId ?? null,
      });
      const upload = yield* requiredUpload(
        project.id,
        command.uploadId,
        command.principal.id,
      );
      return yield* storeFile(
        upload,
        command.principal.id,
        project.id,
        command.storageToken,
        command.body,
      );
    },
  );

  const uploadFileWithGrant = Effect.fn(
    "StagedUploadService.uploadFileWithGrant",
  )(function*(
    command: UploadStagedFileWithGrantCommand,
  ): Effect.fn.Return<StagedUpload, StagedUploadFailure> {
    // Permission was checked when the grant was issued and is checked again
    // at commit; the grant itself only lets the declared bytes in.
    const record = yield* dependencies.uploads.findStagedUploadGrant(
      command.uploadId,
    );
    if (
      record === null
      || record.grantDigest === null
      || !uploadGrantDigestsEqual(
        dependencies.secrets.digest(command.grant),
        record.grantDigest,
      )
      || (command.projectId !== null && command.projectId !== record.projectId)
    ) {
      return yield* new AuthenticationRequired({
        message: "A valid upload grant is required.",
      });
    }
    const upload = yield* requiredUpload(
      record.projectId,
      command.uploadId,
      record.principalId,
    );
    return yield* storeFile(
      upload,
      record.principalId,
      record.projectId,
      command.storageToken,
      command.body,
    );
  });

  const publicationSource = (
    upload: StagedUpload,
    file: StagedUpload["files"][number],
    signal: AbortSignal | undefined,
  ): PublicationFileSource => {
    const source = {
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
    };
    return signal === undefined ? source : {...source, signal};
  };

  const commitUpload = Effect.fn("StagedUploadService.commitUpload")(
    function*(
    command: CommitStagedUploadCommand,
  ): Effect.fn.Return<PublishedVersion, StagedUploadFailure> {
      yield* authorization.requirePublicationPreparation(command.principal);
      // An explicit project can be archived after a successful commit. Let the
      // repository replay that exact idempotent result; it still rejects every
      // genuinely new publication into the archived project.
      const project = command.projectId === undefined || command.projectId === null
        ? yield* projects.resolveActiveProject({
          principal: command.principal,
          projectId: null,
        })
        : yield* projects.getProject({
          principal: command.principal,
          projectId: command.projectId,
        });
      const upload = yield* requiredUpload(
        project.id,
        command.uploadId,
        command.principal.id,
      );
      const commitStartedAt = yield* dependencies.clock.now;
      const signal = upload.status === uploadStatuses.open
        ? abortSignalUntil(upload.expiresAt, commitStartedAt)
        : undefined;
      if (upload.status === uploadStatuses.open) {
        yield* ensureUploadNotExpired(upload, commitStartedAt);
      }
      if (upload.files.some((file) => file.uploadedAt === null)) {
        return yield* new UploadIncomplete({
          message: "Every declared upload file must be verified before commit.",
        });
      }
      const files = upload.files.map((file) =>
        publicationSource(upload, file, signal));
      const source = {
        kind: "staged_upload" as const,
        principalId: command.principal.id,
        projectId: project.id,
        uploadId: upload.id,
      };
      switch (command.target.kind) {
        case "new_artifact":
          return yield* expirePublicationAtDeadline(signal,
            publish.publishPreparedNew({
            accessSetting: command.target.accessSetting,
            files,
            idempotencyKey: command.idempotencyKey,
            manifest: upload.manifest,
            name: command.target.name,
            principal: command.principal,
            projectId: project.id,
            source,
            tags: command.target.tags ?? [],
            }));
        case "new_version":
          return yield* expirePublicationAtDeadline(signal,
            publish.publishPreparedVersion({
            artifactId: command.target.artifactId,
            expectedCurrentVersionId: command.target.expectedCurrentVersionId,
            files,
            idempotencyKey: command.idempotencyKey,
            manifest: upload.manifest,
            principal: command.principal,
            projectId: project.id,
            source,
            }));
      }
      return yield* Effect.die(
        new Error(
          `Unreachable staged upload target: ${String(command.target)}`,
        ),
      );
    },
  );

  return StagedUploadService.of({
    commitUpload,
    createUpload,
    createUploadWithGrant,
    uploadFile,
    uploadFileWithGrant,
  });
}

function abortSignalUntil(expiresAt: string, now: DateTime.Utc): AbortSignal {
  const remainingMilliseconds = Math.max(
    1,
    Date.parse(expiresAt) - DateTime.toEpochMillis(now),
  );
  return AbortSignal.timeout(remainingMilliseconds);
}

function expirePublicationAtDeadline<A, E>(
  signal: AbortSignal | undefined,
  effect: Effect.Effect<A, E>,
): Effect.Effect<A, E | UploadExpired> {
  return effect.pipe(Effect.catch((error) => Effect.fail(
    signal?.aborted === true
      ? new UploadExpired({message: "The staged upload has expired."})
      : error,
  )));
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
