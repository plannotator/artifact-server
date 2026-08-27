import {Predicate} from "effect";

import type {PrincipalKind} from "./identity.js";

export const accessSettings = {
  accountRequired: "account_required",
  publicLink: "public_link",
} as const;

export type AccessSetting = (typeof accessSettings)[keyof typeof accessSettings];

/** Artifact mutation kinds persisted in the standalone action history. */
export const artifactActionKinds = {
  capture: "capture",
  changeAccess: "change_access",
  changeTags: "change_tags",
  commentCreate: "comment_create",
  commentDelete: "comment_delete",
  commentReopen: "comment_reopen",
  commentReply: "comment_reply",
  commentResolve: "comment_resolve",
  commentUpdate: "comment_update",
  delete: "delete",
  link: "link",
  publish: "publish",
  relink: "relink",
  restore: "restore",
} as const;

/** One persisted artifact mutation kind. */
export type ArtifactActionKind =
  (typeof artifactActionKinds)[keyof typeof artifactActionKinds];

export const routingModes = {
  spa: "spa",
  static: "static",
} as const;

export type RoutingMode = (typeof routingModes)[keyof typeof routingModes];

export const fileDispositions = {
  attachment: "attachment",
  inline: "inline",
} as const;

export type FileDisposition =
  (typeof fileDispositions)[keyof typeof fileDispositions];

export const uploadStatuses = {
  committed: "committed",
  open: "open",
} as const;

export type UploadStatus =
  (typeof uploadStatuses)[keyof typeof uploadStatuses];

/** Stable identity reserved for the project created with every installation. */
export const defaultProjectId = "prj_default";

/** Initial label used for the project created with every installation. */
export const defaultProjectName = "Default";

/** One project inside an Artifact Server installation. */
export interface ProjectRecord {
  readonly archivedAt: string | null;
  readonly createdAt: string;
  readonly id: string;
  readonly installationId: string;
  readonly name: string;
}

export interface ArtifactRecord {
  readonly accessSetting: AccessSetting;
  readonly createdAt: string;
  readonly currentVersionId: string;
  readonly deletedAt: string | null;
  readonly id: string;
  readonly name: string;
  readonly projectId: string;
  readonly tags: readonly string[];
}

/** An artifact record whose deletion state is known to be committed. */
export interface ArtifactTombstone extends ArtifactRecord {
  readonly deletedAt: string;
}

/** The observed relation between a linked source file and its last capture. */
export type SourceFreshness = "in-sync" | "modified" | "missing" | "unreadable";

/** Persisted source freshness states, named for storage and projection code. */
export const sourceFreshnessStates = {
  inSync: "in-sync",
  missing: "missing",
  modified: "modified",
  unreadable: "unreadable",
} as const satisfies Record<string, SourceFreshness>;

/** One linked artifact's reference to a source file that stays on disk. */
export interface SourceBindingRecord {
  readonly artifactId: string;
  /** `device:inode:size:mtimeNs:ctimeNs` observed at the last capture or relink. */
  readonly fingerprint: string;
  readonly freshness: SourceFreshness;
  /** Instant the freshness was last observed against the source file. */
  readonly lastVerifiedAt: string;
  /** Canonicalized absolute path on the server's own machine. */
  readonly path: string;
  readonly projectId: string;
}

/** Stable keyset position used by bounded artifact and action queries. */
export interface PageCursor {
  readonly createdAt: string;
  readonly id: string;
}

/** One immutable attribution record for an artifact mutation. */
export interface ArtifactActionRecord {
  readonly action: ArtifactActionKind;
  readonly artifactId: string;
  readonly authorizedByPrincipalId: string | null;
  readonly createdAt: string;
  readonly id: string;
  readonly idempotencyKey: string;
  readonly principalId: string;
  readonly projectId: string;
  readonly versionId: string;
}

/** One active artifact with exact aggregate data needed by list surfaces. */
export interface ArtifactListItem extends ArtifactRecord {
  readonly versionCount: number;
}

/** One bounded page of active artifacts. */
export interface ArtifactPage {
  readonly items: readonly ArtifactListItem[];
  readonly nextCursor: PageCursor | null;
}

/** One bounded page of artifact mutation records. */
export interface ArtifactActionPage {
  readonly items: readonly ArtifactActionRecord[];
  readonly nextCursor: PageCursor | null;
}

/** The durable tombstone returned by an artifact deletion. */
export interface ArtifactDeletion {
  readonly artifact: ArtifactTombstone;
  readonly replayed: boolean;
  readonly retainedVersionCount: number;
}

export interface ManifestEntry {
  readonly disposition: FileDisposition;
  readonly mediaType: string;
  readonly path: string;
  readonly sha256: string;
  readonly size: number;
}

export interface CanonicalManifest {
  readonly digest: string;
  readonly entryPath: string;
  readonly entries: readonly ManifestEntry[];
  readonly routingMode: RoutingMode;
  readonly serialized: string;
}

export interface VersionRecord {
  readonly artifactId: string;
  readonly contentToken: string;
  readonly createdAt: string;
  readonly entryPath: string;
  readonly id: string;
  readonly manifestDigest: string;
  readonly number: number;
  readonly publisherPrincipalId: string;
  readonly projectId: string;
  readonly routingMode: RoutingMode;
}

/** One saved version together with the canonical manifest it references. */
export interface ArtifactVersion {
  readonly manifest: CanonicalManifest;
  readonly version: VersionRecord;
}

/** The current persisted state returned by an artifact management mutation. */
export interface ArtifactState {
  readonly artifact: ArtifactRecord;
  readonly replayed: boolean;
  readonly version: VersionRecord;
}

export interface PublishedVersion {
  readonly artifact: ArtifactRecord;
  readonly replayed: boolean;
  readonly version: VersionRecord;
}

export interface VersionContent {
  readonly accessSetting: AccessSetting;
  readonly artifactId: string;
  readonly contentToken: string;
  readonly entry: ManifestEntry;
  readonly isCurrent: boolean;
  readonly projectId: string;
  readonly versionId: string;
}

/** A one-time authorization to create one version-scoped browser session. */
export interface ContentBootstrapRecord {
  readonly artifactId: string;
  readonly contentToken: string;
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly principalId: string;
  readonly projectId: string;
  readonly tokenDigest: string;
  readonly versionId: string;
}

/** A read-only browser session scoped to one immutable version origin. */
export interface ContentSessionRecord {
  readonly artifactId: string;
  readonly contentToken: string;
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly principalId: string;
  readonly projectId: string;
  readonly tokenDigest: string;
  readonly versionId: string;
}

export interface StagedUploadFile {
  readonly entry: ManifestEntry;
  readonly storageToken: string;
  readonly uploadedAt: string | null;
}

interface StagedUploadBase {
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly files: readonly StagedUploadFile[];
  readonly id: string;
  readonly manifest: CanonicalManifest;
  readonly principalId: string;
  readonly projectId: string;
}

export type StagedUpload = StagedUploadBase &
  (
    | {
      readonly committedVersionId: null;
      readonly status: typeof uploadStatuses.open;
    }
    | {
      readonly committedVersionId: string;
      readonly status: typeof uploadStatuses.committed;
    }
  );

/** Comment thread lifecycle states shared by every persistence backend. */
export const commentThreadStates = {
  open: "open",
  resolved: "resolved",
} as const;

/** One persisted comment thread lifecycle state. */
export type CommentThreadState =
  (typeof commentThreadStates)[keyof typeof commentThreadStates];

/** The principal attribution copied onto a comment when it was written. */
export interface CommentAuthor {
  readonly authorizedByPrincipalId: string | null;
  readonly displayName: string;
  readonly principalId: string;
  readonly principalKind: PrincipalKind;
}

/** One root comment on one exact saved version. */
export interface CommentThreadRecord {
  /** Opaque client-owned anchor JSON, or null when the thread has none. */
  readonly anchor: unknown;
  readonly artifactId: string;
  readonly author: CommentAuthor;
  readonly body: string;
  readonly createdAt: string;
  readonly id: string;
  readonly installationId: string;
  /** One manifest entry path inside the version, or null for the whole version. */
  readonly path: string | null;
  readonly projectId: string;
  readonly replyCount: number;
  readonly resolvedAt: string | null;
  readonly resolvedBy: CommentAuthor | null;
  readonly state: CommentThreadState;
  readonly updatedAt: string;
  readonly versionId: string;
}

/** One follow-up inside a comment thread. */
export interface CommentReplyRecord {
  readonly author: CommentAuthor;
  readonly body: string;
  readonly createdAt: string;
  readonly id: string;
  readonly projectId: string;
  readonly threadId: string;
  readonly updatedAt: string;
}

/** Dispatched-thread visibility filters accepted by comment listings. */
export const dispatchedThreadFilters = {
  exclude: "exclude",
  include: "include",
  only: "only",
} as const;

/** One dispatched-thread visibility filter for a comment listing. */
export type DispatchedThreadFilter =
  (typeof dispatchedThreadFilters)[keyof typeof dispatchedThreadFilters];

/** One bounded page of comment threads. */
export interface CommentThreadPage {
  readonly items: readonly CommentThreadRecord[];
  readonly nextCursor: PageCursor | null;
}

/** One comment thread created now or replayed from its idempotency key. */
export interface CommentThreadCreation {
  readonly replayed: boolean;
  readonly thread: CommentThreadRecord;
}

/** One comment reply created now or replayed from its idempotency key. */
export interface CommentReplyCreation {
  readonly replayed: boolean;
  readonly reply: CommentReplyRecord;
}

/** The durable outcome of deleting one comment thread and its replies. */
export interface CommentThreadDeletion {
  readonly deletedReplyCount: number;
  readonly thread: CommentThreadRecord;
}

/** Thread populations a bulk comment clear may target. */
export const commentClearScopes = {
  all: "all",
  resolved: "resolved",
} as const;

/** One bulk-clear target population. */
export type CommentClearScope =
  (typeof commentClearScopes)[keyof typeof commentClearScopes];

/** The durable outcome of one bulk comment clear on one artifact. */
export interface CommentThreadClearing {
  /** Threads deleted, each with its replies and one ledger action. */
  readonly deleted: number;
  /** Threads left in place because an active dispatch still holds them. */
  readonly skippedDispatched: number;
}

/** Slug shape every registered-agent kind must satisfy. */
export const registeredAgentKindPattern = /^[a-z][a-z0-9-]{0,39}$/;

/**
 * One registered-agent kind: display and analytics metadata shaped as a
 * slug. Nothing branches on it — behavior branches on capabilities.
 */
export type RegisteredAgentKind = string;

/** Bridge protocol revision spoken by this server's agent surface. */
export const agentProtocolVersion = 1;

/** Delivery-evidence tiers a registered agent can honestly claim. */
export const agentEvidenceKinds = {
  channel: "channel",
  mailbox: "mailbox",
  native: "native",
} as const;

/** One delivery-evidence tier. */
export type AgentEvidenceKind =
  (typeof agentEvidenceKinds)[keyof typeof agentEvidenceKinds];

/** Normalized capabilities stored for one registered agent. */
export interface AgentCapabilities {
  readonly beacon: boolean;
  readonly evidence: AgentEvidenceKind;
}

/** Capability keys a registration may declare; unknown keys are ignored. */
export interface AgentCapabilityDeclaration {
  readonly beacon?: boolean | undefined;
  readonly evidence?: AgentEvidenceKind | undefined;
}

/** Capabilities describing today's native bridge, applied when undeclared. */
export const defaultAgentCapabilities: AgentCapabilities = {
  beacon: false,
  evidence: agentEvidenceKinds.native,
};

/** Apply defaults and keep only the known capability keys. */
export function normalizeAgentCapabilities(
  declared: AgentCapabilityDeclaration | null,
): AgentCapabilities {
  return {
    beacon: declared?.beacon ?? defaultAgentCapabilities.beacon,
    evidence: declared?.evidence ?? defaultAgentCapabilities.evidence,
  };
}

/**
 * Read one stored capabilities column back into capabilities. The column is
 * written normalized, so anything unreadable decays to the defaults instead
 * of failing the whole agent listing.
 */
export function parseStoredAgentCapabilities(
  json: string | null,
): AgentCapabilities {
  if (json === null) return defaultAgentCapabilities;
  let stored: unknown;
  try {
    stored = JSON.parse(json);
  } catch {
    return defaultAgentCapabilities;
  }
  if (!Predicate.isObject(stored)) return defaultAgentCapabilities;
  const evidence = stored["evidence"];
  return {
    beacon: Predicate.isBoolean(stored["beacon"])
      ? stored["beacon"]
      : defaultAgentCapabilities.beacon,
    evidence: evidence === agentEvidenceKinds.channel ||
        evidence === agentEvidenceKinds.mailbox ||
        evidence === agentEvidenceKinds.native
      ? evidence
      : defaultAgentCapabilities.evidence,
  };
}

/** Presence states derived for one registered agent at read time. */
export const agentActivityStates = {
  disconnected: "disconnected",
  idle: "idle",
  working: "working",
} as const;

/** One derived presence state. */
export type AgentActivityState =
  (typeof agentActivityStates)[keyof typeof agentActivityStates];

/** Finer-grained states an agent's activity beacon may report. */
export const agentBeaconStates = {
  idle: "idle",
  replying: "replying",
  thinking: "thinking",
} as const;

/** One beacon-reported activity state. */
export type AgentBeaconState =
  (typeof agentBeaconStates)[keyof typeof agentBeaconStates];

/** The beacon detail surfaced on read; a fresh idle beacon surfaces null. */
export type AgentBeaconDetail = Exclude<AgentBeaconState, "idle"> | null;

/**
 * One live agent connection. A disposable liveness record, not a durable
 * object: the agent names itself at registration, rows carry no lifecycle
 * state beyond lastSeenAt, stale rows are deleted, and nothing durable hangs
 * off the row. The durable object is the dispatch queue, which survives agent
 * restarts because the same connectionKey upserts back into the same id.
 */
export interface RegisteredAgentRecord {
  /** Instant of the last stored beacon, or null when none was ever sent. */
  readonly activityAt: string | null;
  /** Last beacon-reported state; the read side applies TTL decay. */
  readonly activityState: AgentBeaconState | null;
  /** Pi session id refreshed on re-registration, or null when unknown. */
  readonly agentSessionId: string | null;
  /** Normalized capabilities the agent advertised at registration. */
  readonly capabilities: AgentCapabilities;
  /** Stable upsert key chosen by the agent. */
  readonly connectionKey: string;
  readonly createdAt: string;
  readonly displayName: string;
  readonly id: string;
  readonly installationId: string;
  readonly kind: RegisteredAgentKind;
  /** Bumped once per claim poll request — the poll is the heartbeat. */
  readonly lastSeenAt: string;
  /** The principal that registered the agent, kept for audit. */
  readonly principalId: string;
  readonly workingDirectory: string;
}

/**
 * One listed agent with the presence facts read lazily from
 * `agent_dispatches`: no stored activity writes, no background jobs.
 */
export interface RegisteredAgentPresence {
  /**
   * The claimed or delivered dispatch whose bundle threads are not all
   * resolved — the dispatch the agent is working, or null.
   */
  readonly activeDispatchId: string | null;
  readonly agent: RegisteredAgentRecord;
  /** Latest dispatch transition recorded for the agent, or null. */
  readonly latestDispatchTransitionAt: string | null;
}

/** Dispatch delivery states shared by every persistence backend. */
export const agentDispatchStates = {
  addressed: "addressed",
  canceled: "canceled",
  claimed: "claimed",
  delivered: "delivered",
  failed: "failed",
  queued: "queued",
} as const;

/** One persisted dispatch delivery state. */
export type AgentDispatchState =
  (typeof agentDispatchStates)[keyof typeof agentDispatchStates];

/** Whether a dispatch still owns the immutable membership of its threads. */
export function dispatchHoldsCommentThread(
  state: AgentDispatchState | null,
): boolean {
  return state === agentDispatchStates.queued ||
    state === agentDispatchStates.claimed ||
    state === agentDispatchStates.delivered;
}

/** One bundle of comment threads sent to one registered agent. */
export interface AgentDispatchRecord {
  readonly addressedAt: string | null;
  /** Snapshot at send time, so history survives agent-row deletion. */
  readonly agentDisplayName: string;
  /** No foreign key — agent rows are disposable; the name is snapshotted. */
  readonly agentId: string;
  readonly canceledAt: string | null;
  readonly claimedAt: string | null;
  readonly createdAt: string;
  readonly deliveredAt: string | null;
  readonly failedAt: string | null;
  /** From the agent report or "agent_unavailable". */
  readonly failureReason: string | null;
  readonly id: string;
  readonly idempotencyKey: string;
  readonly installationId: string;
  /** Claim lease; expiry returns the dispatch to queued. */
  readonly leaseExpiresAt: string | null;
  readonly note: string | null;
  readonly projectId: string;
  readonly sender: CommentAuthor;
  readonly state: AgentDispatchState;
  /** Ordered thread ids, all open and undispatched at send time. */
  readonly threadIds: readonly string[];
  readonly updatedAt: string;
}

/** One bounded page of agent dispatches, newest first. */
export interface AgentDispatchPage {
  readonly items: readonly AgentDispatchRecord[];
  readonly nextCursor: PageCursor | null;
}

/** One dispatch created now or replayed from its idempotency key. */
export interface AgentDispatchCreation {
  readonly dispatch: AgentDispatchRecord;
  readonly replayed: boolean;
}
