import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

import { DateTime, Effect, Layer, Redacted } from "effect";

import { AuthenticationService } from "../application/authentication.js";
import { AuthorizationService } from "../application/authorization.js";
import {
  type ContentAccessDependencies,
  ContentAccessService,
} from "../application/content-access.js";

import {
  type PublishArtifactDependencies,
  PublishArtifactService,
} from "../application/publish-artifact.js";
import {
  type StagedUploadDependencies,
  StagedUploadService,
} from "../application/staged-upload.js";
import {
  ArtifactNotFound,
  ArtifactRepositoryFailure,
  AuthenticationRequired,
  BlobStorageFailure,
  IdempotencyConflict,
  PublishConflict,
  StagingStorageFailure,
  UploadClosed,
  UploadExpired,
  UploadFileNotFound,
  UploadIncomplete,
  UploadNotFound,
  UploadedFileMismatch,
} from "../core/errors.js";
import {
  membershipRoles,
  principalCapabilities,
  principalKinds,
  type Principal,
} from "../core/identity.js";
import type {
  BlobStore,
  Clock,
  IdGenerator,
  StagingStore,
} from "../core/ports.js";
import { FileVerificationError } from "../storage/verified-file.js";
import type { SqliteArtifactRepository } from "../storage/sqlite-artifact-repository.js";

/** Concrete local adapters reused by the Effect application layer. */
export interface LocalApplicationAdapters {
  readonly apiToken: Redacted.Redacted;
  readonly blobs: BlobStore;
  readonly clock: Clock;
  readonly ids: IdGenerator;
  readonly installationId: string;
  readonly repository: SqliteArtifactRepository;
  readonly staging: StagingStore;
}

/** Build the local publication services without changing their storage adapters. */
export function createLocalApplicationLayer(
  adapters: LocalApplicationAdapters,
): Layer.Layer<
  | AuthenticationService
  | AuthorizationService
  | ContentAccessService
  | PublishArtifactService
  | StagedUploadService
> {
  const clock = {
    now: Effect.sync(() => DateTime.makeUnsafe(adapters.clock.now())),
  };
  const publishDependencies: PublishArtifactDependencies = {
    blobs: {
      put: (write) =>
        Effect.tryPromise({
          try: () => adapters.blobs.put(write),
          catch: (cause) =>
            new BlobStorageFailure({cause, operation: "put"}),
        }),
    },
    clock,
    ids: adapters.ids,
    repository: {
      assertPublicationSourceReady: (source, manifestDigest, commitTime) =>
        Effect.tryPromise({
          try: () =>
            adapters.repository.assertPublicationSourceReady(
              source,
              manifestDigest,
              commitTime,
            ),
          catch: classifySourceReadinessFailure,
        }),
      commitNewArtifact: (command) =>
        Effect.tryPromise({
          try: () => adapters.repository.commitNewArtifact(command),
          catch: classifyCommitNewFailure,
        }),
      commitVersion: (command) =>
        Effect.tryPromise({
          try: () => adapters.repository.commitVersion(command),
          catch: classifyCommitVersionFailure,
        }),
      findIdempotentPublication: (idempotencyKey, inputDigest) =>
        Effect.tryPromise({
          try: () =>
            adapters.repository.findIdempotentPublication(
              idempotencyKey,
              inputDigest,
            ),
          catch: (cause) =>
            cause instanceof IdempotencyConflict
              ? cause
              : repositoryFailure("findIdempotentPublication", cause),
        }),
      findCurrentVersion: (artifactId) =>
        Effect.tryPromise({
          try: () => adapters.repository.findCurrentVersion(artifactId),
          catch: (cause) => repositoryFailure("findCurrentVersion", cause),
        }),
    },
  };
  const stagedDependencies: StagedUploadDependencies = {
    clock,
    ids: adapters.ids,
    staging: {
      open: (uploadId, storageToken) =>
        Effect.tryPromise({
          try: () => adapters.staging.open(uploadId, storageToken),
          catch: (cause) =>
            new StagingStorageFailure({cause, operation: "open"}),
        }),
      put: (write) =>
        Effect.tryPromise({
          try: () => adapters.staging.put(write),
          catch: (cause) =>
            cause instanceof FileVerificationError
              ? new UploadedFileMismatch({
                message:
                  "The uploaded bytes do not match the declared size and SHA-256 fingerprint.",
              })
              : new StagingStorageFailure({cause, operation: "put"}),
        }),
    },
    uploads: {
      createStagedUpload: (command) =>
        Effect.tryPromise({
          try: () => adapters.repository.createStagedUpload(command),
          catch: (cause) => repositoryFailure("createStagedUpload", cause),
        }),
      findStagedUpload: (uploadId, principalId) =>
        Effect.tryPromise({
          try: () =>
            adapters.repository.findStagedUpload(uploadId, principalId),
          catch: (cause) => repositoryFailure("findStagedUpload", cause),
        }),
      markStagedFileUploaded: (
        uploadId,
        principalId,
        storageToken,
        uploadedAt,
      ) =>
        Effect.tryPromise({
          try: () =>
            adapters.repository.markStagedFileUploaded(
              uploadId,
              principalId,
              storageToken,
              uploadedAt,
            ),
          catch: (cause) => {
            if (
              cause instanceof UploadNotFound ||
              cause instanceof UploadClosed ||
              cause instanceof UploadFileNotFound
            ) {
              return cause;
            }
            return repositoryFailure("markStagedFileUploaded", cause);
          },
        }),
    },
  };

  const contentDependencies: ContentAccessDependencies = {
    clock,
    repository: {
      createContentBootstrap: (command) =>
        Effect.tryPromise({
          try: () => adapters.repository.createContentBootstrap(command),
          catch: (cause) => repositoryFailure("createContentBootstrap", cause),
        }),
      exchangeContentBootstrap: (command) =>
        Effect.tryPromise({
          try: () => adapters.repository.exchangeContentBootstrap(command),
          catch: (cause) => repositoryFailure("exchangeContentBootstrap", cause),
        }),
      findContentSession: (tokenDigest, contentToken, requestTime) =>
        Effect.tryPromise({
          try: () =>
            adapters.repository.findContentSession(
              tokenDigest,
              contentToken,
              requestTime,
            ),
          catch: (cause) => repositoryFailure("findContentSession", cause),
        }),
      findCurrentVersion: (artifactId) =>
        Effect.tryPromise({
          try: () => adapters.repository.findCurrentVersion(artifactId),
          catch: (cause) => repositoryFailure("findCurrentVersion", cause),
        }),
      findVersionContent: (contentToken, requestedPath) =>
        Effect.tryPromise({
          try: () =>
            adapters.repository.findVersionContent(contentToken, requestedPath),
          catch: (cause) => repositoryFailure("findVersionContent", cause),
        }),
    },
    secrets: {
      digest: (token) =>
        createHash("sha256").update(Redacted.value(token)).digest("hex"),
      issue: () => {
        const raw = randomBytes(32).toString("base64url");
        return {
          digest: createHash("sha256").update(raw).digest("hex"),
          token: Redacted.make(raw, {label: "content-session-token"}),
        };
      },
    },
  };

  const localPrincipal: Principal = {
    authorizedByPrincipalId: null,
    capabilities: [
      principalCapabilities.createArtifact,
      principalCapabilities.issueContentSession,
      principalCapabilities.publishAnyArtifact,
      principalCapabilities.publishOwnedArtifact,
    ],
    id: "local-api-token",
    installationId: adapters.installationId,
    kind: principalKinds.service,
    membershipRole: membershipRoles.member,
  };
  const authenticationLayer = AuthenticationService.layer({
    bearerCredentials: {
      verify: (credential) =>
        credentialsEqual(
          Redacted.value(credential),
          Redacted.value(adapters.apiToken),
        )
          ? Effect.succeed(localPrincipal)
          : Effect.fail(new AuthenticationRequired({
            message: "A valid local API token is required.",
          })),
    },
  });
  const authorizationLayer = AuthorizationService.layer({
    installationId: adapters.installationId,
  });

  const publishLayer = PublishArtifactService.layer(publishDependencies).pipe(
    Layer.provideMerge(authorizationLayer),
  );
  const stagedLayer = StagedUploadService.layer(stagedDependencies).pipe(
    Layer.provideMerge(publishLayer),
  );
  const contentLayer = ContentAccessService.layer(contentDependencies).pipe(
    Layer.provideMerge(authorizationLayer),
  );
  return Layer.mergeAll(authenticationLayer, stagedLayer, contentLayer);
}

function credentialsEqual(actualToken: string, expectedToken: string): boolean {
  const actual = Buffer.from(actualToken);
  const expected = Buffer.from(expectedToken);
  return actual.byteLength === expected.byteLength &&
    timingSafeEqual(actual, expected);
}

function classifySourceReadinessFailure(cause: unknown) {
  if (
    cause instanceof UploadNotFound ||
    cause instanceof UploadClosed ||
    cause instanceof UploadExpired ||
    cause instanceof UploadIncomplete
  ) {
    return cause;
  }
  return repositoryFailure("assertPublicationSourceReady", cause);
}

function classifyCommitNewFailure(cause: unknown) {
  if (cause instanceof IdempotencyConflict) return cause;
  if (
    cause instanceof UploadNotFound ||
    cause instanceof UploadClosed ||
    cause instanceof UploadExpired ||
    cause instanceof UploadIncomplete
  ) {
    return cause;
  }
  return repositoryFailure("commitNewArtifact", cause);
}

function classifyCommitVersionFailure(cause: unknown) {
  if (
    cause instanceof ArtifactNotFound ||
    cause instanceof IdempotencyConflict ||
    cause instanceof PublishConflict
  ) {
    return cause;
  }
  if (
    cause instanceof UploadNotFound ||
    cause instanceof UploadClosed ||
    cause instanceof UploadExpired ||
    cause instanceof UploadIncomplete
  ) {
    return cause;
  }
  return repositoryFailure("commitVersion", cause);
}

function repositoryFailure(
  operation: ArtifactRepositoryFailure["operation"],
  cause: unknown,
): ArtifactRepositoryFailure {
  return new ArtifactRepositoryFailure({cause, operation});
}
