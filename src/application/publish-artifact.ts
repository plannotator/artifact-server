import { createHash } from "node:crypto";

import { Context, DateTime, Effect, Layer, Schema } from "effect";

import {
  ArtifactNotFound,
  type ArtifactRepositoryFailure,
  type AuthorizationDenied,
  type BlobStorageFailure,
  type IdempotencyConflict,
  InvalidArtifactName,
  InvalidIdempotencyKey,
  type PublishConflict,
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
import {
  type ManifestFailure,
  parseSingleFileManifest,
} from "./parse-manifest.js";
import {
  type AuthorizationOperations,
  AuthorizationService,
} from "./authorization.js";

/** Input for publishing one inline file as a new artifact. */
export interface PublishNewArtifactCommand {
  readonly accessSetting: AccessSetting;
  readonly bytes: Uint8Array;
  readonly idempotencyKey: string;
  readonly mediaType: string;
  readonly name: string;
  readonly path: string;
  readonly principal: Principal;
}

/** Input for publishing one inline file as the next artifact version. */
export interface PublishVersionCommand {
  readonly artifactId: string;
  readonly bytes: Uint8Array;
  readonly expectedCurrentVersionId: string;
  readonly idempotencyKey: string;
  readonly mediaType: string;
  readonly path: string;
  readonly principal: Principal;
}

/** An immutable file source that can be opened during publication. */
export interface PublicationFileSource {
  readonly path: string;
  readonly sha256: string;
  readonly size: number;
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
  readonly source: PublicationSource;
}

/** Input for publishing an already parsed and fingerprinted artifact version. */
export interface PublishPreparedVersionCommand {
  readonly artifactId: string;
  readonly expectedCurrentVersionId: string;
  readonly files: readonly PublicationFileSource[];
  readonly idempotencyKey: string;
  readonly manifest: CanonicalManifest;
  readonly principal: Principal;
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
  | SourceReadinessFailure;

type CommitVersionFailure =
  | ArtifactNotFound
  | IdempotencyConflict
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
    idempotencyKey: string,
    inputDigest: string,
  ): Effect.Effect<PublishedVersion | null, IdempotencyConflict | ArtifactRepositoryFailure>;
  findCurrentVersion(
    artifactId: string,
  ): Effect.Effect<PublishedVersion | null, ArtifactRepositoryFailure>;
}

/** Immutable blob capability required by publication. */
export interface PublishBlobStorage {
  put(write: BlobWrite): Effect.Effect<StoredBlob, BlobStorageFailure>;
}

/** Testable current-time capability used by publishing operations. */
export interface PublishingClock {
  readonly now: Effect.Effect<DateTime.Utc>;
}

/** Dependencies used to construct the publication application service. */
export interface PublishArtifactDependencies {
  readonly blobs: PublishBlobStorage;
  readonly clock: PublishingClock;
  readonly ids: IdGenerator;
  readonly repository: PublishArtifactRepository;
}

/** Expected failures produced by the publication application service. */
export type PublishArtifactFailure =
  | InvalidArtifactName
  | InvalidIdempotencyKey
  | ManifestFailure
  | IdempotencyConflict
  | SourceReadinessFailure
  | ArtifactNotFound
  | PublishConflict
  | BlobStorageFailure
  | StagingStorageFailure
  | AuthorizationDenied;

interface PublishArtifactOperations {
  readonly publishNew: (
    command: PublishNewArtifactCommand,
  ) => Effect.Effect<PublishedVersion, PublishArtifactFailure>;
  readonly publishPreparedNew: (
    command: PublishPreparedNewArtifactCommand,
  ) => Effect.Effect<PublishedVersion, PublishArtifactFailure>;
  readonly publishPreparedVersion: (
    command: PublishPreparedVersionCommand,
  ) => Effect.Effect<PublishedVersion, PublishArtifactFailure>;
  readonly publishVersion: (
    command: PublishVersionCommand,
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
const idempotencyKeySchema = Schema.String.check(
  Schema.isLengthBetween(16, 200),
);
const decodeArtifactName = Schema.decodeUnknownEffect(artifactNameSchema);
const decodeIdempotencyKey = Schema.decodeUnknownEffect(idempotencyKeySchema);

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
            Effect.flatMap((body) =>
              dependencies.blobs.put({
                body,
                sha256: entry.sha256,
                size: entry.size,
              })
            ),
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
    const inputDigest = newArtifactInputDigest({
      accessSetting: command.accessSetting,
      manifest: command.manifest,
      name,
      principalId: command.principal.id,
      source: command.source,
    });
    const replayed = yield* dependencies.repository.findIdempotentPublication(
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
      source: command.source,
      versionId: dependencies.ids.versionId(),
    });
  });

  const publishPreparedVersion = Effect.fn(
    "PublishArtifactService.publishPreparedVersion",
  )(function*(
    command: PublishPreparedVersionCommand,
  ): Effect.fn.Return<PublishedVersion, PublishArtifactFailure> {
    const current = yield* dependencies.repository.findCurrentVersion(
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
      source: command.source,
    });
    const replayed = yield* dependencies.repository.findIdempotentPublication(
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
      source: command.source,
      versionId: dependencies.ids.versionId(),
    });
  });

  const publishNew = Effect.fn("PublishArtifactService.publishNew")(
    function*(
      command: PublishNewArtifactCommand,
    ): Effect.fn.Return<PublishedVersion, PublishArtifactFailure> {
      const manifest = yield* parseSingleFileManifest(command);
      const entry = onlyManifestEntry(manifest);
      return yield* publishPreparedNew({
        accessSetting: command.accessSetting,
        files: [inlineFileSource(command.bytes, entry)],
        idempotencyKey: command.idempotencyKey,
        manifest,
        name: command.name,
        principal: command.principal,
        source: {kind: "inline"},
      });
    },
  );

  const publishVersion = Effect.fn("PublishArtifactService.publishVersion")(
    function*(
      command: PublishVersionCommand,
    ): Effect.fn.Return<PublishedVersion, PublishArtifactFailure> {
      const manifest = yield* parseSingleFileManifest(command);
      const entry = onlyManifestEntry(manifest);
      return yield* publishPreparedVersion({
        artifactId: command.artifactId,
        expectedCurrentVersionId: command.expectedCurrentVersionId,
        files: [inlineFileSource(command.bytes, entry)],
        idempotencyKey: command.idempotencyKey,
        manifest,
        principal: command.principal,
        source: {kind: "inline"},
      });
    },
  );

  return PublishArtifactService.of({
    publishNew,
    publishPreparedNew,
    publishPreparedVersion,
    publishVersion,
  });
}

function parseIdempotencyKey(
  candidate: string,
): Effect.Effect<string, InvalidIdempotencyKey> {
  return decodeIdempotencyKey(candidate).pipe(
    Effect.mapError(() =>
      new InvalidIdempotencyKey({
        message: "Idempotency keys must contain between 16 and 200 characters.",
      })
    ),
  );
}

interface NewArtifactDigestInput {
  readonly accessSetting: AccessSetting;
  readonly manifest: CanonicalManifest;
  readonly name: string;
  readonly principalId: string;
  readonly source: PublicationSource;
}

interface ArtifactVersionDigestInput {
  readonly artifactId: string;
  readonly expectedCurrentVersionId: string;
  readonly manifest: CanonicalManifest;
  readonly principalId: string;
  readonly source: PublicationSource;
}

function newArtifactInputDigest(input: NewArtifactDigestInput): string {
  const canonicalInput = JSON.stringify({
    accessSetting: input.accessSetting,
    manifestDigest: input.manifest.digest,
    name: input.name,
    principalId: input.principalId,
    source: sourceDigestValue(input.source),
  });
  return createHash("sha256").update(canonicalInput).digest("hex");
}

function artifactVersionInputDigest(input: ArtifactVersionDigestInput): string {
  const canonicalInput = JSON.stringify({
    artifactId: input.artifactId,
    expectedCurrentVersionId: input.expectedCurrentVersionId,
    manifestDigest: input.manifest.digest,
    principalId: input.principalId,
    source: sourceDigestValue(input.source),
  });
  return createHash("sha256").update(canonicalInput).digest("hex");
}

function inlineFileSource(
  bytes: Uint8Array,
  entry: CanonicalManifest["entries"][number],
): PublicationFileSource {
  return {
    open: () =>
      Effect.succeed(new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(bytes);
          controller.close();
        },
      })),
    path: entry.path,
    sha256: entry.sha256,
    size: entry.size,
  };
}

function onlyManifestEntry(
  manifest: CanonicalManifest,
): CanonicalManifest["entries"][number] {
  const entry = manifest.entries[0];
  if (entry === undefined || manifest.entries.length !== 1) {
    throw new Error("A single-file manifest must contain exactly one entry.");
  }
  return entry;
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

function sourceDigestValue(source: PublicationSource): string {
  switch (source.kind) {
    case "inline":
      return "inline";
    case "staged_upload":
      return `${source.principalId}:${source.uploadId}`;
  }
  return casesHandled(source);
}

function casesHandled(value: never): never {
  throw new Error(`Unreachable publication variant: ${String(value)}`);
}
