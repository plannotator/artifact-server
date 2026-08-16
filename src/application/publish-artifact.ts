import { createHash } from "node:crypto";

import { Context, DateTime, Effect, Layer, Schema } from "effect";

import {
  ArtifactNotFound,
  type ArtifactRepositoryFailure,
  type AuthorizationDenied,
  type BlobStorageFailure,
  type IdempotencyConflict,
  InvalidArtifactName,
  type InvalidArtifactTags,
  type InvalidIdempotencyKey,
  type PublishConflict,
  type ProjectArchived,
  type StagingStorageFailure,
  type UploadClosed,
  type UploadExpired,
  type UploadIncomplete,
  type UploadNotFound,
} from "../core/errors.js";
import type { Principal } from "../core/identity.js";
import type {
  AccessSetting,
  CanonicalManifest,
  PublishedVersion,
} from "../core/model.js";
import type {
  BlobWrite,
  CommitArtifactVersion,
  CommitNewArtifact,
  IdGenerator,
  PublicationSource,
  StoredBlob,
} from "../core/ports.js";
import type {ManifestFailure} from "./parse-manifest.js";
import {
  type AuthorizationOperations,
  AuthorizationService,
} from "./authorization.js";
import type { ApplicationClock } from "./application-clock.js";
import { parseIdempotencyKey } from "./idempotency-key.js";
import { parseArtifactTags } from "./artifact-tags.js";

/** An immutable file source that can be opened during publication. */
export interface PublicationFileSource {
  readonly path: string;
  readonly sha256: string;
  readonly size: number;
  readonly signal?: AbortSignal;
  open(): Effect.Effect<ReadableStream<Uint8Array>, StagingStorageFailure>;
}

/** Input for publishing an already parsed and fingerprinted artifact. */
export interface PublishPreparedNewArtifactCommand {
  readonly accessSetting: AccessSetting;
  readonly files: readonly PublicationFileSource[];
  readonly idempotencyKey: string;
  readonly manifest: CanonicalManifest;
  readonly name: string;
  readonly principal: Principal;
  readonly projectId: string;
  readonly source: PublicationSource;
  readonly tags?: readonly string[];
}

/** Input for publishing an already parsed and fingerprinted artifact version. */
export interface PublishPreparedVersionCommand {
  readonly artifactId: string;
  readonly expectedCurrentVersionId: string;
  readonly files: readonly PublicationFileSource[];
  readonly idempotencyKey: string;
  readonly manifest: CanonicalManifest;
  readonly principal: Principal;
  readonly projectId: string;
  readonly source: PublicationSource;
}

type SourceReadinessFailure =
  | UploadNotFound
  | UploadClosed
  | UploadExpired
  | UploadIncomplete
  | ArtifactRepositoryFailure;

type CommitNewFailure =
  | IdempotencyConflict
  | ProjectArchived
  | SourceReadinessFailure;

type CommitVersionFailure =
  | ArtifactNotFound
  | IdempotencyConflict
  | ProjectArchived
  | PublishConflict
  | SourceReadinessFailure;

/** Repository capabilities required by immutable publication. */
export interface PublishArtifactRepository {
  assertPublicationSourceReady(
    source: PublicationSource,
    manifestDigest: string,
    commitTime: string,
  ): Effect.Effect<void, SourceReadinessFailure>;
  commitNewArtifact(
    command: CommitNewArtifact,
  ): Effect.Effect<PublishedVersion, CommitNewFailure>;
  commitVersion(
    command: CommitArtifactVersion,
  ): Effect.Effect<PublishedVersion, CommitVersionFailure>;
  findIdempotentPublication(
    projectId: string,
    idempotencyKey: string,
    inputDigest: string,
  ): Effect.Effect<PublishedVersion | null, IdempotencyConflict | ArtifactRepositoryFailure>;
  findCurrentVersion(
    projectId: string,
    artifactId: string,
  ): Effect.Effect<PublishedVersion | null, ArtifactRepositoryFailure>;
}

/** Immutable blob capability required by publication. */
export interface PublishBlobStorage {
  put(write: BlobWrite): Effect.Effect<StoredBlob, BlobStorageFailure>;
}

/** Dependencies used to construct the publication application service. */
export interface PublishArtifactDependencies {
  readonly blobs: PublishBlobStorage;
  readonly clock: ApplicationClock;
  readonly ids: IdGenerator;
  readonly repository: PublishArtifactRepository;
}

/** Expected failures produced by the publication application service. */
export type PublishArtifactFailure =
  | InvalidArtifactName
  | InvalidArtifactTags
  | InvalidIdempotencyKey
  | ManifestFailure
  | IdempotencyConflict
  | SourceReadinessFailure
  | ArtifactNotFound
  | PublishConflict
  | ProjectArchived
  | BlobStorageFailure
  | StagingStorageFailure
  | AuthorizationDenied;

interface PublishArtifactOperations {
  readonly publishPreparedNew: (
    command: PublishPreparedNewArtifactCommand,
  ) => Effect.Effect<PublishedVersion, PublishArtifactFailure>;
  readonly publishPreparedVersion: (
    command: PublishPreparedVersionCommand,
  ) => Effect.Effect<PublishedVersion, PublishArtifactFailure>;
}

/** Publishes immutable artifacts through deployment-neutral Effect operations. */
export class PublishArtifactService extends Context.Service<
  PublishArtifactService,
  PublishArtifactOperations
>()("artifact-server/application/PublishArtifactService") {
  /** Construct the service from application-owned publication ports. */
  static readonly layer = (
    dependencies: PublishArtifactDependencies,
  ): Layer.Layer<PublishArtifactService, never, AuthorizationService> =>
    Layer.effect(
      PublishArtifactService,
      Effect.gen(function*() {
        const authorization = yield* AuthorizationService;
        return makePublishArtifactService(dependencies, authorization);
      }),
    );
}

const artifactNameSchema = Schema.Trim.check(Schema.isLengthBetween(1, 200));
const decodeArtifactName = Schema.decodeUnknownEffect(artifactNameSchema);

function makePublishArtifactService(
  dependencies: PublishArtifactDependencies,
  authorization: AuthorizationOperations,
): PublishArtifactOperations {
  const storeFiles = Effect.fn("PublishArtifactService.storeFiles")(
    function*(
      manifest: CanonicalManifest,
      files: readonly PublicationFileSource[],
    ): Effect.fn.Return<void, BlobStorageFailure | StagingStorageFailure> {
      const sources = publicationSourcesByPath(manifest, files);
      yield* Effect.forEach(
        manifest.entries,
        (entry) => {
          const source = sources.get(entry.path);
          if (source === undefined) {
            return Effect.die(
              new Error(`The publication source for ${entry.path} is missing.`),
            );
          }
          return source.open().pipe(
            Effect.flatMap((body) => {
              const write = {
                body,
                sha256: entry.sha256,
                size: entry.size,
              };
              return dependencies.blobs.put(source.signal === undefined
                ? write
                : {...write, signal: source.signal});
            }),
          );
        },
        {concurrency: 1, discard: true},
      );
    },
  );

  const publishPreparedNew = Effect.fn(
    "PublishArtifactService.publishPreparedNew",
  )(function*(
    command: PublishPreparedNewArtifactCommand,
  ): Effect.fn.Return<PublishedVersion, PublishArtifactFailure> {
    yield* authorization.requireArtifactCreation(command.principal);
    const name = yield* decodeArtifactName(command.name).pipe(
      Effect.mapError(() =>
        new InvalidArtifactName({
          message: "Artifact names must contain between 1 and 200 characters.",
        })
      ),
    );
    const idempotencyKey = yield* parseIdempotencyKey(command.idempotencyKey);
    const tags = yield* parseArtifactTags(command.tags ?? []);
    const inputDigest = newArtifactInputDigest({
      accessSetting: command.accessSetting,
      manifest: command.manifest,
      name,
      principalId: command.principal.id,
      projectId: command.projectId,
      tags,
    });
    const replayed = yield* dependencies.repository.findIdempotentPublication(
      command.projectId,
      idempotencyKey,
      inputDigest,
    );
    if (replayed !== null) return replayed;

    const sourceCheckTime = DateTime.formatIso(yield* dependencies.clock.now);
    yield* dependencies.repository.assertPublicationSourceReady(
      command.source,
      command.manifest.digest,
      sourceCheckTime,
    );
    yield* storeFiles(command.manifest, command.files);

    const createdAt = DateTime.formatIso(yield* dependencies.clock.now);

    return yield* dependencies.repository.commitNewArtifact({
      accessSetting: command.accessSetting,
      artifactId: dependencies.ids.artifactId(),
      contentToken: dependencies.ids.contentToken(),
      createdAt,
      idempotencyKey,
      inputDigest,
      manifest: command.manifest,
      name,
      ownerPrincipalId: command.principal.id,
      principalId: command.principal.id,
      projectId: command.projectId,
      authorizedByPrincipalId: command.principal.authorizedByPrincipalId,
      source: command.source,
      tags,
      versionId: dependencies.ids.versionId(),
    });
  });

  const publishPreparedVersion = Effect.fn(
    "PublishArtifactService.publishPreparedVersion",
  )(function*(
    command: PublishPreparedVersionCommand,
  ): Effect.fn.Return<PublishedVersion, PublishArtifactFailure> {
    const current = yield* dependencies.repository.findCurrentVersion(
      command.projectId,
      command.artifactId,
    );
    if (current === null) {
      return yield* Effect.fail(
        new ArtifactNotFound({message: "The artifact does not exist."}),
      );
    }
    yield* authorization.requireVersionPublication(
      command.principal,
      current.artifact,
    );
    const idempotencyKey = yield* parseIdempotencyKey(command.idempotencyKey);
    const inputDigest = artifactVersionInputDigest({
      artifactId: command.artifactId,
      expectedCurrentVersionId: command.expectedCurrentVersionId,
      manifest: command.manifest,
      principalId: command.principal.id,
      projectId: command.projectId,
    });
    const replayed = yield* dependencies.repository.findIdempotentPublication(
      command.projectId,
      idempotencyKey,
      inputDigest,
    );
    if (replayed !== null) return replayed;

    const sourceCheckTime = DateTime.formatIso(yield* dependencies.clock.now);
    yield* dependencies.repository.assertPublicationSourceReady(
      command.source,
      command.manifest.digest,
      sourceCheckTime,
    );
    yield* storeFiles(command.manifest, command.files);

    const createdAt = DateTime.formatIso(yield* dependencies.clock.now);

    return yield* dependencies.repository.commitVersion({
      artifactId: command.artifactId,
      contentToken: dependencies.ids.contentToken(),
      createdAt,
      expectedCurrentVersionId: command.expectedCurrentVersionId,
      idempotencyKey,
      inputDigest,
      manifest: command.manifest,
      principalId: command.principal.id,
      projectId: command.projectId,
      authorizedByPrincipalId: command.principal.authorizedByPrincipalId,
      source: command.source,
      versionId: dependencies.ids.versionId(),
    });
  });

  return PublishArtifactService.of({
    publishPreparedNew,
    publishPreparedVersion,
  });
}

interface NewArtifactDigestInput {
  readonly accessSetting: AccessSetting;
  readonly manifest: CanonicalManifest;
  readonly name: string;
  readonly principalId: string;
  readonly projectId: string;
  readonly tags: readonly string[];
}

interface ArtifactVersionDigestInput {
  readonly artifactId: string;
  readonly expectedCurrentVersionId: string;
  readonly manifest: CanonicalManifest;
  readonly principalId: string;
  readonly projectId: string;
}

function newArtifactInputDigest(input: NewArtifactDigestInput): string {
  const canonicalInput = JSON.stringify({
    accessSetting: input.accessSetting,
    manifestDigest: input.manifest.digest,
    name: input.name,
    principalId: input.principalId,
    projectId: input.projectId,
    tags: input.tags,
  });
  return createHash("sha256").update(canonicalInput).digest("hex");
}

function artifactVersionInputDigest(input: ArtifactVersionDigestInput): string {
  const canonicalInput = JSON.stringify({
    artifactId: input.artifactId,
    expectedCurrentVersionId: input.expectedCurrentVersionId,
    manifestDigest: input.manifest.digest,
    principalId: input.principalId,
    projectId: input.projectId,
  });
  return createHash("sha256").update(canonicalInput).digest("hex");
}

function publicationSourcesByPath(
  manifest: CanonicalManifest,
  files: readonly PublicationFileSource[],
): ReadonlyMap<string, PublicationFileSource> {
  const manifestByPath = new Map(
    manifest.entries.map((entry) => [entry.path, entry] as const),
  );
  const sources = new Map<string, PublicationFileSource>();
  for (const file of files) {
    const entry = manifestByPath.get(file.path);
    if (
      entry === undefined ||
      sources.has(file.path) ||
      file.sha256 !== entry.sha256 ||
      file.size !== entry.size
    ) {
      throw new Error("Publication file sources do not match the canonical manifest.");
    }
    sources.set(file.path, file);
  }
  if (sources.size !== manifestByPath.size) {
    throw new Error("Publication file sources do not match the canonical manifest.");
  }
  return sources;
}
