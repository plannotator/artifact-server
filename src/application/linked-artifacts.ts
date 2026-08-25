import { createHash } from "node:crypto";

import { Context, DateTime, Effect, Layer, type Redacted } from "effect";

import {
  ArtifactNotFound,
  ArtifactRepositoryFailure,
  CapabilityUnavailable,
  ContentSessionRequired,
  InvalidLinkPath,
  isArtifactServerFailure,
  type AuthorizationDenied,
  type BlobStorageFailure,
  type IdempotencyConflict,
  type InvalidIdempotencyKey,
  type LinkPathOutsideRoots,
  type LinkPathProtected,
  type ProjectArchived,
  type PublishConflict,
  type SourceDrifted,
  type SourceMissing,
  type SourceUnreadable,
  type StagingStorageFailure,
} from "../core/errors.js";
import type { Principal } from "../core/identity.js";
import {
  accessSettings,
  type ArtifactVersion,
  type PublishedVersion,
  type SourceBindingRecord,
  type SourceFreshness,
} from "../core/model.js";
import type {
  CommitCapturedVersion,
  CommitLinkedArtifact,
  CreateContentBootstrap,
  IdGenerator,
  RecordSourceFreshness,
  RelinkSourceBinding,
} from "../core/ports.js";
import type { ApplicationClock } from "./application-clock.js";
import type {
  ContentSecretProvider,
} from "./content-access.js";
import type {
  PublishArtifactRepository,
  PublishBlobStorage,
} from "./publish-artifact.js";
import { parseIdempotencyKey } from "./idempotency-key.js";
import {
  type AuthorizationOperations,
  AuthorizationService,
} from "./authorization.js";
import {
  type ProjectManagementFailure,
  ProjectManagementService,
} from "./project-management.js";
import {
  type StagedUploadFailure,
  StagedUploadService,
} from "./staged-upload.js";

const liveBootstrapLifetimeMilliseconds = 2 * 60 * 1_000;
const liveTokenPrefix = "live-";
const artifactIdentityPrefix = "art_";
const liveIdentityPattern = /^[A-Za-z0-9-]{8,80}$/u;

/** One lazily observed relation between a binding and its source file. */
export interface SourceObservation {
  readonly fingerprint: string | null;
  readonly freshness: SourceFreshness;
}

/** One opened source whose stat and bytes share a single descriptor. */
export interface VerifiedSourceStream {
  close(): Promise<void>;
  readonly fingerprint: string;
  readonly size: number;
  stream(): ReadableStream<Uint8Array>;
}

/** One drift-checked source read, spooled for the publish pipeline. */
export interface CapturedSourceSpool {
  discard(): Promise<void>;
  readonly fingerprint: string;
  openStream(): Promise<ReadableStream<Uint8Array>>;
  readonly sha256: string;
  readonly size: number;
  readonly spoolPath: string;
}

/**
 * Filesystem mechanics injected by the local deployment. The application
 * layer never touches the filesystem directly, so this module stays safe for
 * every deployment bundle while the engine itself remains Node-only.
 */
export interface LinkedSourceEngineOperations {
  canonicalizeLinkPath(rawPath: string): Promise<string>;
  canonicalizeLinkRoots(roots: readonly string[]): Promise<readonly string[]>;
  captureSource(
    canonicalPath: string,
    spoolDirectory: string,
  ): Promise<CapturedSourceSpool>;
  checkLinkRoots(
    canonicalPath: string,
    canonicalRoots: readonly string[],
  ): void;
  checkSelfProtection(canonicalPath: string): Promise<void>;
  mediaTypeForPath(canonicalPath: string): string;
  openVerifiedSource(canonicalPath: string): Promise<VerifiedSourceStream>;
  refreshFreshness(
    canonicalPath: string,
    storedFingerprint: string,
  ): Promise<SourceObservation>;
}

/** Binding persistence required by linked-artifact operations. */
export interface LinkedBindingRepository {
  readonly commitCapturedVersion: (
    command: CommitCapturedVersion,
  ) => Effect.Effect<
    PublishedVersion,
    | ArtifactNotFound
    | IdempotencyConflict
    | ProjectArchived
    | PublishConflict
    | ArtifactRepositoryFailure
  >;
  readonly commitLinkedArtifact: (
    command: CommitLinkedArtifact,
  ) => Effect.Effect<
    PublishedVersion,
    IdempotencyConflict | ProjectArchived | ArtifactRepositoryFailure
  >;
  readonly findSourceBinding: (
    projectId: string,
    artifactId: string,
  ) => Effect.Effect<SourceBindingRecord | null, ArtifactRepositoryFailure>;
  readonly recordSourceFreshness: (
    command: RecordSourceFreshness,
  ) => Effect.Effect<SourceBindingRecord, ArtifactRepositoryFailure>;
  readonly relinkSource: (
    command: RelinkSourceBinding,
  ) => Effect.Effect<
    SourceBindingRecord,
    ArtifactNotFound | IdempotencyConflict | ArtifactRepositoryFailure
  >;
}

/** Content-session persistence reused for the artifact-scoped live origin. */
export interface LiveSessionRepository {
  readonly createContentBootstrap: (
    command: CreateContentBootstrap,
  ) => Effect.Effect<unknown, ArtifactRepositoryFailure>;
  readonly findContentSession: (
    tokenDigest: string,
    contentToken: string,
    requestTime: string,
  ) => Effect.Effect<
    {readonly artifactId: string; readonly projectId: string} | null,
    ArtifactRepositoryFailure
  >;
}

/** Publication reads reused unchanged from the publish pipeline. */
export type LinkedPublicationRepository = Pick<
  PublishArtifactRepository,
  "assertPublicationSourceReady" | "findIdempotentPublication" | "findCurrentVersion"
> & {
  readonly findVersionRecord: (
    projectId: string,
    artifactId: string,
    versionId: string,
  ) => Effect.Effect<ArtifactVersion | null, ArtifactRepositoryFailure>;
};

/** Locations and roots fixed by the local deployment's configuration. */
export interface LinkedArtifactConfiguration {
  readonly linkRoots: readonly string[];
  readonly spoolDirectory: string;
}

/** Dependencies used to construct the enabled linked-artifact service. */
export interface LinkedArtifactDependencies {
  readonly bindings: LinkedBindingRepository;
  readonly blobs: PublishBlobStorage;
  readonly clock: ApplicationClock;
  readonly configuration: LinkedArtifactConfiguration;
  readonly engine: LinkedSourceEngineOperations;
  readonly ids: IdGenerator;
  readonly liveSessions: LiveSessionRepository;
  readonly publication: LinkedPublicationRepository;
  readonly secrets: ContentSecretProvider;
}

/** Expected failures produced by linked-artifact operations. */
export type LinkedArtifactFailure =
  | ArtifactNotFound
  | AuthorizationDenied
  | CapabilityUnavailable
  | IdempotencyConflict
  | InvalidIdempotencyKey
  | InvalidLinkPath
  | LinkPathOutsideRoots
  | LinkPathProtected
  | PublishConflict
  | SourceDrifted
  | SourceMissing
  | SourceUnreadable
  | ArtifactRepositoryFailure
  | BlobStorageFailure
  | StagingStorageFailure
  | ProjectManagementFailure
  | StagedUploadFailure;

/** Failures an implicit comment-time capture can surface to comment policy. */
export type LinkedCommentCaptureFailure = LinkedArtifactFailure;

/** Input naming one artifact through authenticated application policy. */
export interface LinkedArtifactReadCommand {
  readonly artifactId: string;
  readonly principal: Principal;
  readonly projectId: string | null;
}

/** Input for linking one server-machine file as a new artifact. */
export interface LinkArtifactCommand {
  readonly idempotencyKey: string;
  readonly name?: string;
  readonly path: string;
  readonly principal: Principal;
  readonly projectId: string | null;
}

/** Input for capturing one linked source's current bytes as a version. */
export interface CaptureArtifactCommand extends LinkedArtifactReadCommand {
  readonly expectedCurrentVersionId: string;
  readonly idempotencyKey: string;
}

/** Input for re-pointing one binding at a moved source file. */
export interface RelinkArtifactCommand extends LinkedArtifactReadCommand {
  readonly expectedSha256: string;
  readonly idempotencyKey: string;
  readonly path: string;
}

/** Input for the comment-time implicit capture decision. */
export interface CaptureForCommentCommand {
  readonly artifactId: string;
  readonly idempotencyKey: string;
  readonly principal: Principal;
  readonly projectId: string;
}

/** One linked artifact together with its persisted binding state. */
export interface LinkedPublication {
  readonly binding: SourceBindingRecord;
  readonly published: PublishedVersion;
}

/** One issued live-origin bootstrap, exchangeable exactly once. */
export interface IssuedLiveBootstrap {
  readonly contentToken: string;
  readonly expiresAt: string;
  readonly token: Redacted.Redacted;
}

/** Input for authorizing one live-origin read. */
export interface AuthorizeLiveReadCommand {
  readonly liveToken: string;
  readonly sessionToken: Redacted.Redacted | null;
}

/** One authorized live read: live bytes, or the captured fallback. */
export type LiveReadGrant =
  | {
    readonly freshness: SourceFreshness;
    readonly kind: "live";
    readonly mediaType: string;
    readonly source: VerifiedSourceStream;
  }
  | {
    readonly entry: ArtifactVersion["manifest"]["entries"][number];
    readonly freshness: SourceFreshness;
    readonly kind: "captured";
  };

interface LinkedArtifactOperations {
  readonly authorizeLiveRead: (
    command: AuthorizeLiveReadCommand,
  ) => Effect.Effect<
    LiveReadGrant,
    | ArtifactNotFound
    | CapabilityUnavailable
    | ContentSessionRequired
    | ArtifactRepositoryFailure
  >;
  readonly captureArtifact: (
    command: CaptureArtifactCommand,
  ) => Effect.Effect<LinkedPublication, LinkedArtifactFailure>;
  readonly captureForComment: (
    command: CaptureForCommentCommand,
  ) => Effect.Effect<
    {readonly versionId: string} | null,
    LinkedCommentCaptureFailure
  >;
  readonly describeCapability: () => Effect.Effect<
    {readonly linkedArtifacts: boolean}
  >;
  readonly issueLiveBootstrap: (
    command: LinkedArtifactReadCommand,
  ) => Effect.Effect<IssuedLiveBootstrap, LinkedArtifactFailure>;
  readonly linkArtifact: (
    command: LinkArtifactCommand,
  ) => Effect.Effect<LinkedPublication, LinkedArtifactFailure>;
  readonly observeBinding: (
    command: LinkedArtifactReadCommand,
  ) => Effect.Effect<
    SourceBindingRecord | null,
    AuthorizationDenied | ArtifactRepositoryFailure | ProjectManagementFailure
  >;
  readonly relinkArtifact: (
    command: RelinkArtifactCommand,
  ) => Effect.Effect<SourceBindingRecord, LinkedArtifactFailure>;
}

/**
 * Owns linked-artifact policy: the section 4.3 authorization ladder, capture
 * through the ordinary publish pipeline, lazy freshness observation, and the
 * artifact-scoped live origin. Every deployment provides this service; only
 * the local deployment with linked files enabled provides the enabled layer,
 * and everywhere else the disabled layer answers the stable
 * capability-unavailable shape (project/spec/local-workspace-spec.md section 3).
 */
export class LinkedArtifactService extends Context.Service<
  LinkedArtifactService,
  LinkedArtifactOperations
>()("artifact-server/application/LinkedArtifactService") {
  /** Construct the enabled service for a local deployment. */
  static readonly layer = (
    dependencies: LinkedArtifactDependencies,
  ): Layer.Layer<
    LinkedArtifactService,
    never,
    AuthorizationService | ProjectManagementService | StagedUploadService
  > =>
    Layer.effect(
      LinkedArtifactService,
      Effect.gen(function*() {
        const authorization = yield* AuthorizationService;
        const projects = yield* ProjectManagementService;
        const staged = yield* StagedUploadService;
        return makeLinkedArtifactService(
          dependencies,
          authorization,
          projects,
          staged,
        );
      }),
    );
}

/** The stable answer every deployment gives while the capability is off. */
export const disabledLinkedArtifactLayer: Layer.Layer<LinkedArtifactService> =
  Layer.effect(
    LinkedArtifactService,
    Effect.sync(() => makeDisabledLinkedArtifactService()),
  );

/** Build the artifact-scoped live-origin host label for one artifact. */
export function liveContentToken(artifactId: string): string | null {
  if (!artifactId.startsWith(artifactIdentityPrefix)) return null;
  const identity = artifactId.slice(artifactIdentityPrefix.length);
  if (!liveIdentityPattern.test(identity)) return null;
  return `${liveTokenPrefix}${identity}`;
}

/** Determine whether one content-host label names a live origin. */
export function isLiveContentToken(candidate: string): boolean {
  return candidate.startsWith(liveTokenPrefix)
    && liveIdentityPattern.test(candidate.slice(liveTokenPrefix.length));
}

const unavailable = () =>
  Effect.fail(
    new CapabilityUnavailable({
      message: "Linked artifacts are not available on this deployment.",
    }),
  );

function makeDisabledLinkedArtifactService(): LinkedArtifactOperations {
  return LinkedArtifactService.of({
    authorizeLiveRead: unavailable,
    captureArtifact: unavailable,
    captureForComment: () => Effect.succeed(null),
    describeCapability: () => Effect.succeed({linkedArtifacts: false}),
    issueLiveBootstrap: unavailable,
    linkArtifact: unavailable,
    observeBinding: () => Effect.succeed(null),
    relinkArtifact: unavailable,
  });
}

function makeLinkedArtifactService(
  dependencies: LinkedArtifactDependencies,
  authorization: AuthorizationOperations,
  projects: ProjectManagementService["Service"],
  staged: StagedUploadService["Service"],
): LinkedArtifactOperations {
  const runEngine = <A>(
    run: () => Promise<A>,
  ): Effect.Effect<A, EngineFailure> =>
    Effect.tryPromise({
      catch: classifyEngineFailure,
      try: run,
    });

  const resolveProject = Effect.fn("LinkedArtifactService.resolveProject")(
    function*(principal: Principal, projectId: string | null) {
      return projectId === null
        ? yield* projects.resolveActiveProject({principal, projectId})
        : yield* projects.getProject({principal, projectId});
    },
  );

  const requireBinding = Effect.fn("LinkedArtifactService.requireBinding")(
    function*(projectId: string, artifactId: string): Effect.fn.Return<
      SourceBindingRecord,
      InvalidLinkPath | ArtifactRepositoryFailure
    > {
      const binding = yield* dependencies.bindings.findSourceBinding(
        projectId,
        artifactId,
      );
      if (binding !== null) return binding;
      return yield* new InvalidLinkPath({
        message: "The artifact has no linked source.",
      });
    },
  );

  const runLadder = Effect.fn("LinkedArtifactService.runLadder")(
    function*(rawPath: string) {
      const canonical = yield* runEngine(() =>
        dependencies.engine.canonicalizeLinkPath(rawPath)
      );
      const roots = yield* runEngine(() =>
        dependencies.engine.canonicalizeLinkRoots(
          dependencies.configuration.linkRoots,
        )
      );
      yield* runEngine(() =>
        Promise.resolve(dependencies.engine.checkLinkRoots(canonical, roots))
      );
      yield* runEngine(() =>
        dependencies.engine.checkSelfProtection(canonical)
      );
      return canonical;
    },
  );

  /** Spool, stage, and verify one capture so publish invariants hold. */
  const stageCapture = Effect.fn("LinkedArtifactService.stageCapture")(
    function*(input: {
      readonly capture: CapturedSourceSpool;
      readonly entryPath: string;
      readonly mediaType: string;
      readonly principal: Principal;
      readonly projectId: string;
    }) {
      const upload = yield* staged.createUpload({
        entryPath: input.entryPath,
        files: [{
          mediaType: input.mediaType,
          path: input.entryPath,
          sha256: input.capture.sha256,
          size: input.capture.size,
        }],
        principal: input.principal,
        projectId: input.projectId,
      });
      const file = upload.files[0];
      if (file === undefined) {
        return yield* Effect.die(
          new Error("A staged capture upload declared no file slot."),
        );
      }
      const body = yield* runEngine(() => input.capture.openStream());
      yield* staged.uploadFile({
        body,
        principal: input.principal,
        projectId: input.projectId,
        storageToken: file.storageToken,
        uploadId: upload.id,
      });
      return upload;
    },
  );

  const storeCaptureBlob = Effect.fn("LinkedArtifactService.storeCaptureBlob")(
    function*(capture: CapturedSourceSpool) {
      const body = yield* runEngine(() => capture.openStream());
      yield* dependencies.blobs.put({
        body,
        sha256: capture.sha256,
        size: capture.size,
      });
    },
  );

  const linkArtifact = Effect.fn("LinkedArtifactService.linkArtifact")(
    function*(command: LinkArtifactCommand) {
      yield* authorization.requireArtifactCreation(command.principal);
      const project = yield* resolveProject(
        command.principal,
        command.projectId,
      );
      const idempotencyKey = yield* parseIdempotencyKey(command.idempotencyKey);
      const canonical = yield* runLadder(command.path);
      const entryPath = fileNameOf(canonical);
      const name = command.name ?? entryPath;
      const inputDigest = linkInputDigest({
        operation: "link",
        path: canonical,
        principalId: command.principal.id,
        projectId: project.id,
        value: name,
      });
      const replayed = yield* dependencies.publication.findIdempotentPublication(
        project.id,
        idempotencyKey,
        inputDigest,
      );
      if (replayed !== null) {
        const binding = yield* requireBinding(project.id, replayed.artifact.id);
        return {binding, published: replayed};
      }

      const capture = yield* runEngine(() =>
        dependencies.engine.captureSource(
          canonical,
          dependencies.configuration.spoolDirectory,
        )
      );
      const published = yield* commitLink().pipe(
        Effect.ensuring(discardCapture(capture)),
      );
      const binding = yield* requireBinding(project.id, published.artifact.id);
      return {binding, published};

      function commitLink() {
        return Effect.gen(function*() {
          const upload = yield* stageCapture({
            capture,
            entryPath,
            mediaType: dependencies.engine.mediaTypeForPath(canonical),
            principal: command.principal,
            projectId: project.id,
          });
          const commitTime = DateTime.formatIso(yield* dependencies.clock.now);
          yield* dependencies.publication.assertPublicationSourceReady(
            {
              kind: "staged_upload",
              principalId: command.principal.id,
              projectId: project.id,
              uploadId: upload.id,
            },
            upload.manifest.digest,
            commitTime,
          );
          yield* storeCaptureBlob(capture);
          return yield* dependencies.bindings.commitLinkedArtifact({
            accessSetting: accessSettings.accountRequired,
            artifactId: dependencies.ids.artifactId(),
            authorizedByPrincipalId: command.principal.authorizedByPrincipalId,
            binding: {
              fingerprint: capture.fingerprint,
              path: canonical,
              verifiedAt: commitTime,
            },
            contentToken: dependencies.ids.contentToken(),
            createdAt: commitTime,
            idempotencyKey,
            inputDigest,
            manifest: upload.manifest,
            name,
            principalId: command.principal.id,
            projectId: project.id,
            source: {
              kind: "staged_upload",
              principalId: command.principal.id,
              projectId: project.id,
              uploadId: upload.id,
            },
            tags: [],
            versionId: dependencies.ids.versionId(),
          });
        });
      }
    },
  );

  const capturePublication = Effect.fn(
    "LinkedArtifactService.capturePublication",
  )(function*(input: {
    readonly artifactId: string;
    readonly binding: SourceBindingRecord;
    readonly expectedCurrentVersionId: string;
    readonly idempotencyKey: string;
    readonly principal: Principal;
    readonly projectId: string;
  }): Effect.fn.Return<LinkedPublication, LinkedArtifactFailure> {
    const idempotencyKey = yield* parseIdempotencyKey(input.idempotencyKey);
    const inputDigest = linkInputDigest({
      operation: "capture",
      path: input.binding.path,
      principalId: input.principal.id,
      projectId: input.projectId,
      value: `${input.artifactId}:${input.expectedCurrentVersionId}`,
    });
    const replayed = yield* dependencies.publication.findIdempotentPublication(
      input.projectId,
      idempotencyKey,
      inputDigest,
    );
    if (replayed !== null) {
      const binding = yield* requireBinding(input.projectId, input.artifactId);
      return {binding, published: replayed};
    }

    const current = yield* dependencies.publication.findVersionRecord(
      input.projectId,
      input.artifactId,
      input.expectedCurrentVersionId,
    );
    const entryPath = current === null
      ? fileNameOf(input.binding.path)
      : current.version.entryPath;
    const capture = yield* runEngine(() =>
      dependencies.engine.captureSource(
        input.binding.path,
        dependencies.configuration.spoolDirectory,
      )
    );
    const published = yield* commitCapture().pipe(
      Effect.ensuring(discardCapture(capture)),
    );
    const binding = yield* requireBinding(input.projectId, input.artifactId);
    return {binding, published};

    function commitCapture() {
      return Effect.gen(function*() {
        const upload = yield* stageCapture({
          capture,
          entryPath,
          mediaType: dependencies.engine.mediaTypeForPath(input.binding.path),
          principal: input.principal,
          projectId: input.projectId,
        });
        const commitTime = DateTime.formatIso(yield* dependencies.clock.now);
        yield* dependencies.publication.assertPublicationSourceReady(
          {
            kind: "staged_upload",
            principalId: input.principal.id,
            projectId: input.projectId,
            uploadId: upload.id,
          },
          upload.manifest.digest,
          commitTime,
        );
        yield* storeCaptureBlob(capture);
        return yield* dependencies.bindings.commitCapturedVersion({
          artifactId: input.artifactId,
          authorizedByPrincipalId: input.principal.authorizedByPrincipalId,
          binding: {
            fingerprint: capture.fingerprint,
            path: input.binding.path,
            verifiedAt: commitTime,
          },
          contentToken: dependencies.ids.contentToken(),
          createdAt: commitTime,
          expectedCurrentVersionId: input.expectedCurrentVersionId,
          idempotencyKey,
          inputDigest,
          manifest: upload.manifest,
          principalId: input.principal.id,
          projectId: input.projectId,
          source: {
            kind: "staged_upload",
            principalId: input.principal.id,
            projectId: input.projectId,
            uploadId: upload.id,
          },
          versionId: dependencies.ids.versionId(),
        });
      });
    }
  });

  const captureArtifact = Effect.fn("LinkedArtifactService.captureArtifact")(
    function*(command: CaptureArtifactCommand) {
      yield* authorization.requireVersionPublication(command.principal);
      const project = yield* resolveProject(
        command.principal,
        command.projectId,
      );
      const binding = yield* requireBinding(project.id, command.artifactId);
      const observation = yield* runEngine(() =>
        dependencies.engine.refreshFreshness(binding.path, binding.fingerprint)
      );
      if (observation.freshness === "in-sync") {
        const refreshed = yield* recordObservation(binding, observation);
        const current = yield* dependencies.publication.findCurrentVersion(
          project.id,
          command.artifactId,
        );
        if (current === null) {
          return yield* new ArtifactNotFound({
            message: "The artifact does not exist.",
          });
        }
        return {
          binding: refreshed,
          published: {...current, replayed: true},
        };
      }
      return yield* capturePublication({
        artifactId: command.artifactId,
        binding,
        expectedCurrentVersionId: command.expectedCurrentVersionId,
        idempotencyKey: command.idempotencyKey,
        principal: command.principal,
        projectId: project.id,
      });
    },
  );

  const captureForComment = Effect.fn(
    "LinkedArtifactService.captureForComment",
  )(function*(command: CaptureForCommentCommand): Effect.fn.Return<
    {readonly versionId: string} | null,
    LinkedCommentCaptureFailure
  > {
    const binding = yield* dependencies.bindings.findSourceBinding(
      command.projectId,
      command.artifactId,
    );
    if (binding === null) return null;
    const observation = yield* runEngine(() =>
      dependencies.engine.refreshFreshness(binding.path, binding.fingerprint)
    );
    if (observation.freshness !== "modified") {
      yield* recordObservation(binding, observation);
      return null;
    }
    const current = yield* dependencies.publication.findCurrentVersion(
      command.projectId,
      command.artifactId,
    );
    if (current === null) return null;
    const publication = yield* capturePublication({
      artifactId: command.artifactId,
      binding,
      expectedCurrentVersionId: current.version.id,
      idempotencyKey: commentCaptureKey(command.idempotencyKey),
      principal: command.principal,
      projectId: command.projectId,
    });
    return {versionId: publication.published.version.id};
  });

  const relinkArtifact = Effect.fn("LinkedArtifactService.relinkArtifact")(
    function*(command: RelinkArtifactCommand) {
      yield* authorization.requireVersionPublication(command.principal);
      const project = yield* resolveProject(
        command.principal,
        command.projectId,
      );
      yield* requireBinding(project.id, command.artifactId);
      const idempotencyKey = yield* parseIdempotencyKey(command.idempotencyKey);
      const canonical = yield* runLadder(command.path);
      const capture = yield* runEngine(() =>
        dependencies.engine.captureSource(
          canonical,
          dependencies.configuration.spoolDirectory,
        )
      );
      yield* discardCapture(capture);
      if (capture.sha256 !== command.expectedSha256) {
        return yield* new InvalidLinkPath({
          message:
            "The relink target's content does not match the expected hash.",
        });
      }
      const relinkedAt = DateTime.formatIso(yield* dependencies.clock.now);
      return yield* dependencies.bindings.relinkSource({
        artifactId: command.artifactId,
        authorizedByPrincipalId: command.principal.authorizedByPrincipalId,
        binding: {
          fingerprint: capture.fingerprint,
          path: canonical,
          verifiedAt: relinkedAt,
        },
        createdAt: relinkedAt,
        idempotencyKey,
        inputDigest: linkInputDigest({
          operation: "relink",
          path: canonical,
          principalId: command.principal.id,
          projectId: project.id,
          value: `${command.artifactId}:${command.expectedSha256}`,
        }),
        principalId: command.principal.id,
        projectId: project.id,
      });
    },
  );

  const recordObservation = Effect.fn(
    "LinkedArtifactService.recordObservation",
  )(function*(
    binding: SourceBindingRecord,
    observation: SourceObservation,
  ): Effect.fn.Return<SourceBindingRecord, ArtifactRepositoryFailure> {
    if (observation.freshness === binding.freshness) return binding;
    const verifiedAt = DateTime.formatIso(yield* dependencies.clock.now);
    return yield* dependencies.bindings.recordSourceFreshness({
      artifactId: binding.artifactId,
      freshness: observation.freshness,
      projectId: binding.projectId,
      verifiedAt,
    });
  });

  const observeBinding = Effect.fn("LinkedArtifactService.observeBinding")(
    function*(command: LinkedArtifactReadCommand) {
      yield* authorization.requireArtifactRead(command.principal);
      const project = yield* resolveProject(
        command.principal,
        command.projectId,
      );
      const binding = yield* dependencies.bindings.findSourceBinding(
        project.id,
        command.artifactId,
      );
      if (binding === null) return null;
      const observation = yield* runEngine(() =>
        dependencies.engine.refreshFreshness(binding.path, binding.fingerprint)
      ).pipe(
        Effect.catch(() =>
          Effect.succeed<SourceObservation>({
            fingerprint: null,
            freshness: "unreadable",
          })
        ),
      );
      return yield* recordObservation(binding, observation);
    },
  );

  const issueLiveBootstrap = Effect.fn(
    "LinkedArtifactService.issueLiveBootstrap",
  )(function*(command: LinkedArtifactReadCommand): Effect.fn.Return<
    IssuedLiveBootstrap,
    LinkedArtifactFailure
  > {
    const project = yield* resolveProject(
      command.principal,
      command.projectId,
    );
    const current = yield* dependencies.publication.findCurrentVersion(
      project.id,
      command.artifactId,
    );
    if (current === null) {
      return yield* new ArtifactNotFound({
        message: "The artifact does not exist.",
      });
    }
    yield* authorization.requireContentSession(
      command.principal,
      current.artifact,
    );
    yield* requireBinding(project.id, command.artifactId);
    const contentToken = liveContentToken(command.artifactId);
    if (contentToken === null) {
      return yield* Effect.die(
        new Error("The artifact identity cannot name a live origin."),
      );
    }
    const now = yield* dependencies.clock.now;
    const secret = dependencies.secrets.issue();
    const expiresAt = DateTime.formatIso(
      DateTime.addDuration(now, liveBootstrapLifetimeMilliseconds),
    );
    yield* dependencies.liveSessions.createContentBootstrap({
      artifactId: command.artifactId,
      contentToken,
      createdAt: DateTime.formatIso(now),
      expiresAt,
      principalId: command.principal.id,
      projectId: project.id,
      tokenDigest: secret.digest,
      versionId: current.version.id,
    });
    return {contentToken, expiresAt, token: secret.token};
  });

  const authorizeLiveRead = Effect.fn(
    "LinkedArtifactService.authorizeLiveRead",
  )(function*(command: AuthorizeLiveReadCommand): Effect.fn.Return<
    LiveReadGrant,
    ArtifactNotFound | ContentSessionRequired | ArtifactRepositoryFailure
  > {
    if (command.sessionToken === null) {
      return yield* liveSessionRequired();
    }
    const now = DateTime.formatIso(yield* dependencies.clock.now);
    const session = yield* dependencies.liveSessions.findContentSession(
      dependencies.secrets.digest(command.sessionToken),
      command.liveToken,
      now,
    );
    if (session === null) {
      return yield* liveSessionRequired();
    }
    const binding = yield* dependencies.bindings.findSourceBinding(
      session.projectId,
      session.artifactId,
    );
    if (binding === null) {
      return yield* new ArtifactNotFound({
        message: "The artifact does not exist.",
      });
    }
    const current = yield* dependencies.publication.findCurrentVersion(
      session.projectId,
      session.artifactId,
    );
    if (current === null) {
      return yield* new ArtifactNotFound({
        message: "The artifact does not exist.",
      });
    }
    const saved = yield* dependencies.publication.findVersionRecord(
      session.projectId,
      session.artifactId,
      current.version.id,
    );
    if (saved === null) {
      return yield* new ArtifactNotFound({
        message: "The artifact does not exist.",
      });
    }
    const entry = saved.manifest.entries.find(
      (candidate) => candidate.path === saved.version.entryPath,
    );
    if (entry === undefined) {
      return yield* new ArtifactNotFound({
        message: "The artifact does not exist.",
      });
    }
    const observation = yield* runEngine(() =>
      dependencies.engine.refreshFreshness(binding.path, binding.fingerprint)
    ).pipe(
      Effect.catch(() =>
        Effect.succeed<SourceObservation>({
          fingerprint: null,
          freshness: "unreadable",
        })
      ),
    );
    if (
      observation.freshness === "missing"
      || observation.freshness === "unreadable"
    ) {
      return {entry, freshness: observation.freshness, kind: "captured"};
    }
    const opened = yield* Effect.tryPromise({
      catch: classifyEngineFailure,
      try: () => dependencies.engine.openVerifiedSource(binding.path),
    }).pipe(Effect.catch(() => Effect.succeed(null)));
    if (opened === null) {
      // The source raced away between the stat and the open; the captured
      // version keeps the live view readable, never erroring the artifact.
      return {entry, freshness: "missing", kind: "captured"};
    }
    return {
      freshness: observation.freshness,
      kind: "live",
      mediaType: entry.mediaType,
      source: opened,
    };
  });

  return LinkedArtifactService.of({
    authorizeLiveRead,
    captureArtifact,
    captureForComment,
    describeCapability,
    issueLiveBootstrap,
    linkArtifact,
    observeBinding,
    relinkArtifact,
  });
}

const describeCapability = () => Effect.succeed({linkedArtifacts: true});

const discardCapture = (capture: CapturedSourceSpool) =>
  Effect.tryPromise({
    catch: (cause) =>
      new ArtifactRepositoryFailure({cause, operation: "linkedSource"}),
    try: () => capture.discard(),
  }).pipe(Effect.catch(() => Effect.void));

type EngineFailure =
  | InvalidLinkPath
  | LinkPathOutsideRoots
  | LinkPathProtected
  | SourceDrifted
  | SourceMissing
  | SourceUnreadable
  | ArtifactRepositoryFailure;

/** The engine raises only its own tagged failures; anything else is a fault. */
function classifyEngineFailure(cause: unknown): EngineFailure {
  if (cause instanceof Error && isArtifactServerFailure(cause)) {
    if (
      cause._tag === "InvalidLinkPath"
      || cause._tag === "LinkPathOutsideRoots"
      || cause._tag === "LinkPathProtected"
      || cause._tag === "SourceDrifted"
      || cause._tag === "SourceMissing"
      || cause._tag === "SourceUnreadable"
      || cause._tag === "ArtifactRepositoryFailure"
    ) {
      return cause;
    }
  }
  return new ArtifactRepositoryFailure({cause, operation: "linkedSource"});
}

function liveSessionRequired(): Effect.Effect<never, ContentSessionRequired> {
  return Effect.fail(
    new ContentSessionRequired({
      message: "The live view requires an authorized content session.",
    }),
  );
}

function fileNameOf(canonicalPath: string): string {
  const separator = Math.max(
    canonicalPath.lastIndexOf("/"),
    canonicalPath.lastIndexOf("\\"),
  );
  return separator < 0 ? canonicalPath : canonicalPath.slice(separator + 1);
}

/** Derive one deterministic capture key from the comment's own key. */
function commentCaptureKey(idempotencyKey: string): string {
  const digest = createHash("sha256")
    .update(`comment-capture:${idempotencyKey}`)
    .digest("hex");
  return `capture-${digest.slice(0, 48)}`;
}

interface LinkDigestInput {
  readonly operation: "capture" | "link" | "relink";
  readonly path: string;
  readonly principalId: string;
  readonly projectId: string;
  readonly value: string;
}

function linkInputDigest(input: LinkDigestInput): string {
  return createHash("sha256").update(JSON.stringify(input)).digest("hex");
}
