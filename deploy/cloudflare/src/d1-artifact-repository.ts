import {z} from "zod";

import type {
  ListPublicLinks,
  PublicLinkInventoryPage,
} from "../../../src/application/public-link-administration.js";
import {
  AgentDispatchNotFound,
  ArtifactMutationConflict,
  ArtifactNotFound,
  CommentNotFound,
  CommentResolved,
  DispatchStateConflict,
  IdempotencyConflict,
  InvalidDispatch,
  ProjectArchived,
  ProjectConflict,
  ProjectNotFound,
  PublishConflict,
  UploadClosed,
  UploadExpired,
  UploadFileNotFound,
  UploadIncomplete,
  UploadNotFound,
  VersionNotFound,
} from "../../../src/core/errors.js";
import {principalKinds} from "../../../src/core/identity.js";
import type {
  ProjectGitHistoryProgress,
  ProjectGitHistoryStore,
  StoreProjectGitHistorySetting,
} from "../../../src/application/project-git-history.js";
import {normalizeArtifactSearchText} from
  "../../../src/application/artifact-tags.js";
import {
  accessSettings,
  agentBeaconStates,
  agentDispatchStates,
  artifactActionKinds,
  commentThreadStates,
  dispatchHoldsCommentThread,
  dispatchedThreadFilters,
  fileDispositions,
  parseStoredAgentCapabilities,
  routingModes,
  uploadStatuses,
  type AgentDispatchCreation,
  type AgentDispatchPage,
  type AgentDispatchRecord,
  type AgentDispatchState,
  type ArtifactActionPage,
  type ArtifactActionRecord,
  type ArtifactDeletion,
  type ArtifactPage,
  type ArtifactRecord,
  type ArtifactState,
  type ArtifactTombstone,
  type CommentAuthor,
  type CommentReplyCreation,
  type CommentReplyRecord,
  type CommentThreadClearing,
  type CommentThreadCreation,
  type CommentThreadDeletion,
  type CommentThreadPage,
  type CommentThreadRecord,
  type ContentSessionRecord,
  type ManifestEntry,
  type PageCursor,
  type PublishedVersion,
  type ProjectRecord,
  type RegisteredAgentPresence,
  type RegisteredAgentRecord,
  type StagedUpload,
  type StagedUploadFile,
  type VersionContent,
  type VersionRecord,
} from "../../../src/core/model.js";
import type {
  AgentDispatchRepository,
  ArtifactRepository,
  CancelAgentDispatch,
  ChangeArtifactAccessSetting,
  ChangeArtifactTags,
  ClearCommentThreads,
  CommentRepository,
  CommitArtifactVersion,
  CommitNewArtifact,
  ContentSessionRepository,
  CreateAgentDispatch,
  CreateCommentReply,
  CreateCommentThread,
  CreateContentBootstrap,
  CreatePreviewLease,
  CreateProject,
  CreateStagedUpload,
  DeleteArtifact,
  DeleteCommentReply,
  DeleteCommentThread,
  ExchangeContentBootstrap,
  ExpiredStagedUpload,
  ListAgentDispatches,
  ListArtifactActions,
  ListArtifacts,
  ListCommentThreads,
  MarkDispatchDelivered,
  MarkDispatchFailed,
  PublicationSource,
  ProjectRepository,
  RecordAgentActivity,
  RegisterAgent,
  RenameProject,
  RestoreArtifactVersion,
  SetProjectArchive,
  StagedUploadRepository,
  UpdateCommentReply,
  UpdateCommentThread,
} from "../../../src/core/ports.js";
import {
  agentDispatchLeaseMilliseconds,
  agentUnavailableStalenessMilliseconds,
  registeredAgentRetentionMilliseconds,
} from "../../../src/core/publishing-limits.js";
import {createManifest} from "../../../src/manifest/create-manifest.js";
import {
  publicLinkInventoryRowSchema,
  publicLinkPageFromRows,
} from "../../../src/storage/public-link-inventory-row.js";
import {
  gitHistoryJobId,
  gitHistoryJobKinds,
  type GitHistoryBudgetReservation,
  type GitHistoryJob,
  type GitHistoryMirrorStore,
} from "../../../src/git-history/git-history-mirror.js";
import {defaultGitHistoryMaximumCopiedFiles} from
  "../../../src/git-history/git-history-capability.js";
import type {GitHistoryPurgeStore} from
  "../../../src/git-history/git-history-purge.js";

const accessSettingSchema = z.enum([
  accessSettings.accountRequired,
  accessSettings.publicLink,
]);
const dispositionSchema = z.enum([
  fileDispositions.attachment,
  fileDispositions.inline,
]);
const d1MirrorJobId = (versionId: string): string => `ghj_d1_${versionId}`;
const routingModeSchema = z.enum([routingModes.static, routingModes.spa]);
const uploadStatusSchema = z.enum([
  uploadStatuses.committed,
  uploadStatuses.open,
]);
const actionSchema = z.enum([
  artifactActionKinds.changeAccess,
  artifactActionKinds.changeTags,
  artifactActionKinds.commentCreate,
  artifactActionKinds.commentDelete,
  artifactActionKinds.commentReopen,
  artifactActionKinds.commentReply,
  artifactActionKinds.commentResolve,
  artifactActionKinds.commentUpdate,
  artifactActionKinds.delete,
  artifactActionKinds.publish,
  artifactActionKinds.restore,
]);
const projectRowSchema = z.object({
  archivedAt: z.string().nullable(),
  createdAt: z.string(),
  id: z.string(),
  installationId: z.string(),
  name: z.string(),
});
const projectGitHistorySettingRowSchema = z.object({
  enabled: z.union([z.literal(0), z.literal(1)]).transform((value) => value === 1),
  projectId: z.string(),
  updatedAt: z.string(),
  updatedByPrincipalId: z.string(),
});
const projectGitHistoryEstimateRowSchema = z.object({
  estimatedCopiedBytes: z.number().int().nonnegative(),
  estimatedPointerBytes: z.number().int().nonnegative(),
  repositories: z.number().int().nonnegative(),
  versions: z.number().int().nonnegative(),
});
const projectGitHistoryProgressRowSchema = z.object({
  budgetLimitedJobs: z.number().int().nonnegative(),
  mappedVersions: z.number().int().nonnegative(),
  pendingJobs: z.number().int().nonnegative(),
  unmappedVersions: z.number().int().nonnegative(),
});
const gitHistoryJobRowSchema = z.object({
  artifactId: z.string(),
  attempts: z.number().int().nonnegative(),
  fileCopyBytes: z.number().int().nonnegative().nullable(),
  id: z.string(),
  kind: z.enum([
    gitHistoryJobKinds.deleteRepository,
    gitHistoryJobKinds.mirrorVersion,
  ]),
  maximumCopiedFiles: z.number().int().positive().nullable(),
  projectId: z.string(),
  storageBudgetBytes: z.number().int().nonnegative().nullable(),
  versionCopyBytes: z.number().int().nonnegative().nullable(),
  versionId: z.string().nullable(),
}).transform((row, context): GitHistoryJob => {
  if (row.kind === gitHistoryJobKinds.deleteRepository) {
    if (row.versionId !== null) {
      context.addIssue({
        code: "custom",
        message: "A delete-repository Git job cannot name a version.",
      });
      return z.NEVER;
    }
    return {
      artifactId: row.artifactId,
      attempts: row.attempts,
      id: row.id,
      kind: row.kind,
      limits: null,
      projectId: row.projectId,
      versionId: null,
    };
  }
  if (
    row.versionId === null || row.fileCopyBytes === null ||
    row.maximumCopiedFiles === null || row.versionCopyBytes === null
  ) {
    context.addIssue({
      code: "custom",
      message: "A mirror-version Git job requires a version and copy limits.",
    });
    return z.NEVER;
  }
  return {
    artifactId: row.artifactId,
    attempts: row.attempts,
    id: row.id,
    kind: row.kind,
    limits: {
      fileCopyBytes: row.fileCopyBytes,
      maximumCopiedFiles: row.maximumCopiedFiles,
      storageBudgetBytes: row.storageBudgetBytes,
      versionCopyBytes: row.versionCopyBytes,
    },
    projectId: row.projectId,
    versionId: row.versionId,
  };
});
const gitHistoryRepositoryRowSchema = z.object({
  artifactId: z.string(),
  defaultBranch: z.literal("main"),
  projectId: z.string(),
  provider: z.literal("cloudflare-artifacts"),
  remoteUrl: z.string(),
  repositoryName: z.string(),
  status: z.enum(["provisioned", "deleting", "deleted"]),
});
const gitHistoryPurgePlanRowSchema = z.object({
  alreadyDeletedRepositories: z.number().int().nonnegative(),
  enabledProjects: z.number().int().nonnegative(),
  logicalCopiedBytes: z.number().int().nonnegative(),
  repositories: z.number().int().nonnegative(),
  repositoriesToDelete: z.number().int().nonnegative(),
});
const gitHistoryMappingRowSchema = z.object({
  artifactId: z.string(),
  commitId: z.string(),
  copiedBytes: z.number().int().nonnegative(),
  projectId: z.string(),
  repositoryName: z.string(),
  versionId: z.string(),
});
const artifactRowSchema = z.object({
  accessSetting: accessSettingSchema,
  createdAt: z.string(),
  currentVersionId: z.string(),
  deletedAt: z.string().nullable(),
  id: z.string(),
  name: z.string(),
  projectId: z.string(),
});
const artifactListRowSchema = artifactRowSchema.extend({
  commentCount: z.coerce.number().int().nonnegative(),
  versionCount: z.coerce.number().int().positive(),
});
const tagRowSchema = z.object({artifactId: z.string(), tag: z.string()});
const versionRowSchema = z.object({
  artifactId: z.string(),
  contentToken: z.string(),
  createdAt: z.string(),
  entryPath: z.string(),
  id: z.string(),
  manifestDigest: z.string(),
  number: z.number().int().positive(),
  projectId: z.string(),
  publisherPrincipalId: z.string(),
  routingMode: routingModeSchema,
});
const entryRowSchema = z.object({
  disposition: dispositionSchema,
  mediaType: z.string(),
  path: z.string(),
  sha256: z.string(),
  size: z.number().int().nonnegative(),
});
const idempotencyRowSchema = z.object({
  accessSetting: accessSettingSchema.nullable(),
  artifactId: z.string(),
  inputDigest: z.string(),
  operation: actionSchema,
  tagsJson: z.string().nullable(),
  versionId: z.string(),
});
const actionRowSchema = z.object({
  action: actionSchema,
  artifactId: z.string(),
  authorizedByPrincipalId: z.string().nullable(),
  createdAt: z.string(),
  id: z.string(),
  idempotencyKey: z.string(),
  principalId: z.string(),
  projectId: z.string(),
  versionId: z.string(),
});
const stagedUploadBaseSchema = z.object({
  createdAt: z.string(),
  entryPath: z.string(),
  expiresAt: z.string(),
  id: z.string(),
  manifestDigest: z.string(),
  principalId: z.string(),
  projectId: z.string(),
  routingMode: routingModeSchema,
});
const stagedUploadSchema = z.discriminatedUnion("status", [
  stagedUploadBaseSchema.extend({
    committedVersionId: z.null(),
    status: z.literal(uploadStatuses.open),
  }),
  stagedUploadBaseSchema.extend({
    committedVersionId: z.string(),
    status: z.literal(uploadStatuses.committed),
  }),
]);
const stagedFileSchema = z.object({
  disposition: dispositionSchema,
  mediaType: z.string(),
  path: z.string(),
  sha256: z.string(),
  size: z.number().int().nonnegative(),
  storageToken: z.string(),
  uploadedAt: z.string().nullable(),
});
const expiredStagedUploadRowSchema = z.object({
  id: z.string(),
  storageToken: z.string(),
});
const stagedCommitSchema = z.object({
  expiresAt: z.string(),
  fileCount: z.number().int().nonnegative(),
  manifestDigest: z.string(),
  readyCount: z.number().int().nonnegative(),
  status: uploadStatusSchema,
});
const contentRecordSchema = z.object({
  artifactId: z.string(),
  contentToken: z.string(),
  createdAt: z.string(),
  expiresAt: z.string(),
  principalId: z.string(),
  projectId: z.string(),
  tokenDigest: z.string(),
  versionId: z.string(),
});
const commentPrincipalKindSchema = z.enum([
  principalKinds.human,
  principalKinds.service,
]);
const commentThreadStateSchema = z.enum([
  commentThreadStates.open,
  commentThreadStates.resolved,
]);
const commentThreadRowSchema = z.object({
  anchorJson: z.string().nullable(),
  artifactId: z.string(),
  authorAuthorizedByPrincipalId: z.string().nullable(),
  authorDisplayName: z.string(),
  authorPrincipalId: z.string(),
  authorPrincipalKind: commentPrincipalKindSchema,
  body: z.string(),
  createdAt: z.string(),
  id: z.string(),
  installationId: z.string(),
  path: z.string().nullable(),
  projectId: z.string(),
  replyCount: z.number().int().nonnegative(),
  resolvedAt: z.string().nullable(),
  resolvedByAuthorizedByPrincipalId: z.string().nullable(),
  resolvedByDisplayName: z.string().nullable(),
  resolvedByPrincipalId: z.string().nullable(),
  resolvedByPrincipalKind: commentPrincipalKindSchema.nullable(),
  state: commentThreadStateSchema,
  updatedAt: z.string(),
  versionId: z.string(),
});
const commentReplyRowSchema = z.object({
  authorAuthorizedByPrincipalId: z.string().nullable(),
  authorDisplayName: z.string(),
  authorPrincipalId: z.string(),
  authorPrincipalKind: commentPrincipalKindSchema,
  body: z.string(),
  createdAt: z.string(),
  id: z.string(),
  projectId: z.string(),
  threadId: z.string(),
  updatedAt: z.string(),
});
const agentBeaconStateSchema = z.enum([
  agentBeaconStates.idle,
  agentBeaconStates.replying,
  agentBeaconStates.thinking,
]);
const registeredAgentRowSchema = z.object({
  activityAt: z.string().nullable(),
  activityState: agentBeaconStateSchema.nullable(),
  agentSessionId: z.string().nullable(),
  capabilitiesJson: z.string().nullable(),
  connectionKey: z.string(),
  createdAt: z.string(),
  displayName: z.string(),
  id: z.string(),
  installationId: z.string(),
  kind: z.string(),
  lastSeenAt: z.string(),
  principalId: z.string(),
  workingDirectory: z.string(),
}).transform(({capabilitiesJson, ...agent}) => ({
  ...agent,
  capabilities: parseStoredAgentCapabilities(capabilitiesJson),
}));
const agentDispatchStateSchema = z.enum([
  agentDispatchStates.addressed,
  agentDispatchStates.canceled,
  agentDispatchStates.claimed,
  agentDispatchStates.delivered,
  agentDispatchStates.failed,
  agentDispatchStates.queued,
]);
const workingDispatchRowSchema = z.object({
  agentId: z.string(),
  id: z.string(),
});
const latestDispatchTransitionRowSchema = z.object({
  agentId: z.string(),
  latestAt: z.string().nullable(),
});
const clearableThreadRowSchema = z.object({
  dispatchState: agentDispatchStateSchema.nullable(),
  id: z.string(),
  versionId: z.string(),
});
const agentDispatchRowSchema = z.object({
  addressedAt: z.string().nullable(),
  agentDisplayName: z.string(),
  agentId: z.string(),
  canceledAt: z.string().nullable(),
  claimedAt: z.string().nullable(),
  createdAt: z.string(),
  deliveredAt: z.string().nullable(),
  failedAt: z.string().nullable(),
  failureReason: z.string().nullable(),
  id: z.string(),
  idempotencyKey: z.string(),
  installationId: z.string(),
  leaseExpiresAt: z.string().nullable(),
  note: z.string().nullable(),
  projectId: z.string(),
  senderAuthorizedByPrincipalId: z.string().nullable(),
  senderDisplayName: z.string(),
  senderPrincipalId: z.string(),
  senderPrincipalKind: commentPrincipalKindSchema,
  state: agentDispatchStateSchema,
  threadIdsJson: z.string(),
  updatedAt: z.string(),
});
const dispatchThreadCheckRowSchema = z.object({
  dispatchId: z.string().nullable(),
  id: z.string(),
  state: commentThreadStateSchema,
});
const dispatchCandidateRowSchema = z.object({
  id: z.string(),
  installationId: z.string(),
});
const threadIdsSchema = z.array(z.string());
const versionContentRowSchema = z.object({
  accessSetting: accessSettingSchema,
  artifactId: z.string(),
  contentToken: z.string(),
  disposition: dispositionSchema,
  isCurrent: z.union([z.literal(0), z.literal(1)]).transform((value) => value === 1),
  mediaType: z.string(),
  path: z.string(),
  projectId: z.string(),
  sha256: z.string(),
  size: z.number().int().nonnegative(),
  versionId: z.string(),
});

const artifactSelect = `
  SELECT id, project_id AS projectId, name,
    access_setting AS accessSetting,
    current_version_id AS currentVersionId,
    created_at AS createdAt, deleted_at AS deletedAt
  FROM artifacts
`;
const versionSelect = `
  SELECT id, project_id AS projectId, artifact_id AS artifactId, number,
    manifest_digest AS manifestDigest, entry_path AS entryPath,
    routing_mode AS routingMode, content_token AS contentToken,
    publisher_principal_id AS publisherPrincipalId, created_at AS createdAt
  FROM versions
`;
const commentThreadSelect = `
  SELECT t.id, t.installation_id AS installationId,
    t.project_id AS projectId, t.artifact_id AS artifactId,
    t.version_id AS versionId, t.path, t.anchor_json AS anchorJson,
    t.body, t.state,
    t.author_principal_id AS authorPrincipalId,
    t.author_principal_kind AS authorPrincipalKind,
    t.author_display_name AS authorDisplayName,
    t.author_authorized_by_principal_id AS authorAuthorizedByPrincipalId,
    t.resolved_at AS resolvedAt,
    t.resolved_by_principal_id AS resolvedByPrincipalId,
    t.resolved_by_principal_kind AS resolvedByPrincipalKind,
    t.resolved_by_display_name AS resolvedByDisplayName,
    t.resolved_by_authorized_by_principal_id AS resolvedByAuthorizedByPrincipalId,
    t.created_at AS createdAt, t.updated_at AS updatedAt,
    (SELECT COUNT(*) FROM comment_replies r WHERE r.thread_id = t.id) AS replyCount
  FROM comment_threads t
`;
const registeredAgentSelect = `
  SELECT id, installation_id AS installationId,
    connection_key AS connectionKey, display_name AS displayName, kind,
    working_directory AS workingDirectory,
    agent_session_id AS agentSessionId, principal_id AS principalId,
    created_at AS createdAt, last_seen_at AS lastSeenAt,
    capabilities_json AS capabilitiesJson,
    activity_state AS activityState, activity_at AS activityAt
  FROM registered_agents
`;
const agentDispatchSelect = `
  SELECT d.id, d.installation_id AS installationId,
    d.project_id AS projectId, d.agent_id AS agentId,
    d.agent_display_name AS agentDisplayName,
    d.thread_ids_json AS threadIdsJson, d.note, d.state,
    d.sender_principal_id AS senderPrincipalId,
    d.sender_principal_kind AS senderPrincipalKind,
    d.sender_display_name AS senderDisplayName,
    d.sender_authorized_by_principal_id AS senderAuthorizedByPrincipalId,
    d.idempotency_key AS idempotencyKey, d.claimed_at AS claimedAt,
    d.lease_expires_at AS leaseExpiresAt, d.delivered_at AS deliveredAt,
    d.addressed_at AS addressedAt, d.failed_at AS failedAt,
    d.failure_reason AS failureReason, d.canceled_at AS canceledAt,
    d.created_at AS createdAt, d.updated_at AS updatedAt
  FROM agent_dispatches d
`;
const commentReplySelect = `
  SELECT r.id, r.thread_id AS threadId, r.project_id AS projectId, r.body,
    r.author_principal_id AS authorPrincipalId,
    r.author_principal_kind AS authorPrincipalKind,
    r.author_display_name AS authorDisplayName,
    r.author_authorized_by_principal_id AS authorAuthorizedByPrincipalId,
    r.created_at AS createdAt, r.updated_at AS updatedAt
  FROM comment_replies r
`;
const commentThreadScope =
  "FROM comment_threads t WHERE t.id = ? AND t.project_id = ? AND t.artifact_id = ?";
const commentReplyScope = `FROM comment_threads t
  JOIN comment_replies r ON r.thread_id = t.id AND r.id = ?
  WHERE t.id = ? AND t.project_id = ? AND t.artifact_id = ?`;
const idempotencySelect = `
  SELECT access_setting AS accessSetting, artifact_id AS artifactId,
    input_digest AS inputDigest, operation, tags_json AS tagsJson,
    version_id AS versionId
  FROM idempotency_records
`;

interface PageResult<Item> {
  readonly items: readonly Item[];
  readonly nextCursor: PageCursor | null;
}

export type D1ArtifactRepository = AgentDispatchRepository & ArtifactRepository &
  CommentRepository & ContentSessionRepository & ProjectRepository &
  ProjectGitHistoryStore & GitHistoryMirrorStore & GitHistoryPurgeStore &
  StagedUploadRepository & {
    readonly listPublicLinks: (
      command: ListPublicLinks,
    ) => Promise<PublicLinkInventoryPage>;
  };

/**
 * D1 binds at most 100 parameters per statement, and a batch is the only
 * atomicity D1 offers, so every row of one publication has to reach the
 * database inside a single batch. Multi-row INSERT statements carry the same
 * rows in far fewer statements: each statement takes the parameter budget
 * divided by the columns one row binds.
 * https://developers.cloudflare.com/d1/platform/limits/
 */
const maximumBoundParametersPerStatement = 100;
const manifestEntryColumns = [
  "version_id",
  "path",
  "size",
  "media_type",
  "sha256",
  "disposition",
];
const stagedUploadFileColumns = [
  "upload_id",
  "storage_token",
  "path",
  "size",
  "media_type",
  "sha256",
  "disposition",
];

const buildManifest = (
  version: VersionRecord,
  stored: readonly z.output<typeof entryRowSchema>[],
) => {
  const manifest = createManifest({
    entryPath: version.entryPath,
    files: stored.map(({mediaType, path, sha256, size}) => ({
      mediaType,
      path,
      sha256,
      size,
    })),
    routingMode: version.routingMode,
  });
  if (manifest.digest !== version.manifestDigest) {
    throw new Error(`Saved version ${version.id} has an invalid manifest digest.`);
  }
  const canonicalByPath = new Map(
    manifest.entries.map((entry) => [entry.path, entry] as const),
  );
  for (const storedEntry of stored) {
    if (canonicalByPath.get(storedEntry.path)?.disposition !== storedEntry.disposition) {
      throw new Error(`Saved version ${version.id} has invalid serving metadata.`);
    }
  }
  return manifest;
};

/** Build Artifact Server persistence ports over one installation-scoped D1 binding. */
export function createD1ArtifactRepository(
  database: D1Database,
  installationId: string,
): D1ArtifactRepository {
  const readProjectOrNull = async (projectId: string): Promise<ProjectRecord | null> => {
    const row = await database.prepare(`
      SELECT id, installation_id AS installationId, name,
        created_at AS createdAt, archived_at AS archivedAt
      FROM projects WHERE installation_id = ? AND id = ?
    `).bind(installationId, projectId).first<z.input<typeof projectRowSchema>>();
    return row === null ? null : projectRowSchema.parse(row);
  };
  const readProject = async (projectId: string): Promise<ProjectRecord> => {
    const project = await readProjectOrNull(projectId);
    if (project === null) throw new ProjectNotFound({message: "The project does not exist."});
    return project;
  };
  const assertProjectActive = async (projectId: string): Promise<void> => {
    const project = await readProjectOrNull(projectId);
    if (project === null || project.archivedAt !== null) {
      throw new ProjectArchived({
        message: "The project is archived and cannot accept new work.",
      });
    }
  };
  const readTags = async (artifactId: string): Promise<readonly string[]> => {
    const result = await database.prepare(`
      SELECT artifact_id AS artifactId, tag FROM artifact_tags
      WHERE artifact_id = ? ORDER BY tag
    `).bind(artifactId).all<z.input<typeof tagRowSchema>>();
    return result.results.map((row) => tagRowSchema.parse(row).tag);
  };
  const readArtifactOrNull = async (
    projectId: string,
    artifactId: string,
    includeDeleted = false,
  ): Promise<ArtifactRecord | null> => {
    const [artifactResult, tagsResult] = await database.batch([
      database.prepare(`${artifactSelect}
        WHERE project_id = ? AND id = ? ${includeDeleted ? "" : "AND deleted_at IS NULL"}
      `).bind(projectId, artifactId),
      database.prepare(`
        SELECT artifact_id AS artifactId, tag FROM artifact_tags
        WHERE artifact_id = ? ORDER BY tag
      `).bind(artifactId),
    ]);
    const row = artifactResult?.results[0] ?? null;
    if (row === null) return null;
    const artifact = artifactRowSchema.parse(row);
    const tags = (tagsResult?.results ?? [])
      .map((tagRow) => tagRowSchema.parse(tagRow).tag);
    return {...artifact, tags};
  };
  const readArtifact = async (
    projectId: string,
    artifactId: string,
  ): Promise<ArtifactRecord> => {
    const artifact = await readArtifactOrNull(projectId, artifactId);
    if (artifact === null) throw new ArtifactNotFound({message: "The artifact does not exist."});
    return artifact;
  };
  const readVersionOrNull = async (
    projectId: string,
    versionId: string,
    artifactId: string,
  ): Promise<VersionRecord | null> => {
    const row = await database.prepare(`${versionSelect}
      WHERE project_id = ? AND id = ? AND artifact_id = ?
    `).bind(projectId, versionId, artifactId)
      .first<z.input<typeof versionRowSchema>>();
    return row === null ? null : versionRowSchema.parse(row);
  };
  const readPublishedVersion = async (
    projectId: string,
    versionId: string,
    replayed: boolean,
  ): Promise<PublishedVersion> => {
    const versionRow = await database.prepare(`${versionSelect}
      WHERE project_id = ? AND id = ?
    `).bind(projectId, versionId).first<z.input<typeof versionRowSchema>>();
    if (versionRow === null) throw new Error(`Saved version ${versionId} is missing.`);
    const version = versionRowSchema.parse(versionRow);
    const artifact = await readArtifact(projectId, version.artifactId);
    return {artifact, replayed, version};
  };
  const readIdempotency = async (
    projectId: string,
    idempotencyKey: string,
  ) => {
    const row = await database.prepare(`${idempotencySelect}
      WHERE project_id = ? AND idempotency_key = ?
    `).bind(projectId, idempotencyKey)
      .first<z.input<typeof idempotencyRowSchema>>();
    return row === null ? null : idempotencyRowSchema.parse(row);
  };
  const findIdempotentPublication = async (
    projectId: string,
    idempotencyKey: string,
    inputDigest: string,
  ): Promise<PublishedVersion | null> => {
    const record = await readIdempotency(projectId, idempotencyKey);
    if (record === null) return null;
    if (record.operation !== artifactActionKinds.publish || record.inputDigest !== inputDigest) {
      throw new IdempotencyConflict({
        message: "The idempotency key was already used with different input.",
      });
    }
    return readPublishedVersion(projectId, record.versionId, true);
  };
  const readStagedUploadOrNull = async (
    projectId: string,
    uploadId: string,
    principalId: string,
  ): Promise<StagedUpload | null> => {
    const row = await database.prepare(`
      SELECT id, project_id AS projectId, principal_id AS principalId, status,
        manifest_digest AS manifestDigest, entry_path AS entryPath,
        routing_mode AS routingMode, created_at AS createdAt,
        expires_at AS expiresAt, committed_version_id AS committedVersionId
      FROM staged_uploads
      WHERE project_id = ? AND id = ? AND principal_id = ?
    `).bind(projectId, uploadId, principalId)
      .first<z.input<typeof stagedUploadSchema>>();
    if (row === null) return null;
    const upload = stagedUploadSchema.parse(row);
    const filesResult = await database.prepare(`
      SELECT storage_token AS storageToken, path, size,
        media_type AS mediaType, sha256, disposition,
        uploaded_at AS uploadedAt
      FROM staged_upload_files WHERE upload_id = ? ORDER BY path
    `).bind(uploadId).all<z.input<typeof stagedFileSchema>>();
    const files = filesResult.results.map((file) => stagedFileSchema.parse(file));
    const manifest = createManifest({
      entryPath: upload.entryPath,
      files: files.map(({mediaType, path, sha256, size}) => ({
        mediaType,
        path,
        sha256,
        size,
      })),
      routingMode: upload.routingMode,
    });
    if (manifest.digest !== upload.manifestDigest) {
      throw new Error(`Staged upload ${uploadId} has an invalid manifest digest.`);
    }
    const stagedFiles: readonly StagedUploadFile[] = files.map((file) => ({
      entry: {
        disposition: file.disposition,
        mediaType: file.mediaType,
        path: file.path,
        sha256: file.sha256,
        size: file.size,
      },
      storageToken: file.storageToken,
      uploadedAt: file.uploadedAt,
    }));
    return {...upload, files: stagedFiles, manifest};
  };
  const assertSourceReady = async (
    source: PublicationSource,
    manifestDigest: string,
    commitTime: string,
  ): Promise<void> => {
    const row = await database.prepare(`
      SELECT u.status, u.expires_at AS expiresAt,
        u.manifest_digest AS manifestDigest,
        COUNT(f.storage_token) AS fileCount,
        COALESCE(SUM(CASE WHEN f.uploaded_at IS NOT NULL THEN 1 ELSE 0 END), 0) AS readyCount
      FROM staged_uploads u
      LEFT JOIN staged_upload_files f ON f.upload_id = u.id
      WHERE u.project_id = ? AND u.id = ? AND u.principal_id = ?
      GROUP BY u.id
    `).bind(source.projectId, source.uploadId, source.principalId)
      .first<z.input<typeof stagedCommitSchema>>();
    if (row === null) throw new UploadNotFound({message: "The staged upload does not exist."});
    const upload = stagedCommitSchema.parse(row);
    if (upload.status !== uploadStatuses.open) {
      throw new UploadClosed({message: "The staged upload is already committed."});
    }
    if (upload.expiresAt <= commitTime) {
      throw new UploadExpired({message: "The staged upload has expired."});
    }
    if (
      upload.fileCount === 0 || upload.readyCount !== upload.fileCount ||
      upload.manifestDigest !== manifestDigest
    ) {
      throw new UploadIncomplete({
        message: "Every declared upload file must be verified before commit.",
      });
    }
  };
  const artifactState = async (
    projectId: string,
    artifactId: string,
    versionId: string,
    replayed: boolean,
    accessSetting?: ArtifactRecord["accessSetting"],
    tags?: readonly string[],
  ): Promise<ArtifactState> => {
    const artifact = await readArtifact(projectId, artifactId);
    const version = await readVersionOrNull(projectId, versionId, artifactId);
    if (version === null) throw new Error(`Artifact state references missing version ${versionId}.`);
    return {
      artifact: {
        ...artifact,
        accessSetting: accessSetting ?? artifact.accessSetting,
        currentVersionId: versionId,
        tags: tags ?? artifact.tags,
      },
      replayed,
      version,
    };
  };
  /**
   * Build the fewest INSERT statements that carry every row while each one
   * stays inside D1's per-statement parameter budget, so a publication of any
   * declared size still commits as one atomic batch.
   */
  const insertRowsStatements = (
    table: string,
    columns: readonly string[],
    rows: readonly (readonly (number | string | null)[])[],
  ): readonly D1PreparedStatement[] => {
    const rowsPerStatement = Math.floor(
      maximumBoundParametersPerStatement / columns.length,
    );
    const rowPlaceholders = `(${columns.map(() => "?").join(", ")})`;
    const statements: D1PreparedStatement[] = [];
    for (let start = 0; start < rows.length; start += rowsPerStatement) {
      const chunk = rows.slice(start, start + rowsPerStatement);
      statements.push(database.prepare(
        `INSERT INTO ${table} (${columns.join(", ")})
          VALUES ${chunk.map(() => rowPlaceholders).join(", ")}`,
      ).bind(...chunk.flat()));
    }
    return statements;
  };
  const actionStatement = (
    command: {
      readonly artifactId: string;
      readonly authorizedByPrincipalId: string | null;
      readonly createdAt: string;
      readonly idempotencyKey: string;
      readonly principalId: string;
      readonly projectId: string;
    },
    versionId: string,
    action: ArtifactActionRecord["action"],
  ) => database.prepare(`
    INSERT INTO actions (
      id, project_id, artifact_id, version_id, action, principal_id,
      authorized_by_principal_id, idempotency_key, created_at
    ) VALUES (lower(hex(randomblob(16))), ?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    command.projectId,
    command.artifactId,
    versionId,
    action,
    command.principalId,
    command.authorizedByPrincipalId,
    command.idempotencyKey,
    command.createdAt,
  );
  const idempotencyStatement = (
    command: {
      readonly artifactId: string;
      readonly createdAt: string;
      readonly idempotencyKey: string;
      readonly inputDigest: string;
      readonly projectId: string;
    },
    versionId: string,
    operation: ArtifactActionRecord["action"],
    accessSetting: ArtifactRecord["accessSetting"] | null = null,
    tagsJson: string | null = null,
  ) => database.prepare(`
    INSERT INTO idempotency_records (
      project_id, idempotency_key, input_digest, artifact_id, version_id,
      operation, access_setting, tags_json, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    command.projectId,
    command.idempotencyKey,
    command.inputDigest,
    command.artifactId,
    versionId,
    operation,
    accessSetting,
    tagsJson,
    command.createdAt,
  );
  const mutationGuardStatements = (
    id: string,
    predicate: string,
    bindings: readonly (number | string | null)[],
  ): readonly D1PreparedStatement[] => [
    database.prepare(`
      INSERT INTO mutation_checks (id, succeeded)
      VALUES (?, CASE WHEN EXISTS (${predicate}) THEN 1 ELSE 0 END)
    `).bind(id, ...bindings),
    database.prepare("DELETE FROM mutation_checks WHERE id = ?").bind(id),
  ];
  const publicationGuardStatements = (
    command: CommitNewArtifact | CommitArtifactVersion,
  ): readonly D1PreparedStatement[] => mutationGuardStatements(
    `publish:${command.projectId}:${command.idempotencyKey}`,
    `SELECT 1 FROM artifacts a JOIN staged_uploads u ON u.id = ?
      JOIN idempotency_records i
        ON i.project_id = a.project_id AND i.idempotency_key = ?
      WHERE a.project_id = ? AND a.id = ? AND a.current_version_id = ?
        AND a.deleted_at IS NULL AND u.project_id = ? AND u.principal_id = ?
        AND u.status = 'committed' AND u.committed_version_id = ?
        AND i.input_digest = ? AND i.artifact_id = ? AND i.version_id = ?
        AND i.operation = 'publish'`,
    [
      command.source.uploadId,
      command.idempotencyKey,
      command.projectId,
      command.artifactId,
      command.versionId,
      command.source.projectId,
      command.source.principalId,
      command.versionId,
      command.inputDigest,
      command.artifactId,
      command.versionId,
    ],
  );
  const managementGuardStatements = (
    command: {
      readonly artifactId: string;
      readonly idempotencyKey: string;
      readonly inputDigest: string;
      readonly projectId: string;
    },
    operation: ArtifactActionRecord["action"],
    currentVersionId: string,
    artifactPredicate: string,
    artifactBindings: readonly (number | string | null)[] = [],
  ): readonly D1PreparedStatement[] => mutationGuardStatements(
    `${operation}:${command.projectId}:${command.idempotencyKey}`,
    `SELECT 1 FROM artifacts a JOIN idempotency_records i
      ON i.project_id = a.project_id AND i.idempotency_key = ?
      WHERE a.project_id = ? AND a.id = ? AND a.current_version_id = ?
        AND ${artifactPredicate}
        AND i.input_digest = ? AND i.artifact_id = ? AND i.version_id = ?
        AND i.operation = ?`,
    [
      command.idempotencyKey,
      command.projectId,
      command.artifactId,
      currentVersionId,
      ...artifactBindings,
      command.inputDigest,
      command.artifactId,
      currentVersionId,
      operation,
    ],
  );
  const versionStatements = (
    command: CommitNewArtifact | CommitArtifactVersion,
    versionNumber: number,
  ): readonly D1PreparedStatement[] => [
    database.prepare(`
      INSERT INTO versions (
        id, project_id, artifact_id, number, manifest_digest, entry_path,
        routing_mode, content_token, publisher_principal_id, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      command.versionId,
      command.projectId,
      command.artifactId,
      versionNumber,
      command.manifest.digest,
      command.manifest.entryPath,
      command.manifest.routingMode,
      command.contentToken,
      command.principalId,
      command.createdAt,
    ),
    ...insertRowsStatements(
      "manifest_entries",
      manifestEntryColumns,
      command.manifest.entries.map((entry) => [
        command.versionId,
        entry.path,
        entry.size,
        entry.mediaType,
        entry.sha256,
        entry.disposition,
      ]),
    ),
  ];
  const mirrorJobStatement = (
    projectId: string,
    artifactId: string,
    versionId: string,
    createdAt: string,
  ): D1PreparedStatement => database.prepare(`
    INSERT OR IGNORE INTO git_history_jobs (
      id, installation_id, project_id, artifact_id, version_id,
      kind, state, attempts, file_copy_limit_bytes,
      version_copy_limit_bytes, maximum_copied_files,
      storage_budget_bytes, copy_policy_digest, lease_expires_at,
      available_at, last_error, created_at, updated_at
    )
    SELECT ?, setting.installation_id, setting.project_id, ?, ?,
      'mirror-version', 'queued', 0, setting.file_copy_limit_bytes,
      setting.version_copy_limit_bytes, setting.maximum_copied_files,
      setting.storage_budget_bytes,
      'd1:' || setting.file_copy_limit_bytes || ':' ||
        setting.version_copy_limit_bytes || ':' || setting.maximum_copied_files,
      NULL, ?, NULL, ?, ?
    FROM git_history_project_settings setting
    WHERE setting.installation_id = ? AND setting.project_id = ?
      AND setting.enabled = 1
  `).bind(
    d1MirrorJobId(versionId),
    artifactId,
    versionId,
    createdAt,
    createdAt,
    createdAt,
    installationId,
    projectId,
  );
  const managementReplay = async (
    command: {readonly idempotencyKey: string; readonly inputDigest: string; readonly projectId: string},
    operation: typeof artifactActionKinds.changeAccess | typeof artifactActionKinds.changeTags |
      typeof artifactActionKinds.restore,
  ): Promise<ArtifactState | null> => {
    const record = await readIdempotency(command.projectId, command.idempotencyKey);
    if (record === null) return null;
    if (record.inputDigest !== command.inputDigest || record.operation !== operation) {
      throw new IdempotencyConflict({message: "The idempotency key was already used with different input."});
    }
    const tags = record.tagsJson === null
      ? undefined
      : z.array(z.string()).parse(JSON.parse(record.tagsJson));
    return artifactState(
      command.projectId,
      record.artifactId,
      record.versionId,
      true,
      record.accessSetting ?? undefined,
      tags,
    );
  };
  const applyManagementMutation = async (
    command: {
      readonly idempotencyKey: string;
      readonly inputDigest: string;
      readonly projectId: string;
    },
    operation: typeof artifactActionKinds.changeAccess |
      typeof artifactActionKinds.changeTags |
      typeof artifactActionKinds.restore,
    statements: D1PreparedStatement[],
    readState: () => Promise<ArtifactState>,
  ): Promise<ArtifactState> => {
    try {
      const results = await database.batch(statements);
      if (results[0]?.meta.changes !== 1) throw changedDuringManagement();
      return await readState();
    } catch (cause) {
      const raced = await managementReplay(command, operation);
      if (raced !== null) return raced;
      if (cause instanceof Error && /constraint|unique/iu.test(cause.message)) {
        throw changedDuringManagement();
      }
      throw cause;
    }
  };

  const readThreadRowOrNull = async (
    projectId: string,
    artifactId: string,
    threadId: string,
  ): Promise<z.infer<typeof commentThreadRowSchema> | null> => {
    const row = await database.prepare(`${commentThreadSelect}
      WHERE t.id = ? AND t.project_id = ? AND t.artifact_id = ?
    `).bind(threadId, projectId, artifactId)
      .first<z.input<typeof commentThreadRowSchema>>();
    return row === null ? null : commentThreadRowSchema.parse(row);
  };
  const readThreadRow = async (
    projectId: string,
    artifactId: string,
    threadId: string,
  ): Promise<z.infer<typeof commentThreadRowSchema>> => {
    const row = await readThreadRowOrNull(projectId, artifactId, threadId);
    if (row === null) {
      throw new Error(
        `Comment thread ${threadId} was not found after a successful write.`,
      );
    }
    return row;
  };
  const readThreadDispatchState = async (
    projectId: string,
    artifactId: string,
    threadId: string,
  ): Promise<AgentDispatchState | null> => {
    const row = await database.prepare(`
      SELECT d.state AS state
      FROM comment_threads t
      LEFT JOIN agent_dispatches d ON d.id = t.dispatch_id
      WHERE t.id = ? AND t.project_id = ? AND t.artifact_id = ?
    `).bind(threadId, projectId, artifactId).first<{state: string | null}>();
    return agentDispatchStateSchema.nullable().parse(row?.state ?? null);
  };
  const readIdempotentThreadRowOrNull = async (
    projectId: string,
    idempotencyKey: string,
  ): Promise<z.infer<typeof commentThreadRowSchema> | null> => {
    const row = await database.prepare(`${commentThreadSelect}
      WHERE t.project_id = ? AND t.idempotency_key = ?
    `).bind(projectId, idempotencyKey)
      .first<z.input<typeof commentThreadRowSchema>>();
    return row === null ? null : commentThreadRowSchema.parse(row);
  };
  const readReplyRowOrNull = async (
    replyId: string,
  ): Promise<z.infer<typeof commentReplyRowSchema> | null> => {
    const row = await database.prepare(`${commentReplySelect} WHERE r.id = ?`)
      .bind(replyId).first<z.input<typeof commentReplyRowSchema>>();
    return row === null ? null : commentReplyRowSchema.parse(row);
  };
  const readReplyRow = async (
    replyId: string,
  ): Promise<z.infer<typeof commentReplyRowSchema>> => {
    const row = await readReplyRowOrNull(replyId);
    if (row === null) {
      throw new Error(
        `Comment reply ${replyId} was not found after a successful write.`,
      );
    }
    return row;
  };
  const readIdempotentReplyRowOrNull = async (
    projectId: string,
    idempotencyKey: string,
  ): Promise<z.infer<typeof commentReplyRowSchema> | null> => {
    const row = await database.prepare(`${commentReplySelect}
      WHERE r.project_id = ? AND r.idempotency_key = ?
    `).bind(projectId, idempotencyKey)
      .first<z.input<typeof commentReplyRowSchema>>();
    return row === null ? null : commentReplyRowSchema.parse(row);
  };
  const commentActionStatement = (
    entry: {
      readonly action: ArtifactActionRecord["action"];
      readonly actionId: string | null;
      readonly authorizedByPrincipalId: string | null;
      readonly changedAt: string;
      readonly idempotencyKey: string;
      readonly principalId: string;
    },
    source: string,
    sourceBindings: readonly string[],
  ): D1PreparedStatement => database.prepare(`
    INSERT INTO actions (
      id, project_id, artifact_id, version_id, action, principal_id,
      authorized_by_principal_id, idempotency_key, created_at
    )
    SELECT COALESCE(?, lower(hex(randomblob(16)))), t.project_id, t.artifact_id,
      t.version_id, ?, ?, ?, ?, ?
    ${source}
  `).bind(
    entry.actionId,
    entry.action,
    entry.principalId,
    entry.authorizedByPrincipalId,
    entry.idempotencyKey,
    entry.changedAt,
    ...sourceBindings,
  );

  const readAgentRowOrNull = async (
    scopeInstallationId: string,
    agentId: string,
  ): Promise<RegisteredAgentRecord | null> => {
    const row = await database.prepare(`${registeredAgentSelect}
      WHERE installation_id = ? AND id = ?
    `).bind(scopeInstallationId, agentId)
      .first<z.input<typeof registeredAgentRowSchema>>();
    return row === null ? null : registeredAgentRowSchema.parse(row);
  };
  const readAgentRowByConnectionKey = async (
    scopeInstallationId: string,
    principalId: string,
    connectionKey: string,
  ): Promise<RegisteredAgentRecord> => {
    const row = await database.prepare(`${registeredAgentSelect}
      WHERE installation_id = ? AND principal_id = ? AND connection_key = ?
    `).bind(scopeInstallationId, principalId, connectionKey)
      .first<z.input<typeof registeredAgentRowSchema>>();
    if (row === null) {
      throw new Error(
        `Registered agent ${connectionKey} was not found after a successful write.`,
      );
    }
    return registeredAgentRowSchema.parse(row);
  };
  const readDispatchRowOrNull = async (
    scopeInstallationId: string,
    dispatchId: string,
  ): Promise<z.infer<typeof agentDispatchRowSchema> | null> => {
    const row = await database.prepare(`${agentDispatchSelect}
      WHERE d.installation_id = ? AND d.id = ?
    `).bind(scopeInstallationId, dispatchId)
      .first<z.input<typeof agentDispatchRowSchema>>();
    return row === null ? null : agentDispatchRowSchema.parse(row);
  };
  const readDispatchRow = async (
    scopeInstallationId: string,
    dispatchId: string,
  ): Promise<z.infer<typeof agentDispatchRowSchema>> => {
    const row = await readDispatchRowOrNull(scopeInstallationId, dispatchId);
    if (row === null) {
      throw new Error(
        `Agent dispatch ${dispatchId} was not found after a successful write.`,
      );
    }
    return row;
  };
  const readIdempotentDispatchRowOrNull = async (
    scopeInstallationId: string,
    projectId: string,
    idempotencyKey: string,
  ): Promise<z.infer<typeof agentDispatchRowSchema> | null> => {
    const row = await database.prepare(`${agentDispatchSelect}
      WHERE d.installation_id = ? AND d.project_id = ? AND d.idempotency_key = ?
    `).bind(scopeInstallationId, projectId, idempotencyKey)
      .first<z.input<typeof agentDispatchRowSchema>>();
    return row === null ? null : agentDispatchRowSchema.parse(row);
  };
  const failedDispatchStatements = (
    dispatchId: string,
    reason: string,
    failedAt: string,
  ): readonly D1PreparedStatement[] => [
    database.prepare(`
      UPDATE agent_dispatches
      SET state = 'failed', failed_at = ?, failure_reason = ?, updated_at = ?,
        claimed_at = NULL, lease_expires_at = NULL
      WHERE id = ?
    `).bind(failedAt, reason, failedAt, dispatchId),
    // A permanent failure returns the annotations to the artifact surfaces,
    // which is a thread edit: a `since` poller must see them come back.
    database.prepare(`
      UPDATE comment_threads SET dispatch_id = NULL, updated_at = ?
      WHERE dispatch_id = ?
    `).bind(failedAt, dispatchId),
  ];
  /**
   * Stamp addressed when every bundle thread is resolved, exactly once. Thread
   * resolution is the ground truth; the markers stay in place because the
   * threads are resolved and already invisible.
   */
  const addressedStatement = (
    scope: string,
    scopeBindings: readonly string[],
    now: string,
  ): D1PreparedStatement => database.prepare(`
    UPDATE agent_dispatches
    SET state = 'addressed', addressed_at = ?, updated_at = ?
    WHERE ${scope} AND state = 'delivered'
      AND json_array_length(thread_ids_json) > 0
      AND (
        SELECT COUNT(*) FROM json_each(thread_ids_json) member
        JOIN comment_threads t ON t.id = member.value AND t.state = 'resolved'
      ) = json_array_length(thread_ids_json)
  `).bind(now, now, ...scopeBindings);
  /**
   * The lazy transition set applied on the read path, in machine order: an
   * expired claim lease returns to queued, a queued dispatch whose agent
   * stopped polling fails as agent_unavailable and releases its threads, and a
   * delivered dispatch whose every bundle thread is resolved is stamped
   * addressed once. Each statement carries its own precondition, so the batch
   * is one atomic pass whichever transitions apply.
   */
  const transitionStatements = (
    scope: string,
    scopeBindings: readonly string[],
    now: string,
  ): readonly D1PreparedStatement[] => [
    database.prepare(`
      UPDATE agent_dispatches
      SET state = 'queued', claimed_at = NULL, lease_expires_at = NULL,
        updated_at = ?
      WHERE ${scope} AND state = 'claimed' AND lease_expires_at < ?
    `).bind(now, ...scopeBindings, now),
    database.prepare(`
      UPDATE agent_dispatches
      SET state = 'failed', failed_at = ?, failure_reason = 'agent_unavailable',
        updated_at = ?, claimed_at = NULL, lease_expires_at = NULL
      WHERE ${scope} AND state = 'queued' AND NOT EXISTS (
        SELECT 1 FROM registered_agents a
        WHERE a.id = agent_dispatches.agent_id AND a.last_seen_at >= ?
      )
    `).bind(
      now,
      now,
      ...scopeBindings,
      isoBefore(now, agentUnavailableStalenessMilliseconds),
    ),
    database.prepare(`
      UPDATE comment_threads SET dispatch_id = NULL, updated_at = ?
      WHERE dispatch_id IN (
        SELECT id FROM agent_dispatches
        WHERE ${scope} AND state IN ('failed', 'canceled')
      )
    `).bind(now, ...scopeBindings),
    addressedStatement(scope, scopeBindings, now),
  ];
  const applyDispatchTransitions = async (
    dispatchId: string,
    now: string,
  ): Promise<void> => {
    await database.batch([...transitionStatements("id = ?", [dispatchId], now)]);
  };
  const applyProjectTransitions = async (
    scopeInstallationId: string,
    projectId: string,
    now: string,
  ): Promise<void> => {
    await database.batch([...transitionStatements(
      "installation_id = ? AND project_id = ?",
      [scopeInstallationId, projectId],
      now,
    )]);
  };
  const assertSendableThreads = async (
    command: CreateAgentDispatch,
  ): Promise<void> => {
    if (command.threadIds.length === 0) return;
    const placeholders = command.threadIds.map(() => "?").join(", ");
    const result = await database.prepare(`
      SELECT id, state, dispatch_id AS dispatchId FROM comment_threads
      WHERE installation_id = ? AND project_id = ? AND id IN (${placeholders})
    `).bind(command.installationId, command.projectId, ...command.threadIds)
      .all<z.input<typeof dispatchThreadCheckRowSchema>>();
    const found = new Map<string, z.infer<typeof dispatchThreadCheckRowSchema>>();
    for (const row of result.results) {
      const parsed = dispatchThreadCheckRowSchema.parse(row);
      found.set(parsed.id, parsed);
    }
    for (const threadId of command.threadIds) {
      const row = found.get(threadId);
      if (row === undefined) {
        throw new InvalidDispatch({
          message:
            "The bundle references a comment thread that does not exist in this project.",
        });
      }
      if (row.state !== commentThreadStates.open) {
        throw new InvalidDispatch({
          message: "The bundle references a comment thread that is not open.",
        });
      }
      if (row.dispatchId !== null) {
        throw new InvalidDispatch({
          message:
            "The bundle references a comment thread that is already dispatched.",
        });
      }
    }
  };
  /**
   * Apply one dispatch transition together with the thread markers it moves.
   * The guard reads the pre-state inside the batch, so a dispatch that left
   * the allowed set concurrently aborts every statement in the transition.
   */
  const applyGuardedTransition = async (
    guardKey: string,
    scopeInstallationId: string,
    dispatchId: string,
    allowedStates: readonly AgentDispatchState[],
    statements: readonly D1PreparedStatement[],
    refusal: string,
  ): Promise<void> => {
    const placeholders = allowedStates.map(() => "?").join(", ");
    try {
      await database.batch([
        ...mutationGuardStatements(
          `${guardKey}:${dispatchId}`,
          `SELECT 1 FROM agent_dispatches
            WHERE id = ? AND state IN (${placeholders})`,
          [dispatchId, ...allowedStates],
        ),
        ...statements,
      ]);
    } catch (cause) {
      const current = await readDispatchRowOrNull(
        scopeInstallationId,
        dispatchId,
      );
      if (current === null) throw missingDispatch();
      if (!allowedStates.includes(current.state)) {
        throw new DispatchStateConflict({
          message: `A ${current.state} dispatch cannot be ${refusal}.`,
        });
      }
      throw cause;
    }
  };

  return {
    assertPublicationSourceReady: assertSourceReady,
    close: () => undefined,

    createProject: async (command: CreateProject) => {
      if (command.installationId !== installationId) {
        throw new ProjectConflict({message: "The project belongs to another installation."});
      }
      try {
        await database.prepare(`
          INSERT INTO projects (id, installation_id, name, created_at, archived_at)
          VALUES (?, ?, ?, ?, ?)
        `).bind(
          command.id,
          installationId,
          command.name,
          command.createdAt,
          command.archivedAt,
        ).run();
      } catch (cause) {
        if (cause instanceof Error && /constraint|unique/iu.test(cause.message)) {
          throw new ProjectConflict({message: "The project identity is already in use."});
        }
        throw cause;
      }
      return readProject(command.id);
    },
    findProject: readProjectOrNull,
    listProjects: async () => {
      const result = await database.prepare(`
        SELECT id, installation_id AS installationId, name,
          created_at AS createdAt, archived_at AS archivedAt
        FROM projects WHERE installation_id = ? ORDER BY created_at, id
      `).bind(installationId).all<z.input<typeof projectRowSchema>>();
      return result.results.map((row) => projectRowSchema.parse(row));
    },
    readProjectGitHistorySetting: async (projectId: string) => {
      const row = await database.prepare(`
        SELECT project_id AS projectId, enabled,
          updated_by_principal_id AS updatedByPrincipalId,
          updated_at AS updatedAt
        FROM git_history_project_settings
        WHERE installation_id = ? AND project_id = ?
      `).bind(installationId, projectId).first();
      return projectGitHistorySettingRowSchema.nullable().parse(row);
    },
    readProjectGitHistoryProgress: async (
      projectId: string,
    ): Promise<ProjectGitHistoryProgress> => {
      const row = await database.prepare(`
        SELECT
          (SELECT COUNT(*)
            FROM versions version
            JOIN artifacts artifact
              ON artifact.project_id = version.project_id
              AND artifact.id = version.artifact_id
            JOIN git_history_mappings mapping
              ON mapping.installation_id = ?
              AND mapping.project_id = version.project_id
              AND mapping.artifact_id = version.artifact_id
              AND mapping.version_id = version.id
              AND mapping.status = 'recorded'
            WHERE version.project_id = ? AND artifact.deleted_at IS NULL
          ) AS mappedVersions,
          (SELECT COUNT(*)
            FROM versions version
            JOIN artifacts artifact
              ON artifact.project_id = version.project_id
              AND artifact.id = version.artifact_id
            LEFT JOIN git_history_mappings mapping
              ON mapping.installation_id = ?
              AND mapping.project_id = version.project_id
              AND mapping.artifact_id = version.artifact_id
              AND mapping.version_id = version.id
              AND mapping.status = 'recorded'
            WHERE version.project_id = ? AND artifact.deleted_at IS NULL
              AND mapping.version_id IS NULL
          ) AS unmappedVersions,
          (SELECT COUNT(*) FROM git_history_jobs
            WHERE installation_id = ? AND project_id = ?
              AND kind = 'mirror-version' AND state IN ('queued', 'claimed')
          ) AS pendingJobs,
          (SELECT COUNT(*) FROM git_history_jobs
            WHERE installation_id = ? AND project_id = ?
              AND kind = 'mirror-version' AND state = 'queued'
              AND last_error = 'budget_limited'
          ) AS budgetLimitedJobs
      `).bind(
        installationId,
        projectId,
        installationId,
        projectId,
        installationId,
        projectId,
        installationId,
        projectId,
      ).first();
      return projectGitHistoryProgressRowSchema.parse(row);
    },
    estimateProjectGitHistory: async (
      projectId: string,
      limits: {readonly fileCopyBytes: number; readonly versionCopyBytes: number},
    ) => {
      const row = await database.prepare(`
        WITH active_versions AS (
          SELECT version.id
          FROM versions version
          JOIN artifacts artifact ON artifact.id = version.artifact_id
          WHERE version.project_id = ?
            AND artifact.project_id = ?
            AND artifact.deleted_at IS NULL
        ), version_totals AS (
          SELECT active.id,
            COALESCE(SUM(entry.size), 0) AS totalBytes,
            COALESCE(SUM(CASE
              WHEN entry.size <= ? THEN entry.size ELSE 0
            END), 0) AS eligibleBytes
          FROM active_versions active
          LEFT JOIN manifest_entries entry ON entry.version_id = active.id
          GROUP BY active.id
        )
        SELECT
          (SELECT COUNT(*) FROM artifacts
            WHERE project_id = ? AND deleted_at IS NULL) AS repositories,
          (SELECT COUNT(*) FROM active_versions) AS versions,
          COALESCE(SUM(CASE
            WHEN eligibleBytes > ? THEN ? ELSE eligibleBytes
          END), 0) AS estimatedCopiedBytes,
          COALESCE(SUM(totalBytes - CASE
            WHEN eligibleBytes > ? THEN ? ELSE eligibleBytes
          END), 0) AS estimatedPointerBytes
        FROM version_totals
      `).bind(
        projectId,
        projectId,
        limits.fileCopyBytes,
        projectId,
        limits.versionCopyBytes,
        limits.versionCopyBytes,
        limits.versionCopyBytes,
        limits.versionCopyBytes,
      ).first();
      return projectGitHistoryEstimateRowSchema.parse(row);
    },
    storeProjectGitHistorySetting: async (setting: StoreProjectGitHistorySetting) => {
      const statements: D1PreparedStatement[] = [database.prepare(`
        INSERT INTO git_history_project_settings (
          project_id, installation_id, enabled,
          file_copy_limit_bytes, version_copy_limit_bytes,
          maximum_copied_files, storage_budget_bytes,
          updated_by_principal_id, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(project_id) DO UPDATE SET
          enabled = excluded.enabled,
          file_copy_limit_bytes = excluded.file_copy_limit_bytes,
          version_copy_limit_bytes = excluded.version_copy_limit_bytes,
          maximum_copied_files = excluded.maximum_copied_files,
          storage_budget_bytes = excluded.storage_budget_bytes,
          updated_by_principal_id = excluded.updated_by_principal_id,
          updated_at = excluded.updated_at
        WHERE installation_id = excluded.installation_id
      `).bind(
        setting.projectId,
        installationId,
        setting.enabled ? 1 : 0,
        setting.limits.fileCopyBytes,
        setting.limits.versionCopyBytes,
        defaultGitHistoryMaximumCopiedFiles,
        setting.limits.storageBudgetBytes,
        setting.updatedByPrincipalId,
        setting.updatedAt,
      )];
      if (setting.enabled) {
        statements.push(database.prepare(`
          UPDATE git_history_jobs
          SET storage_budget_bytes = ?, last_error = NULL,
            available_at = ?, updated_at = ?
          WHERE installation_id = ? AND project_id = ?
            AND kind = 'mirror-version' AND state = 'queued'
            AND last_error = 'budget_limited'
        `).bind(
          setting.limits.storageBudgetBytes,
          setting.updatedAt,
          setting.updatedAt,
          installationId,
          setting.projectId,
        ));
        statements.push(database.prepare(`
          INSERT OR IGNORE INTO git_history_jobs (
            id, installation_id, project_id, artifact_id, version_id,
            kind, state, attempts, file_copy_limit_bytes,
            version_copy_limit_bytes, maximum_copied_files,
            storage_budget_bytes, copy_policy_digest, lease_expires_at,
            available_at, last_error, created_at, updated_at
          )
          SELECT 'ghj_d1_' || version.id, setting.installation_id,
            version.project_id, version.artifact_id, version.id,
            'mirror-version', 'queued', 0, setting.file_copy_limit_bytes,
            setting.version_copy_limit_bytes, setting.maximum_copied_files,
            setting.storage_budget_bytes,
            'd1:' || setting.file_copy_limit_bytes || ':' ||
              setting.version_copy_limit_bytes || ':' || setting.maximum_copied_files,
            NULL, ?, NULL, ?, ?
          FROM versions version
          JOIN artifacts artifact ON artifact.project_id = version.project_id
            AND artifact.id = version.artifact_id
          JOIN git_history_project_settings setting
            ON setting.installation_id = ? AND setting.project_id = version.project_id
          LEFT JOIN git_history_mappings mapping
            ON mapping.installation_id = setting.installation_id
            AND mapping.project_id = version.project_id
            AND mapping.artifact_id = version.artifact_id
            AND mapping.version_id = version.id
            AND mapping.status = 'recorded'
          WHERE version.project_id = ? AND artifact.deleted_at IS NULL
            AND mapping.version_id IS NULL AND setting.enabled = 1
        `).bind(
          setting.updatedAt,
          setting.updatedAt,
          setting.updatedAt,
          installationId,
          setting.projectId,
        ));
      }
      await database.batch(statements);
      const row = await database.prepare(`
        SELECT project_id AS projectId, enabled,
          updated_by_principal_id AS updatedByPrincipalId,
          updated_at AS updatedAt
        FROM git_history_project_settings
        WHERE installation_id = ? AND project_id = ?
      `).bind(installationId, setting.projectId).first();
      return projectGitHistorySettingRowSchema.parse(row);
    },
    claimGitHistoryJob: async (now: string, leaseExpiresAt: string) => {
      await database.prepare(`
        UPDATE git_history_jobs SET state = 'queued', lease_expires_at = NULL,
          available_at = ?, updated_at = ?
        WHERE installation_id = ? AND state = 'claimed'
          AND lease_expires_at <= ?
      `).bind(now, now, installationId, now).run();
      const result = await database.prepare(`
        UPDATE git_history_jobs
        SET state = 'claimed', attempts = attempts + 1,
          lease_expires_at = ?, updated_at = ?
        WHERE installation_id = ? AND state = 'queued' AND id = (
          SELECT job.id
          FROM git_history_jobs job
          LEFT JOIN git_history_project_settings setting
            ON setting.installation_id = job.installation_id
            AND setting.project_id = job.project_id
          WHERE job.installation_id = ? AND job.state = 'queued'
            AND job.available_at <= ?
            AND (job.kind = 'delete-repository' OR setting.enabled = 1)
            AND NOT EXISTS (
              SELECT 1 FROM git_history_jobs claimed
              WHERE claimed.installation_id = job.installation_id
                AND claimed.artifact_id = job.artifact_id
                AND claimed.state = 'claimed'
            )
          ORDER BY job.created_at, job.id LIMIT 1
        )
        RETURNING id, project_id AS projectId, artifact_id AS artifactId,
          version_id AS versionId, kind, attempts,
          file_copy_limit_bytes AS fileCopyBytes,
          version_copy_limit_bytes AS versionCopyBytes,
          maximum_copied_files AS maximumCopiedFiles,
          storage_budget_bytes AS storageBudgetBytes
      `).bind(
        leaseExpiresAt,
        now,
        installationId,
        installationId,
        now,
      ).all<z.input<typeof gitHistoryJobRowSchema>>();
      return gitHistoryJobRowSchema.nullable().parse(result.results[0] ?? null);
    },
    findGitHistoryRepository: async (projectId, artifactId) => {
      const row = await database.prepare(`
        SELECT project_id AS projectId, artifact_id AS artifactId,
          provider, repository_name AS repositoryName,
          remote_url AS remoteUrl, default_branch AS defaultBranch, status
        FROM git_history_repositories
        WHERE installation_id = ? AND project_id = ? AND artifact_id = ?
      `).bind(installationId, projectId, artifactId).first();
      return gitHistoryRepositoryRowSchema.nullable().parse(row);
    },
    recordGitHistoryRepository: async (coordinates, recordedAt) => {
      await database.prepare(`
        INSERT OR IGNORE INTO git_history_repositories (
          installation_id, project_id, artifact_id, provider,
          repository_name, remote_url, default_branch, status,
          created_at, updated_at
        ) SELECT ?, ?, ?, ?, ?, ?, ?,
          CASE WHEN artifact.deleted_at IS NULL THEN 'provisioned' ELSE 'deleting' END,
          ?, ?
        FROM artifacts artifact
        WHERE artifact.project_id = ? AND artifact.id = ?
      `).bind(
        installationId,
        coordinates.projectId,
        coordinates.artifactId,
        coordinates.provider,
        coordinates.repositoryName,
        coordinates.remoteUrl,
        coordinates.defaultBranch,
        recordedAt,
        recordedAt,
        coordinates.projectId,
        coordinates.artifactId,
      ).run();
      const row = await database.prepare(`
        SELECT project_id AS projectId, artifact_id AS artifactId,
          provider, repository_name AS repositoryName,
          remote_url AS remoteUrl, default_branch AS defaultBranch, status
        FROM git_history_repositories
        WHERE installation_id = ? AND project_id = ? AND artifact_id = ?
      `).bind(
        installationId,
        coordinates.projectId,
        coordinates.artifactId,
      ).first();
      const stored = gitHistoryRepositoryRowSchema.parse(row);
      if (
        stored.repositoryName !== coordinates.repositoryName ||
        stored.remoteUrl !== coordinates.remoteUrl
      ) {
        throw new Error("Git history repository coordinates changed during creation.");
      }
      return stored;
    },
    findGitHistoryMapping: async (projectId, artifactId, versionId) => {
      const row = await database.prepare(`
        SELECT project_id AS projectId, artifact_id AS artifactId,
          version_id AS versionId, repository_name AS repositoryName,
          commit_id AS commitId, copied_bytes AS copiedBytes
        FROM git_history_mappings
        WHERE installation_id = ? AND project_id = ?
          AND artifact_id = ? AND version_id = ? AND status = 'recorded'
      `).bind(
        installationId,
        projectId,
        artifactId,
        versionId,
      ).first();
      return gitHistoryMappingRowSchema.nullable().parse(row);
    },
    reserveGitHistoryBudget: async (
      jobId,
      logicalBytes,
      storageBudgetBytes,
      updatedAt,
    ): Promise<GitHistoryBudgetReservation> => {
      if (storageBudgetBytes === null) {
        const inserted = await database.prepare(`
          INSERT OR IGNORE INTO git_history_budget_reservations (
            job_id, installation_id, logical_bytes, state, updated_at
          ) VALUES (?, ?, ?, 'reserved', ?)
        `).bind(jobId, installationId, logicalBytes, updatedAt).run();
        return inserted.meta.changes === 1
          ? {_tag: "Reserved"}
          : {_tag: "AlreadyReserved"};
      }
      const inserted = await database.prepare(`
        INSERT OR IGNORE INTO git_history_budget_reservations (
          job_id, installation_id, logical_bytes, state, updated_at
        )
        SELECT ?, ?, ?, 'reserved', ?
        WHERE ? IS NULL OR (
          SELECT COALESCE(SUM(logical_bytes), 0)
          FROM git_history_budget_reservations
          WHERE installation_id = ? AND state IN ('reserved', 'committed')
        ) + ? <= ?
      `).bind(
        jobId,
        installationId,
        logicalBytes,
        updatedAt,
        storageBudgetBytes,
        installationId,
        logicalBytes,
        storageBudgetBytes,
      ).run();
      if (inserted.meta.changes === 1) return {_tag: "Reserved"};
      const existing = await database.prepare(`
        SELECT state FROM git_history_budget_reservations
        WHERE installation_id = ? AND job_id = ?
      `).bind(installationId, jobId).first();
      return existing === null
        ? {_tag: "BudgetLimited"}
        : {_tag: "AlreadyReserved"};
    },
    completeGitHistoryMirror: async (job, mapping, completedAt) => {
      await database.batch([
        database.prepare(`
          INSERT OR IGNORE INTO git_history_mappings (
            installation_id, project_id, artifact_id, version_id,
            repository_name, commit_id, attempts, copied_bytes,
            status, created_at
          ) SELECT ?, ?, ?, ?, ?, ?, ?, ?, 'recorded', ?
          WHERE EXISTS (
            SELECT 1 FROM artifacts artifact
            JOIN git_history_jobs claimed
              ON claimed.installation_id = ? AND claimed.id = ?
            WHERE artifact.project_id = ? AND artifact.id = ?
              AND artifact.deleted_at IS NULL AND claimed.state = 'claimed'
          )
        `).bind(
          installationId,
          mapping.projectId,
          mapping.artifactId,
          mapping.versionId,
          mapping.repositoryName,
          mapping.commitId,
          job.attempts,
          mapping.copiedBytes,
          completedAt,
          installationId,
          job.id,
          mapping.projectId,
          mapping.artifactId,
        ),
        database.prepare(`
          UPDATE git_history_budget_reservations
          SET state = 'committed', updated_at = ?
          WHERE installation_id = ? AND job_id = ? AND state = 'reserved'
            AND EXISTS (
              SELECT 1 FROM git_history_mappings
              WHERE installation_id = ? AND project_id = ?
                AND artifact_id = ? AND version_id = ? AND status = 'recorded'
            )
        `).bind(
          completedAt,
          installationId,
          job.id,
          installationId,
          mapping.projectId,
          mapping.artifactId,
          mapping.versionId,
        ),
        database.prepare(`
          UPDATE git_history_budget_reservations
          SET state = 'released', updated_at = ?
          WHERE installation_id = ? AND job_id = ? AND state = 'reserved'
            AND NOT EXISTS (
              SELECT 1 FROM git_history_mappings
              WHERE installation_id = ? AND project_id = ?
                AND artifact_id = ? AND version_id = ? AND status = 'recorded'
            )
        `).bind(
          completedAt,
          installationId,
          job.id,
          installationId,
          mapping.projectId,
          mapping.artifactId,
          mapping.versionId,
        ),
        database.prepare(`
          UPDATE git_history_jobs SET state = 'done', lease_expires_at = NULL,
            last_error = NULL, updated_at = ?
          WHERE installation_id = ? AND id = ?
        `).bind(completedAt, installationId, job.id),
        database.prepare(`
          INSERT OR IGNORE INTO git_history_jobs (
            id, installation_id, project_id, artifact_id, version_id,
            kind, state, attempts, available_at, created_at, updated_at
          ) SELECT ?, repository.installation_id, repository.project_id,
            repository.artifact_id, NULL, 'delete-repository', 'queued', 0,
            ?, ?, ?
          FROM git_history_repositories repository
          JOIN artifacts artifact ON artifact.project_id = repository.project_id
            AND artifact.id = repository.artifact_id
          WHERE repository.installation_id = ? AND repository.project_id = ?
            AND repository.artifact_id = ? AND repository.status <> 'deleted'
            AND artifact.deleted_at IS NOT NULL
        `).bind(
          gitHistoryJobId(
            gitHistoryJobKinds.deleteRepository,
            mapping.artifactId,
            null,
          ),
          completedAt,
          completedAt,
          completedAt,
          installationId,
          mapping.projectId,
          mapping.artifactId,
        ),
        database.prepare(`
          UPDATE git_history_repositories SET status = 'deleting', updated_at = ?
          WHERE installation_id = ? AND project_id = ? AND artifact_id = ?
            AND status <> 'deleted' AND EXISTS (
              SELECT 1 FROM artifacts artifact
              WHERE artifact.project_id = ? AND artifact.id = ?
                AND artifact.deleted_at IS NOT NULL
            )
        `).bind(
          completedAt,
          installationId,
          mapping.projectId,
          mapping.artifactId,
          mapping.projectId,
          mapping.artifactId,
        ),
      ]);
      const recorded = await database.prepare(`
        SELECT 1 FROM git_history_mappings
        WHERE installation_id = ? AND project_id = ? AND artifact_id = ?
          AND version_id = ? AND status = 'recorded'
      `).bind(
        installationId,
        mapping.projectId,
        mapping.artifactId,
        mapping.versionId,
      ).first();
      return recorded === null ? "artifact-deleted" : "mirrored";
    },
    releaseGitHistoryJob: async (job, classification, availableAt) => {
      await database.prepare(`
        UPDATE git_history_jobs SET state = 'queued', lease_expires_at = NULL,
          last_error = ?, available_at = ?, updated_at = ?
        WHERE installation_id = ? AND id = ? AND state = 'claimed'
      `).bind(
        classification,
        availableAt,
        availableAt,
        installationId,
        job.id,
      ).run();
    },
    completeGitHistoryDeletion: async (job, completedAt) => {
      await database.batch([
        database.prepare(`
          UPDATE git_history_repositories SET status = 'deleted', updated_at = ?
          WHERE installation_id = ? AND artifact_id = ?
        `).bind(completedAt, installationId, job.artifactId),
        database.prepare(`
          UPDATE git_history_mappings SET status = 'deleted'
          WHERE installation_id = ? AND artifact_id = ?
        `).bind(installationId, job.artifactId),
        database.prepare(`
          UPDATE git_history_budget_reservations
          SET state = 'released', updated_at = ?
          WHERE installation_id = ? AND job_id IN (
            SELECT id FROM git_history_jobs
            WHERE installation_id = ? AND artifact_id = ?
          )
        `).bind(
          completedAt,
          installationId,
          installationId,
          job.artifactId,
        ),
        database.prepare(`
          UPDATE git_history_jobs SET state = 'done', lease_expires_at = NULL,
            last_error = NULL, updated_at = ?
          WHERE installation_id = ? AND id = ?
        `).bind(completedAt, installationId, job.id),
      ]);
    },
    readGitHistoryPurgePlan: async () => {
      const row = await database.prepare(`
        SELECT
          COUNT(*) AS repositories,
          COALESCE(SUM(CASE WHEN status = 'deleted' THEN 1 ELSE 0 END), 0)
            AS alreadyDeletedRepositories,
          COALESCE(SUM(CASE WHEN status <> 'deleted' THEN 1 ELSE 0 END), 0)
            AS repositoriesToDelete,
          COALESCE((SELECT SUM(copied_bytes) FROM git_history_mappings
            WHERE installation_id = ? AND status = 'recorded'), 0)
            AS logicalCopiedBytes,
          (SELECT COUNT(*) FROM git_history_project_settings
            WHERE installation_id = ? AND enabled = 1) AS enabledProjects
        FROM git_history_repositories
        WHERE installation_id = ?
      `).bind(installationId, installationId, installationId).first();
      return gitHistoryPurgePlanRowSchema.parse(row);
    },
    listGitHistoryRepositoriesForPurge: async (
      afterArtifactId: string | null,
      limit: number,
    ) => {
      const result = await database.prepare(`
        SELECT artifact_id AS artifactId, default_branch AS defaultBranch,
          project_id AS projectId, provider, remote_url AS remoteUrl,
          repository_name AS repositoryName, status
        FROM git_history_repositories
        WHERE installation_id = ? AND status <> 'deleted'
          AND (? IS NULL OR artifact_id > ?)
        ORDER BY artifact_id
        LIMIT ?
      `).bind(
        installationId,
        afterArtifactId,
        afterArtifactId,
        limit,
      ).all();
      return gitHistoryRepositoryRowSchema.array().parse(result.results);
    },
    completeGitHistoryPurge: async (coordinates, completedAt) => {
      await database.batch([
        database.prepare(`
          UPDATE git_history_repositories SET status = 'deleted', updated_at = ?
          WHERE installation_id = ? AND artifact_id = ?
        `).bind(completedAt, installationId, coordinates.artifactId),
        database.prepare(`
          UPDATE git_history_mappings SET status = 'deleted'
          WHERE installation_id = ? AND artifact_id = ?
        `).bind(installationId, coordinates.artifactId),
        database.prepare(`
          UPDATE git_history_budget_reservations
          SET state = 'released', updated_at = ?
          WHERE installation_id = ? AND job_id IN (
            SELECT id FROM git_history_jobs
            WHERE installation_id = ? AND artifact_id = ?
          )
        `).bind(
          completedAt,
          installationId,
          installationId,
          coordinates.artifactId,
        ),
        database.prepare(`
          UPDATE git_history_jobs SET state = 'done', lease_expires_at = NULL,
            last_error = NULL, updated_at = ?
          WHERE installation_id = ? AND artifact_id = ?
        `).bind(completedAt, installationId, coordinates.artifactId),
      ]);
    },
    renameProject: async (command: RenameProject) => {
      const result = await database.prepare(`
        UPDATE projects SET name = ? WHERE installation_id = ? AND id = ?
      `).bind(command.name, installationId, command.projectId).run();
      if (result.meta.changes !== 1) throw new ProjectNotFound({message: "The project does not exist."});
      return readProject(command.projectId);
    },
    setProjectArchive: async (command: SetProjectArchive) => {
      const result = await database.prepare(`
        UPDATE projects SET archived_at = ? WHERE installation_id = ? AND id = ?
      `).bind(command.archivedAt, installationId, command.projectId).run();
      if (result.meta.changes !== 1) throw new ProjectNotFound({message: "The project does not exist."});
      return readProject(command.projectId);
    },

    createStagedUpload: async (command: CreateStagedUpload) => {
      await assertProjectActive(command.projectId);
      await database.batch([
        database.prepare(`
          INSERT INTO staged_uploads (
            id, project_id, principal_id, status, manifest_digest, entry_path,
            routing_mode, created_at, expires_at, committed_version_id
          ) VALUES (?, ?, ?, 'open', ?, ?, ?, ?, ?, NULL)
        `).bind(
          command.id,
          command.projectId,
          command.principalId,
          command.manifest.digest,
          command.manifest.entryPath,
          command.manifest.routingMode,
          command.createdAt,
          command.expiresAt,
        ),
        // `uploaded_at` stays out of the column list so it defaults to NULL:
        // every bound column costs part of the per-statement budget.
        ...insertRowsStatements(
          "staged_upload_files",
          stagedUploadFileColumns,
          command.files.map((file) => [
            command.id,
            file.storageToken,
            file.entry.path,
            file.entry.size,
            file.entry.mediaType,
            file.entry.sha256,
            file.entry.disposition,
          ]),
        ),
      ]);
      const upload = await readStagedUploadOrNull(
        command.projectId,
        command.id,
        command.principalId,
      );
      if (upload === null) throw new Error("The staged upload was not persisted.");
      return upload;
    },
    findStagedUpload: readStagedUploadOrNull,
    markStagedFileUploaded: async (
      projectId,
      uploadId,
      principalId,
      storageToken,
      uploadedAt,
    ) => {
      await assertProjectActive(projectId);
      const result = await database.prepare(`
        UPDATE staged_upload_files SET uploaded_at = ?
        WHERE upload_id = ? AND storage_token = ? AND EXISTS (
          SELECT 1 FROM staged_uploads u
          WHERE u.id = staged_upload_files.upload_id AND u.project_id = ?
            AND u.principal_id = ? AND u.status = 'open'
            AND u.expires_at > ?
        )
      `).bind(
        uploadedAt,
        uploadId,
        storageToken,
        projectId,
        principalId,
        uploadedAt,
      ).run();
      if (result.meta.changes !== 1) {
        const upload = await readStagedUploadOrNull(projectId, uploadId, principalId);
        if (upload === null) throw new UploadNotFound({message: "The staged upload does not exist."});
        if (upload.status !== uploadStatuses.open) {
          throw new UploadClosed({message: "The staged upload is already committed."});
        }
        if (upload.expiresAt <= uploadedAt) {
          throw new UploadExpired({message: "The staged upload has expired."});
        }
        throw new UploadFileNotFound({message: "The staged upload file does not exist."});
      }
      const upload = await readStagedUploadOrNull(projectId, uploadId, principalId);
      if (upload === null) throw new Error("The staged upload disappeared.");
      return upload;
    },

    commitNewArtifact: async (command: CommitNewArtifact) => {
      const replay = await findIdempotentPublication(
        command.projectId,
        command.idempotencyKey,
        command.inputDigest,
      );
      if (replay !== null) return replay;
      await assertProjectActive(command.projectId);
      await assertSourceReady(command.source, command.manifest.digest, command.createdAt);
      try {
        await database.batch([
          database.prepare(`
            INSERT INTO artifacts (
              id, project_id, name, search_name, access_setting,
              current_version_id, created_at, deleted_at
            ) VALUES (?, ?, ?, ?, ?, NULL, ?, NULL)
          `).bind(
            command.artifactId,
            command.projectId,
            command.name,
            normalizeArtifactSearchText(command.name),
            command.accessSetting,
            command.createdAt,
          ),
          ...versionStatements(command, 1),
          database.prepare(`
            UPDATE artifacts SET current_version_id = ?
            WHERE project_id = ? AND id = ? AND current_version_id IS NULL
          `).bind(command.versionId, command.projectId, command.artifactId),
          ...command.tags.map((tag) => database.prepare(`
            INSERT INTO artifact_tags (artifact_id, tag) VALUES (?, ?)
          `).bind(command.artifactId, tag)),
          actionStatement(command, command.versionId, artifactActionKinds.publish),
          idempotencyStatement(command, command.versionId, artifactActionKinds.publish),
          database.prepare(`
            UPDATE staged_uploads SET status = 'committed', committed_version_id = ?
            WHERE project_id = ? AND id = ? AND principal_id = ? AND status = 'open'
          `).bind(
            command.versionId,
            command.source.projectId,
            command.source.uploadId,
            command.source.principalId,
          ),
          mirrorJobStatement(
            command.projectId,
            command.artifactId,
            command.versionId,
            command.createdAt,
          ),
          ...publicationGuardStatements(command),
        ]);
      } catch (cause) {
        const raced = await findIdempotentPublication(
          command.projectId,
          command.idempotencyKey,
          command.inputDigest,
        );
        if (raced !== null) return raced;
        if (cause instanceof Error && /constraint|unique/iu.test(cause.message)) {
          throw new PublishConflict({message: "The artifact changed during publication."});
        }
        throw cause;
      }
      return readPublishedVersion(command.projectId, command.versionId, false);
    },
    commitVersion: async (command: CommitArtifactVersion) => {
      const replay = await findIdempotentPublication(
        command.projectId,
        command.idempotencyKey,
        command.inputDigest,
      );
      if (replay !== null) return replay;
      await assertProjectActive(command.projectId);
      await assertSourceReady(command.source, command.manifest.digest, command.createdAt);
      const artifact = await readArtifact(command.projectId, command.artifactId);
      if (artifact.currentVersionId !== command.expectedCurrentVersionId) {
        throw new PublishConflict({message: `The artifact moved to version ${artifact.currentVersionId}.`});
      }
      const nextNumber = await database.prepare(`
        SELECT COALESCE(MAX(number), 0) + 1 AS nextNumber
        FROM versions WHERE project_id = ? AND artifact_id = ?
      `).bind(command.projectId, command.artifactId).first<number>("nextNumber");
      if (nextNumber === null) throw new Error("D1 did not calculate the next version number.");
      try {
        await database.batch([
          database.prepare(`
            UPDATE artifacts SET current_version_id = ?
            WHERE project_id = ? AND id = ? AND current_version_id = ? AND deleted_at IS NULL
          `).bind(
            command.versionId,
            command.projectId,
            command.artifactId,
            command.expectedCurrentVersionId,
          ),
          ...versionStatements(command, nextNumber),
          actionStatement(command, command.versionId, artifactActionKinds.publish),
          idempotencyStatement(command, command.versionId, artifactActionKinds.publish),
          database.prepare(`
            UPDATE staged_uploads SET status = 'committed', committed_version_id = ?
            WHERE project_id = ? AND id = ? AND principal_id = ? AND status = 'open'
          `).bind(
            command.versionId,
            command.source.projectId,
            command.source.uploadId,
            command.source.principalId,
          ),
          mirrorJobStatement(
            command.projectId,
            command.artifactId,
            command.versionId,
            command.createdAt,
          ),
          ...publicationGuardStatements(command),
        ]);
      } catch (cause) {
        const raced = await findIdempotentPublication(
          command.projectId,
          command.idempotencyKey,
          command.inputDigest,
        );
        if (raced !== null) return raced;
        if (cause instanceof Error && /constraint|unique/iu.test(cause.message)) {
          throw new PublishConflict({message: "The artifact changed during publication."});
        }
        throw cause;
      }
      return readPublishedVersion(command.projectId, command.versionId, false);
    },
    findIdempotentPublication,
    findArtifact: (projectId, artifactId) => readArtifactOrNull(projectId, artifactId),
    findArtifactForAdministration: (projectId, artifactId) =>
      readArtifactOrNull(projectId, artifactId, true),
    findCurrentVersion: async (projectId, artifactId) => {
      const row = await database.prepare(`
        SELECT project_id AS projectId, current_version_id AS currentVersionId
        FROM artifacts WHERE (? IS NULL OR project_id = ?) AND id = ? AND deleted_at IS NULL
      `).bind(projectId, projectId, artifactId).first<{
        readonly currentVersionId: string;
        readonly projectId: string;
      }>();
      return row === null
        ? null
        : readPublishedVersion(row.projectId, row.currentVersionId, false);
    },
    findVersionRecord: async (projectId, artifactId, versionId) => {
      const [versionResult, entriesResult] = await database.batch([
        database.prepare(`${versionSelect}
          WHERE project_id = ? AND id = ? AND artifact_id = ?
        `).bind(projectId, versionId, artifactId),
        database.prepare(`
          SELECT path, size, media_type AS mediaType, sha256, disposition
          FROM manifest_entries WHERE version_id = ? ORDER BY path
        `).bind(versionId),
      ]);
      const versionRow = versionResult?.results[0] ?? null;
      if (versionRow === null) return null;
      const version = versionRowSchema.parse(versionRow);
      const stored = (entriesResult?.results ?? [])
        .map((row) => entryRowSchema.parse(row));
      return {manifest: buildManifest(version, stored), version};
    },
    listArtifactVersions: async (projectId, artifactId) => {
      if (await readArtifactOrNull(projectId, artifactId) === null) return [];
      const result = await database.prepare(`${versionSelect}
        WHERE project_id = ? AND artifact_id = ? ORDER BY number DESC
      `).bind(projectId, artifactId).all<z.input<typeof versionRowSchema>>();
      return result.results.map((row) => versionRowSchema.parse(row));
    },
    listExpiredStagedUploads: async (
      expiredBefore: string,
      limit: number,
    ): Promise<readonly ExpiredStagedUpload[]> => {
      const result = await database.prepare(`
        WITH selected AS (
          SELECT id FROM staged_uploads
          WHERE status = 'open' AND expires_at <= ?
          ORDER BY expires_at, id
          LIMIT ?
        )
        SELECT selected.id, file.storage_token AS storageToken
        FROM selected
        JOIN staged_upload_files file ON file.upload_id = selected.id
        ORDER BY selected.id, file.storage_token
      `).bind(expiredBefore, limit)
        .all<z.input<typeof expiredStagedUploadRowSchema>>();
      const grouped = new Map<string, Array<{readonly storageToken: string}>>();
      for (const candidate of result.results) {
        const row = expiredStagedUploadRowSchema.parse(candidate);
        const files = grouped.get(row.id) ?? [];
        files.push({storageToken: row.storageToken});
        grouped.set(row.id, files);
      }
      return [...grouped].map(([id, files]) => ({files, id}));
    },
    removeExpiredStagedUpload: async (
      uploadId: string,
      expiredBefore: string,
    ): Promise<boolean> => {
      const results = await database.batch([
        database.prepare(`
          DELETE FROM staged_upload_files
          WHERE upload_id = ? AND EXISTS (
            SELECT 1 FROM staged_uploads upload
            WHERE upload.id = staged_upload_files.upload_id
              AND upload.status = 'open' AND upload.expires_at <= ?
          )
        `).bind(uploadId, expiredBefore),
        database.prepare(`
          DELETE FROM staged_uploads
          WHERE id = ? AND status = 'open' AND expires_at <= ?
        `).bind(uploadId, expiredBefore),
      ]);
      return results[1]?.meta.changes === 1;
    },
    listArtifacts: async (command: ListArtifacts): Promise<ArtifactPage> => {
      const result = await database.prepare(`
        SELECT id, project_id AS projectId, name,
          access_setting AS accessSetting,
          current_version_id AS currentVersionId,
          created_at AS createdAt, deleted_at AS deletedAt,
          (
            SELECT COUNT(*) FROM comment_threads
            WHERE comment_threads.project_id = artifacts.project_id
              AND comment_threads.artifact_id = artifacts.id
          ) AS commentCount,
          (
            SELECT COUNT(*) FROM versions
            WHERE versions.project_id = artifacts.project_id
              AND versions.artifact_id = artifacts.id
          ) AS versionCount
        FROM artifacts
        WHERE project_id = ? AND deleted_at IS NULL
          AND (? IS NULL
            OR instr(search_name, ?) > 0
            OR EXISTS (
              SELECT 1 FROM artifact_tags searched_tags
              WHERE searched_tags.artifact_id = artifacts.id
                AND searched_tags.tag = ?
            ))
          AND (? IS NULL OR EXISTS (
            SELECT 1 FROM artifact_tags
            WHERE artifact_tags.artifact_id = artifacts.id AND artifact_tags.tag = ?
          ))
          AND (? IS NULL OR created_at < ? OR (created_at = ? AND id < ?))
        ORDER BY created_at DESC, id DESC LIMIT ?
      `).bind(
        command.projectId,
        command.search ?? null,
        command.search ?? null,
        command.search ?? null,
        command.tag,
        command.tag,
        command.cursor?.createdAt ?? null,
        command.cursor?.createdAt ?? null,
        command.cursor?.createdAt ?? null,
        command.cursor?.id ?? null,
        command.limit + 1,
      ).all<z.input<typeof artifactListRowSchema>>();
      const parsed = result.results.map((row) => artifactListRowSchema.parse(row));
      const items = await Promise.all(
        parsed.slice(0, command.limit).map(async (artifact) =>
          Object.assign({}, artifact, {tags: await readTags(artifact.id)})),
      );
      return pageResult(items, parsed, command.limit);
    },
    listPublicLinks: async (
      command: ListPublicLinks,
    ): Promise<PublicLinkInventoryPage> => {
      const result = await database.prepare(`
        SELECT
          artifact.id AS artifactId,
          artifact.project_id AS projectId,
          artifact.name AS artifactName,
          artifact.access_setting AS accessSetting,
          artifact.current_version_id AS currentVersionId,
          artifact.created_at AS artifactCreatedAt,
          artifact.deleted_at AS artifactDeletedAt,
          project.installation_id AS installationId,
          project.name AS projectName,
          project.created_at AS projectCreatedAt,
          project.archived_at AS projectArchivedAt,
          version.id AS versionId,
          version.number AS versionNumber,
          version.manifest_digest AS manifestDigest,
          version.entry_path AS entryPath,
          version.routing_mode AS routingMode,
          version.content_token AS contentToken,
          version.publisher_principal_id AS publisherPrincipalId,
          version.created_at AS versionCreatedAt
        FROM artifacts artifact
        INNER JOIN projects project ON project.id = artifact.project_id
        INNER JOIN versions version
          ON version.project_id = artifact.project_id
          AND version.artifact_id = artifact.id
          AND version.id = artifact.current_version_id
        WHERE artifact.deleted_at IS NULL
          AND artifact.access_setting = 'public_link'
          AND (? IS NULL OR artifact.created_at < ?
            OR (artifact.created_at = ? AND artifact.id < ?))
        ORDER BY artifact.created_at DESC, artifact.id DESC
        LIMIT ?
      `).bind(
        command.cursor?.createdAt ?? null,
        command.cursor?.createdAt ?? null,
        command.cursor?.createdAt ?? null,
        command.cursor?.id ?? null,
        command.limit + 1,
      ).all<z.output<typeof publicLinkInventoryRowSchema>>();
      const parsedRows = result.results.map((row) =>
        publicLinkInventoryRowSchema.parse(row)
      );
      const artifacts = await Promise.all(parsedRows.map(async (row) => ({
        accessSetting: row.accessSetting,
        createdAt: row.artifactCreatedAt,
        currentVersionId: row.currentVersionId,
        deletedAt: row.artifactDeletedAt,
        id: row.artifactId,
        name: row.artifactName,
        projectId: row.projectId,
        tags: await readTags(row.artifactId),
      })));
      return publicLinkPageFromRows(parsedRows, artifacts, command.limit);
    },
    listArtifactActions: async (command: ListArtifactActions): Promise<ArtifactActionPage> => {
      const result = await database.prepare(`
        SELECT id, project_id AS projectId, artifact_id AS artifactId,
          version_id AS versionId, action, principal_id AS principalId,
          authorized_by_principal_id AS authorizedByPrincipalId,
          idempotency_key AS idempotencyKey, created_at AS createdAt
        FROM actions WHERE project_id = ? AND artifact_id = ?
          AND (? IS NULL OR created_at < ? OR (created_at = ? AND id < ?))
        ORDER BY created_at DESC, id DESC LIMIT ?
      `).bind(
        command.projectId,
        command.artifactId,
        command.cursor?.createdAt ?? null,
        command.cursor?.createdAt ?? null,
        command.cursor?.createdAt ?? null,
        command.cursor?.id ?? null,
        command.limit + 1,
      ).all<z.input<typeof actionRowSchema>>();
      const parsed = result.results.map((row) => actionRowSchema.parse(row));
      return pageResult(parsed.slice(0, command.limit), parsed, command.limit);
    },
    findVersionContent: async (contentToken, requestedPath, fallback) => {
      const row = await database.prepare(`
        SELECT a.access_setting AS accessSetting, a.id AS artifactId,
          a.project_id AS projectId, v.content_token AS contentToken,
          v.id AS versionId, e.path, e.size, e.media_type AS mediaType,
          e.sha256, e.disposition,
          CASE WHEN v.id = a.current_version_id THEN 1 ELSE 0 END AS isCurrent
        FROM versions v JOIN artifacts a ON a.id = v.artifact_id
        JOIN manifest_entries e ON e.version_id = v.id
        WHERE v.content_token = ?
          AND e.path = CASE
            WHEN ? = '' THEN v.entry_path
            WHEN EXISTS (
              SELECT 1 FROM manifest_entries exact
              WHERE exact.version_id = v.id AND exact.path = ?
            ) THEN ?
            WHEN ? = 'entry' AND v.routing_mode = 'spa' THEN v.entry_path
            ELSE ?
          END
          AND a.deleted_at IS NULL
      `).bind(
        contentToken,
        requestedPath,
        requestedPath,
        requestedPath,
        fallback,
        requestedPath,
      )
        .first<z.input<typeof versionContentRowSchema>>();
      if (row === null) return null;
      const parsed = versionContentRowSchema.parse(row);
      const entry: ManifestEntry = {
        disposition: parsed.disposition,
        mediaType: parsed.mediaType,
        path: parsed.path,
        sha256: parsed.sha256,
        size: parsed.size,
      };
      const content: VersionContent = {
        accessSetting: parsed.accessSetting,
        artifactId: parsed.artifactId,
        contentToken: parsed.contentToken,
        entry,
        isCurrent: parsed.isCurrent,
        projectId: parsed.projectId,
        versionId: parsed.versionId,
      };
      return content;
    },

    changeAccessSetting: async (command: ChangeArtifactAccessSetting) => {
      const replay = await managementReplay(command, artifactActionKinds.changeAccess);
      if (replay !== null) return replay;
      const artifact = await readArtifact(command.projectId, command.artifactId);
      assertCurrent(artifact, command.expectedCurrentVersionId);
      return applyManagementMutation(command, artifactActionKinds.changeAccess, [
        database.prepare(`
          UPDATE artifacts SET access_setting = ?
          WHERE project_id = ? AND id = ? AND current_version_id = ? AND deleted_at IS NULL
        `).bind(
          command.accessSetting,
          command.projectId,
          command.artifactId,
          command.expectedCurrentVersionId,
        ),
        actionStatement(command, command.expectedCurrentVersionId, artifactActionKinds.changeAccess),
        idempotencyStatement(
          command,
          command.expectedCurrentVersionId,
          artifactActionKinds.changeAccess,
          command.accessSetting,
        ),
        ...managementGuardStatements(
          command,
          artifactActionKinds.changeAccess,
          command.expectedCurrentVersionId,
          "a.deleted_at IS NULL AND a.access_setting = ?",
          [command.accessSetting],
        ),
      ], () => artifactState(
          command.projectId,
          command.artifactId,
          command.expectedCurrentVersionId,
          false,
          command.accessSetting,
        ));
    },
    changeTags: async (command: ChangeArtifactTags) => {
      const replay = await managementReplay(command, artifactActionKinds.changeTags);
      if (replay !== null) return replay;
      const artifact = await readArtifact(command.projectId, command.artifactId);
      assertCurrent(artifact, command.expectedCurrentVersionId);
      return applyManagementMutation(command, artifactActionKinds.changeTags, [
        database.prepare(`
          UPDATE artifacts SET current_version_id = current_version_id
          WHERE project_id = ? AND id = ? AND current_version_id = ? AND deleted_at IS NULL
        `).bind(
          command.projectId,
          command.artifactId,
          command.expectedCurrentVersionId,
        ),
        database.prepare("DELETE FROM artifact_tags WHERE artifact_id = ?").bind(command.artifactId),
        ...command.tags.map((tag) => database.prepare(`
          INSERT INTO artifact_tags (artifact_id, tag) VALUES (?, ?)
        `).bind(command.artifactId, tag)),
        actionStatement(command, command.expectedCurrentVersionId, artifactActionKinds.changeTags),
        idempotencyStatement(
          command,
          command.expectedCurrentVersionId,
          artifactActionKinds.changeTags,
          artifact.accessSetting,
          JSON.stringify(command.tags),
        ),
        ...managementGuardStatements(
          command,
          artifactActionKinds.changeTags,
          command.expectedCurrentVersionId,
          "a.deleted_at IS NULL",
        ),
      ], () => artifactState(
          command.projectId,
          command.artifactId,
          command.expectedCurrentVersionId,
          false,
          artifact.accessSetting,
          command.tags,
        ));
    },
    restoreVersion: async (command: RestoreArtifactVersion) => {
      const replay = await managementReplay(command, artifactActionKinds.restore);
      if (replay !== null) return replay;
      const artifact = await readArtifact(command.projectId, command.artifactId);
      assertCurrent(artifact, command.expectedCurrentVersionId);
      if (await readVersionOrNull(command.projectId, command.versionId, command.artifactId) === null) {
        throw new VersionNotFound({message: "The saved version does not exist on this artifact."});
      }
      return applyManagementMutation(command, artifactActionKinds.restore, [
        database.prepare(`
          UPDATE artifacts SET current_version_id = ?
          WHERE project_id = ? AND id = ? AND current_version_id = ? AND deleted_at IS NULL
        `).bind(
          command.versionId,
          command.projectId,
          command.artifactId,
          command.expectedCurrentVersionId,
        ),
        actionStatement(command, command.versionId, artifactActionKinds.restore),
        idempotencyStatement(
          command,
          command.versionId,
          artifactActionKinds.restore,
          artifact.accessSetting,
        ),
        ...managementGuardStatements(
          command,
          artifactActionKinds.restore,
          command.versionId,
          "a.deleted_at IS NULL",
        ),
      ], () => artifactState(
          command.projectId,
          command.artifactId,
          command.versionId,
          false,
          artifact.accessSetting,
        ));
    },
    deleteArtifact: async (command: DeleteArtifact) => {
      const existingRecord = await readIdempotency(command.projectId, command.idempotencyKey);
      if (existingRecord !== null) {
        if (
          existingRecord.operation !== artifactActionKinds.delete ||
          existingRecord.inputDigest !== command.inputDigest
        ) {
          throw new IdempotencyConflict({message: "The idempotency key was already used with different input."});
        }
        return readDeletion(command.projectId, existingRecord.artifactId, true);
      }
      const artifact = await readArtifact(command.projectId, command.artifactId);
      assertCurrent(artifact, command.expectedCurrentVersionId);
      try {
        const results = await database.batch([
          database.prepare(`
            UPDATE artifacts SET deleted_at = ?
            WHERE project_id = ? AND id = ? AND current_version_id = ? AND deleted_at IS NULL
          `).bind(
            command.createdAt,
            command.projectId,
            command.artifactId,
            command.expectedCurrentVersionId,
          ),
          actionStatement(command, command.expectedCurrentVersionId, artifactActionKinds.delete),
          idempotencyStatement(
            command,
            command.expectedCurrentVersionId,
            artifactActionKinds.delete,
            artifact.accessSetting,
          ),
          database.prepare(`
            UPDATE git_history_jobs SET state = 'done', lease_expires_at = NULL,
              last_error = 'artifact_deleted', updated_at = ?
            WHERE installation_id = ? AND project_id = ? AND artifact_id = ?
              AND kind = 'mirror-version' AND state <> 'done'
          `).bind(
            command.createdAt,
            installationId,
            command.projectId,
            command.artifactId,
          ),
          database.prepare(`
            INSERT OR IGNORE INTO git_history_jobs (
              id, installation_id, project_id, artifact_id, version_id,
              kind, state, attempts, available_at, created_at, updated_at
            )
            SELECT ?, installation_id, project_id, artifact_id, NULL,
              'delete-repository', 'queued', 0, ?, ?, ?
            FROM git_history_repositories
            WHERE installation_id = ? AND project_id = ? AND artifact_id = ?
              AND status <> 'deleted'
          `).bind(
            gitHistoryJobId(
              gitHistoryJobKinds.deleteRepository,
              command.artifactId,
              null,
            ),
            command.createdAt,
            command.createdAt,
            command.createdAt,
            installationId,
            command.projectId,
            command.artifactId,
          ),
          database.prepare(`
            UPDATE git_history_repositories SET status = 'deleting', updated_at = ?
            WHERE installation_id = ? AND project_id = ? AND artifact_id = ?
              AND status <> 'deleted'
          `).bind(
            command.createdAt,
            installationId,
            command.projectId,
            command.artifactId,
          ),
          ...managementGuardStatements(
            command,
            artifactActionKinds.delete,
            command.expectedCurrentVersionId,
            "a.deleted_at = ?",
            [command.createdAt],
          ),
        ]);
        if (results[0]?.meta.changes !== 1) throw changedDuringManagement();
        return await readDeletion(command.projectId, command.artifactId, false);
      } catch (cause) {
        const racedRecord = await readIdempotency(
          command.projectId,
          command.idempotencyKey,
        );
        if (racedRecord !== null) {
          if (
            racedRecord.operation !== artifactActionKinds.delete ||
            racedRecord.inputDigest !== command.inputDigest
          ) {
            throw new IdempotencyConflict({
              message: "The idempotency key was already used with different input.",
            });
          }
          return readDeletion(command.projectId, racedRecord.artifactId, true);
        }
        if (cause instanceof Error && /constraint|unique/iu.test(cause.message)) {
          throw changedDuringManagement();
        }
        throw cause;
      }
    },

    createContentBootstrap: async (command: CreateContentBootstrap) => {
      await database.prepare(`
        INSERT INTO content_bootstraps (
          token_digest, principal_id, project_id, artifact_id, version_id,
          content_token, created_at, expires_at, consumed_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)
      `).bind(
        command.tokenDigest,
        command.principalId,
        command.projectId,
        command.artifactId,
        command.versionId,
        command.contentToken,
        command.createdAt,
        command.expiresAt,
      ).run();
      return command;
    },
    exchangeContentBootstrap: async (command: ExchangeContentBootstrap) => {
      const row = await database.prepare(`
        SELECT b.token_digest AS tokenDigest, b.principal_id AS principalId,
          b.project_id AS projectId, b.artifact_id AS artifactId,
          b.version_id AS versionId, b.content_token AS contentToken,
          b.created_at AS createdAt, b.expires_at AS expiresAt
        FROM content_bootstraps b JOIN artifacts a ON a.id = b.artifact_id
        WHERE b.token_digest = ? AND b.content_token = ?
          AND b.consumed_at IS NULL AND b.expires_at > ? AND a.deleted_at IS NULL
      `).bind(
        command.bootstrapTokenDigest,
        command.contentToken,
        command.exchangedAt,
      ).first<z.input<typeof contentRecordSchema>>();
      if (row === null) return null;
      const bootstrap = contentRecordSchema.parse(row);
      const session: ContentSessionRecord = {
        artifactId: bootstrap.artifactId,
        contentToken: bootstrap.contentToken,
        createdAt: command.session.createdAt,
        expiresAt: command.session.expiresAt,
        principalId: bootstrap.principalId,
        projectId: bootstrap.projectId,
        tokenDigest: command.session.tokenDigest,
        versionId: bootstrap.versionId,
      };
      try {
        await database.batch([
          database.prepare(`
            UPDATE content_bootstraps
            SET consumed_at = ?, consumed_session_digest = ?
            WHERE token_digest = ? AND consumed_at IS NULL
          `).bind(
            command.exchangedAt,
            session.tokenDigest,
            command.bootstrapTokenDigest,
          ),
          database.prepare(`
            INSERT INTO content_sessions (
              token_digest, principal_id, project_id, artifact_id, version_id,
              content_token, created_at, expires_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
          `).bind(
            session.tokenDigest,
            session.principalId,
            session.projectId,
            session.artifactId,
            session.versionId,
            session.contentToken,
            session.createdAt,
            session.expiresAt,
          ),
          ...mutationGuardStatements(
            `content-bootstrap:${command.bootstrapTokenDigest}`,
            `SELECT 1 FROM content_bootstraps b JOIN content_sessions s
              ON s.token_digest = ?
              WHERE b.token_digest = ? AND b.consumed_at = ?
                AND b.consumed_session_digest = ?`,
            [
              session.tokenDigest,
              command.bootstrapTokenDigest,
              command.exchangedAt,
              session.tokenDigest,
            ],
          ),
        ]);
        return session;
      } catch (cause) {
        if (cause instanceof Error && /constraint|unique/iu.test(cause.message)) {
          return null;
        }
        throw cause;
      }
    },
    findContentSession: async (tokenDigest, contentToken, requestTime) => {
      const row = await database.prepare(`
        SELECT s.token_digest AS tokenDigest, s.principal_id AS principalId,
          s.project_id AS projectId, s.artifact_id AS artifactId,
          s.version_id AS versionId, s.content_token AS contentToken,
          s.created_at AS createdAt, s.expires_at AS expiresAt
        FROM content_sessions s JOIN artifacts a ON a.id = s.artifact_id
        WHERE s.token_digest = ? AND s.content_token = ?
          AND s.expires_at > ? AND a.deleted_at IS NULL
      `).bind(tokenDigest, contentToken, requestTime)
        .first<z.input<typeof contentRecordSchema>>();
      return row === null ? null : contentRecordSchema.parse(row);
    },
    createPreviewLease: async (command: CreatePreviewLease) => {
      await database.prepare(`
        INSERT INTO content_sessions (
          token_digest, principal_id, project_id, artifact_id, version_id,
          content_token, created_at, expires_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).bind(
        command.tokenDigest,
        command.principalId,
        command.projectId,
        command.artifactId,
        command.versionId,
        command.contentToken,
        command.createdAt,
        command.expiresAt,
      ).run();
      return command;
    },
    findPreviewLease: async (tokenDigest, requestTime) => {
      const row = await database.prepare(`
        SELECT s.token_digest AS tokenDigest, s.principal_id AS principalId,
          s.project_id AS projectId, s.artifact_id AS artifactId,
          s.version_id AS versionId, s.content_token AS contentToken,
          s.created_at AS createdAt, s.expires_at AS expiresAt
        FROM content_sessions s JOIN artifacts a ON a.id = s.artifact_id
        WHERE s.token_digest = ? AND s.expires_at > ? AND a.deleted_at IS NULL
      `).bind(tokenDigest, requestTime)
        .first<z.input<typeof contentRecordSchema>>();
      return row === null ? null : contentRecordSchema.parse(row);
    },
    createThread: async (
      command: CreateCommentThread,
    ): Promise<CommentThreadCreation> => {
      const anchorJson = serializeCommentAnchor(command);
      const replayed = await readIdempotentThreadRowOrNull(
        command.projectId,
        command.idempotencyKey,
      );
      if (replayed !== null) return replayedThread(replayed, command, anchorJson);
      try {
        await database.batch([
          database.prepare(`
            INSERT INTO comment_threads (
              id, installation_id, project_id, artifact_id, version_id, path,
              anchor_json, body, state, author_principal_id,
              author_principal_kind, author_display_name,
              author_authorized_by_principal_id, resolved_at,
              resolved_by_principal_id, resolved_by_principal_kind,
              resolved_by_display_name, resolved_by_authorized_by_principal_id,
              idempotency_key, created_at, updated_at
            ) VALUES (
              ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?, ?, ?,
              NULL, NULL, NULL, NULL, NULL, ?, ?, ?
            )
          `).bind(
            command.id,
            command.installationId,
            command.projectId,
            command.artifactId,
            command.versionId,
            command.path,
            anchorJson,
            command.body,
            command.author.principalId,
            command.author.principalKind,
            command.author.displayName,
            command.author.authorizedByPrincipalId,
            command.idempotencyKey,
            command.createdAt,
            command.createdAt,
          ),
          actionStatement(
            {
              artifactId: command.artifactId,
              authorizedByPrincipalId: command.author.authorizedByPrincipalId,
              createdAt: command.createdAt,
              idempotencyKey: commentActionIdentity(command.id).idempotencyKey,
              principalId: command.author.principalId,
              projectId: command.projectId,
            },
            command.versionId,
            artifactActionKinds.commentCreate,
          ),
        ]);
      } catch (cause) {
        const raced = await readIdempotentThreadRowOrNull(
          command.projectId,
          command.idempotencyKey,
        );
        if (raced !== null) return replayedThread(raced, command, anchorJson);
        throw cause;
      }
      return {
        replayed: false,
        thread: commentThreadFromRow(
          await readThreadRow(command.projectId, command.artifactId, command.id),
        ),
      };
    },
    findThread: async (projectId, artifactId, threadId) => {
      const row = await readThreadRowOrNull(projectId, artifactId, threadId);
      return row === null ? null : commentThreadFromRow(row);
    },
    findIdempotentThread: async (projectId, idempotencyKey) => {
      const row = await readIdempotentThreadRowOrNull(projectId, idempotencyKey);
      return row === null ? null : commentThreadFromRow(row);
    },
    listThreads: async (
      command: ListCommentThreads,
    ): Promise<CommentThreadPage> => {
      // Excluding actively dispatched threads by default is what makes a send
      // consumptive on every existing surface without a client change.
      const dispatchedPredicate =
        command.dispatched === dispatchedThreadFilters.include
          ? "1 = 1"
          : command.dispatched === dispatchedThreadFilters.only
          ? "t.dispatch_id IS NOT NULL"
          : "t.dispatch_id IS NULL";
      const result = await database.prepare(`${commentThreadSelect}
        WHERE t.project_id = ? AND t.artifact_id = ?
          AND ${dispatchedPredicate}
          AND (? IS NULL OR t.version_id = ?)
          AND (? IS NULL OR t.state = ?)
          AND (? IS NULL OR t.updated_at >= ?)
          AND (? IS NULL OR t.created_at < ? OR (t.created_at = ? AND t.id < ?))
        ORDER BY t.created_at DESC, t.id DESC LIMIT ?
      `).bind(
        command.projectId,
        command.artifactId,
        command.versionId,
        command.versionId,
        command.state,
        command.state,
        command.since,
        command.since,
        command.cursor?.createdAt ?? null,
        command.cursor?.createdAt ?? null,
        command.cursor?.createdAt ?? null,
        command.cursor?.id ?? null,
        command.limit + 1,
      ).all<z.input<typeof commentThreadRowSchema>>();
      const parsed = result.results.map((row) => commentThreadRowSchema.parse(row));
      return pageResult(
        parsed.slice(0, command.limit).map(commentThreadFromRow),
        parsed,
        command.limit,
      );
    },
    updateThread: async (
      command: UpdateCommentThread,
    ): Promise<CommentThreadRecord> => {
      const resolution = command.state?.resolvedBy ?? null;
      const stateChanged = command.state === null ? 0 : 1;
      const commentAction = commentActionIdentity(command.threadId);
      try {
        await database.batch([
          database.prepare(`
            UPDATE comment_threads SET
              body = COALESCE(?, body),
              anchor_json = CASE WHEN ? = 1 THEN ? ELSE anchor_json END,
              state = COALESCE(?, state),
              resolved_at = CASE WHEN ? = 1 THEN ? ELSE resolved_at END,
              resolved_by_principal_id =
                CASE WHEN ? = 1 THEN ? ELSE resolved_by_principal_id END,
              resolved_by_principal_kind =
                CASE WHEN ? = 1 THEN ? ELSE resolved_by_principal_kind END,
              resolved_by_display_name =
                CASE WHEN ? = 1 THEN ? ELSE resolved_by_display_name END,
              resolved_by_authorized_by_principal_id =
                CASE WHEN ? = 1 THEN ?
                ELSE resolved_by_authorized_by_principal_id END,
              updated_at = ?
            WHERE id = ? AND project_id = ? AND artifact_id = ?
          `).bind(
            command.body,
            command.anchor === null ? 0 : 1,
            command.anchor === null ? null : serializeCommentAnchor(command.anchor),
            command.state?.state ?? null,
            stateChanged,
            command.state?.resolvedAt ?? null,
            stateChanged,
            resolution?.principalId ?? null,
            stateChanged,
            resolution?.principalKind ?? null,
            stateChanged,
            resolution?.displayName ?? null,
            stateChanged,
            resolution?.authorizedByPrincipalId ?? null,
            command.updatedAt,
            command.threadId,
            command.projectId,
            command.artifactId,
          ),
          // Reopening a thread returns it to the artifact surfaces. A marker
          // whose bundle already reached the agent has nothing left to hold:
          // keeping it would strand the reopened thread off every default
          // listing and refuse every later send, with no route that clears it.
          database.prepare(`
            UPDATE comment_threads SET dispatch_id = NULL
            WHERE ? = 1 AND id = ? AND state = ? AND dispatch_id IN (
              SELECT id FROM agent_dispatches
              WHERE state IN ('delivered', 'addressed', 'failed', 'canceled')
            )
          `).bind(
            command.state?.state === commentThreadStates.open ? 1 : 0,
            command.threadId,
            commentThreadStates.open,
          ),
          commentActionStatement(
            {
              action: commentUpdateActionKind(command),
              actionId: commentAction.actionId,
              authorizedByPrincipalId: command.authorizedByPrincipalId,
              changedAt: command.updatedAt,
              idempotencyKey: commentAction.idempotencyKey,
              principalId: command.principalId,
            },
            `${commentThreadScope} AND t.updated_at = ?`,
            [
              command.threadId,
              command.projectId,
              command.artifactId,
              command.updatedAt,
            ],
          ),
          ...mutationGuardStatements(
            `comment-update:${command.projectId}:${command.threadId}`,
            `SELECT 1 FROM comment_threads
              WHERE id = ? AND project_id = ? AND artifact_id = ? AND updated_at = ?`,
            [
              command.threadId,
              command.projectId,
              command.artifactId,
              command.updatedAt,
            ],
          ),
        ]);
      } catch (cause) {
        const existing = await readThreadRowOrNull(
          command.projectId,
          command.artifactId,
          command.threadId,
        );
        if (existing === null) throw missingComment();
        throw cause;
      }
      return commentThreadFromRow(await readThreadRow(
        command.projectId,
        command.artifactId,
        command.threadId,
      ));
    },
    deleteThread: async (
      command: DeleteCommentThread,
    ): Promise<CommentThreadDeletion> => {
      const row = await readThreadRowOrNull(
        command.projectId,
        command.artifactId,
        command.threadId,
      );
      if (row === null) throw missingComment();
      const commentAction = commentActionIdentity(command.threadId);
      try {
        const results = await database.batch([
          ...mutationGuardStatements(
            `comment-delete-dispatch:${command.projectId}:${command.threadId}`,
            `SELECT 1 FROM comment_threads t
             LEFT JOIN agent_dispatches d ON d.id = t.dispatch_id
             WHERE t.id = ? AND t.project_id = ? AND t.artifact_id = ?
               AND (d.state IS NULL OR d.state NOT IN ('queued', 'claimed', 'delivered'))`,
            [command.threadId, command.projectId, command.artifactId],
          ),
          commentActionStatement(
            {
              action: artifactActionKinds.commentDelete,
              actionId: commentAction.actionId,
              authorizedByPrincipalId: command.authorizedByPrincipalId,
              changedAt: command.deletedAt,
              idempotencyKey: commentAction.idempotencyKey,
              principalId: command.principalId,
            },
            commentThreadScope,
            [command.threadId, command.projectId, command.artifactId],
          ),
          database.prepare("DELETE FROM comment_replies WHERE thread_id = ?")
            .bind(command.threadId),
          database.prepare(`
            DELETE FROM comment_threads
            WHERE id = ? AND project_id = ? AND artifact_id = ?
          `).bind(command.threadId, command.projectId, command.artifactId),
          ...mutationGuardStatements(
            `comment-delete:${command.projectId}:${command.threadId}`,
            `SELECT 1 FROM actions
              WHERE project_id = ? AND artifact_id = ? AND idempotency_key = ?
                AND action = ?`,
            [
              command.projectId,
              command.artifactId,
              commentAction.idempotencyKey,
              artifactActionKinds.commentDelete,
            ],
          ),
        ]);
        return {
          deletedReplyCount: results[3]?.meta.changes ?? 0,
          thread: commentThreadFromRow(row),
        };
      } catch (cause) {
        const existing = await readThreadRowOrNull(
          command.projectId,
          command.artifactId,
          command.threadId,
        );
        if (existing === null) throw missingComment();
        const dispatchState = await readThreadDispatchState(
          command.projectId,
          command.artifactId,
          command.threadId,
        );
        if (dispatchHoldsCommentThread(dispatchState)) {
          throw dispatchedCommentDeletionConflict();
        }
        throw cause;
      }
    },
    clearThreads: async (
      command: ClearCommentThreads,
    ): Promise<CommentThreadClearing> => {
      const listed = await database.prepare(`
        SELECT t.id, t.version_id AS versionId, d.state AS dispatchState
        FROM comment_threads t
        LEFT JOIN agent_dispatches d ON d.id = t.dispatch_id
        WHERE t.project_id = ? AND t.artifact_id = ?
          AND (? IS NULL OR t.version_id = ?)
          AND (? = 'all' OR t.state = 'resolved')
        ORDER BY t.created_at ASC, t.id ASC
      `).bind(
        command.projectId,
        command.artifactId,
        command.versionId,
        command.versionId,
        command.scope,
      ).all<object>();
      const rows = z.array(clearableThreadRowSchema).parse(listed.results);
      let skippedDispatched = 0;
      const deletable: z.infer<typeof clearableThreadRowSchema>[] = [];
      for (const row of rows) {
        // Clearing never yanks work out from under an agent: a thread held by
        // a queued, claimed, or delivered dispatch stays, and the caller
        // learns how many did.
        if (dispatchHoldsCommentThread(row.dispatchState)) {
          skippedDispatched += 1;
          continue;
        }
        deletable.push(row);
      }
      if (deletable.length > 0) {
        // One atomic batch: per thread the ledger action lands first — its
        // source select still sees the row — then the replies and the thread
        // go, so no thread ever disappears without its comment_delete action.
        await database.batch(deletable.flatMap((row) => {
          const commentAction = commentActionIdentity(row.id);
          return [
            commentActionStatement(
              {
                action: artifactActionKinds.commentDelete,
                actionId: commentAction.actionId,
                authorizedByPrincipalId: command.authorizedByPrincipalId,
                changedAt: command.clearedAt,
                idempotencyKey: commentAction.idempotencyKey,
                principalId: command.principalId,
              },
              commentThreadScope,
              [row.id, command.projectId, command.artifactId],
            ),
            database.prepare("DELETE FROM comment_replies WHERE thread_id = ?")
              .bind(row.id),
            database.prepare(`
              DELETE FROM comment_threads
              WHERE id = ? AND project_id = ? AND artifact_id = ?
            `).bind(row.id, command.projectId, command.artifactId),
          ];
        }));
      }
      return {deleted: deletable.length, skippedDispatched};
    },
    createReply: async (
      command: CreateCommentReply,
    ): Promise<CommentReplyCreation> => {
      const replayed = await readIdempotentReplyRowOrNull(
        command.projectId,
        command.idempotencyKey,
      );
      if (replayed !== null) return replayedReply(replayed, command);
      try {
        await database.batch([
          database.prepare(`
            INSERT INTO comment_replies (
              id, thread_id, project_id, body, author_principal_id,
              author_principal_kind, author_display_name,
              author_authorized_by_principal_id, idempotency_key,
              created_at, updated_at
            )
            SELECT ?, t.id, t.project_id, ?, ?, ?, ?, ?, ?, ?, ?
            FROM comment_threads t
            WHERE t.id = ? AND t.project_id = ? AND t.artifact_id = ?
              AND t.state = 'open'
          `).bind(
            command.id,
            command.body,
            command.author.principalId,
            command.author.principalKind,
            command.author.displayName,
            command.author.authorizedByPrincipalId,
            command.idempotencyKey,
            command.createdAt,
            command.createdAt,
            command.threadId,
            command.projectId,
            command.artifactId,
          ),
          database.prepare(
            "UPDATE comment_threads SET updated_at = ? WHERE id = ?",
          ).bind(command.createdAt, command.threadId),
          commentActionStatement(
            {
              action: artifactActionKinds.commentReply,
              actionId: null,
              authorizedByPrincipalId: command.author.authorizedByPrincipalId,
              changedAt: command.createdAt,
              idempotencyKey:
                commentActionIdentity(command.threadId).idempotencyKey,
              principalId: command.author.principalId,
            },
            commentReplyScope,
            [
              command.id,
              command.threadId,
              command.projectId,
              command.artifactId,
            ],
          ),
          ...mutationGuardStatements(
            `comment-reply:${command.projectId}:${command.idempotencyKey}`,
            "SELECT 1 FROM comment_replies WHERE id = ?",
            [command.id],
          ),
        ]);
      } catch (cause) {
        const raced = await readIdempotentReplyRowOrNull(
          command.projectId,
          command.idempotencyKey,
        );
        if (raced !== null) return replayedReply(raced, command);
        const thread = await readThreadRowOrNull(
          command.projectId,
          command.artifactId,
          command.threadId,
        );
        if (thread === null) throw missingComment();
        if (thread.state === commentThreadStates.resolved) throw resolvedComment();
        throw cause;
      }
      return {replayed: false, reply: commentReplyFromRow(await readReplyRow(command.id))};
    },
    findIdempotentReply: async (projectId, idempotencyKey) => {
      const row = await readIdempotentReplyRowOrNull(projectId, idempotencyKey);
      return row === null ? null : commentReplyFromRow(row);
    },
    listReplies: async (
      threadId: string,
    ): Promise<readonly CommentReplyRecord[]> => {
      const result = await database.prepare(`${commentReplySelect}
        WHERE r.thread_id = ? ORDER BY r.created_at ASC, r.id ASC
      `).bind(threadId).all<z.input<typeof commentReplyRowSchema>>();
      return result.results.map((row) =>
        commentReplyFromRow(commentReplyRowSchema.parse(row)));
    },
    updateReply: async (
      command: UpdateCommentReply,
    ): Promise<CommentReplyRecord> => {
      const commentAction = commentActionIdentity(command.threadId);
      try {
        await database.batch([
          database.prepare(`
            UPDATE comment_replies SET body = ?, updated_at = ?
            WHERE id = ? AND thread_id = ? AND EXISTS (
              SELECT 1 FROM comment_threads t
              WHERE t.id = comment_replies.thread_id AND t.project_id = ?
                AND t.artifact_id = ?
            )
          `).bind(
            command.body,
            command.updatedAt,
            command.replyId,
            command.threadId,
            command.projectId,
            command.artifactId,
          ),
          database.prepare(
            "UPDATE comment_threads SET updated_at = ? WHERE id = ?",
          ).bind(command.updatedAt, command.threadId),
          commentActionStatement(
            {
              action: artifactActionKinds.commentUpdate,
              actionId: commentAction.actionId,
              authorizedByPrincipalId: command.authorizedByPrincipalId,
              changedAt: command.updatedAt,
              idempotencyKey: commentAction.idempotencyKey,
              principalId: command.principalId,
            },
            `${commentReplyScope} AND r.updated_at = ?`,
            [
              command.replyId,
              command.threadId,
              command.projectId,
              command.artifactId,
              command.updatedAt,
            ],
          ),
          ...mutationGuardStatements(
            `comment-reply-update:${command.projectId}:${command.replyId}`,
            `SELECT 1 FROM comment_replies
              WHERE id = ? AND thread_id = ? AND updated_at = ?`,
            [command.replyId, command.threadId, command.updatedAt],
          ),
        ]);
      } catch (cause) {
        const existing = await readReplyRowOrNull(command.replyId);
        if (existing === null) throw missingComment();
        throw cause;
      }
      return commentReplyFromRow(await readReplyRow(command.replyId));
    },
    deleteReply: async (command: DeleteCommentReply): Promise<void> => {
      const commentAction = commentActionIdentity(command.threadId);
      try {
        await database.batch([
          commentActionStatement(
            {
              action: artifactActionKinds.commentDelete,
              actionId: commentAction.actionId,
              authorizedByPrincipalId: command.authorizedByPrincipalId,
              changedAt: command.deletedAt,
              idempotencyKey: commentAction.idempotencyKey,
              principalId: command.principalId,
            },
            commentReplyScope,
            [
              command.replyId,
              command.threadId,
              command.projectId,
              command.artifactId,
            ],
          ),
          database.prepare(`
            UPDATE comment_threads SET updated_at = ?
            WHERE id = ? AND EXISTS (
              SELECT 1 FROM comment_replies r
              WHERE r.id = ? AND r.thread_id = comment_threads.id
            )
          `).bind(command.deletedAt, command.threadId, command.replyId),
          database.prepare(
            "DELETE FROM comment_replies WHERE id = ? AND thread_id = ?",
          ).bind(command.replyId, command.threadId),
          ...mutationGuardStatements(
            `comment-reply-delete:${command.projectId}:${command.replyId}`,
            `SELECT 1 FROM actions
              WHERE project_id = ? AND artifact_id = ? AND idempotency_key = ?
                AND action = ?`,
            [
              command.projectId,
              command.artifactId,
              commentAction.idempotencyKey,
              artifactActionKinds.commentDelete,
            ],
          ),
        ]);
      } catch (cause) {
        const existing = await readReplyRowOrNull(command.replyId);
        if (existing === null) throw missingComment();
        throw cause;
      }
    },
    registerAgent: async (
      command: RegisterAgent,
    ): Promise<RegisteredAgentRecord> => {
      // The id survives re-registration, so pending dispatches stay queued for
      // the same agent across restarts and session replacements. The key is
      // scoped to the registering principal, so one principal never reclaims
      // another's row, and with it another's queued dispatches.
      await database.prepare(`
        INSERT INTO registered_agents (
          id, installation_id, connection_key, display_name, kind,
          working_directory, agent_session_id, principal_id, created_at,
          last_seen_at, capabilities_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT (installation_id, principal_id, connection_key)
        DO UPDATE SET
          display_name = excluded.display_name,
          kind = excluded.kind,
          working_directory = excluded.working_directory,
          agent_session_id = excluded.agent_session_id,
          last_seen_at = excluded.last_seen_at,
          capabilities_json = excluded.capabilities_json
      `).bind(
        command.id,
        command.installationId,
        command.connectionKey,
        command.displayName,
        command.kind,
        command.workingDirectory,
        command.agentSessionId,
        command.principalId,
        command.registeredAt,
        command.registeredAt,
        JSON.stringify(command.capabilities),
      ).run();
      return readAgentRowByConnectionKey(
        command.installationId,
        command.principalId,
        command.connectionKey,
      );
    },
    disconnectAgent: async (
      installationScope: string,
      agentId: string,
    ): Promise<void> => {
      await database.prepare(
        "DELETE FROM registered_agents WHERE installation_id = ? AND id = ?",
      ).bind(installationScope, agentId).run();
    },
    listAgents: async (
      installationScope: string,
      now: string,
    ): Promise<readonly RegisteredAgentPresence[]> => {
      // Rows are disposable liveness records: reap what stopped polling in
      // the same batch that reads the survivors and their dispatch-derived
      // presence facts (spec §3.2) — no stored activity writes.
      const results = await database.batch<object>([
        database.prepare(`
          DELETE FROM registered_agents
          WHERE installation_id = ? AND last_seen_at < ?
        `).bind(
          installationScope,
          isoBefore(now, registeredAgentRetentionMilliseconds),
        ),
        database.prepare(`${registeredAgentSelect}
          WHERE installation_id = ? ORDER BY created_at ASC, id ASC
        `).bind(installationScope),
        // The newest claimed/delivered dispatch whose bundle threads are not
        // all resolved is the dispatch the agent is working.
        database.prepare(`
          SELECT d.id, d.agent_id AS agentId FROM agent_dispatches d
          WHERE d.installation_id = ? AND d.state IN ('claimed', 'delivered')
            AND (
              SELECT COUNT(*) FROM json_each(d.thread_ids_json) member
              JOIN comment_threads t
                ON t.id = member.value AND t.state = 'resolved'
            ) < json_array_length(d.thread_ids_json)
          ORDER BY d.updated_at DESC, d.id DESC
        `).bind(installationScope),
        database.prepare(`
          SELECT agent_id AS agentId, MAX(updated_at) AS latestAt
          FROM agent_dispatches WHERE installation_id = ?
          GROUP BY agent_id
        `).bind(installationScope),
      ]);
      const listed = results[1];
      const working = results[2];
      const transitions = results[3];
      if (
        listed === undefined || working === undefined ||
        transitions === undefined
      ) {
        throw new Error("D1 did not return the registered-agent listing.");
      }
      const activeByAgent = new Map<string, string>();
      for (const row of z.array(workingDispatchRowSchema).parse(working.results)) {
        if (!activeByAgent.has(row.agentId)) {
          activeByAgent.set(row.agentId, row.id);
        }
      }
      const latestByAgent = new Map<string, string>();
      for (
        const row of z.array(latestDispatchTransitionRowSchema)
          .parse(transitions.results)
      ) {
        if (row.latestAt !== null) latestByAgent.set(row.agentId, row.latestAt);
      }
      return listed.results.map((row) => {
        const agent = registeredAgentRowSchema.parse(row);
        return {
          activeDispatchId: activeByAgent.get(agent.id) ?? null,
          agent,
          latestDispatchTransitionAt: latestByAgent.get(agent.id) ?? null,
        };
      });
    },
    recordActivity: async (command: RecordAgentActivity): Promise<void> => {
      // Beacons are display metadata: the newest write wins unconditionally,
      // and the read side applies TTL decay and the liveness gate.
      await database.prepare(`
        UPDATE registered_agents SET activity_state = ?, activity_at = ?
        WHERE installation_id = ? AND id = ?
      `).bind(
        command.state,
        command.observedAt,
        command.installationId,
        command.agentId,
      ).run();
    },
    findAgent: (installationScope: string, agentId: string) =>
      readAgentRowOrNull(installationScope, agentId),
    createDispatch: async (
      command: CreateAgentDispatch,
    ): Promise<AgentDispatchCreation> => {
      const threadIdsJson = JSON.stringify(command.threadIds);
      const replayed = await readIdempotentDispatchRowOrNull(
        command.installationId,
        command.projectId,
        command.idempotencyKey,
      );
      if (replayed !== null) {
        return replayedDispatch(replayed, command, threadIdsJson);
      }
      await assertSendableThreads(command);
      try {
        await database.batch([
          database.prepare(`
            INSERT INTO agent_dispatches (
              id, installation_id, project_id, agent_id, agent_display_name,
              thread_ids_json, note, state, sender_principal_id,
              sender_principal_kind, sender_display_name,
              sender_authorized_by_principal_id, idempotency_key, claimed_at,
              lease_expires_at, delivered_at, addressed_at, failed_at,
              failure_reason, canceled_at, created_at, updated_at
            ) VALUES (
              ?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?, ?, ?, ?,
              NULL, NULL, NULL, NULL, NULL, NULL, NULL, ?, ?
            )
          `).bind(
            command.id,
            command.installationId,
            command.projectId,
            command.agentId,
            command.agentDisplayName,
            threadIdsJson,
            command.note,
            command.sender.principalId,
            command.sender.principalKind,
            command.sender.displayName,
            command.sender.authorizedByPrincipalId,
            command.idempotencyKey,
            command.createdAt,
            command.createdAt,
          ),
          // The marker moves the thread off the default listings, so it
          // counts as a thread edit: a `since` poller must see it leave.
          ...command.threadIds.map((threadId) => database.prepare(`
            UPDATE comment_threads SET dispatch_id = ?, updated_at = ?
            WHERE id = ? AND project_id = ? AND state = 'open'
              AND dispatch_id IS NULL
          `).bind(command.id, command.createdAt, threadId, command.projectId)),
          // The guard fails the whole batch unless every bundle thread now
          // carries this dispatch marker, so two concurrent sends can never
          // double-book a thread and a rejected bundle leaves no partial
          // markers behind.
          ...(command.threadIds.length === 0 ? [] : mutationGuardStatements(
            `dispatch-create:${command.projectId}:${command.idempotencyKey}`,
            `SELECT 1 FROM comment_threads WHERE dispatch_id = ?
              GROUP BY dispatch_id HAVING COUNT(*) = ?`,
            [command.id, command.threadIds.length],
          )),
        ]);
      } catch (cause) {
        const raced = await readIdempotentDispatchRowOrNull(
          command.installationId,
          command.projectId,
          command.idempotencyKey,
        );
        if (raced !== null) {
          return replayedDispatch(raced, command, threadIdsJson);
        }
        await assertSendableThreads(command);
        throw cause;
      }
      return {
        dispatch: agentDispatchFromRow(
          await readDispatchRow(command.installationId, command.id),
        ),
        replayed: false,
      };
    },
    claimNextDispatch: async (
      agentId: string,
      now: string,
      bumpHeartbeat: boolean,
    ): Promise<AgentDispatchRecord | null> => {
      // A re-check inside one held poll is a pure read while nothing is
      // claimable: the request's first attempt already stamped the heartbeat,
      // so an empty mailbox must not run a write batch every second. An
      // expired lease or a queued dispatch falls through to the write path.
      if (!bumpHeartbeat) {
        const expired = await database.prepare(`
          SELECT id FROM agent_dispatches
          WHERE agent_id = ? AND state = 'claimed' AND lease_expires_at < ?
          LIMIT 1
        `).bind(agentId, now).first<string>("id");
        if (expired === null) {
          const held = await database.prepare(`
            SELECT id FROM agent_dispatches
            WHERE agent_id = ? AND state = 'claimed' LIMIT 1
          `).bind(agentId).first<string>("id");
          if (held !== null) return null;
          const queued = await database.prepare(`
            SELECT id FROM agent_dispatches
            WHERE agent_id = ? AND state = 'queued' LIMIT 1
          `).bind(agentId).first<string>("id");
          if (queued === null) return null;
        }
      }
      // The poll request is the heartbeat — refreshed by every attempt that
      // reaches this write path — and an expired lease returns its dispatch
      // to the queue before the oldest-queued selection, so a dead claimer
      // never wedges the FIFO.
      await database.batch([
        database.prepare(
          "UPDATE registered_agents SET last_seen_at = ? WHERE id = ?",
        ).bind(now, agentId),
        database.prepare(`
          UPDATE agent_dispatches
          SET state = 'queued', claimed_at = NULL, lease_expires_at = NULL,
            updated_at = ?
          WHERE agent_id = ? AND state = 'claimed' AND lease_expires_at < ?
        `).bind(now, agentId, now),
      ]);
      // One-active-claim: while a claim is held, the next claim waits.
      const active = await database.prepare(`
        SELECT id FROM agent_dispatches
        WHERE agent_id = ? AND state = 'claimed' LIMIT 1
      `).bind(agentId).first<string>("id");
      if (active !== null) return null;
      const candidate = await database.prepare(`
        SELECT id, installation_id AS installationId FROM agent_dispatches
        WHERE agent_id = ? AND state = 'queued'
        ORDER BY created_at ASC, id ASC LIMIT 1
      `).bind(agentId).first<z.input<typeof dispatchCandidateRowSchema>>();
      if (candidate === null) return null;
      const oldest = dispatchCandidateRowSchema.parse(candidate);
      try {
        await database.batch([
          // The guard reads the pre-state, so a dispatch that stopped being
          // queued between the selection and the claim aborts the batch.
          ...mutationGuardStatements(
            `dispatch-claim:${oldest.id}`,
            `SELECT 1 FROM agent_dispatches
              WHERE id = ? AND agent_id = ? AND state = 'queued'`,
            [oldest.id, agentId],
          ),
          database.prepare(`
            UPDATE agent_dispatches
            SET state = 'claimed', claimed_at = ?, lease_expires_at = ?,
              updated_at = ?
            WHERE id = ? AND state = 'queued'
          `).bind(
            now,
            isoAfter(now, agentDispatchLeaseMilliseconds),
            now,
            oldest.id,
          ),
        ]);
      } catch (cause) {
        const contested = await readDispatchRowOrNull(
          oldest.installationId,
          oldest.id,
        );
        if (contested === null || contested.state !== agentDispatchStates.queued) {
          return null;
        }
        throw cause;
      }
      return agentDispatchFromRow(
        await readDispatchRow(oldest.installationId, oldest.id),
      );
    },
    markDelivered: async (
      command: MarkDispatchDelivered,
    ): Promise<AgentDispatchRecord> => {
      const row = await readDispatchRowOrNull(
        command.installationId,
        command.dispatchId,
      );
      if (row === null) throw missingDispatch();
      requireClaimHolder(row, command.agentId);
      if (row.state !== agentDispatchStates.claimed) {
        throw new DispatchStateConflict({
          message: `A ${row.state} dispatch cannot be reported delivered.`,
        });
      }
      await applyGuardedTransition(
        "dispatch-delivered",
        command.installationId,
        row.id,
        [agentDispatchStates.claimed],
        [database.prepare(`
          UPDATE agent_dispatches
          SET state = 'delivered', delivered_at = ?, updated_at = ?
          WHERE id = ? AND state = 'claimed'
        `).bind(command.deliveredAt, command.deliveredAt, row.id)],
        "reported delivered",
      );
      return agentDispatchFromRow(
        await readDispatchRow(command.installationId, row.id),
      );
    },
    markFailed: async (
      command: MarkDispatchFailed,
    ): Promise<AgentDispatchRecord> => {
      const row = await readDispatchRowOrNull(
        command.installationId,
        command.dispatchId,
      );
      if (row === null) throw missingDispatch();
      requireClaimHolder(row, command.agentId);
      if (
        row.state !== agentDispatchStates.claimed &&
        row.state !== agentDispatchStates.delivered
      ) {
        throw new DispatchStateConflict({
          message: `A ${row.state} dispatch cannot be reported failed.`,
        });
      }
      await applyGuardedTransition(
        "dispatch-failed",
        command.installationId,
        row.id,
        [agentDispatchStates.claimed, agentDispatchStates.delivered],
        failedDispatchStatements(row.id, command.reason, command.failedAt),
        "reported failed",
      );
      return agentDispatchFromRow(
        await readDispatchRow(command.installationId, row.id),
      );
    },
    cancelDispatch: async (
      command: CancelAgentDispatch,
    ): Promise<AgentDispatchRecord> => {
      const row = await readDispatchRowOrNull(
        command.installationId,
        command.dispatchId,
      );
      if (row === null || row.projectId !== command.projectId) {
        throw missingDispatch();
      }
      if (
        row.state !== agentDispatchStates.queued &&
        row.state !== agentDispatchStates.claimed
      ) {
        throw new DispatchStateConflict({
          message: `A ${row.state} dispatch cannot be canceled.`,
        });
      }
      await applyGuardedTransition(
        "dispatch-cancel",
        command.installationId,
        row.id,
        [agentDispatchStates.queued, agentDispatchStates.claimed],
        [
          database.prepare(`
            UPDATE agent_dispatches
            SET state = 'canceled', canceled_at = ?, updated_at = ?,
              claimed_at = NULL, lease_expires_at = NULL
            WHERE id = ?
          `).bind(command.canceledAt, command.canceledAt, row.id),
          // Cancellation clears the markers so the threads reappear in the
          // default listings: work is never silently lost.
          database.prepare(`
            UPDATE comment_threads SET dispatch_id = NULL, updated_at = ?
            WHERE dispatch_id = ?
          `).bind(command.canceledAt, row.id),
        ],
        "canceled",
      );
      return agentDispatchFromRow(
        await readDispatchRow(command.installationId, row.id),
      );
    },
    listDispatches: async (
      command: ListAgentDispatches,
    ): Promise<AgentDispatchPage> => {
      await applyProjectTransitions(
        command.installationId,
        command.projectId,
        command.now,
      );
      const result = await database.prepare(`${agentDispatchSelect}
        WHERE d.installation_id = ? AND d.project_id = ?
          AND (? IS NULL OR d.state = ?)
          AND (? IS NULL OR d.agent_id = ?)
          AND (? IS NULL OR d.created_at < ? OR (d.created_at = ? AND d.id < ?))
        ORDER BY d.created_at DESC, d.id DESC LIMIT ?
      `).bind(
        command.installationId,
        command.projectId,
        command.state,
        command.state,
        command.agentId,
        command.agentId,
        command.cursor?.createdAt ?? null,
        command.cursor?.createdAt ?? null,
        command.cursor?.createdAt ?? null,
        command.cursor?.id ?? null,
        command.limit + 1,
      ).all<z.input<typeof agentDispatchRowSchema>>();
      const parsed = result.results
        .map((row) => agentDispatchRowSchema.parse(row));
      return pageResult(
        parsed.slice(0, command.limit).map(agentDispatchFromRow),
        parsed,
        command.limit,
      );
    },
    findDispatch: async (
      installationScope: string,
      dispatchId: string,
      now: string,
    ): Promise<AgentDispatchRecord | null> => {
      const row = await readDispatchRowOrNull(installationScope, dispatchId);
      if (row === null) return null;
      await applyDispatchTransitions(dispatchId, now);
      return agentDispatchFromRow(
        await readDispatchRow(installationScope, dispatchId),
      );
    },
    observeAddressed: async (
      dispatchId: string,
      now: string,
    ): Promise<AgentDispatchRecord | null> => {
      const row = await database.prepare(`${agentDispatchSelect}
        WHERE d.id = ?
      `).bind(dispatchId).first<z.input<typeof agentDispatchRowSchema>>();
      if (row === null) return null;
      const found = agentDispatchRowSchema.parse(row);
      await addressedStatement("id = ?", [dispatchId], now).run();
      return agentDispatchFromRow(
        await readDispatchRow(found.installationId, dispatchId),
      );
    },
    versionContainsPath: async (projectId, versionId, path) => {
      const found = await database.prepare(`
        SELECT 1 AS found FROM manifest_entries entry
        INNER JOIN versions version ON version.id = entry.version_id
        WHERE version.project_id = ? AND entry.version_id = ? AND entry.path = ?
      `).bind(projectId, versionId, path).first<number>("found");
      return found !== null;
    },
  };

  async function readDeletion(
    projectId: string,
    artifactId: string,
    replayed: boolean,
  ): Promise<ArtifactDeletion> {
    const artifact = await readArtifactOrNull(projectId, artifactId, true);
    if (artifact === null || artifact.deletedAt === null) {
      throw new Error(`Artifact ${artifactId} has no persisted tombstone.`);
    }
    const tombstone: ArtifactTombstone = {...artifact, deletedAt: artifact.deletedAt};
    const retainedVersionCount = await database.prepare(`
      SELECT COUNT(*) AS retainedVersionCount FROM versions
      WHERE project_id = ? AND artifact_id = ?
    `).bind(projectId, artifactId).first<number>("retainedVersionCount");
    if (retainedVersionCount === null) throw new Error("D1 did not count retained versions.");
    return {artifact: tombstone, replayed, retainedVersionCount};
  }
}

function serializeCommentAnchor(carrier: {readonly anchor: unknown}): string | null {
  return carrier.anchor === null || carrier.anchor === undefined
    ? null
    : JSON.stringify(carrier.anchor);
}

// A comment action never carries the caller's idempotency key: that key already
// belongs to a publish, a restore, or another comment write in the same project.
// Two mutations on one thread can also share a millisecond, so the derived key
// carries the action row id instead of the changed-at timestamp. Postgres
// enforces uniqueness on (installation_id, project_id, idempotency_key) and D1
// keeps the same shape so the ledger reads identically on every backend.
function commentActionIdentity(threadId: string) {
  const actionId = crypto.randomUUID();
  return {actionId, idempotencyKey: `comment:${threadId}:${actionId}`};
}

function commentUpdateActionKind(
  command: UpdateCommentThread,
): ArtifactActionRecord["action"] {
  if (command.state === null) return artifactActionKinds.commentUpdate;
  return command.state.state === commentThreadStates.resolved
    ? artifactActionKinds.commentResolve
    : artifactActionKinds.commentReopen;
}

function commentAuthorFromRow(
  row: z.infer<typeof commentThreadRowSchema> | z.infer<typeof commentReplyRowSchema>,
): CommentAuthor {
  return {
    authorizedByPrincipalId: row.authorAuthorizedByPrincipalId,
    displayName: row.authorDisplayName,
    principalId: row.authorPrincipalId,
    principalKind: row.authorPrincipalKind,
  };
}

function commentThreadFromRow(
  row: z.infer<typeof commentThreadRowSchema>,
): CommentThreadRecord {
  return {
    anchor: row.anchorJson === null ? null : JSON.parse(row.anchorJson),
    artifactId: row.artifactId,
    author: commentAuthorFromRow(row),
    body: row.body,
    createdAt: row.createdAt,
    id: row.id,
    installationId: row.installationId,
    path: row.path,
    projectId: row.projectId,
    replyCount: row.replyCount,
    resolvedAt: row.resolvedAt,
    resolvedBy: row.resolvedByPrincipalId === null ||
        row.resolvedByPrincipalKind === null ||
        row.resolvedByDisplayName === null
      ? null
      : {
        authorizedByPrincipalId: row.resolvedByAuthorizedByPrincipalId,
        displayName: row.resolvedByDisplayName,
        principalId: row.resolvedByPrincipalId,
        principalKind: row.resolvedByPrincipalKind,
      },
    state: row.state,
    updatedAt: row.updatedAt,
    versionId: row.versionId,
  };
}

function commentReplyFromRow(
  row: z.infer<typeof commentReplyRowSchema>,
): CommentReplyRecord {
  return {
    author: commentAuthorFromRow(row),
    body: row.body,
    createdAt: row.createdAt,
    id: row.id,
    projectId: row.projectId,
    threadId: row.threadId,
    updatedAt: row.updatedAt,
  };
}

function replayedThread(
  row: z.infer<typeof commentThreadRowSchema>,
  command: CreateCommentThread,
  anchorJson: string | null,
): CommentThreadCreation {
  if (
    row.artifactId !== command.artifactId ||
    row.versionId !== command.versionId ||
    row.path !== command.path ||
    row.body !== command.body ||
    row.anchorJson !== anchorJson
  ) {
    throw new IdempotencyConflict({
      message: "The idempotency key was already used with different input.",
    });
  }
  return {replayed: true, thread: commentThreadFromRow(row)};
}

function replayedReply(
  row: z.infer<typeof commentReplyRowSchema>,
  command: CreateCommentReply,
): CommentReplyCreation {
  if (row.threadId !== command.threadId || row.body !== command.body) {
    throw new IdempotencyConflict({
      message: "The idempotency key was already used with different input.",
    });
  }
  return {replayed: true, reply: commentReplyFromRow(row)};
}

function missingDispatch(): AgentDispatchNotFound {
  return new AgentDispatchNotFound({message: "The dispatch does not exist."});
}

function dispatchedCommentDeletionConflict(): DispatchStateConflict {
  return new DispatchStateConflict({
    message:
      "This comment has been sent to an agent and cannot be deleted until the dispatch is complete.",
  });
}

function requireClaimHolder(
  row: z.infer<typeof agentDispatchRowSchema>,
  agentId: string,
): void {
  if (row.agentId === agentId) return;
  throw new DispatchStateConflict({
    message: "The reporting agent does not hold this dispatch.",
  });
}

function agentDispatchFromRow(
  row: z.infer<typeof agentDispatchRowSchema>,
): AgentDispatchRecord {
  return {
    addressedAt: row.addressedAt,
    agentDisplayName: row.agentDisplayName,
    agentId: row.agentId,
    canceledAt: row.canceledAt,
    claimedAt: row.claimedAt,
    createdAt: row.createdAt,
    deliveredAt: row.deliveredAt,
    failedAt: row.failedAt,
    failureReason: row.failureReason,
    id: row.id,
    idempotencyKey: row.idempotencyKey,
    installationId: row.installationId,
    leaseExpiresAt: row.leaseExpiresAt,
    note: row.note,
    projectId: row.projectId,
    sender: {
      authorizedByPrincipalId: row.senderAuthorizedByPrincipalId,
      displayName: row.senderDisplayName,
      principalId: row.senderPrincipalId,
      principalKind: row.senderPrincipalKind,
    },
    state: row.state,
    threadIds: threadIdsSchema.parse(JSON.parse(row.threadIdsJson)),
    updatedAt: row.updatedAt,
  };
}

function replayedDispatch(
  row: z.infer<typeof agentDispatchRowSchema>,
  command: CreateAgentDispatch,
  threadIdsJson: string,
): AgentDispatchCreation {
  if (
    row.agentId !== command.agentId ||
    row.threadIdsJson !== threadIdsJson ||
    row.note !== command.note
  ) {
    throw new IdempotencyConflict({
      message: "The idempotency key was already used with different input.",
    });
  }
  return {dispatch: agentDispatchFromRow(row), replayed: true};
}

// Stored timestamps are canonical millisecond ISO text, so offsets computed
// through Date round-trip into the same lexicographically comparable format.
function isoAfter(instant: string, milliseconds: number): string {
  return new Date(Date.parse(instant) + milliseconds).toISOString();
}

function isoBefore(instant: string, milliseconds: number): string {
  return new Date(Date.parse(instant) - milliseconds).toISOString();
}

function missingComment(): CommentNotFound {
  return new CommentNotFound({
    message: "The comment thread or reply does not exist.",
  });
}

function resolvedComment(): CommentResolved {
  return new CommentResolved({
    message: "The comment thread is resolved and cannot accept replies.",
  });
}

function changedDuringManagement(): ArtifactMutationConflict {
  return new ArtifactMutationConflict({
    message: "The artifact changed while this operation was being applied.",
  });
}

function assertCurrent(
  artifact: ArtifactRecord,
  expectedCurrentVersionId: string,
): void {
  if (artifact.currentVersionId !== expectedCurrentVersionId) {
    throw new ArtifactMutationConflict({
      message: `The artifact moved to version ${artifact.currentVersionId}.`,
    });
  }
}

function pageResult<Item extends {readonly createdAt: string; readonly id: string}>(
  items: readonly Item[],
  allRows: readonly {readonly createdAt: string; readonly id: string}[],
  limit: number,
): PageResult<Item> {
  const boundary = allRows.length > limit ? items.at(-1) : undefined;
  return {
    items,
    nextCursor: boundary === undefined
      ? null
      : {createdAt: boundary.createdAt, id: boundary.id},
  };
}
