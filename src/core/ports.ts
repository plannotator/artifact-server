import type {
  AccessSetting,
  AgentDispatchCreation,
  AgentDispatchPage,
  AgentDispatchRecord,
  AgentDispatchState,
  ArtifactActionPage,
  ArtifactDeletion,
  ArtifactPage,
  ArtifactState,
  ArtifactVersion,
  ArtifactRecord,
  CanonicalManifest,
  CommentAuthor,
  DispatchedThreadFilter,
  CommentReplyCreation,
  CommentReplyRecord,
  CommentThreadCreation,
  CommentThreadDeletion,
  CommentThreadPage,
  CommentThreadRecord,
  CommentThreadState,
  ContentBootstrapRecord,
  ContentSessionRecord,
  AgentBeaconState,
  AgentCapabilities,
  CommentClearScope,
  CommentThreadClearing,
  PageCursor,
  PublishedVersion,
  ProjectRecord,
  RegisteredAgentKind,
  RegisteredAgentPresence,
  RegisteredAgentRecord,
  SourceBindingRecord,
  SourceFreshness,
  StagedUpload,
  VersionRecord,
  VersionContent,
} from "./model.js";

export interface StoredBlob {
  readonly sha256: string;
  readonly size: number;
}

export interface OpenedBlob extends StoredBlob {
  readonly body: ReadableStream<Uint8Array>;
}

/** One inclusive byte range inside a stored blob. */
export interface BlobByteRange {
  readonly endInclusive: number;
  readonly start: number;
}

/** A ranged blob read whose size remains the complete stored-object size. */
export interface OpenedBlobRange extends StoredBlob {
  readonly body: ReadableStream<Uint8Array>;
  readonly range: BlobByteRange;
}

export interface BlobWrite extends StoredBlob {
  readonly body: ReadableStream<Uint8Array>;
  readonly signal?: AbortSignal;
}

export interface BlobStore {
  inspect(sha256: string): Promise<StoredBlob>;
  open(sha256: string): Promise<OpenedBlob>;
  openRange(sha256: string, range: BlobByteRange): Promise<OpenedBlobRange>;
  put(write: BlobWrite): Promise<StoredBlob>;
}

export interface StagedFileWrite extends BlobWrite {
  readonly storageToken: string;
  readonly uploadId: string;
}

export interface OpenedStagedFile {
  readonly body: ReadableStream<Uint8Array>;
  readonly size: number;
}

export interface StagingStore {
  open(uploadId: string, storageToken: string): Promise<OpenedStagedFile>;
  put(write: StagedFileWrite): Promise<StoredBlob>;
  remove(uploadId: string, storageToken: string): Promise<void>;
}

/** Exact staging objects selected from one expired, uncommitted upload. */
export interface ExpiredStagedUpload {
  readonly files: readonly {readonly storageToken: string}[];
  readonly id: string;
}

export interface PublicationSource {
  readonly kind: "staged_upload";
  readonly principalId: string;
  readonly projectId: string;
  readonly uploadId: string;
}

export interface CommitNewArtifact {
  readonly accessSetting: AccessSetting;
  readonly artifactId: string;
  readonly contentToken: string;
  readonly createdAt: string;
  readonly idempotencyKey: string;
  readonly inputDigest: string;
  readonly manifest: CanonicalManifest;
  readonly name: string;
  readonly principalId: string;
  readonly projectId: string;
  readonly authorizedByPrincipalId: string | null;
  readonly source: PublicationSource;
  readonly tags: readonly string[];
  readonly versionId: string;
}

export interface CommitArtifactVersion {
  readonly artifactId: string;
  readonly contentToken: string;
  readonly createdAt: string;
  readonly expectedCurrentVersionId: string;
  readonly idempotencyKey: string;
  readonly inputDigest: string;
  readonly manifest: CanonicalManifest;
  readonly principalId: string;
  readonly projectId: string;
  readonly authorizedByPrincipalId: string | null;
  readonly source: PublicationSource;
  readonly versionId: string;
}

/** Values used to atomically restore one existing saved version. */
export interface RestoreArtifactVersion {
  readonly artifactId: string;
  readonly authorizedByPrincipalId: string | null;
  readonly createdAt: string;
  readonly expectedCurrentVersionId: string;
  readonly idempotencyKey: string;
  readonly inputDigest: string;
  readonly principalId: string;
  readonly projectId: string;
  readonly versionId: string;
}

/** Values used to atomically change one artifact's read setting. */
export interface ChangeArtifactAccessSetting {
  readonly accessSetting: AccessSetting;
  readonly artifactId: string;
  readonly authorizedByPrincipalId: string | null;
  readonly createdAt: string;
  readonly expectedCurrentVersionId: string;
  readonly idempotencyKey: string;
  readonly inputDigest: string;
  readonly principalId: string;
  readonly projectId: string;
}

/** Values used to atomically replace one artifact's complete tag set. */
export interface ChangeArtifactTags {
  readonly artifactId: string;
  readonly authorizedByPrincipalId: string | null;
  readonly createdAt: string;
  readonly expectedCurrentVersionId: string;
  readonly idempotencyKey: string;
  readonly inputDigest: string;
  readonly principalId: string;
  readonly projectId: string;
  readonly tags: readonly string[];
}

/** Values used to atomically tombstone one artifact. */
export interface DeleteArtifact {
  readonly artifactId: string;
  readonly authorizedByPrincipalId: string | null;
  readonly createdAt: string;
  readonly expectedCurrentVersionId: string;
  readonly idempotencyKey: string;
  readonly inputDigest: string;
  readonly principalId: string;
  readonly projectId: string;
}

/** Values used to read one bounded page of active artifacts. */
export interface ListArtifacts {
  readonly cursor: PageCursor | null;
  readonly limit: number;
  readonly projectId: string;
  /** Normalized name-substring or exact-tag search, when supplied. */
  readonly search?: string | null;
  readonly tag: string | null;
}

/** Values used to read one bounded page of artifact actions. */
export interface ListArtifactActions {
  readonly artifactId: string;
  readonly cursor: PageCursor | null;
  readonly limit: number;
  readonly projectId: string;
}

/** Values used to create one comment thread on one exact saved version. */
export interface CreateCommentThread {
  /** Opaque client-owned anchor value, or null for an unanchored thread. */
  readonly anchor: unknown;
  readonly artifactId: string;
  readonly author: CommentAuthor;
  readonly body: string;
  readonly createdAt: string;
  readonly id: string;
  readonly idempotencyKey: string;
  readonly installationId: string;
  readonly path: string | null;
  readonly projectId: string;
  readonly versionId: string;
}

/** Values used to read one bounded page of comment threads on one artifact. */
export interface ListCommentThreads {
  readonly artifactId: string;
  readonly cursor: PageCursor | null;
  /** Visibility of threads referenced by an active dispatch. */
  readonly dispatched: DispatchedThreadFilter;
  readonly limit: number;
  readonly projectId: string;
  /** Inclusive lower bound on updatedAt, or null for no lower bound. */
  readonly since: string | null;
  readonly state: CommentThreadState | null;
  readonly versionId: string | null;
}

/** One requested anchor replacement; a null anchor clears the stored value. */
export interface CommentAnchorChange {
  readonly anchor: unknown;
}

/** One requested comment state transition together with its attribution. */
export interface CommentStateChange {
  readonly resolvedAt: string | null;
  readonly resolvedBy: CommentAuthor | null;
  readonly state: CommentThreadState;
}

/**
 * Values used to change one comment thread. A null field is left unchanged.
 * The recorded action kind is `comment_resolve` or `comment_reopen` when the
 * command carries a state change, and `comment_update` otherwise.
 */
export interface UpdateCommentThread {
  readonly anchor: CommentAnchorChange | null;
  readonly artifactId: string;
  readonly authorizedByPrincipalId: string | null;
  readonly body: string | null;
  readonly principalId: string;
  readonly projectId: string;
  readonly state: CommentStateChange | null;
  readonly threadId: string;
  readonly updatedAt: string;
}

/** Values used to delete one comment thread together with its replies. */
export interface DeleteCommentThread {
  readonly artifactId: string;
  readonly authorizedByPrincipalId: string | null;
  readonly deletedAt: string;
  readonly principalId: string;
  readonly projectId: string;
  readonly threadId: string;
}

/** Values used to append one reply to one open comment thread. */
export interface CreateCommentReply {
  readonly artifactId: string;
  readonly author: CommentAuthor;
  readonly body: string;
  readonly createdAt: string;
  readonly id: string;
  readonly idempotencyKey: string;
  readonly projectId: string;
  readonly threadId: string;
}

/** Values used to change one reply's body. */
export interface UpdateCommentReply {
  readonly artifactId: string;
  readonly authorizedByPrincipalId: string | null;
  readonly body: string;
  readonly principalId: string;
  readonly projectId: string;
  readonly replyId: string;
  readonly threadId: string;
  readonly updatedAt: string;
}

/**
 * Values used to clear one artifact's matching comment threads in bulk.
 * Deletion semantics per thread match {@link DeleteCommentThread}: replies
 * cascade and one `comment_delete` action lands in the ledger. Threads held
 * by an active (queued or claimed) dispatch are skipped and counted.
 */
export interface ClearCommentThreads {
  readonly artifactId: string;
  readonly authorizedByPrincipalId: string | null;
  readonly clearedAt: string;
  readonly principalId: string;
  readonly projectId: string;
  readonly scope: CommentClearScope;
  /** Restricts the clear to threads on one saved version when present. */
  readonly versionId: string | null;
}

/** Values used to delete one reply from one comment thread. */
export interface DeleteCommentReply {
  readonly artifactId: string;
  readonly authorizedByPrincipalId: string | null;
  readonly deletedAt: string;
  readonly principalId: string;
  readonly projectId: string;
  readonly replyId: string;
  readonly threadId: string;
}

/**
 * Persistent comment operations required by the comment application service.
 * Every mutation appends its attributed action record in the same transaction.
 */
export interface CommentRepository {
  clearThreads(command: ClearCommentThreads): Promise<CommentThreadClearing>;
  createReply(command: CreateCommentReply): Promise<CommentReplyCreation>;
  createThread(command: CreateCommentThread): Promise<CommentThreadCreation>;
  deleteReply(command: DeleteCommentReply): Promise<void>;
  deleteThread(command: DeleteCommentThread): Promise<CommentThreadDeletion>;
  findIdempotentReply(
    projectId: string,
    idempotencyKey: string,
  ): Promise<CommentReplyRecord | null>;
  findIdempotentThread(
    projectId: string,
    idempotencyKey: string,
  ): Promise<CommentThreadRecord | null>;
  findThread(
    projectId: string,
    artifactId: string,
    threadId: string,
  ): Promise<CommentThreadRecord | null>;
  listReplies(threadId: string): Promise<readonly CommentReplyRecord[]>;
  listThreads(command: ListCommentThreads): Promise<CommentThreadPage>;
  updateReply(command: UpdateCommentReply): Promise<CommentReplyRecord>;
  updateThread(command: UpdateCommentThread): Promise<CommentThreadRecord>;
  /** Determine whether one saved version's manifest declares one exact path. */
  versionContainsPath(
    projectId: string,
    versionId: string,
    path: string,
  ): Promise<boolean>;
}

/** Binding values persisted when linking, capturing, or relinking one source file. */
export interface SourceBindingWrite {
  /** `device:inode:size:mtimeNs:ctimeNs` verified on the capturing descriptor. */
  readonly fingerprint: string;
  /** Canonicalized absolute path that already passed the section 4.3 ladder. */
  readonly path: string;
  readonly verifiedAt: string;
}

/**
 * Values used to atomically create one linked artifact together with its
 * source binding and its initial captured version.
 */
export interface CommitLinkedArtifact extends CommitNewArtifact {
  readonly binding: SourceBindingWrite;
}

/**
 * Values used to atomically commit one captured version while refreshing the
 * binding's fingerprint and freshness in the same transaction.
 */
export interface CommitCapturedVersion extends CommitArtifactVersion {
  readonly binding: SourceBindingWrite;
}

/** Values used to record one lazily observed source freshness state. */
export interface RecordSourceFreshness {
  readonly artifactId: string;
  readonly freshness: SourceFreshness;
  readonly projectId: string;
  readonly verifiedAt: string;
}

/** Values used to re-point one binding at a moved source file. */
export interface RelinkSourceBinding {
  readonly artifactId: string;
  readonly authorizedByPrincipalId: string | null;
  readonly binding: SourceBindingWrite;
  readonly createdAt: string;
  readonly idempotencyKey: string;
  readonly inputDigest: string;
  readonly principalId: string;
  readonly projectId: string;
}

/**
 * Persistent linked-artifact binding operations, implemented only by the
 * local SQLite backend. Link and capture commits keep binding state and
 * version state consistent in one transaction; the relink mutation appends
 * its attributed action record in the same transaction; freshness recording
 * is a lazy observation that never touches versions.
 */
export interface SourceBindingRepository {
  commitCapturedVersion(
    command: CommitCapturedVersion,
  ): Promise<PublishedVersion>;
  commitLinkedArtifact(command: CommitLinkedArtifact): Promise<PublishedVersion>;
  findSourceBinding(
    projectId: string,
    artifactId: string,
  ): Promise<SourceBindingRecord | null>;
  recordSourceFreshness(
    command: RecordSourceFreshness,
  ): Promise<SourceBindingRecord>;
  relinkSource(command: RelinkSourceBinding): Promise<SourceBindingRecord>;
}

/** Values used to register or refresh one live agent connection. */
export interface RegisterAgent {
  readonly agentSessionId: string | null;
  /** Already normalized: known keys only, defaults applied. */
  readonly capabilities: AgentCapabilities;
  readonly connectionKey: string;
  readonly displayName: string;
  /** Identity used only when the connection key inserts a new row. */
  readonly id: string;
  readonly installationId: string;
  readonly kind: RegisteredAgentKind;
  readonly principalId: string;
  readonly registeredAt: string;
  readonly workingDirectory: string;
}

/** Values used to create one dispatch and mark its threads atomically. */
export interface CreateAgentDispatch {
  readonly agentDisplayName: string;
  readonly agentId: string;
  readonly createdAt: string;
  readonly id: string;
  readonly idempotencyKey: string;
  readonly installationId: string;
  readonly note: string | null;
  readonly projectId: string;
  readonly sender: CommentAuthor;
  readonly threadIds: readonly string[];
}

/** Values used to report one claimed dispatch as delivered. */
export interface MarkDispatchDelivered {
  /** The reporting agent; a non-holder report is a state conflict. */
  readonly agentId: string;
  readonly deliveredAt: string;
  readonly dispatchId: string;
  readonly installationId: string;
}

/** Values used to report one dispatch as permanently failed. */
export interface MarkDispatchFailed {
  /** The reporting agent; a non-holder report is a state conflict. */
  readonly agentId: string;
  readonly dispatchId: string;
  readonly failedAt: string;
  readonly installationId: string;
  readonly reason: string;
}

/**
 * Values used to store one activity beacon on one registered agent. Display
 * metadata only: the write always lands, and the read side decays it.
 */
export interface RecordAgentActivity {
  readonly agentId: string;
  readonly installationId: string;
  readonly observedAt: string;
  readonly state: AgentBeaconState;
}

/** Values used to cancel one queued or claimed dispatch. */
export interface CancelAgentDispatch {
  readonly canceledAt: string;
  readonly dispatchId: string;
  readonly installationId: string;
  readonly projectId: string;
}

/** Values used to read one bounded page of dispatches, newest first. */
export interface ListAgentDispatches {
  readonly agentId: string | null;
  readonly cursor: PageCursor | null;
  readonly installationId: string;
  readonly limit: number;
  /** Read time used to apply lazy dispatch transitions before shaping. */
  readonly now: string;
  readonly projectId: string;
  readonly state: AgentDispatchState | null;
}

/**
 * Persistent agent-registry and dispatch-mailbox operations. Dispatch
 * creation validates and marks its threads in one transaction; claim,
 * failure, and cancellation apply their state checks and thread markers in
 * one transaction; reads apply the lazy transitions (lease reclaim,
 * agent_unavailable failure, addressed inference) before shaping.
 */
export interface AgentDispatchRepository {
  cancelDispatch(command: CancelAgentDispatch): Promise<AgentDispatchRecord>;
  /**
   * Claim the oldest queued dispatch. A heartbeat attempt (the first attempt
   * of one held poll request) refreshes the agent's liveness and sweeps
   * expired leases unconditionally; a re-check attempt inside the same held
   * request stays a pure read while nothing is claimable, and only opens the
   * write path — which also refreshes liveness — when it finds an expired
   * lease to reclaim or a queued dispatch to claim.
   */
  claimNextDispatch(
    agentId: string,
    now: string,
    bumpHeartbeat: boolean,
  ): Promise<AgentDispatchRecord | null>;
  createDispatch(command: CreateAgentDispatch): Promise<AgentDispatchCreation>;
  disconnectAgent(installationId: string, agentId: string): Promise<void>;
  findAgent(
    installationId: string,
    agentId: string,
  ): Promise<RegisteredAgentRecord | null>;
  findDispatch(
    installationId: string,
    dispatchId: string,
    now: string,
  ): Promise<AgentDispatchRecord | null>;
  /**
   * List live agents with their dispatch-derived presence, lazily deleting
   * rows past their polling retention.
   */
  listAgents(
    installationId: string,
    now: string,
  ): Promise<readonly RegisteredAgentPresence[]>;
  listDispatches(command: ListAgentDispatches): Promise<AgentDispatchPage>;
  markDelivered(command: MarkDispatchDelivered): Promise<AgentDispatchRecord>;
  markFailed(command: MarkDispatchFailed): Promise<AgentDispatchRecord>;
  /** Stamp addressed when every bundle thread is resolved, exactly once. */
  observeAddressed(
    dispatchId: string,
    now: string,
  ): Promise<AgentDispatchRecord | null>;
  /** Store one activity beacon; overwrites the previous one regardless. */
  recordActivity(command: RecordAgentActivity): Promise<void>;
  registerAgent(command: RegisterAgent): Promise<RegisteredAgentRecord>;
}

/** Values persisted when issuing a one-time private-content bootstrap. */
export type CreateContentBootstrap = ContentBootstrapRecord;

/** Values persisted for one short-lived exact-version Review preview lease. */
export type CreatePreviewLease = ContentSessionRecord;

/** Values used to atomically exchange a bootstrap for a browser session. */
export interface ExchangeContentBootstrap {
  readonly bootstrapTokenDigest: string;
  readonly contentToken: string;
  readonly exchangedAt: string;
  readonly session: {
    readonly createdAt: string;
    readonly expiresAt: string;
    readonly tokenDigest: string;
  };
}

export interface CreateStagedUpload {
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly files: readonly {
    readonly entry: CanonicalManifest["entries"][number];
    readonly storageToken: string;
  }[];
  readonly id: string;
  readonly manifest: CanonicalManifest;
  readonly principalId: string;
  readonly projectId: string;
}

/** Values persisted when creating one project. */
export type CreateProject = ProjectRecord;

/** Values used to change one project's label. */
export interface RenameProject {
  readonly name: string;
  readonly projectId: string;
}

/** Values used to archive or unarchive one project. */
export interface SetProjectArchive {
  readonly archivedAt: string | null;
  readonly projectId: string;
}

/** Persistent project operations required by the project application service. */
export interface ProjectRepository {
  createProject(command: CreateProject): Promise<ProjectRecord>;
  findProject(projectId: string): Promise<ProjectRecord | null>;
  listProjects(): Promise<readonly ProjectRecord[]>;
  renameProject(command: RenameProject): Promise<ProjectRecord>;
  setProjectArchive(command: SetProjectArchive): Promise<ProjectRecord>;
}

export interface ArtifactRepository {
  assertPublicationSourceReady(
    source: PublicationSource,
    manifestDigest: string,
    commitTime: string,
  ): Promise<void>;
  close(): void;
  commitNewArtifact(command: CommitNewArtifact): Promise<PublishedVersion>;
  commitVersion(command: CommitArtifactVersion): Promise<PublishedVersion>;
  changeAccessSetting(command: ChangeArtifactAccessSetting): Promise<ArtifactState>;
  changeTags(command: ChangeArtifactTags): Promise<ArtifactState>;
  deleteArtifact(command: DeleteArtifact): Promise<ArtifactDeletion>;
  findArtifact(projectId: string, artifactId: string): Promise<ArtifactRecord | null>;
  findArtifactForAdministration(
    projectId: string,
    artifactId: string,
  ): Promise<ArtifactRecord | null>;
  /**
   * Read one saved version and its manifest without re-reading the artifact.
   * Callers must have already established the artifact exists and is live.
   */
  findVersionRecord(
    projectId: string,
    artifactId: string,
    versionId: string,
  ): Promise<ArtifactVersion | null>;
  findCurrentVersion(
    projectId: string | null,
    artifactId: string,
  ): Promise<PublishedVersion | null>;
  findIdempotentPublication(
    projectId: string,
    idempotencyKey: string,
    inputDigest: string,
  ): Promise<PublishedVersion | null>;
  findVersionContent(
    contentToken: string,
    path: string,
    fallback: "entry" | "none",
  ): Promise<VersionContent | null>;
  listArtifactActions(command: ListArtifactActions): Promise<ArtifactActionPage>;
  listArtifacts(command: ListArtifacts): Promise<ArtifactPage>;
  listArtifactVersions(
    projectId: string,
    artifactId: string,
  ): Promise<readonly VersionRecord[]>;
  restoreVersion(command: RestoreArtifactVersion): Promise<ArtifactState>;
}

/** Persistent capabilities required by private browser content sessions. */
export interface ContentSessionRepository {
  createContentBootstrap(
    command: CreateContentBootstrap,
  ): Promise<ContentBootstrapRecord>;
  exchangeContentBootstrap(
    command: ExchangeContentBootstrap,
  ): Promise<ContentSessionRecord | null>;
  findContentSession(
    tokenDigest: string,
    contentToken: string,
    requestTime: string,
  ): Promise<ContentSessionRecord | null>;
  createPreviewLease(command: CreatePreviewLease): Promise<ContentSessionRecord>;
  findPreviewLease(
    tokenDigest: string,
    requestTime: string,
  ): Promise<ContentSessionRecord | null>;
}

export interface StagedUploadRepository {
  createStagedUpload(command: CreateStagedUpload): Promise<StagedUpload>;
  findStagedUpload(
    projectId: string,
    uploadId: string,
    principalId: string,
  ): Promise<StagedUpload | null>;
  markStagedFileUploaded(
    projectId: string,
    uploadId: string,
    principalId: string,
    storageToken: string,
    uploadedAt: string,
  ): Promise<StagedUpload>;
  listExpiredStagedUploads(
    expiredBefore: string,
    limit: number,
  ): Promise<readonly ExpiredStagedUpload[]>;
  removeExpiredStagedUpload(
    uploadId: string,
    expiredBefore: string,
  ): Promise<boolean>;
}

export interface Clock {
  now(): Date;
}

export interface IdGenerator {
  agentDispatchId(): string;
  artifactId(): string;
  commentReplyId(): string;
  commentThreadId(): string;
  contentToken(): string;
  projectId(): string;
  registeredAgentId(): string;
  stagedFileToken(): string;
  uploadId(): string;
  versionId(): string;
}
