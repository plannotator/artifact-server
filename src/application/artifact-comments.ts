import {Context, DateTime, Effect, Layer, Option, Schema} from "effect";

import type {ApplicationClock} from "./application-clock.js";
import {
  type AuthorizationOperations,
  AuthorizationService,
} from "./authorization.js";
import {parseIdempotencyKey} from "./idempotency-key.js";
import {
  type LinkedCommentCaptureFailure,
  LinkedArtifactService,
} from "./linked-artifacts.js";
import {
  type ProjectManagementFailure,
  ProjectManagementService,
} from "./project-management.js";
import {
  ArtifactNotFound,
  type ArtifactRepositoryFailure,
  AuthorizationDenied,
  CommentNotFound,
  type CommentResolved,
  type IdempotencyConflict,
  InvalidComment,
  type InvalidIdempotencyKey,
  InvalidPagination,
  VersionNotFound,
} from "../core/errors.js";
import {
  isHumanAdministrator,
  hasCapability,
  principalCapabilities,
  type Principal,
} from "../core/identity.js";
import {
  commentThreadStates,
  dispatchedThreadFilters,
  type ArtifactRecord,
  type ArtifactVersion,
  type CommentAuthor,
  type CommentClearScope,
  type DispatchedThreadFilter,
  type CommentReplyCreation,
  type CommentReplyRecord,
  type CommentThreadClearing,
  type CommentThreadCreation,
  type CommentThreadDeletion,
  type CommentThreadPage,
  type CommentThreadRecord,
  type CommentThreadState,
  type PageCursor,
} from "../core/model.js";
import type {
  ClearCommentThreads,
  CreateCommentReply,
  CreateCommentThread,
  DeleteCommentReply,
  DeleteCommentThread,
  IdGenerator,
  ListCommentThreads,
  UpdateCommentReply,
  UpdateCommentThread,
} from "../core/ports.js";
import {
  maximumCommentAnchorBytes,
  maximumCommentBodyCharacters,
  maximumCommentPageSize,
} from "../core/publishing-limits.js";

/** Outbound failures surfaced by comment persistence. */
export type CommentRepositoryFailure =
  | ArtifactNotFound
  | ArtifactRepositoryFailure
  | CommentNotFound
  | CommentResolved
  | IdempotencyConflict
  | InvalidComment
  | VersionNotFound;

const anchorUnitSchema = Schema.Finite.check(
  Schema.isBetween({maximum: 1, minimum: 0}),
);
const carriesAnchorPoint = Schema.is(Schema.Struct({point: Schema.Unknown}));
const carriesValidAnchorPoint = Schema.is(Schema.Struct({
  point: Schema.Struct({x: anchorUnitSchema, y: anchorUnitSchema}),
}));

/** One opaque client-owned anchor presented for validation or storage. */
export interface CommentAnchorInput {
  readonly anchor: unknown;
}

/** One comment thread together with every reply it carries. */
export interface CommentThreadDetails {
  readonly replies: readonly CommentReplyRecord[];
  readonly thread: CommentThreadRecord;
}

/** Input shared by every comment operation scoped to one artifact. */
export interface ReadArtifactCommentsCommand {
  readonly artifactId: string;
  readonly principal: Principal;
  readonly projectId: string | null;
}

/** Input shared by every operation scoped to one existing comment thread. */
export interface ReadCommentThreadCommand extends ReadArtifactCommentsCommand {
  readonly threadId: string;
}

/** Input shared by every operation scoped to one existing reply. */
export interface ReadCommentReplyCommand extends ReadCommentThreadCommand {
  readonly replyId: string;
}

/** Input for opening one comment thread on one exact saved version. */
export interface CreateCommentThreadCommand extends ReadArtifactCommentsCommand {
  readonly anchor: unknown;
  readonly body: string;
  readonly idempotencyKey: string;
  readonly path: string | null;
  readonly versionId: string;
}

/** Input for listing one artifact's comment threads. */
export interface ListCommentThreadsCommand extends ReadArtifactCommentsCommand {
  readonly cursor: PageCursor | null;
  /** Dispatched-thread visibility; an omitted filter excludes them. */
  readonly dispatched?: DispatchedThreadFilter;
  readonly limit: number;
  readonly since: string | null;
  readonly state: CommentThreadState | null;
  readonly versionId: string | null;
}

/** Input for changing one comment thread's body, anchor, or state. */
export interface UpdateCommentThreadCommand extends ReadCommentThreadCommand {
  readonly anchor?: unknown;
  readonly body?: string;
  readonly state?: CommentThreadState;
}

/** Input for appending one reply to one open comment thread. */
export interface CreateCommentReplyCommand extends ReadCommentThreadCommand {
  readonly body: string;
  readonly idempotencyKey: string;
}

/** Input for changing one reply's body. */
export interface UpdateCommentReplyCommand extends ReadCommentReplyCommand {
  readonly body: string;
}

/** Input for clearing one artifact's matching comment threads in bulk. */
export interface ClearCommentThreadsCommand extends ReadArtifactCommentsCommand {
  readonly state: CommentClearScope;
  /** Restricts the clear to threads on one saved version when present. */
  readonly versionId: string | null;
}

/** Persistence required by comment threads and replies. */
export interface ArtifactCommentRepository {
  readonly clearThreads: (
    command: ClearCommentThreads,
  ) => Effect.Effect<CommentThreadClearing, CommentRepositoryFailure>;
  readonly createReply: (
    command: CreateCommentReply,
  ) => Effect.Effect<CommentReplyCreation, CommentRepositoryFailure>;
  readonly createThread: (
    command: CreateCommentThread,
  ) => Effect.Effect<CommentThreadCreation, CommentRepositoryFailure>;
  readonly deleteReply: (
    command: DeleteCommentReply,
  ) => Effect.Effect<void, CommentRepositoryFailure>;
  readonly deleteThread: (
    command: DeleteCommentThread,
  ) => Effect.Effect<CommentThreadDeletion, CommentRepositoryFailure>;
  readonly findArtifact: (
    projectId: string,
    artifactId: string,
  ) => Effect.Effect<ArtifactRecord | null, CommentRepositoryFailure>;
  readonly findVersionRecord: (
    projectId: string,
    artifactId: string,
    versionId: string,
  ) => Effect.Effect<ArtifactVersion | null, CommentRepositoryFailure>;
  readonly findThread: (
    projectId: string,
    artifactId: string,
    threadId: string,
  ) => Effect.Effect<CommentThreadRecord | null, CommentRepositoryFailure>;
  readonly listReplies: (
    threadId: string,
  ) => Effect.Effect<readonly CommentReplyRecord[], CommentRepositoryFailure>;
  readonly listThreads: (
    command: ListCommentThreads,
  ) => Effect.Effect<CommentThreadPage, CommentRepositoryFailure>;
  readonly updateReply: (
    command: UpdateCommentReply,
  ) => Effect.Effect<CommentReplyRecord, CommentRepositoryFailure>;
  readonly updateThread: (
    command: UpdateCommentThread,
  ) => Effect.Effect<CommentThreadRecord, CommentRepositoryFailure>;
  readonly versionContainsPath: (
    projectId: string,
    versionId: string,
    path: string,
  ) => Effect.Effect<boolean, CommentRepositoryFailure>;
}

/** Dependencies used to construct comment operations. */
export interface ArtifactCommentDependencies {
  readonly clock: ApplicationClock;
  readonly ids: IdGenerator;
  readonly installationId: string;
  readonly repository: ArtifactCommentRepository;
}

/** Expected failures produced by comment operations. */
export type ArtifactCommentFailure =
  | ArtifactNotFound
  | ArtifactRepositoryFailure
  | AuthorizationDenied
  | CommentNotFound
  | CommentResolved
  | IdempotencyConflict
  | InvalidComment
  | InvalidIdempotencyKey
  | InvalidPagination
  | ProjectManagementFailure
  | VersionNotFound
  | LinkedCommentCaptureFailure;

interface ArtifactCommentOperations {
  readonly clearThreads: (
    command: ClearCommentThreadsCommand,
  ) => Effect.Effect<CommentThreadClearing, ArtifactCommentFailure>;
  readonly createReply: (
    command: CreateCommentReplyCommand,
  ) => Effect.Effect<CommentReplyCreation, ArtifactCommentFailure>;
  readonly createThread: (
    command: CreateCommentThreadCommand,
  ) => Effect.Effect<CommentThreadCreation, ArtifactCommentFailure>;
  readonly deleteReply: (
    command: ReadCommentReplyCommand,
  ) => Effect.Effect<void, ArtifactCommentFailure>;
  readonly deleteThread: (
    command: ReadCommentThreadCommand,
  ) => Effect.Effect<CommentThreadDeletion, ArtifactCommentFailure>;
  readonly getThread: (
    command: ReadCommentThreadCommand,
  ) => Effect.Effect<CommentThreadDetails, ArtifactCommentFailure>;
  readonly listThreads: (
    command: ListCommentThreadsCommand,
  ) => Effect.Effect<CommentThreadPage, ArtifactCommentFailure>;
  readonly updateReply: (
    command: UpdateCommentReplyCommand,
  ) => Effect.Effect<CommentReplyRecord, ArtifactCommentFailure>;
  readonly updateThread: (
    command: UpdateCommentThreadCommand,
  ) => Effect.Effect<CommentThreadRecord, ArtifactCommentFailure>;
}

/** Owns comment thread and reply policy for one installation. */
export class ArtifactCommentService extends Context.Service<
  ArtifactCommentService,
  ArtifactCommentOperations
>()("artifact-server/application/ArtifactCommentService") {
  /** Construct comment operations from deployment-neutral persistence. */
  static readonly layer = (
    dependencies: ArtifactCommentDependencies,
  ): Layer.Layer<
    ArtifactCommentService,
    never,
    AuthorizationService | LinkedArtifactService | ProjectManagementService
  > =>
    Layer.effect(
      ArtifactCommentService,
      Effect.gen(function*() {
        const authorization = yield* AuthorizationService;
        const projects = yield* ProjectManagementService;
        const linked = yield* LinkedArtifactService;
        return makeArtifactCommentService(
          dependencies,
          authorization,
          projects,
          linked,
        );
      }),
    );
}

function makeArtifactCommentService(
  dependencies: ArtifactCommentDependencies,
  authorization: AuthorizationOperations,
  projects: ProjectManagementService["Service"],
  linked: LinkedArtifactService["Service"],
): ArtifactCommentOperations {
  const resolveProjectForRead = Effect.fn(
    "ArtifactCommentService.resolveProjectForRead",
  )(function*(principal: Principal, projectId: string | null) {
    return projectId === null
      ? yield* projects.resolveActiveProject({principal, projectId})
      : yield* projects.getProject({principal, projectId});
  });

  const resolveProjectForWrite = Effect.fn(
    "ArtifactCommentService.resolveProjectForWrite",
  )(function*(principal: Principal, projectId: string | null) {
    return yield* projects.resolveActiveProject({principal, projectId});
  });

  const requireArtifact = Effect.fn("ArtifactCommentService.requireArtifact")(
    function*(projectId: string, artifactId: string): Effect.fn.Return<
      ArtifactRecord,
      CommentRepositoryFailure
    > {
      const artifact = yield* dependencies.repository.findArtifact(
        projectId,
        artifactId,
      );
      if (artifact !== null) return artifact;
      return yield* new ArtifactNotFound({message: "The artifact does not exist."});
    },
  );

  const requireVersion = Effect.fn("ArtifactCommentService.requireVersion")(
    function*(
      projectId: string,
      artifactId: string,
      versionId: string,
    ): Effect.fn.Return<ArtifactVersion, CommentRepositoryFailure> {
      const version = yield* dependencies.repository.findVersionRecord(
        projectId,
        artifactId,
        versionId,
      );
      if (version !== null) return version;
      return yield* new VersionNotFound({
        message: "The saved version does not exist on this artifact.",
      });
    },
  );

  const requireThread = Effect.fn("ArtifactCommentService.requireThread")(
    function*(
      projectId: string,
      artifactId: string,
      threadId: string,
    ): Effect.fn.Return<CommentThreadRecord, CommentRepositoryFailure> {
      const thread = yield* dependencies.repository.findThread(
        projectId,
        artifactId,
        threadId,
      );
      if (thread !== null) return thread;
      return yield* new CommentNotFound({
        message: "The comment thread does not exist.",
      });
    },
  );

  const requireReply = Effect.fn("ArtifactCommentService.requireReply")(
    function*(threadId: string, replyId: string): Effect.fn.Return<
      CommentReplyRecord,
      CommentRepositoryFailure
    > {
      const replies = yield* dependencies.repository.listReplies(threadId);
      const reply = replies.find((candidate) => candidate.id === replyId);
      if (reply !== undefined) return reply;
      return yield* new CommentNotFound({
        message: "The comment reply does not exist.",
      });
    },
  );

  const requirePageSize = Effect.fn("ArtifactCommentService.requirePageSize")(
    function*(limit: number) {
      if (
        Number.isSafeInteger(limit) && limit >= 1 &&
        limit <= maximumCommentPageSize
      ) {
        return limit;
      }
      return yield* new InvalidPagination({
        message:
          `A comment page must contain between 1 and ${maximumCommentPageSize} records.`,
      });
    },
  );

  // Stored timestamps are canonical millisecond ISO text and every repository
  // compares `since` against them as text, so a second-precision instant would
  // sort after the whole second it names and hide those updates.
  const requireSince = Effect.fn("ArtifactCommentService.requireSince")(
    function*(since: string | null) {
      if (since === null) return null;
      const parsed = DateTime.make(since);
      if (Option.isNone(parsed)) {
        return yield* new InvalidPagination({
          message: "A comment change filter must be an ISO 8601 instant.",
        });
      }
      return DateTime.formatIso(parsed.value);
    },
  );

  const requireBody = Effect.fn("ArtifactCommentService.requireBody")(
    function*(body: string): Effect.fn.Return<string, InvalidComment> {
      const trimmed = body.trim();
      if (
        trimmed.length >= 1 && trimmed.length <= maximumCommentBodyCharacters
      ) {
        return trimmed;
      }
      return yield* new InvalidComment({
        message:
          `A comment body must contain between 1 and ${maximumCommentBodyCharacters} characters.`,
      });
    },
  );

  const requireAnchor = Effect.fn("ArtifactCommentService.requireAnchor")(
    function*(input: CommentAnchorInput): Effect.fn.Return<
      string | null,
      InvalidComment
    > {
      if (input.anchor === null || input.anchor === undefined) return null;
      const serialized = JSON.stringify(input.anchor);
      if (
        serialized === undefined ||
        Buffer.byteLength(serialized, "utf8") > maximumCommentAnchorBytes
      ) {
        return yield* new InvalidComment({
          message:
            `A comment anchor must serialize to at most ${maximumCommentAnchorBytes} bytes of JSON.`,
        });
      }
      if (
        carriesAnchorPoint(input.anchor) &&
        !carriesValidAnchorPoint(input.anchor)
      ) {
        return yield* new InvalidComment({
          message:
            "A comment anchor point must carry numeric x and y values between 0 and 1.",
        });
      }
      return serialized;
    },
  );

  const requireVersionPath = Effect.fn(
    "ArtifactCommentService.requireVersionPath",
  )(function*(
    projectId: string,
    versionId: string,
    path: string | null,
  ): Effect.fn.Return<string | null, CommentRepositoryFailure> {
    if (path === null) return null;
    const declared = yield* dependencies.repository.versionContainsPath(
      projectId,
      versionId,
      path,
    );
    if (declared) return path;
    return yield* new InvalidComment({
      message: "The comment path does not name a file in this saved version.",
    });
  });

  const requireCommentAuthor = Effect.fn(
    "ArtifactCommentService.requireCommentAuthor",
  )(function*(
    principal: Principal,
    author: CommentAuthor,
  ): Effect.fn.Return<CommentAuthor, AuthorizationDenied> {
    if (principal.id === author.principalId) return author;
    return yield* new AuthorizationDenied({
      message: "Only the author can change the words attributed to that author.",
    });
  });

  const requireCommentDeletionAuthority = Effect.fn(
    "ArtifactCommentService.requireCommentDeletionAuthority",
  )(function*(principal: Principal) {
    if (hasCapability(principal, principalCapabilities.manageAnyArtifact)) {
      return yield* authorization.requireArtifactManagement(principal);
    }
    return yield* authorization.requireCommentWrite(principal);
  });

  const requireCommentRemoval = Effect.fn(
    "ArtifactCommentService.requireCommentRemoval",
  )(function*(
    principal: Principal,
    author: CommentAuthor,
  ): Effect.fn.Return<CommentAuthor, AuthorizationDenied> {
    if (
      principal.id === author.principalId ||
      isHumanAdministrator(principal) ||
      hasCapability(principal, principalCapabilities.manageAnyArtifact)
    ) {
      return author;
    }
    return yield* new AuthorizationDenied({
      message: "The authenticated principal cannot delete this comment.",
    });
  });

  const createThread = Effect.fn("ArtifactCommentService.createThread")(
    function*(command: CreateCommentThreadCommand) {
      const project = yield* resolveProjectForWrite(
        command.principal,
        command.projectId,
      );
      yield* authorization.requireCommentWrite(command.principal);
      const artifact = yield* requireArtifact(project.id, command.artifactId);
      const requestedVersion = yield* requireVersion(
        project.id,
        artifact.id,
        command.versionId,
      );
      const body = yield* requireBody(command.body);
      yield* requireAnchor(command);
      yield* requireVersionPath(
        project.id,
        requestedVersion.version.id,
        command.path,
      );
      const idempotencyKey = yield* parseIdempotencyKey(command.idempotencyKey);
      // A thread must anchor to bytes that hold still: a drifted linked
      // source is captured first, attributed to the commenting principal,
      // and the thread lands on the resulting version (LNK-008). A capture
      // failure aborts this whole request before any thread row exists. All
      // caller-controlled fields are validated first so a rejected comment
      // cannot leave behind a capture version as a side effect.
      const captured = yield* linked.captureForComment({
        artifactId: artifact.id,
        idempotencyKey: command.idempotencyKey,
        principal: command.principal,
        projectId: project.id,
      });
      const versionId = captured?.versionId ?? requestedVersion.version.id;
      const createdAt = DateTime.formatIso(yield* dependencies.clock.now);
      return yield* dependencies.repository.createThread({
        anchor: command.anchor ?? null,
        artifactId: artifact.id,
        author: commentAuthor(command.principal),
        body,
        createdAt,
        id: dependencies.ids.commentThreadId(),
        idempotencyKey,
        installationId: dependencies.installationId,
        path: command.path,
        projectId: project.id,
        versionId,
      });
    },
  );

  const listThreads = Effect.fn("ArtifactCommentService.listThreads")(
    function*(command: ListCommentThreadsCommand) {
      const limit = yield* requirePageSize(command.limit);
      const since = yield* requireSince(command.since);
      const project = yield* resolveProjectForRead(
        command.principal,
        command.projectId,
      );
      yield* authorization.requireCommentRead(command.principal);
      const artifact = yield* requireArtifact(project.id, command.artifactId);
      return yield* dependencies.repository.listThreads({
        artifactId: artifact.id,
        cursor: command.cursor,
        // The default hides dispatched threads: this is what keeps a send
        // consumptive on every existing surface without a client change.
        dispatched: command.dispatched ?? dispatchedThreadFilters.exclude,
        limit,
        projectId: project.id,
        since,
        state: command.state,
        versionId: command.versionId,
      });
    },
  );

  const getThread = Effect.fn("ArtifactCommentService.getThread")(
    function*(command: ReadCommentThreadCommand) {
      const project = yield* resolveProjectForRead(
        command.principal,
        command.projectId,
      );
      yield* authorization.requireCommentRead(command.principal);
      const artifact = yield* requireArtifact(project.id, command.artifactId);
      const thread = yield* requireThread(
        project.id,
        artifact.id,
        command.threadId,
      );
      const replies = yield* dependencies.repository.listReplies(thread.id);
      return {replies, thread};
    },
  );

  const updateThread = Effect.fn("ArtifactCommentService.updateThread")(
    function*(command: UpdateCommentThreadCommand) {
      const project = yield* resolveProjectForWrite(
        command.principal,
        command.projectId,
      );
      yield* authorization.requireCommentWrite(command.principal);
      const artifact = yield* requireArtifact(project.id, command.artifactId);
      const thread = yield* requireThread(
        project.id,
        artifact.id,
        command.threadId,
      );
      if (
        command.anchor === undefined && command.body === undefined &&
        command.state === undefined
      ) {
        return yield* new InvalidComment({
          message: "A comment update must change a body, an anchor, or a state.",
        });
      }
      if (command.anchor !== undefined || command.body !== undefined) {
        yield* requireCommentAuthor(command.principal, thread.author);
      }
      const body = command.body === undefined
        ? null
        : yield* requireBody(command.body);
      if (command.anchor !== undefined) {
        yield* requireAnchor({anchor: command.anchor});
      }
      const updatedAt = DateTime.formatIso(yield* dependencies.clock.now);
      return yield* dependencies.repository.updateThread({
        anchor: command.anchor === undefined ? null : {anchor: command.anchor},
        artifactId: artifact.id,
        authorizedByPrincipalId: command.principal.authorizedByPrincipalId,
        body,
        principalId: command.principal.id,
        projectId: project.id,
        state: command.state === undefined
          ? null
          : stateChange(command.state, command.principal, updatedAt),
        threadId: thread.id,
        updatedAt,
      });
    },
  );

  const deleteThread = Effect.fn("ArtifactCommentService.deleteThread")(
    function*(command: ReadCommentThreadCommand) {
      const project = yield* resolveProjectForWrite(
        command.principal,
        command.projectId,
      );
      yield* requireCommentDeletionAuthority(command.principal);
      const artifact = yield* requireArtifact(project.id, command.artifactId);
      const thread = yield* requireThread(
        project.id,
        artifact.id,
        command.threadId,
      );
      yield* requireCommentRemoval(command.principal, thread.author);
      const deletedAt = DateTime.formatIso(yield* dependencies.clock.now);
      return yield* dependencies.repository.deleteThread({
        artifactId: artifact.id,
        authorizedByPrincipalId: command.principal.authorizedByPrincipalId,
        deletedAt,
        principalId: command.principal.id,
        projectId: project.id,
        threadId: thread.id,
      });
    },
  );

  const clearThreads = Effect.fn("ArtifactCommentService.clearThreads")(
    function*(command: ClearCommentThreadsCommand) {
      const project = yield* resolveProjectForWrite(
        command.principal,
        command.projectId,
      );
      // Bulk clear shares the dispatch-send rule: a direct human member, or
      // the artifact-management capability (spec §2).
      yield* authorization.requireDispatchSend(command.principal);
      const artifact = yield* requireArtifact(project.id, command.artifactId);
      if (command.versionId !== null) {
        yield* requireVersion(project.id, artifact.id, command.versionId);
      }
      const clearedAt = DateTime.formatIso(yield* dependencies.clock.now);
      return yield* dependencies.repository.clearThreads({
        artifactId: artifact.id,
        authorizedByPrincipalId: command.principal.authorizedByPrincipalId,
        clearedAt,
        principalId: command.principal.id,
        projectId: project.id,
        scope: command.state,
        versionId: command.versionId,
      });
    },
  );

  const createReply = Effect.fn("ArtifactCommentService.createReply")(
    function*(command: CreateCommentReplyCommand) {
      const project = yield* resolveProjectForWrite(
        command.principal,
        command.projectId,
      );
      yield* authorization.requireCommentWrite(command.principal);
      const artifact = yield* requireArtifact(project.id, command.artifactId);
      const thread = yield* requireThread(
        project.id,
        artifact.id,
        command.threadId,
      );
      const body = yield* requireBody(command.body);
      const idempotencyKey = yield* parseIdempotencyKey(command.idempotencyKey);
      const createdAt = DateTime.formatIso(yield* dependencies.clock.now);
      return yield* dependencies.repository.createReply({
        artifactId: artifact.id,
        author: commentAuthor(command.principal),
        body,
        createdAt,
        id: dependencies.ids.commentReplyId(),
        idempotencyKey,
        projectId: project.id,
        threadId: thread.id,
      });
    },
  );

  const updateReply = Effect.fn("ArtifactCommentService.updateReply")(
    function*(command: UpdateCommentReplyCommand) {
      const project = yield* resolveProjectForWrite(
        command.principal,
        command.projectId,
      );
      yield* authorization.requireCommentWrite(command.principal);
      const artifact = yield* requireArtifact(project.id, command.artifactId);
      const thread = yield* requireThread(
        project.id,
        artifact.id,
        command.threadId,
      );
      const reply = yield* requireReply(thread.id, command.replyId);
      yield* requireCommentAuthor(command.principal, reply.author);
      const body = yield* requireBody(command.body);
      const updatedAt = DateTime.formatIso(yield* dependencies.clock.now);
      return yield* dependencies.repository.updateReply({
        artifactId: artifact.id,
        authorizedByPrincipalId: command.principal.authorizedByPrincipalId,
        body,
        principalId: command.principal.id,
        projectId: project.id,
        replyId: reply.id,
        threadId: thread.id,
        updatedAt,
      });
    },
  );

  const deleteReply = Effect.fn("ArtifactCommentService.deleteReply")(
    function*(command: ReadCommentReplyCommand) {
      const project = yield* resolveProjectForWrite(
        command.principal,
        command.projectId,
      );
      yield* requireCommentDeletionAuthority(command.principal);
      const artifact = yield* requireArtifact(project.id, command.artifactId);
      const thread = yield* requireThread(
        project.id,
        artifact.id,
        command.threadId,
      );
      const reply = yield* requireReply(thread.id, command.replyId);
      yield* requireCommentRemoval(command.principal, reply.author);
      const deletedAt = DateTime.formatIso(yield* dependencies.clock.now);
      yield* dependencies.repository.deleteReply({
        artifactId: artifact.id,
        authorizedByPrincipalId: command.principal.authorizedByPrincipalId,
        deletedAt,
        principalId: command.principal.id,
        projectId: project.id,
        replyId: reply.id,
        threadId: thread.id,
      });
    },
  );

  return ArtifactCommentService.of({
    clearThreads,
    createReply,
    createThread,
    deleteReply,
    deleteThread,
    getThread,
    listThreads,
    updateReply,
    updateThread,
  });
}

function commentAuthor(principal: Principal): CommentAuthor {
  return {
    authorizedByPrincipalId: principal.authorizedByPrincipalId,
    displayName: principal.displayName,
    principalId: principal.id,
    principalKind: principal.kind,
  };
}

function stateChange(
  state: CommentThreadState,
  principal: Principal,
  changedAt: string,
): UpdateCommentThread["state"] {
  return state === commentThreadStates.resolved
    ? {resolvedAt: changedAt, resolvedBy: commentAuthor(principal), state}
    : {resolvedAt: null, resolvedBy: null, state};
}
