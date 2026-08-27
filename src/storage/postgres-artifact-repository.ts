import {Effect} from "effect";
import {SqlClient} from "effect/unstable/sql/SqlClient";
import {z} from "zod";

import {
  AgentDispatchNotFound,
  ArtifactMutationConflict,
  ArtifactNotFound,
  CommentNotFound,
  CommentResolved,
  DispatchStateConflict,
  IdempotencyConflict,
  InvalidDispatch,
  ProjectConflict,
  ProjectArchived,
  ProjectNotFound,
  PublishConflict,
  UploadClosed,
  UploadExpired,
  UploadFileNotFound,
  UploadIncomplete,
  UploadNotFound,
  VersionNotFound,
} from "../core/errors.js";
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
  type ArtifactActionPage,
  type ArtifactActionRecord,
  type ArtifactDeletion,
  type ArtifactPage,
  type ArtifactRecord,
  type ArtifactState,
  type ArtifactTombstone,
  type ArtifactVersion,
  type CommentAuthor,
  type CommentReplyCreation,
  type CommentReplyRecord,
  type CommentThreadClearing,
  type CommentThreadCreation,
  type CommentThreadDeletion,
  type CommentThreadPage,
  type CommentThreadRecord,
  type CommentThreadState,
  type ContentBootstrapRecord,
  type ContentSessionRecord,
  type PageCursor,
  defaultProjectId,
  defaultProjectName,
  type PublishedVersion,
  type ProjectRecord,
  type RegisteredAgentPresence,
  type RegisteredAgentRecord,
  type StagedUpload,
  type StagedUploadFile,
  type VersionContent,
  type VersionRecord,
} from "../core/model.js";
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
} from "../core/ports.js";
import {principalKinds, type PrincipalKind} from "../core/identity.js";
import type {
  ProjectGitHistoryProgress,
  StoredProjectGitHistorySetting,
  StoreProjectGitHistorySetting,
} from "../application/project-git-history.js";
import {normalizeArtifactSearchText} from "../application/artifact-tags.js";
import {
  agentDispatchLeaseMilliseconds,
  agentUnavailableStalenessMilliseconds,
  registeredAgentRetentionMilliseconds,
} from "../core/publishing-limits.js";
import {createManifest} from "../manifest/create-manifest.js";
import type {PostgresDatabase} from "./postgres-database.js";
import type {
  ListPublicLinks,
  PublicLinkInventoryPage,
} from "../application/public-link-administration.js";
import {
  publicLinkInventoryRowSchema,
  publicLinkPageFromRows,
} from "./public-link-inventory-row.js";
import {
  gitHistoryCopyPolicyDigest,
  gitHistoryJobId,
  gitHistoryJobKinds,
  type GitHistoryBudgetReservation,
  type GitHistoryJob,
  type GitHistoryMapping,
  type GitHistoryMirrorStore,
  type GitRepositoryCoordinates,
} from "../git-history/git-history-mirror.js";
import {defaultGitHistoryMaximumCopiedFiles} from
  "../git-history/git-history-capability.js";

const accessSettingSchema = z.enum([
  accessSettings.accountRequired,
  accessSettings.publicLink,
]);
const dispositionSchema = z.enum([
  fileDispositions.attachment,
  fileDispositions.inline,
]);
const routingModeSchema = z.enum([routingModes.static, routingModes.spa]);
const uploadStatusSchema = z.enum([
  uploadStatuses.committed,
  uploadStatuses.open,
]);
const artifactActionKindSchema = z.enum([
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
const nonnegativeIntegerSchema = z.coerce.number().int().nonnegative();
const positiveIntegerSchema = z.coerce.number().int().positive();
const gitHistoryJobRowSchema = z.object({
  artifactId: z.string(),
  attempts: z.coerce.number().int().nonnegative(),
  fileCopyBytes: z.coerce.number().int().nonnegative(),
  id: z.string(),
  kind: z.enum([gitHistoryJobKinds.deleteRepository, gitHistoryJobKinds.mirrorVersion]),
  maximumCopiedFiles: z.coerce.number().int().positive(),
  projectId: z.string(),
  storageBudgetBytes: z.coerce.number().int().nonnegative().nullable(),
  versionCopyBytes: z.coerce.number().int().nonnegative(),
  versionId: z.string().nullable(),
}).transform((row): GitHistoryJob => ({
  artifactId: row.artifactId,
  attempts: row.attempts,
  id: row.id,
  kind: row.kind,
  limits: row.kind === gitHistoryJobKinds.mirrorVersion
    ? {
      fileCopyBytes: row.fileCopyBytes,
      maximumCopiedFiles: row.maximumCopiedFiles,
      storageBudgetBytes: row.storageBudgetBytes,
      versionCopyBytes: row.versionCopyBytes,
    }
    : null,
  projectId: row.projectId,
  versionId: row.versionId,
}));
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
  alreadyDeletedRepositories: nonnegativeIntegerSchema,
  enabledProjects: nonnegativeIntegerSchema,
  logicalCopiedBytes: nonnegativeIntegerSchema,
  repositories: nonnegativeIntegerSchema,
  repositoriesToDelete: nonnegativeIntegerSchema,
});
const gitHistoryMappingRowSchema = z.object({
  artifactId: z.string(),
  commitId: z.string(),
  copiedBytes: z.coerce.number().int().nonnegative(),
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
  versionCount: z.coerce.number().int().positive(),
});
const artifactTagRowSchema = z.object({artifactId: z.string(), tag: z.string()});
const versionRowSchema = z.object({
  artifactId: z.string(),
  contentToken: z.string(),
  createdAt: z.string(),
  entryPath: z.string(),
  id: z.string(),
  manifestDigest: z.string(),
  number: positiveIntegerSchema,
  publisherPrincipalId: z.string(),
  projectId: z.string(),
  routingMode: routingModeSchema,
});
const publishedRowSchema = z.object({
  accessSetting: accessSettingSchema,
  artifactCreatedAt: z.string(),
  artifactDeletedAt: z.string().nullable(),
  artifactId: z.string(),
  artifactName: z.string(),
  contentToken: z.string(),
  currentVersionId: z.string(),
  entryPath: z.string(),
  manifestDigest: z.string(),
  projectId: z.string(),
  publisherPrincipalId: z.string(),
  routingMode: routingModeSchema,
  versionCreatedAt: z.string(),
  versionId: z.string(),
  versionNumber: positiveIntegerSchema,
});
const storedManifestEntryRowSchema = z.object({
  disposition: dispositionSchema,
  mediaType: z.string(),
  path: z.string(),
  sha256: z.string(),
  size: nonnegativeIntegerSchema,
});
const versionContentRowSchema = z.object({
  accessSetting: accessSettingSchema,
  artifactId: z.string(),
  contentToken: z.string(),
  disposition: dispositionSchema,
  isCurrent: z.boolean(),
  mediaType: z.string(),
  path: z.string(),
  projectId: z.string(),
  sha256: z.string(),
  size: nonnegativeIntegerSchema,
  versionId: z.string(),
});
const idempotencyRowSchema = z.object({
  accessSetting: accessSettingSchema.nullable(),
  artifactId: z.string(),
  inputDigest: z.string(),
  operation: z.enum([
    "change_access",
    "change_tags",
    "delete",
    "publish",
    "restore",
  ]),
  tagsJson: z.string().nullable(),
  versionId: z.string(),
});
const artifactActionRowSchema = z.object({
  action: artifactActionKindSchema,
  artifactId: z.string(),
  authorizedByPrincipalId: z.string().nullable(),
  createdAt: z.string(),
  id: z.string(),
  idempotencyKey: z.string(),
  principalId: z.string(),
  projectId: z.string(),
  versionId: z.string(),
});
const contentRecordRowSchema = z.object({
  artifactId: z.string(),
  contentToken: z.string(),
  createdAt: z.string(),
  expiresAt: z.string(),
  principalId: z.string(),
  projectId: z.string(),
  tokenDigest: z.string(),
  versionId: z.string(),
});
const stagedUploadRowSchema = z.object({
  committedVersionId: z.string().nullable(),
  createdAt: z.string(),
  entryPath: z.string(),
  expiresAt: z.string(),
  id: z.string(),
  manifestDigest: z.string(),
  principalId: z.string(),
  projectId: z.string(),
  routingMode: routingModeSchema,
  status: uploadStatusSchema,
});
const stagedUploadFileRowSchema = z.object({
  disposition: dispositionSchema,
  mediaType: z.string(),
  path: z.string(),
  sha256: z.string(),
  size: nonnegativeIntegerSchema,
  storageToken: z.string(),
  uploadedAt: z.string().nullable(),
});
const expiredStagedUploadRowSchema = z.object({
  id: z.string(),
  storageToken: z.string(),
});
const stagedUploadCommitRowSchema = z.object({
  expiresAt: z.string(),
  fileCount: nonnegativeIntegerSchema,
  manifestDigest: z.string(),
  readyCount: nonnegativeIntegerSchema,
  status: uploadStatusSchema,
});
const projectRowSchema = z.object({
  archivedAt: z.string().nullable(),
  createdAt: z.string(),
  id: z.string(),
  installationId: z.string(),
  name: z.string(),
});
const projectGitHistorySettingRowSchema = z.object({
  enabled: z.boolean(),
  projectId: z.string(),
  updatedAt: z.string(),
  updatedByPrincipalId: z.string(),
});
const projectGitHistoryEstimateRowSchema = z.object({
  estimatedCopiedBytes: nonnegativeIntegerSchema,
  estimatedPointerBytes: nonnegativeIntegerSchema,
  repositories: nonnegativeIntegerSchema,
  versions: nonnegativeIntegerSchema,
});
const projectGitHistoryProgressRowSchema = z.object({
  budgetLimitedJobs: nonnegativeIntegerSchema,
  mappedVersions: nonnegativeIntegerSchema,
  pendingJobs: nonnegativeIntegerSchema,
  unmappedVersions: nonnegativeIntegerSchema,
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
  replyCount: nonnegativeIntegerSchema,
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
const dispatchIdentityRowSchema = z.object({id: z.string()});
const threadIdsSchema = z.array(z.string());
const resolvedCountRowSchema = z.object({
  resolvedCount: nonnegativeIntegerSchema,
});
const latestDispatchTransitionRowSchema = z.object({
  latestAt: z.string().nullable(),
});
const workingDispatchCandidateRowSchema = z.object({
  id: z.string(),
  threadIdsJson: z.string(),
});
const clearableThreadRowSchema = z.object({
  dispatchState: agentDispatchStateSchema.nullable(),
  id: z.string(),
  versionId: z.string(),
});

interface PageResult<Item> {
  readonly items: readonly Item[];
  readonly nextCursor: PageCursor | null;
}

/** The comment thread column values one update command leaves behind. */
interface ChangedCommentThreadValues {
  readonly anchorJson: string | null;
  readonly body: string;
  readonly resolvedAt: string | null;
  readonly resolvedByAuthorizedByPrincipalId: string | null;
  readonly resolvedByDisplayName: string | null;
  readonly resolvedByPrincipalId: string | null;
  readonly resolvedByPrincipalKind: PrincipalKind | null;
  readonly state: CommentThreadState;
}

/** Installation-scoped Postgres persistence for artifacts and browser content sessions. */
export class PostgresArtifactRepository implements
  AgentDispatchRepository,
  ArtifactRepository,
  CommentRepository,
  ContentSessionRepository,
  GitHistoryMirrorStore,
  ProjectRepository,
  StagedUploadRepository
{
  readonly #database: PostgresDatabase;
  readonly #installationId: string;

  private constructor(database: PostgresDatabase, installationId: string) {
    this.#database = database;
    this.#installationId = installationId;
  }

  /** Create a ready repository scoped to one trusted installation. */
  static async open(
    database: PostgresDatabase,
    installationId: string,
  ): Promise<PostgresArtifactRepository> {
    await database.run(Effect.gen({self: this}, function*() {
      const sql = yield* SqlClient;
      yield* sql`INSERT INTO artifact_installations (id, created_at)
        VALUES (${installationId}, ${new Date().toISOString()})
        ON CONFLICT (id) DO NOTHING`;
      yield* sql`INSERT INTO projects (
          installation_id, id, name, created_at, archived_at
        ) VALUES (
          ${installationId}, ${defaultProjectId}, ${defaultProjectName},
          ${new Date().toISOString()}, NULL
        ) ON CONFLICT (installation_id, id) DO NOTHING`;
    }));
    return new PostgresArtifactRepository(database, installationId);
  }

  async createProject(command: CreateProject): Promise<ProjectRecord> {
    const installationId = this.#installationId;
    const rows = await this.#database.run(Effect.gen(function*() {
      const sql = yield* SqlClient;
      return yield* sql`INSERT INTO projects (
          installation_id, id, name, created_at, archived_at
        ) VALUES (
          ${installationId}, ${command.id}, ${command.name},
          ${command.createdAt}, ${command.archivedAt}
        ) ON CONFLICT (installation_id, id) DO NOTHING
        RETURNING installation_id AS "installationId", id, name,
          created_at AS "createdAt", archived_at AS "archivedAt"`;
    }));
    const project = projectRowSchema.nullable().parse(rows[0] ?? null);
    if (project === null) {
      throw new ProjectConflict({message: "The project identity is already in use."});
    }
    return project;
  }

  async findProject(projectId: string): Promise<ProjectRecord | null> {
    return this.#database.run(this.#readProjectOrNull(projectId));
  }

  async listProjects(): Promise<readonly ProjectRecord[]> {
    const installationId = this.#installationId;
    return this.#database.run(Effect.gen(function*() {
      const sql = yield* SqlClient;
      const rows = yield* sql.unsafe<object>(
        `SELECT installation_id AS "installationId", id, name,
          created_at AS "createdAt", archived_at AS "archivedAt"
         FROM projects
         WHERE installation_id = $1
         ORDER BY created_at, id`,
        [installationId],
      );
      return projectRowSchema.array().parse(rows);
    }));
  }

  async readProjectGitHistorySetting(
    projectId: string,
  ): Promise<StoredProjectGitHistorySetting | null> {
    const installationId = this.#installationId;
    return this.#database.run(Effect.gen(function*() {
      const sql = yield* SqlClient;
      const rows = yield* sql.unsafe<object>(`
        SELECT project_id AS "projectId", enabled,
          updated_by_principal_id AS "updatedByPrincipalId",
          updated_at AS "updatedAt"
        FROM git_history_project_settings
        WHERE installation_id = $1 AND project_id = $2
      `, [installationId, projectId]);
      return projectGitHistorySettingRowSchema.nullable().parse(rows[0] ?? null);
    }));
  }

  async readProjectGitHistoryProgress(
    projectId: string,
  ): Promise<ProjectGitHistoryProgress> {
    const installationId = this.#installationId;
    return this.#database.run(Effect.gen(function*() {
      const sql = yield* SqlClient;
      const rows = yield* sql.unsafe<object>(`
        SELECT
          (SELECT COUNT(*)
            FROM versions version
            JOIN artifacts artifact
              ON artifact.installation_id = version.installation_id
              AND artifact.project_id = version.project_id
              AND artifact.id = version.artifact_id
            JOIN git_history_mappings mapping
              ON mapping.installation_id = version.installation_id
              AND mapping.project_id = version.project_id
              AND mapping.artifact_id = version.artifact_id
              AND mapping.version_id = version.id
              AND mapping.status = 'recorded'
            WHERE version.installation_id = $1 AND version.project_id = $2
              AND artifact.deleted_at IS NULL
          ) AS "mappedVersions",
          (SELECT COUNT(*)
            FROM versions version
            JOIN artifacts artifact
              ON artifact.installation_id = version.installation_id
              AND artifact.project_id = version.project_id
              AND artifact.id = version.artifact_id
            LEFT JOIN git_history_mappings mapping
              ON mapping.installation_id = version.installation_id
              AND mapping.project_id = version.project_id
              AND mapping.artifact_id = version.artifact_id
              AND mapping.version_id = version.id
              AND mapping.status = 'recorded'
            WHERE version.installation_id = $1 AND version.project_id = $2
              AND artifact.deleted_at IS NULL AND mapping.version_id IS NULL
          ) AS "unmappedVersions",
          (SELECT COUNT(*) FROM git_history_jobs
            WHERE installation_id = $1 AND project_id = $2
              AND kind = 'mirror-version' AND state IN ('queued', 'claimed')
          ) AS "pendingJobs",
          (SELECT COUNT(*) FROM git_history_jobs
            WHERE installation_id = $1 AND project_id = $2
              AND kind = 'mirror-version' AND state = 'queued'
              AND last_error = 'budget_limited'
          ) AS "budgetLimitedJobs"
      `, [installationId, projectId]);
      return projectGitHistoryProgressRowSchema.parse(rows[0]);
    }));
  }

  async estimateProjectGitHistory(
    projectId: string,
    limits: {readonly fileCopyBytes: number; readonly versionCopyBytes: number},
  ): Promise<{
    readonly estimatedCopiedBytes: number;
    readonly estimatedPointerBytes: number;
    readonly repositories: number;
    readonly versions: number;
  }> {
    const installationId = this.#installationId;
    return this.#database.run(Effect.gen(function*() {
      const sql = yield* SqlClient;
      const rows = yield* sql.unsafe<object>(`
        WITH active_versions AS (
          SELECT version.id
          FROM versions version
          JOIN artifacts artifact
            ON artifact.installation_id = version.installation_id
            AND artifact.project_id = version.project_id
            AND artifact.id = version.artifact_id
          WHERE version.installation_id = $1
            AND version.project_id = $2
            AND artifact.deleted_at IS NULL
        ), version_totals AS (
          SELECT active.id,
            COALESCE(SUM(entry.size), 0) AS total_bytes,
            COALESCE(SUM(CASE
              WHEN entry.size <= $3 THEN entry.size ELSE 0
            END), 0) AS eligible_bytes
          FROM active_versions active
          LEFT JOIN manifest_entries entry
            ON entry.installation_id = $1 AND entry.version_id = active.id
          GROUP BY active.id
        )
        SELECT
          (SELECT COUNT(*) FROM artifacts
            WHERE installation_id = $1 AND project_id = $2
              AND deleted_at IS NULL) AS repositories,
          (SELECT COUNT(*) FROM active_versions) AS versions,
          COALESCE(SUM(CASE
            WHEN eligible_bytes > $4 THEN $4 ELSE eligible_bytes
          END), 0) AS "estimatedCopiedBytes",
          COALESCE(SUM(total_bytes - CASE
            WHEN eligible_bytes > $4 THEN $4 ELSE eligible_bytes
          END), 0) AS "estimatedPointerBytes"
        FROM version_totals
      `, [
        installationId,
        projectId,
        limits.fileCopyBytes,
        limits.versionCopyBytes,
      ]);
      return projectGitHistoryEstimateRowSchema.parse(rows[0]);
    }));
  }

  async storeProjectGitHistorySetting(
    setting: StoreProjectGitHistorySetting,
  ): Promise<StoredProjectGitHistorySetting> {
    const installationId = this.#installationId;
    return this.#database.run(Effect.gen({self: this}, function*() {
      const sql = yield* SqlClient;
      return yield* sql.withTransaction(Effect.gen({self: this}, function*() {
        const rows = yield* sql.unsafe<object>(`
          INSERT INTO git_history_project_settings (
            installation_id, project_id, enabled,
            file_copy_limit_bytes, version_copy_limit_bytes,
            maximum_copied_files, storage_budget_bytes,
            updated_by_principal_id, updated_at
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
          ON CONFLICT (installation_id, project_id) DO UPDATE SET
            enabled = EXCLUDED.enabled,
            file_copy_limit_bytes = EXCLUDED.file_copy_limit_bytes,
            version_copy_limit_bytes = EXCLUDED.version_copy_limit_bytes,
            maximum_copied_files = EXCLUDED.maximum_copied_files,
            storage_budget_bytes = EXCLUDED.storage_budget_bytes,
            updated_by_principal_id = EXCLUDED.updated_by_principal_id,
            updated_at = EXCLUDED.updated_at
          RETURNING project_id AS "projectId", enabled,
            updated_by_principal_id AS "updatedByPrincipalId",
            updated_at AS "updatedAt"
        `, [
          installationId,
          setting.projectId,
          setting.enabled,
          setting.limits.fileCopyBytes,
          setting.limits.versionCopyBytes,
          defaultGitHistoryMaximumCopiedFiles,
          setting.limits.storageBudgetBytes,
          setting.updatedByPrincipalId,
          setting.updatedAt,
        ]);
        if (setting.enabled) {
          yield* sql.unsafe(`
            UPDATE git_history_jobs
            SET storage_budget_bytes = $1, last_error = NULL,
              available_at = $2, updated_at = $2
            WHERE installation_id = $3 AND project_id = $4
              AND kind = 'mirror-version' AND state = 'queued'
              AND last_error = 'budget_limited'
          `, [
            setting.limits.storageBudgetBytes,
            setting.updatedAt,
            installationId,
            setting.projectId,
          ]);
          const versions = yield* sql.unsafe<{
            readonly artifactId: string;
            readonly projectId: string;
            readonly versionId: string;
          }>(`
            SELECT version.artifact_id AS "artifactId",
              version.project_id AS "projectId", version.id AS "versionId"
            FROM versions version
            JOIN artifacts artifact
              ON artifact.installation_id = version.installation_id
              AND artifact.project_id = version.project_id
              AND artifact.id = version.artifact_id
            LEFT JOIN git_history_mappings mapping
              ON mapping.installation_id = version.installation_id
              AND mapping.project_id = version.project_id
              AND mapping.artifact_id = version.artifact_id
              AND mapping.version_id = version.id
              AND mapping.status = 'recorded'
            WHERE version.installation_id = $1 AND version.project_id = $2
              AND artifact.deleted_at IS NULL AND mapping.version_id IS NULL
            ORDER BY version.artifact_id, version.number
          `, [installationId, setting.projectId]);
          for (const version of versions) {
            yield* this.#insertGitHistoryMirrorJob(
              version.projectId,
              version.artifactId,
              version.versionId,
              setting.updatedAt,
              setting.limits,
              defaultGitHistoryMaximumCopiedFiles,
            );
          }
        }
        return projectGitHistorySettingRowSchema.parse(rows[0]);
      }));
    }));
  }

  async claimGitHistoryJob(
    now: string,
    leaseExpiresAt: string,
  ): Promise<GitHistoryJob | null> {
    const installationId = this.#installationId;
    return this.#database.run(Effect.gen(function*() {
      const sql = yield* SqlClient;
      return yield* sql.withTransaction(Effect.gen(function*() {
        yield* sql.unsafe(`
          UPDATE git_history_jobs SET state = 'queued', lease_expires_at = NULL,
            available_at = $1, updated_at = $1
          WHERE installation_id = $2 AND state = 'claimed'
            AND lease_expires_at <= $1
        `, [now, installationId]);
        const rows = yield* sql.unsafe<object>(`
          SELECT job.id, job.project_id AS "projectId",
            job.artifact_id AS "artifactId", job.version_id AS "versionId",
            job.kind, job.attempts,
            COALESCE(job.file_copy_limit_bytes, 0) AS "fileCopyBytes",
            COALESCE(job.version_copy_limit_bytes, 0) AS "versionCopyBytes",
            COALESCE(job.maximum_copied_files, 1) AS "maximumCopiedFiles",
            job.storage_budget_bytes AS "storageBudgetBytes"
          FROM git_history_jobs job
          LEFT JOIN git_history_project_settings setting
            ON setting.installation_id = job.installation_id
            AND setting.project_id = job.project_id
          WHERE job.installation_id = $1 AND job.state = 'queued'
            AND job.available_at <= $2
            AND (job.kind = 'delete-repository' OR setting.enabled = TRUE)
            AND NOT EXISTS (
              SELECT 1 FROM git_history_jobs claimed
              WHERE claimed.installation_id = job.installation_id
                AND claimed.artifact_id = job.artifact_id
                AND claimed.state = 'claimed'
            )
          ORDER BY job.created_at, job.id
          FOR UPDATE OF job SKIP LOCKED LIMIT 1
        `, [installationId, now]);
        const job = gitHistoryJobRowSchema.nullable().parse(rows[0] ?? null);
        if (job === null) return null;
        yield* sql.unsafe(`
          UPDATE git_history_jobs SET state = 'claimed', attempts = attempts + 1,
            lease_expires_at = $1, updated_at = $2
          WHERE installation_id = $3 AND id = $4
        `, [leaseExpiresAt, now, installationId, job.id]);
        return {...job, attempts: job.attempts + 1};
      }));
    }));
  }

  async findGitHistoryRepository(
    projectId: string,
    artifactId: string,
  ): Promise<GitRepositoryCoordinates | null> {
    const rows = await this.#database.run(Effect.gen({self: this}, function*() {
      const sql = yield* SqlClient;
      return yield* sql.unsafe<object>(`
        SELECT project_id AS "projectId", artifact_id AS "artifactId",
          provider, repository_name AS "repositoryName",
          remote_url AS "remoteUrl", default_branch AS "defaultBranch", status
        FROM git_history_repositories
        WHERE installation_id = $1 AND project_id = $2 AND artifact_id = $3
      `, [this.#installationId, projectId, artifactId]);
    }));
    return gitHistoryRepositoryRowSchema.nullable().parse(rows[0] ?? null);
  }

  async recordGitHistoryRepository(
    coordinates: GitRepositoryCoordinates,
    recordedAt: string,
  ): Promise<GitRepositoryCoordinates> {
    const installationId = this.#installationId;
    const rows = await this.#database.run(Effect.gen(function*() {
      const sql = yield* SqlClient;
      return yield* sql.unsafe<object>(`
        INSERT INTO git_history_repositories (
          installation_id, project_id, artifact_id, provider,
          repository_name, remote_url, default_branch, status,
          created_at, updated_at
        ) SELECT $1, $2, $3, $4, $5, $6, $7,
          CASE WHEN artifact.deleted_at IS NULL THEN 'provisioned' ELSE 'deleting' END,
          $8, $8
        FROM artifacts artifact
        WHERE artifact.installation_id = $1 AND artifact.project_id = $2
          AND artifact.id = $3
        ON CONFLICT (installation_id, artifact_id) DO UPDATE SET
          updated_at = git_history_repositories.updated_at
        RETURNING project_id AS "projectId", artifact_id AS "artifactId",
          provider, repository_name AS "repositoryName",
          remote_url AS "remoteUrl", default_branch AS "defaultBranch", status
      `, [
        installationId, coordinates.projectId, coordinates.artifactId,
        coordinates.provider, coordinates.repositoryName,
        coordinates.remoteUrl, coordinates.defaultBranch, recordedAt,
      ]);
    }));
    const stored = gitHistoryRepositoryRowSchema.parse(rows[0]);
    if (stored.repositoryName !== coordinates.repositoryName ||
      stored.remoteUrl !== coordinates.remoteUrl) {
      throw new Error("Git history repository coordinates changed during creation.");
    }
    return stored;
  }

  async findGitHistoryMapping(
    projectId: string,
    artifactId: string,
    versionId: string,
  ): Promise<GitHistoryMapping | null> {
    const installationId = this.#installationId;
    const rows = await this.#database.run(Effect.gen(function*() {
      const sql = yield* SqlClient;
      return yield* sql.unsafe<object>(`
        SELECT project_id AS "projectId", artifact_id AS "artifactId",
          version_id AS "versionId", repository_name AS "repositoryName",
          commit_id AS "commitId", copied_bytes AS "copiedBytes"
        FROM git_history_mappings
        WHERE installation_id = $1 AND project_id = $2 AND artifact_id = $3
          AND version_id = $4 AND status = 'recorded'
      `, [installationId, projectId, artifactId, versionId]);
    }));
    return gitHistoryMappingRowSchema.nullable().parse(rows[0] ?? null);
  }

  async reserveGitHistoryBudget(
    jobId: string,
    logicalBytes: number,
    storageBudgetBytes: number | null,
    updatedAt: string,
  ): Promise<GitHistoryBudgetReservation> {
    const installationId = this.#installationId;
    return this.#database.run(Effect.gen(function*() {
      const sql = yield* SqlClient;
      return yield* sql.withTransaction(Effect.gen(function*() {
        if (storageBudgetBytes !== null) {
          yield* sql.unsafe(
            "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
            [`artifact-server:git-budget:${installationId}`],
          );
        }
        const existing = yield* sql.unsafe<{readonly state: string}>(`
          SELECT state FROM git_history_budget_reservations
          WHERE installation_id = $1 AND job_id = $2
        `, [installationId, jobId]);
        if (existing.length > 0) return {_tag: "AlreadyReserved"} as const;
        if (storageBudgetBytes !== null) {
          const usedRows = yield* sql.unsafe<{readonly logicalBytes: number}>(`
            SELECT COALESCE(SUM(logical_bytes), 0) AS "logicalBytes"
            FROM git_history_budget_reservations
            WHERE installation_id = $1 AND state IN ('reserved', 'committed')
          `, [installationId]);
          const used = nonnegativeIntegerSchema.parse(
            usedRows[0]?.logicalBytes ?? 0,
          );
          if (used + logicalBytes > storageBudgetBytes) {
            return {_tag: "BudgetLimited"} as const;
          }
        }
        yield* sql.unsafe(`
          INSERT INTO git_history_budget_reservations (
            installation_id, job_id, logical_bytes, state, updated_at
          ) VALUES ($1, $2, $3, 'reserved', $4)
        `, [installationId, jobId, logicalBytes, updatedAt]);
        return {_tag: "Reserved"} as const;
      }));
    }));
  }

  async completeGitHistoryMirror(
    job: GitHistoryJob,
    mapping: GitHistoryMapping,
    completedAt: string,
  ): Promise<"mirrored" | "artifact-deleted"> {
    const installationId = this.#installationId;
    return this.#database.run(Effect.gen(function*() {
      const sql = yield* SqlClient;
      return yield* sql.withTransaction(Effect.gen(function*() {
        const eligible = yield* sql.unsafe<object>(`
          SELECT 1 FROM artifacts artifact
          JOIN git_history_jobs job
            ON job.installation_id = $1 AND job.id = $2
          WHERE artifact.installation_id = $1 AND artifact.project_id = $3
            AND artifact.id = $4 AND artifact.deleted_at IS NULL
            AND job.state = 'claimed'
          FOR UPDATE OF artifact, job
        `, [installationId, job.id, mapping.projectId, mapping.artifactId]);
        if (eligible.length === 0) {
          yield* sql.unsafe(`
            UPDATE git_history_budget_reservations
            SET state = 'released', updated_at = $1
            WHERE installation_id = $2 AND job_id = $3 AND state = 'reserved'
          `, [completedAt, installationId, job.id]);
          yield* sql.unsafe(`
            UPDATE git_history_jobs SET state = 'done', lease_expires_at = NULL,
              last_error = 'artifact_deleted', updated_at = $1
            WHERE installation_id = $2 AND id = $3
          `, [completedAt, installationId, job.id]);
          yield* sql.unsafe(`
            INSERT INTO git_history_jobs (
              id, installation_id, project_id, artifact_id, version_id,
              kind, state, attempts, available_at, created_at, updated_at
            ) SELECT $1, installation_id, project_id, artifact_id, NULL,
              'delete-repository', 'queued', 0, $2, $2, $2
            FROM git_history_repositories
            WHERE installation_id = $3 AND project_id = $4 AND artifact_id = $5
              AND status <> 'deleted'
            ON CONFLICT (id) DO NOTHING
          `, [
            gitHistoryJobId(gitHistoryJobKinds.deleteRepository, mapping.artifactId, null),
            completedAt,
            installationId,
            mapping.projectId,
            mapping.artifactId,
          ]);
          yield* sql.unsafe(`
            UPDATE git_history_repositories SET status = 'deleting', updated_at = $1
            WHERE installation_id = $2 AND project_id = $3 AND artifact_id = $4
              AND status <> 'deleted'
          `, [completedAt, installationId, mapping.projectId, mapping.artifactId]);
          return "artifact-deleted" as const;
        }
        yield* sql.unsafe(`
          INSERT INTO git_history_mappings (
            installation_id, project_id, artifact_id, version_id,
            repository_name, commit_id, attempts, copied_bytes,
            status, created_at
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'recorded', $9)
          ON CONFLICT (installation_id, project_id, artifact_id, version_id)
          DO NOTHING
        `, [
          installationId, mapping.projectId, mapping.artifactId,
          mapping.versionId, mapping.repositoryName, mapping.commitId,
          job.attempts, mapping.copiedBytes, completedAt,
        ]);
        yield* sql.unsafe(`
          UPDATE git_history_budget_reservations
          SET state = 'committed', updated_at = $1
          WHERE installation_id = $2 AND job_id = $3 AND state = 'reserved'
        `, [completedAt, installationId, job.id]);
        yield* sql.unsafe(`
          UPDATE git_history_jobs SET state = 'done', lease_expires_at = NULL,
            last_error = NULL, updated_at = $1
          WHERE installation_id = $2 AND id = $3
        `, [completedAt, installationId, job.id]);
        return "mirrored" as const;
      }));
    }));
  }

  async releaseGitHistoryJob(
    job: GitHistoryJob,
    classification: string,
    availableAt: string,
  ): Promise<void> {
    const installationId = this.#installationId;
    await this.#database.run(Effect.gen(function*() {
      const sql = yield* SqlClient;
      yield* sql.unsafe(`
        UPDATE git_history_jobs SET state = 'queued', lease_expires_at = NULL,
          last_error = $1, available_at = $2, updated_at = $2
        WHERE installation_id = $3 AND id = $4 AND state = 'claimed'
      `, [classification, availableAt, installationId, job.id]);
    }));
  }

  async completeGitHistoryDeletion(
    job: GitHistoryJob,
    completedAt: string,
  ): Promise<void> {
    const installationId = this.#installationId;
    await this.#database.run(Effect.gen(function*() {
      const sql = yield* SqlClient;
      yield* sql.withTransaction(Effect.gen(function*() {
        yield* sql.unsafe(`
          UPDATE git_history_repositories SET status = 'deleted', updated_at = $1
          WHERE installation_id = $2 AND artifact_id = $3
        `, [completedAt, installationId, job.artifactId]);
        yield* sql.unsafe(`
          UPDATE git_history_mappings SET status = 'deleted'
          WHERE installation_id = $1 AND artifact_id = $2
        `, [installationId, job.artifactId]);
        yield* sql.unsafe(`
          UPDATE git_history_budget_reservations
          SET state = 'released', updated_at = $1
          WHERE installation_id = $2 AND job_id IN (
            SELECT id FROM git_history_jobs
            WHERE installation_id = $2 AND artifact_id = $3
          )
        `, [completedAt, installationId, job.artifactId]);
        yield* sql.unsafe(`
          UPDATE git_history_jobs SET state = 'done', lease_expires_at = NULL,
            last_error = NULL, updated_at = $1
          WHERE installation_id = $2 AND id = $3
        `, [completedAt, installationId, job.id]);
      }));
    }));
  }

  async readGitHistoryPurgePlan(): Promise<{
    readonly alreadyDeletedRepositories: number;
    readonly enabledProjects: number;
    readonly logicalCopiedBytes: number;
    readonly repositories: number;
    readonly repositoriesToDelete: number;
  }> {
    const installationId = this.#installationId;
    const rows = await this.#database.run(Effect.gen(function*() {
      const sql = yield* SqlClient;
      return yield* sql.unsafe(`
        SELECT
          COUNT(*) AS "repositories",
          COUNT(*) FILTER (WHERE status = 'deleted')
            AS "alreadyDeletedRepositories",
          COUNT(*) FILTER (WHERE status <> 'deleted')
            AS "repositoriesToDelete",
          COALESCE((SELECT SUM(copied_bytes) FROM git_history_mappings
            WHERE installation_id = $1 AND status = 'recorded'), 0)
            AS "logicalCopiedBytes",
          (SELECT COUNT(*) FROM git_history_project_settings
            WHERE installation_id = $1 AND enabled = TRUE) AS "enabledProjects"
        FROM git_history_repositories
        WHERE installation_id = $1
      `, [installationId]);
    }));
    return gitHistoryPurgePlanRowSchema.parse(rows[0]);
  }

  async listGitHistoryRepositoriesForPurge(
    afterArtifactId: string | null,
    limit: number,
  ): Promise<readonly GitRepositoryCoordinates[]> {
    const installationId = this.#installationId;
    const rows = await this.#database.run(Effect.gen(function*() {
      const sql = yield* SqlClient;
      return yield* sql.unsafe(`
        SELECT artifact_id AS "artifactId", default_branch AS "defaultBranch",
          project_id AS "projectId", provider, remote_url AS "remoteUrl",
          repository_name AS "repositoryName", status
        FROM git_history_repositories
        WHERE installation_id = $1 AND status <> 'deleted'
          AND ($2::text IS NULL OR artifact_id > $2)
        ORDER BY artifact_id
        LIMIT $3
      `, [installationId, afterArtifactId, limit]);
    }));
    return gitHistoryRepositoryRowSchema.array().parse(rows);
  }

  async completeGitHistoryPurge(
    coordinates: GitRepositoryCoordinates,
    completedAt: string,
  ): Promise<void> {
    const installationId = this.#installationId;
    await this.#database.run(Effect.gen(function*() {
      const sql = yield* SqlClient;
      yield* sql.withTransaction(Effect.gen(function*() {
        yield* sql.unsafe(`
          UPDATE git_history_repositories SET status = 'deleted', updated_at = $1
          WHERE installation_id = $2 AND artifact_id = $3
        `, [completedAt, installationId, coordinates.artifactId]);
        yield* sql.unsafe(`
          UPDATE git_history_mappings SET status = 'deleted'
          WHERE installation_id = $1 AND artifact_id = $2
        `, [installationId, coordinates.artifactId]);
        yield* sql.unsafe(`
          UPDATE git_history_budget_reservations
          SET state = 'released', updated_at = $1
          WHERE installation_id = $2 AND job_id IN (
            SELECT id FROM git_history_jobs
            WHERE installation_id = $2 AND artifact_id = $3
          )
        `, [completedAt, installationId, coordinates.artifactId]);
        yield* sql.unsafe(`
          UPDATE git_history_jobs SET state = 'done', lease_expires_at = NULL,
            last_error = NULL, updated_at = $1
          WHERE installation_id = $2 AND artifact_id = $3
        `, [completedAt, installationId, coordinates.artifactId]);
      }));
    }));
  }

  async renameProject(command: RenameProject): Promise<ProjectRecord> {
    const installationId = this.#installationId;
    const rows = await this.#database.run(Effect.gen(function*() {
      const sql = yield* SqlClient;
      return yield* sql`UPDATE projects SET name = ${command.name}
        WHERE installation_id = ${installationId} AND id = ${command.projectId}
        RETURNING installation_id AS "installationId", id, name,
          created_at AS "createdAt", archived_at AS "archivedAt"`;
    }));
    const project = projectRowSchema.nullable().parse(rows[0] ?? null);
    if (project === null) {
      throw new ProjectNotFound({message: "The project does not exist."});
    }
    return project;
  }

  async setProjectArchive(command: SetProjectArchive): Promise<ProjectRecord> {
    const installationId = this.#installationId;
    const rows = await this.#database.run(Effect.gen(function*() {
      const sql = yield* SqlClient;
      return yield* sql`UPDATE projects SET archived_at = ${command.archivedAt}
        WHERE installation_id = ${installationId} AND id = ${command.projectId}
        RETURNING installation_id AS "installationId", id, name,
          created_at AS "createdAt", archived_at AS "archivedAt"`;
    }));
    const project = projectRowSchema.nullable().parse(rows[0] ?? null);
    if (project === null) {
      throw new ProjectNotFound({message: "The project does not exist."});
    }
    return project;
  }

  /** The owning Postgres database closes the process pool. */
  close(): void {}

  async assertPublicationSourceReady(
    source: PublicationSource,
    manifestDigest: string,
    commitTime: string,
  ): Promise<void> {
    await this.#database.run(this.#assertStagedUploadReady(
      source,
      manifestDigest,
      commitTime,
    ));
  }

  async commitNewArtifact(command: CommitNewArtifact): Promise<PublishedVersion> {
    const installationId = this.#installationId;
    return this.#database.run(Effect.gen({self: this}, function*() {
      const sql = yield* SqlClient;
      return yield* sql.withTransaction(Effect.gen({self: this}, function*() {
        yield* lockIdempotency(
          sql,
          installationId,
          command.projectId,
          command.idempotencyKey,
        );
        const replayed = yield* this.#findIdempotentResult(
          command.projectId,
          command.idempotencyKey,
          command.inputDigest,
        );
        if (replayed !== null) return replayed;
        yield* this.#assertProjectActive(command.projectId);
        yield* this.#assertStagedUploadReady(
          command.source,
          command.manifest.digest,
          command.createdAt,
        );
        yield* sql`INSERT INTO artifacts (
          installation_id, project_id, id, name, search_name, access_setting,
          current_version_id, created_at, deleted_at
        ) VALUES (
          ${installationId}, ${command.projectId}, ${command.artifactId}, ${command.name},
          ${normalizeArtifactSearchText(command.name)}, ${command.accessSetting}, NULL,
          ${command.createdAt}, NULL
        )`;
        yield* this.#replaceTags(command.artifactId, command.tags);
        yield* this.#insertVersion(
          command.projectId,
          command.artifactId,
          command.versionId,
          command.contentToken,
          command.createdAt,
          1,
          command.manifest,
          command.principalId,
        );
        yield* sql`UPDATE artifacts SET current_version_id = ${command.versionId}
          WHERE installation_id = ${installationId}
            AND project_id = ${command.projectId}
            AND id = ${command.artifactId}`;
        yield* this.#insertAction(command, "publish", command.versionId);
        yield* this.#insertIdempotency({
          accessSetting: null,
          artifactId: command.artifactId,
          createdAt: command.createdAt,
          idempotencyKey: command.idempotencyKey,
          inputDigest: command.inputDigest,
          operation: "publish",
          projectId: command.projectId,
          tagsJson: null,
          versionId: command.versionId,
        });
        yield* this.#sealStagedUpload(command.source, command.versionId);
        yield* this.#queueGitHistoryMirrorIfEnabled(
          command.projectId,
          command.artifactId,
          command.versionId,
          command.createdAt,
        );
        return yield* this.#readPublishedVersion(
          command.projectId,
          command.versionId,
          false,
        );
      }));
    }));
  }

  async commitVersion(command: CommitArtifactVersion): Promise<PublishedVersion> {
    const installationId = this.#installationId;
    return this.#database.run(Effect.gen({self: this}, function*() {
      const sql = yield* SqlClient;
      return yield* sql.withTransaction(Effect.gen({self: this}, function*() {
        yield* lockIdempotency(
          sql,
          installationId,
          command.projectId,
          command.idempotencyKey,
        );
        const replayed = yield* this.#findIdempotentResult(
          command.projectId,
          command.idempotencyKey,
          command.inputDigest,
        );
        if (replayed !== null) return replayed;
        yield* this.#assertProjectActive(command.projectId);
        yield* this.#assertStagedUploadReady(
          command.source,
          command.manifest.digest,
          command.createdAt,
        );
        const currentRows = yield* sql.unsafe<{currentVersionId: string}>(
          `SELECT current_version_id AS "currentVersionId"
           FROM artifacts
           WHERE installation_id = $1 AND project_id = $2
             AND id = $3 AND deleted_at IS NULL
           FOR UPDATE`,
          [installationId, command.projectId, command.artifactId],
        );
        const current = z.object({currentVersionId: z.string()}).nullable()
          .parse(currentRows[0] ?? null);
        if (current === null) {
          return yield* new ArtifactNotFound({message: "The artifact does not exist."});
        }
        if (current.currentVersionId !== command.expectedCurrentVersionId) {
          return yield* new PublishConflict({
            message: `The artifact moved to version ${current.currentVersionId}.`,
          });
        }
        const numberRows = yield* sql.unsafe<{nextNumber: number}>(
          `SELECT COALESCE(MAX(number), 0) + 1 AS "nextNumber"
           FROM versions WHERE installation_id = $1 AND project_id = $2
             AND artifact_id = $3`,
          [installationId, command.projectId, command.artifactId],
        );
        const {nextNumber} = z.object({nextNumber: positiveIntegerSchema})
          .parse(numberRows[0]);
        yield* this.#insertVersion(
          command.projectId,
          command.artifactId,
          command.versionId,
          command.contentToken,
          command.createdAt,
          nextNumber,
          command.manifest,
          command.principalId,
        );
        const updated = yield* sql`UPDATE artifacts
          SET current_version_id = ${command.versionId}
          WHERE installation_id = ${installationId}
            AND project_id = ${command.projectId}
            AND id = ${command.artifactId}
            AND current_version_id = ${command.expectedCurrentVersionId}
            AND deleted_at IS NULL
          RETURNING id`;
        if (updated.length !== 1) {
          return yield* new PublishConflict({
            message: "The artifact changed during publication.",
          });
        }
        yield* this.#insertAction(command, "publish", command.versionId);
        yield* this.#insertIdempotency({
          accessSetting: null,
          artifactId: command.artifactId,
          createdAt: command.createdAt,
          idempotencyKey: command.idempotencyKey,
          inputDigest: command.inputDigest,
          operation: "publish",
          projectId: command.projectId,
          tagsJson: null,
          versionId: command.versionId,
        });
        yield* this.#sealStagedUpload(command.source, command.versionId);
        yield* this.#queueGitHistoryMirrorIfEnabled(
          command.projectId,
          command.artifactId,
          command.versionId,
          command.createdAt,
        );
        return yield* this.#readPublishedVersion(
          command.projectId,
          command.versionId,
          false,
        );
      }));
    }));
  }

  async changeAccessSetting(
    command: ChangeArtifactAccessSetting,
  ): Promise<ArtifactState> {
    return this.#managementTransaction(
      command,
      "change_access",
      command.accessSetting,
      null,
      (sql) => sql`UPDATE artifacts
        SET access_setting = ${command.accessSetting}
        WHERE installation_id = ${this.#installationId}
          AND project_id = ${command.projectId}
          AND id = ${command.artifactId}
          AND current_version_id = ${command.expectedCurrentVersionId}
          AND deleted_at IS NULL
        RETURNING id`,
    );
  }

  async changeTags(command: ChangeArtifactTags): Promise<ArtifactState> {
    const installationId = this.#installationId;
    return this.#database.run(Effect.gen({self: this}, function*() {
      const sql = yield* SqlClient;
      return yield* sql.withTransaction(Effect.gen({self: this}, function*() {
        yield* lockIdempotency(
          sql,
          installationId,
          command.projectId,
          command.idempotencyKey,
        );
        const replayed = yield* this.#findIdempotentTagResult(
          command.projectId,
          command.idempotencyKey,
          command.inputDigest,
        );
        if (replayed !== null) return replayed;
        const artifact = yield* this.#readArtifact(
          command.projectId,
          command.artifactId,
          true,
        );
        yield* assertExpectedVersion(artifact, command.expectedCurrentVersionId);
        yield* this.#replaceTags(command.artifactId, command.tags);
        yield* this.#insertAction(
          command,
          artifactActionKinds.changeTags,
          command.expectedCurrentVersionId,
        );
        yield* this.#insertIdempotency({
          accessSetting: artifact.accessSetting,
          artifactId: command.artifactId,
          createdAt: command.createdAt,
          idempotencyKey: command.idempotencyKey,
          inputDigest: command.inputDigest,
          operation: "change_tags",
          projectId: command.projectId,
          tagsJson: JSON.stringify(command.tags),
          versionId: command.expectedCurrentVersionId,
        });
        return yield* this.#readArtifactState(
          command.projectId,
          command.artifactId,
          command.expectedCurrentVersionId,
          artifact.accessSetting,
          false,
          command.tags,
        );
      }));
    }));
  }

  async deleteArtifact(command: DeleteArtifact): Promise<ArtifactDeletion> {
    const installationId = this.#installationId;
    return this.#database.run(Effect.gen({self: this}, function*() {
      const sql = yield* SqlClient;
      return yield* sql.withTransaction(Effect.gen({self: this}, function*() {
        yield* lockIdempotency(
          sql,
          installationId,
          command.projectId,
          command.idempotencyKey,
        );
        const replayed = yield* this.#findIdempotentDeletion(
          command.projectId,
          command.idempotencyKey,
          command.inputDigest,
        );
        if (replayed !== null) return replayed;
        const artifact = yield* this.#readArtifact(
          command.projectId,
          command.artifactId,
          true,
        );
        yield* assertExpectedVersion(artifact, command.expectedCurrentVersionId);
        const updated = yield* sql`UPDATE artifacts
          SET deleted_at = ${command.createdAt}
          WHERE installation_id = ${installationId}
            AND project_id = ${command.projectId}
            AND id = ${command.artifactId}
            AND current_version_id = ${command.expectedCurrentVersionId}
            AND deleted_at IS NULL
          RETURNING id`;
        if (updated.length !== 1) return yield* changedDuringManagement();
        yield* this.#insertAction(
          command,
          artifactActionKinds.delete,
          command.expectedCurrentVersionId,
        );
        yield* this.#insertIdempotency({
          accessSetting: artifact.accessSetting,
          artifactId: command.artifactId,
          createdAt: command.createdAt,
          idempotencyKey: command.idempotencyKey,
          inputDigest: command.inputDigest,
          operation: "delete",
          projectId: command.projectId,
          tagsJson: null,
          versionId: command.expectedCurrentVersionId,
        });
        yield* this.#queueGitHistoryDeletionIfPresent(
          command.projectId,
          command.artifactId,
          command.createdAt,
        );
        return yield* this.#readDeletionResult(
          command.projectId,
          command.artifactId,
          false,
        );
      }));
    }));
  }

  async findArtifact(
    projectId: string,
    artifactId: string,
  ): Promise<ArtifactRecord | null> {
    return this.#database.run(this.#readArtifactOrNull(
      projectId,
      artifactId,
      false,
    ));
  }

  async findArtifactForAdministration(
    projectId: string,
    artifactId: string,
  ): Promise<ArtifactRecord | null> {
    return this.#database.run(this.#readArtifactOrNull(
      projectId,
      artifactId,
      true,
    ));
  }

  async findVersionRecord(
    projectId: string,
    artifactId: string,
    versionId: string,
  ): Promise<ArtifactVersion | null> {
    return this.#database.run(Effect.gen({self: this}, function*() {
      const version = yield* this.#readVersionOrNull(
        projectId,
        versionId,
        artifactId,
      );
      if (version === null) return null;
      return {manifest: yield* this.#readManifest(version), version};
    }));
  }

  async findCurrentVersion(
    projectId: string | null,
    artifactId: string,
  ): Promise<PublishedVersion | null> {
    const installationId = this.#installationId;
    return this.#database.run(Effect.gen({self: this}, function*() {
      const sql = yield* SqlClient;
      const rows = yield* sql.unsafe<{currentVersionId: string}>(
        `SELECT current_version_id AS "currentVersionId"
         FROM artifacts
         WHERE installation_id = $1
           AND ($2::text IS NULL OR project_id = $2)
           AND id = $3 AND deleted_at IS NULL`,
        [installationId, projectId, artifactId],
      );
      const row = z.object({currentVersionId: z.string()}).nullable()
        .parse(rows[0] ?? null);
      return row === null
        ? null
        : yield* this.#readPublishedVersion(
          projectId,
          row.currentVersionId,
          false,
        );
    }));
  }

  async listArtifactVersions(
    projectId: string,
    artifactId: string,
  ): Promise<readonly VersionRecord[]> {
    const installationId = this.#installationId;
    return this.#database.run(Effect.gen({self: this}, function*() {
      const artifact = yield* this.#readArtifactOrNull(
        projectId,
        artifactId,
        false,
      );
      if (artifact === null) return [];
      const sql = yield* SqlClient;
      const rows = yield* sql.unsafe<object>(
        `SELECT
          id,
          artifact_id AS "artifactId",
          number,
          manifest_digest AS "manifestDigest",
          entry_path AS "entryPath",
          routing_mode AS "routingMode",
          content_token AS "contentToken",
          publisher_principal_id AS "publisherPrincipalId",
          project_id AS "projectId", created_at AS "createdAt"
         FROM versions
         WHERE installation_id = $1 AND project_id = $2 AND artifact_id = $3
         ORDER BY number DESC`,
        [installationId, projectId, artifactId],
      );
      return z.array(versionRowSchema).parse(rows);
    }));
  }

  async listArtifacts(command: ListArtifacts): Promise<ArtifactPage> {
    const installationId = this.#installationId;
    return this.#database.run(Effect.gen({self: this}, function*() {
      const sql = yield* SqlClient;
      const rows = yield* sql.unsafe<object>(
        `SELECT id, project_id AS "projectId", name,
          access_setting AS "accessSetting",
          current_version_id AS "currentVersionId",
          created_at AS "createdAt", deleted_at AS "deletedAt",
          (
            SELECT COUNT(*)::int FROM versions
            WHERE versions.installation_id = artifacts.installation_id
              AND versions.project_id = artifacts.project_id
              AND versions.artifact_id = artifacts.id
          ) AS "versionCount"
         FROM artifacts
         WHERE installation_id = $1 AND project_id = $2
           AND deleted_at IS NULL
           AND ($3::text IS NULL
             OR strpos(search_name, $3) > 0
             OR EXISTS (
               SELECT 1 FROM artifact_tags searched_tags
               WHERE searched_tags.installation_id = artifacts.installation_id
                 AND searched_tags.artifact_id = artifacts.id
                 AND searched_tags.tag = $3
             ))
           AND ($4::text IS NULL OR EXISTS (
             SELECT 1 FROM artifact_tags
             WHERE artifact_tags.installation_id = artifacts.installation_id
               AND artifact_tags.artifact_id = artifacts.id
               AND artifact_tags.tag = $4
           ))
           AND ($5::text IS NULL OR created_at < $5
             OR (created_at = $5 AND id < $6))
         ORDER BY created_at DESC, id DESC
         LIMIT $7`,
        [
          installationId,
          command.projectId,
          command.search ?? null,
          command.tag,
          command.cursor?.createdAt ?? null,
          command.cursor?.id ?? null,
          command.limit + 1,
        ],
      );
      const artifacts = z.array(artifactListRowSchema).parse(rows);
      return pageFromRows(
        yield* this.#withTagsForArtifacts(artifacts),
        command.limit,
      );
    }));
  }

  /** List one bounded installation-wide page of active public-link artifacts. */
  async listPublicLinks(command: ListPublicLinks): Promise<PublicLinkInventoryPage> {
    const installationId = this.#installationId;
    return this.#database.run(Effect.gen({self: this}, function*() {
      const sql = yield* SqlClient;
      const rows = yield* sql.unsafe<object>(
        `SELECT
          artifact.id AS "artifactId",
          artifact.project_id AS "projectId",
          artifact.name AS "artifactName",
          artifact.access_setting AS "accessSetting",
          artifact.current_version_id AS "currentVersionId",
          artifact.created_at AS "artifactCreatedAt",
          artifact.deleted_at AS "artifactDeletedAt",
          project.installation_id AS "installationId",
          project.name AS "projectName",
          project.created_at AS "projectCreatedAt",
          project.archived_at AS "projectArchivedAt",
          version.id AS "versionId",
          version.number AS "versionNumber",
          version.manifest_digest AS "manifestDigest",
          version.entry_path AS "entryPath",
          version.routing_mode AS "routingMode",
          version.content_token AS "contentToken",
          version.publisher_principal_id AS "publisherPrincipalId",
          version.created_at AS "versionCreatedAt"
         FROM artifacts artifact
         INNER JOIN projects project
           ON project.installation_id = artifact.installation_id
           AND project.id = artifact.project_id
         INNER JOIN versions version
           ON version.installation_id = artifact.installation_id
           AND version.project_id = artifact.project_id
           AND version.artifact_id = artifact.id
           AND version.id = artifact.current_version_id
         WHERE artifact.installation_id = $1
           AND artifact.deleted_at IS NULL
           AND artifact.access_setting = 'public_link'
           AND ($2::text IS NULL OR artifact.created_at < $2
             OR (artifact.created_at = $2 AND artifact.id < $3))
         ORDER BY artifact.created_at DESC, artifact.id DESC
         LIMIT $4`,
        [
          installationId,
          command.cursor?.createdAt ?? null,
          command.cursor?.id ?? null,
          command.limit + 1,
        ],
      );
      const parsedRows = z.array(publicLinkInventoryRowSchema).parse(rows);
      const artifacts = yield* this.#withTagsForArtifacts(parsedRows.map((row) => ({
        accessSetting: row.accessSetting,
        createdAt: row.artifactCreatedAt,
        currentVersionId: row.currentVersionId,
        deletedAt: row.artifactDeletedAt,
        id: row.artifactId,
        name: row.artifactName,
        projectId: row.projectId,
      })));
      return publicLinkPageFromRows(parsedRows, artifacts, command.limit);
    }));
  }

  async listArtifactActions(command: ListArtifactActions): Promise<ArtifactActionPage> {
    const installationId = this.#installationId;
    return this.#database.run(Effect.gen({self: this}, function*() {
      const sql = yield* SqlClient;
      const rows = yield* sql.unsafe<object>(
        `SELECT id, project_id AS "projectId", artifact_id AS "artifactId",
          version_id AS "versionId",
          action, principal_id AS "principalId",
          authorized_by_principal_id AS "authorizedByPrincipalId",
          idempotency_key AS "idempotencyKey", created_at AS "createdAt"
         FROM actions
         WHERE installation_id = $1 AND project_id = $2 AND artifact_id = $3
           AND ($4::text IS NULL OR created_at < $4
             OR (created_at = $4 AND id < $5))
         ORDER BY created_at DESC, id DESC
         LIMIT $6`,
        [
          installationId,
          command.projectId,
          command.artifactId,
          command.cursor?.createdAt ?? null,
          command.cursor?.id ?? null,
          command.limit + 1,
        ],
      );
      return pageFromRows(
        z.array(artifactActionRowSchema).parse(rows),
        command.limit,
      );
    }));
  }

  async restoreVersion(command: RestoreArtifactVersion): Promise<ArtifactState> {
    const installationId = this.#installationId;
    return this.#database.run(Effect.gen({self: this}, function*() {
      const sql = yield* SqlClient;
      return yield* sql.withTransaction(Effect.gen({self: this}, function*() {
        yield* lockIdempotency(
          sql,
          installationId,
          command.projectId,
          command.idempotencyKey,
        );
        const replayed = yield* this.#findIdempotentManagementResult(
          command.projectId,
          "restore",
          command.idempotencyKey,
          command.inputDigest,
        );
        if (replayed !== null) return replayed;
        const artifact = yield* this.#readArtifact(
          command.projectId,
          command.artifactId,
          true,
        );
        yield* assertExpectedVersion(artifact, command.expectedCurrentVersionId);
        const restoredVersion = yield* this.#readVersionOrNull(
          command.projectId,
          command.versionId,
          command.artifactId,
        );
        if (restoredVersion === null) {
          return yield* new VersionNotFound({
            message: "The saved version does not exist on this artifact.",
          });
        }
        const updated = yield* sql`UPDATE artifacts
          SET current_version_id = ${command.versionId}
          WHERE installation_id = ${installationId}
            AND project_id = ${command.projectId}
            AND id = ${command.artifactId}
            AND current_version_id = ${command.expectedCurrentVersionId}
            AND deleted_at IS NULL
          RETURNING id`;
        if (updated.length !== 1) return yield* changedDuringManagement();
        yield* this.#insertAction(command, "restore", command.versionId);
        yield* this.#insertIdempotency({
          accessSetting: artifact.accessSetting,
          artifactId: command.artifactId,
          createdAt: command.createdAt,
          idempotencyKey: command.idempotencyKey,
          inputDigest: command.inputDigest,
          operation: "restore",
          projectId: command.projectId,
          tagsJson: null,
          versionId: command.versionId,
        });
        return yield* this.#readArtifactState(
          command.projectId,
          command.artifactId,
          command.versionId,
          artifact.accessSetting,
          false,
        );
      }));
    }));
  }

  async findIdempotentPublication(
    projectId: string,
    idempotencyKey: string,
    inputDigest: string,
  ): Promise<PublishedVersion | null> {
    return this.#database.run(this.#findIdempotentResult(
      projectId,
      idempotencyKey,
      inputDigest,
    ));
  }

  async findVersionContent(
    contentToken: string,
    requestedPath: string,
    fallback: "entry" | "none",
  ): Promise<VersionContent | null> {
    const installationId = this.#installationId;
    return this.#database.run(Effect.gen({self: this}, function*() {
      const sql = yield* SqlClient;
      const rows = yield* sql.unsafe<object>(
        `SELECT a.access_setting AS "accessSetting", a.id AS "artifactId",
          a.project_id AS "projectId",
          v.content_token AS "contentToken", v.id AS "versionId",
          e.path, e.size, e.media_type AS "mediaType", e.sha256,
          e.disposition, v.id = a.current_version_id AS "isCurrent"
         FROM versions v
         JOIN artifacts a
           ON a.installation_id = v.installation_id AND a.id = v.artifact_id
         JOIN manifest_entries e
           ON e.installation_id = v.installation_id AND e.version_id = v.id
         WHERE v.installation_id = $1 AND v.content_token = $2
           AND e.path = CASE
             WHEN $3 = '' THEN v.entry_path
             WHEN EXISTS (
               SELECT 1 FROM manifest_entries exact
               WHERE exact.installation_id = v.installation_id
                 AND exact.version_id = v.id AND exact.path = $3
             ) THEN $3
             WHEN $4 = 'entry' AND v.routing_mode = 'spa' THEN v.entry_path
             ELSE $3
           END
           AND a.deleted_at IS NULL`,
        [installationId, contentToken, requestedPath, fallback],
      );
      const parsed = versionContentRowSchema.nullable().parse(rows[0] ?? null);
      if (parsed === null) return null;
      return {
        accessSetting: parsed.accessSetting,
        artifactId: parsed.artifactId,
        contentToken: parsed.contentToken,
        entry: {
          disposition: parsed.disposition,
          mediaType: parsed.mediaType,
          path: parsed.path,
          sha256: parsed.sha256,
          size: parsed.size,
        },
        isCurrent: parsed.isCurrent,
        projectId: parsed.projectId,
        versionId: parsed.versionId,
      };
    }));
  }

  async createContentBootstrap(
    command: CreateContentBootstrap,
  ): Promise<ContentBootstrapRecord> {
    const installationId = this.#installationId;
    await this.#database.run(Effect.gen({self: this}, function*() {
      const sql = yield* SqlClient;
      yield* sql`INSERT INTO content_bootstraps (
        installation_id, project_id, token_digest, principal_id, artifact_id, version_id,
        content_token, created_at, expires_at, consumed_at
      ) VALUES (
        ${installationId}, ${command.projectId}, ${command.tokenDigest}, ${command.principalId},
        ${command.artifactId}, ${command.versionId}, ${command.contentToken},
        ${command.createdAt}, ${command.expiresAt}, NULL
      )`;
    }));
    return command;
  }

  async exchangeContentBootstrap(
    command: ExchangeContentBootstrap,
  ): Promise<ContentSessionRecord | null> {
    const installationId = this.#installationId;
    return this.#database.run(Effect.gen({self: this}, function*() {
      const sql = yield* SqlClient;
      return yield* sql.withTransaction(Effect.gen({self: this}, function*() {
        const rows = yield* sql.unsafe<object>(
          `SELECT b.token_digest AS "tokenDigest",
            b.principal_id AS "principalId", b.artifact_id AS "artifactId",
            b.project_id AS "projectId",
            b.version_id AS "versionId", b.content_token AS "contentToken",
            b.created_at AS "createdAt", b.expires_at AS "expiresAt"
           FROM content_bootstraps b
           JOIN artifacts a
             ON a.installation_id = b.installation_id AND a.id = b.artifact_id
           WHERE b.installation_id = $1 AND b.token_digest = $2
             AND b.content_token = $3 AND b.consumed_at IS NULL
             AND b.expires_at > $4 AND a.deleted_at IS NULL
           FOR UPDATE OF b`,
          [
            installationId,
            command.bootstrapTokenDigest,
            command.contentToken,
            command.exchangedAt,
          ],
        );
        const bootstrap = contentRecordRowSchema.nullable().parse(rows[0] ?? null);
        if (bootstrap === null) return null;
        const consumed = yield* sql`UPDATE content_bootstraps
          SET consumed_at = ${command.exchangedAt}
          WHERE installation_id = ${installationId}
            AND token_digest = ${command.bootstrapTokenDigest}
            AND consumed_at IS NULL
          RETURNING token_digest`;
        if (consumed.length !== 1) return null;
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
        yield* sql`INSERT INTO content_sessions (
          installation_id, project_id, token_digest, principal_id, artifact_id, version_id,
          content_token, created_at, expires_at
        ) VALUES (
          ${installationId}, ${session.projectId}, ${session.tokenDigest}, ${session.principalId},
          ${session.artifactId}, ${session.versionId}, ${session.contentToken},
          ${session.createdAt}, ${session.expiresAt}
        )`;
        return session;
      }));
    }));
  }

  async findContentSession(
    tokenDigest: string,
    contentToken: string,
    requestTime: string,
  ): Promise<ContentSessionRecord | null> {
    const installationId = this.#installationId;
    return this.#database.run(Effect.gen({self: this}, function*() {
      const sql = yield* SqlClient;
      const rows = yield* sql.unsafe<object>(
        `SELECT s.token_digest AS "tokenDigest",
          s.principal_id AS "principalId", s.artifact_id AS "artifactId",
          s.project_id AS "projectId",
          s.version_id AS "versionId", s.content_token AS "contentToken",
          s.created_at AS "createdAt", s.expires_at AS "expiresAt"
         FROM content_sessions s
         JOIN artifacts a
           ON a.installation_id = s.installation_id AND a.id = s.artifact_id
         WHERE s.installation_id = $1 AND s.token_digest = $2
           AND s.content_token = $3 AND s.expires_at > $4
           AND a.deleted_at IS NULL`,
        [installationId, tokenDigest, contentToken, requestTime],
      );
      return contentRecordRowSchema.nullable().parse(rows[0] ?? null);
    }));
  }

  async createPreviewLease(command: CreatePreviewLease): Promise<ContentSessionRecord> {
    const installationId = this.#installationId;
    await this.#database.run(Effect.gen(function*() {
      const sql = yield* SqlClient;
      yield* sql`INSERT INTO content_sessions (
        installation_id, project_id, token_digest, principal_id, artifact_id, version_id,
        content_token, created_at, expires_at
      ) VALUES (
        ${installationId}, ${command.projectId}, ${command.tokenDigest}, ${command.principalId},
        ${command.artifactId}, ${command.versionId}, ${command.contentToken},
        ${command.createdAt}, ${command.expiresAt}
      )`;
    }));
    return command;
  }

  async findPreviewLease(
    tokenDigest: string,
    requestTime: string,
  ): Promise<ContentSessionRecord | null> {
    const installationId = this.#installationId;
    return this.#database.run(Effect.gen(function*() {
      const sql = yield* SqlClient;
      const rows = yield* sql.unsafe<object>(
        `SELECT s.token_digest AS "tokenDigest",
          s.principal_id AS "principalId", s.artifact_id AS "artifactId",
          s.project_id AS "projectId", s.version_id AS "versionId",
          s.content_token AS "contentToken", s.created_at AS "createdAt",
          s.expires_at AS "expiresAt"
        FROM content_sessions s
        JOIN artifacts a
          ON a.installation_id = s.installation_id AND a.id = s.artifact_id
        WHERE s.installation_id = $1 AND s.token_digest = $2
          AND s.expires_at > $3 AND a.deleted_at IS NULL`,
        [installationId, tokenDigest, requestTime],
      );
      return contentRecordRowSchema.nullable().parse(rows[0] ?? null);
    }));
  }

  async createStagedUpload(command: CreateStagedUpload): Promise<StagedUpload> {
    const installationId = this.#installationId;
    return this.#database.run(Effect.gen({self: this}, function*() {
      const sql = yield* SqlClient;
      return yield* sql.withTransaction(Effect.gen({self: this}, function*() {
        yield* this.#assertProjectActive(command.projectId);
        yield* sql`INSERT INTO staged_uploads (
          installation_id, project_id, id, principal_id, status, manifest_digest,
          entry_path, routing_mode, created_at, expires_at, committed_version_id
        ) VALUES (
          ${installationId}, ${command.projectId}, ${command.id},
          ${command.principalId}, 'open',
          ${command.manifest.digest}, ${command.manifest.entryPath},
          ${command.manifest.routingMode}, ${command.createdAt},
          ${command.expiresAt}, NULL
        )`;
        for (const file of command.files) {
          yield* sql`INSERT INTO staged_upload_files (
            installation_id, upload_id, storage_token, path, size, media_type,
            sha256, disposition, uploaded_at
          ) VALUES (
            ${installationId}, ${command.id}, ${file.storageToken},
            ${file.entry.path}, ${file.entry.size}, ${file.entry.mediaType},
            ${file.entry.sha256}, ${file.entry.disposition}, NULL
          )`;
        }
        return yield* this.#readStagedUpload(
          command.projectId,
          command.id,
          command.principalId,
        );
      }));
    }));
  }

  async findStagedUpload(
    projectId: string,
    uploadId: string,
    principalId: string,
  ): Promise<StagedUpload | null> {
    return this.#database.run(this.#readStagedUploadOrNull(
      projectId,
      uploadId,
      principalId,
    ));
  }

  async listExpiredStagedUploads(
    expiredBefore: string,
    limit: number,
  ): Promise<readonly ExpiredStagedUpload[]> {
    const installationId = this.#installationId;
    return this.#database.run(Effect.gen(function*() {
      const sql = yield* SqlClient;
      const rows = yield* sql.unsafe<object>(`
        WITH selected AS (
          SELECT id FROM staged_uploads
          WHERE installation_id = $1 AND status = 'open' AND expires_at <= $2
          ORDER BY expires_at, id
          LIMIT $3
        )
        SELECT selected.id, file.storage_token AS "storageToken"
        FROM selected
        JOIN staged_upload_files file
          ON file.installation_id = $1 AND file.upload_id = selected.id
        ORDER BY selected.id, file.storage_token
      `, [installationId, expiredBefore, limit]);
      const grouped = new Map<string, Array<{readonly storageToken: string}>>();
      for (const row of z.array(expiredStagedUploadRowSchema).parse(rows)) {
        const files = grouped.get(row.id) ?? [];
        files.push({storageToken: row.storageToken});
        grouped.set(row.id, files);
      }
      return [...grouped].map(([id, files]) => ({files, id}));
    }));
  }

  async removeExpiredStagedUpload(
    uploadId: string,
    expiredBefore: string,
  ): Promise<boolean> {
    const installationId = this.#installationId;
    return this.#database.run(Effect.gen(function*() {
      const sql = yield* SqlClient;
      return yield* sql.withTransaction(Effect.gen(function*() {
        const selected = yield* sql`SELECT id FROM staged_uploads
          WHERE installation_id = ${installationId} AND id = ${uploadId}
            AND status = 'open' AND expires_at <= ${expiredBefore}
          FOR UPDATE`;
        if (selected.length === 0) return false;
        yield* sql`DELETE FROM staged_upload_files
          WHERE installation_id = ${installationId} AND upload_id = ${uploadId}`;
        const deleted = yield* sql`DELETE FROM staged_uploads
          WHERE installation_id = ${installationId} AND id = ${uploadId}
            AND status = 'open' AND expires_at <= ${expiredBefore}
          RETURNING id`;
        return deleted.length === 1;
      }));
    }));
  }

  async markStagedFileUploaded(
    projectId: string,
    uploadId: string,
    principalId: string,
    storageToken: string,
    uploadedAt: string,
  ): Promise<StagedUpload> {
    const installationId = this.#installationId;
    return this.#database.run(Effect.gen({self: this}, function*() {
      const sql = yield* SqlClient;
      return yield* sql.withTransaction(Effect.gen({self: this}, function*() {
        yield* this.#assertProjectActive(projectId);
        const updated = yield* sql`UPDATE staged_upload_files AS file
          SET uploaded_at = ${uploadedAt}
          FROM staged_uploads AS upload
          WHERE file.installation_id = ${installationId}
            AND file.upload_id = ${uploadId}
            AND file.storage_token = ${storageToken}
            AND upload.installation_id = file.installation_id
            AND upload.project_id = ${projectId}
            AND upload.id = file.upload_id
            AND upload.principal_id = ${principalId}
            AND upload.status = 'open'
            AND upload.expires_at > ${uploadedAt}
          RETURNING file.path`;
        if (updated.length !== 1) {
          const upload = yield* this.#readStagedUploadOrNull(
            projectId,
            uploadId,
            principalId,
          );
          if (upload === null) {
            return yield* new UploadNotFound({
              message: "The staged upload does not exist.",
            });
          }
          if (upload.status !== uploadStatuses.open) {
            return yield* new UploadClosed({
              message: "The staged upload is already committed.",
            });
          }
          if (upload.expiresAt <= uploadedAt) {
            return yield* new UploadExpired({
              message: "The staged upload has expired.",
            });
          }
          return yield* new UploadFileNotFound({
            message: "The staged upload file does not exist.",
          });
        }
        return yield* this.#readStagedUpload(projectId, uploadId, principalId);
      }));
    }));
  }

  async createThread(command: CreateCommentThread): Promise<CommentThreadCreation> {
    const installationId = this.#installationId;
    return this.#database.run(Effect.gen({self: this}, function*() {
      const sql = yield* SqlClient;
      return yield* sql.withTransaction(Effect.gen({self: this}, function*() {
        yield* lockIdempotency(
          sql,
          installationId,
          command.projectId,
          command.idempotencyKey,
        );
        const anchorJson = serializeCommentAnchor(command);
        const replayed = yield* this.#readIdempotentThreadRowOrNull(
          command.projectId,
          command.idempotencyKey,
        );
        if (replayed !== null) {
          if (
            replayed.artifactId !== command.artifactId ||
            replayed.versionId !== command.versionId ||
            replayed.path !== command.path ||
            replayed.body !== command.body ||
            replayed.anchorJson !== anchorJson
          ) {
            return yield* new IdempotencyConflict({
              message: "The idempotency key was already used with different input.",
            });
          }
          return {replayed: true, thread: commentThreadFromRow(replayed)};
        }
        yield* sql`INSERT INTO comment_threads (
          installation_id, project_id, id, artifact_id, version_id, path,
          anchor_json, body, state, author_principal_id,
          author_principal_kind, author_display_name,
          author_authorized_by_principal_id, resolved_at,
          resolved_by_principal_id, resolved_by_principal_kind,
          resolved_by_display_name, resolved_by_authorized_by_principal_id,
          idempotency_key, created_at, updated_at
        ) VALUES (
          ${installationId}, ${command.projectId}, ${command.id},
          ${command.artifactId}, ${command.versionId}, ${command.path},
          ${anchorJson}, ${command.body}, ${commentThreadStates.open},
          ${command.author.principalId}, ${command.author.principalKind},
          ${command.author.displayName},
          ${command.author.authorizedByPrincipalId},
          NULL, NULL, NULL, NULL, NULL,
          ${command.idempotencyKey}, ${command.createdAt}, ${command.createdAt}
        )`;
        const createAction = commentActionIdentity(command.id);
        yield* this.#insertAction(
          {
            actionId: createAction.actionId,
            artifactId: command.artifactId,
            authorizedByPrincipalId: command.author.authorizedByPrincipalId,
            createdAt: command.createdAt,
            idempotencyKey: createAction.idempotencyKey,
            principalId: command.author.principalId,
            projectId: command.projectId,
          },
          artifactActionKinds.commentCreate,
          command.versionId,
        );
        return {
          replayed: false,
          thread: commentThreadFromRow(yield* this.#readThreadRow(
            command.projectId,
            command.artifactId,
            command.id,
          )),
        };
      }));
    }));
  }

  async findThread(
    projectId: string,
    artifactId: string,
    threadId: string,
  ): Promise<CommentThreadRecord | null> {
    const row = await this.#database.run(
      this.#readThreadRowOrNull(projectId, artifactId, threadId),
    );
    return row === null ? null : commentThreadFromRow(row);
  }

  async findIdempotentThread(
    projectId: string,
    idempotencyKey: string,
  ): Promise<CommentThreadRecord | null> {
    const row = await this.#database.run(
      this.#readIdempotentThreadRowOrNull(projectId, idempotencyKey),
    );
    return row === null ? null : commentThreadFromRow(row);
  }

  async listThreads(command: ListCommentThreads): Promise<CommentThreadPage> {
    const installationId = this.#installationId;
    // Excluding actively dispatched threads by default is what makes a send
    // consumptive: the annotations leave every existing listing surface.
    const dispatchedPredicate =
      command.dispatched === dispatchedThreadFilters.include
        ? "TRUE"
        : command.dispatched === dispatchedThreadFilters.only
        ? "thread.dispatch_id IS NOT NULL"
        : "thread.dispatch_id IS NULL";
    return this.#database.run(Effect.gen(function*() {
      const sql = yield* SqlClient;
      const rows = yield* sql.unsafe<object>(
        `${commentThreadColumns}
         WHERE thread.installation_id = $1 AND thread.project_id = $2
           AND thread.artifact_id = $3
           AND ${dispatchedPredicate}
           AND ($4::text IS NULL OR thread.version_id = $4)
           AND ($5::text IS NULL OR thread.state = $5)
           AND ($6::text IS NULL OR thread.updated_at >= $6)
           AND ($7::text IS NULL OR thread.created_at < $7
             OR (thread.created_at = $7 AND thread.id < $8))
         ORDER BY thread.created_at DESC, thread.id DESC
         LIMIT $9`,
        [
          installationId,
          command.projectId,
          command.artifactId,
          command.versionId,
          command.state,
          command.since,
          command.cursor?.createdAt ?? null,
          command.cursor?.id ?? null,
          command.limit + 1,
        ],
      );
      return pageFromRows(
        z.array(commentThreadRowSchema).parse(rows).map(commentThreadFromRow),
        command.limit,
      );
    }));
  }

  async updateThread(command: UpdateCommentThread): Promise<CommentThreadRecord> {
    const installationId = this.#installationId;
    return this.#database.run(Effect.gen({self: this}, function*() {
      const sql = yield* SqlClient;
      return yield* sql.withTransaction(Effect.gen({self: this}, function*() {
        const row = yield* this.#readThreadRowOrNull(
          command.projectId,
          command.artifactId,
          command.threadId,
        );
        if (row === null) return yield* missingComment();
        const next = changedThreadValues(command, row);
        yield* sql`UPDATE comment_threads
          SET body = ${next.body},
            anchor_json = ${next.anchorJson},
            state = ${next.state},
            resolved_at = ${next.resolvedAt},
            resolved_by_principal_id = ${next.resolvedByPrincipalId},
            resolved_by_principal_kind = ${next.resolvedByPrincipalKind},
            resolved_by_display_name = ${next.resolvedByDisplayName},
            resolved_by_authorized_by_principal_id = ${
          next.resolvedByAuthorizedByPrincipalId
        },
            updated_at = ${command.updatedAt}
          WHERE installation_id = ${installationId} AND id = ${command.threadId}
            AND project_id = ${command.projectId}
            AND artifact_id = ${command.artifactId}`;
        // Reopening a thread returns it to the artifact surfaces. A marker
        // whose bundle already reached the agent has nothing left to hold:
        // keeping it would strand the reopened thread off every default
        // listing and refuse every later send, with no route that clears it.
        if (command.state?.state === commentThreadStates.open) {
          yield* sql`UPDATE comment_threads SET dispatch_id = NULL
            WHERE installation_id = ${installationId}
              AND id = ${command.threadId}
              AND project_id = ${command.projectId}
              AND state = ${commentThreadStates.open}
              AND dispatch_id IN (
                SELECT id FROM agent_dispatches
                WHERE installation_id = ${installationId}
                  AND state IN ('delivered', 'addressed', 'failed', 'canceled')
              )`;
        }
        const commentAction = commentActionIdentity(command.threadId);
        yield* this.#insertAction(
          {
            actionId: commentAction.actionId,
            artifactId: command.artifactId,
            authorizedByPrincipalId: command.authorizedByPrincipalId,
            createdAt: command.updatedAt,
            idempotencyKey: commentAction.idempotencyKey,
            principalId: command.principalId,
            projectId: command.projectId,
          },
          commentUpdateActionKind(command),
          row.versionId,
        );
        return commentThreadFromRow(yield* this.#readThreadRow(
          command.projectId,
          command.artifactId,
          command.threadId,
        ));
      }));
    }));
  }

  async deleteThread(command: DeleteCommentThread): Promise<CommentThreadDeletion> {
    const installationId = this.#installationId;
    return this.#database.run(Effect.gen({self: this}, function*() {
      const sql = yield* SqlClient;
      return yield* sql.withTransaction(Effect.gen({self: this}, function*() {
        const row = yield* this.#readThreadRowOrNull(
          command.projectId,
          command.artifactId,
          command.threadId,
          true,
        );
        if (row === null) return yield* missingComment();
        const dispatchRows = yield* sql.unsafe<object>(
          `SELECT dispatch.state AS "state"
           FROM comment_threads thread
           LEFT JOIN agent_dispatches dispatch
             ON dispatch.id = thread.dispatch_id
           WHERE thread.installation_id = $1 AND thread.id = $2
             AND thread.project_id = $3 AND thread.artifact_id = $4`,
          [
            installationId,
            command.threadId,
            command.projectId,
            command.artifactId,
          ],
        );
        const dispatchState = z.object({
          state: agentDispatchStateSchema.nullable(),
        }).parse(dispatchRows[0]).state;
        if (dispatchHoldsCommentThread(dispatchState)) {
          return yield* dispatchedCommentDeletionConflict();
        }
        const removedReplies = yield* sql`DELETE FROM comment_replies
          WHERE installation_id = ${installationId}
            AND thread_id = ${command.threadId}
          RETURNING id`;
        yield* sql`DELETE FROM comment_threads
          WHERE installation_id = ${installationId} AND id = ${command.threadId}
            AND project_id = ${command.projectId}
            AND artifact_id = ${command.artifactId}`;
        const commentAction = commentActionIdentity(command.threadId);
        yield* this.#insertAction(
          {
            actionId: commentAction.actionId,
            artifactId: command.artifactId,
            authorizedByPrincipalId: command.authorizedByPrincipalId,
            createdAt: command.deletedAt,
            idempotencyKey: commentAction.idempotencyKey,
            principalId: command.principalId,
            projectId: command.projectId,
          },
          artifactActionKinds.commentDelete,
          row.versionId,
        );
        return {
          deletedReplyCount: removedReplies.length,
          thread: commentThreadFromRow(row),
        };
      }));
    }));
  }

  async clearThreads(
    command: ClearCommentThreads,
  ): Promise<CommentThreadClearing> {
    const installationId = this.#installationId;
    return this.#database.run(Effect.gen({self: this}, function*() {
      const sql = yield* SqlClient;
      return yield* sql.withTransaction(Effect.gen({self: this}, function*() {
        const rows = yield* sql.unsafe<object>(
          `SELECT thread.id AS "id", thread.version_id AS "versionId",
             dispatch.state AS "dispatchState"
           FROM comment_threads thread
           LEFT JOIN agent_dispatches dispatch
             ON dispatch.id = thread.dispatch_id
           WHERE thread.installation_id = $1 AND thread.project_id = $2
             AND thread.artifact_id = $3
             AND ($4::text IS NULL OR thread.version_id = $4)
             AND ($5::text = 'all' OR thread.state = 'resolved')
           ORDER BY thread.created_at ASC, thread.id ASC
           FOR UPDATE OF thread`,
          [
            installationId,
            command.projectId,
            command.artifactId,
            command.versionId,
            command.scope,
          ],
        );
        let deleted = 0;
        let skippedDispatched = 0;
        for (const row of z.array(clearableThreadRowSchema).parse(rows)) {
          // Clearing never yanks work out from under an agent: a thread held
          // by a queued, claimed, or delivered dispatch stays, and the caller
          // learns how many did.
          if (dispatchHoldsCommentThread(row.dispatchState)) {
            skippedDispatched += 1;
            continue;
          }
          yield* sql`DELETE FROM comment_replies
            WHERE installation_id = ${installationId}
              AND thread_id = ${row.id}`;
          yield* sql`DELETE FROM comment_threads
            WHERE installation_id = ${installationId} AND id = ${row.id}
              AND project_id = ${command.projectId}
              AND artifact_id = ${command.artifactId}`;
          const commentAction = commentActionIdentity(row.id);
          yield* this.#insertAction(
            {
              actionId: commentAction.actionId,
              artifactId: command.artifactId,
              authorizedByPrincipalId: command.authorizedByPrincipalId,
              createdAt: command.clearedAt,
              idempotencyKey: commentAction.idempotencyKey,
              principalId: command.principalId,
              projectId: command.projectId,
            },
            artifactActionKinds.commentDelete,
            row.versionId,
          );
          deleted += 1;
        }
        return {deleted, skippedDispatched};
      }));
    }));
  }

  async createReply(command: CreateCommentReply): Promise<CommentReplyCreation> {
    const installationId = this.#installationId;
    return this.#database.run(Effect.gen({self: this}, function*() {
      const sql = yield* SqlClient;
      return yield* sql.withTransaction(Effect.gen({self: this}, function*() {
        yield* lockIdempotency(
          sql,
          installationId,
          command.projectId,
          command.idempotencyKey,
        );
        const replayed = yield* this.#readIdempotentReplyRowOrNull(
          command.projectId,
          command.idempotencyKey,
        );
        if (replayed !== null) {
          if (
            replayed.threadId !== command.threadId ||
            replayed.body !== command.body
          ) {
            return yield* new IdempotencyConflict({
              message: "The idempotency key was already used with different input.",
            });
          }
          return {replayed: true, reply: commentReplyFromRow(replayed)};
        }
        const inserted = yield* sql.unsafe<object>(
          `INSERT INTO comment_replies (
            installation_id, project_id, id, thread_id, body,
            author_principal_id, author_principal_kind, author_display_name,
            author_authorized_by_principal_id, idempotency_key,
            created_at, updated_at
          )
          SELECT thread.installation_id, thread.project_id, $2::text, thread.id,
            $3::text, $4::text, $5::text, $6::text, $7::text, $8::text,
            $9::text, $9::text
          FROM comment_threads thread
          WHERE thread.installation_id = $1 AND thread.id = $10
            AND thread.project_id = $11 AND thread.artifact_id = $12
            AND thread.state = 'open'
          RETURNING id`,
          [
            installationId,
            command.id,
            command.body,
            command.author.principalId,
            command.author.principalKind,
            command.author.displayName,
            command.author.authorizedByPrincipalId,
            command.idempotencyKey,
            command.createdAt,
            command.threadId,
            command.projectId,
            command.artifactId,
          ],
        );
        const thread = yield* this.#readThreadRowOrNull(
          command.projectId,
          command.artifactId,
          command.threadId,
        );
        if (thread === null) return yield* missingComment();
        if (inserted.length !== 1) {
          return yield* new CommentResolved({
            message: "The comment thread is resolved and cannot accept replies.",
          });
        }
        yield* this.#touchThread(command.threadId, command.createdAt);
        const replyAction = commentActionIdentity(command.threadId);
        yield* this.#insertAction(
          {
            actionId: replyAction.actionId,
            artifactId: command.artifactId,
            authorizedByPrincipalId: command.author.authorizedByPrincipalId,
            createdAt: command.createdAt,
            idempotencyKey: replyAction.idempotencyKey,
            principalId: command.author.principalId,
            projectId: command.projectId,
          },
          artifactActionKinds.commentReply,
          thread.versionId,
        );
        return {
          replayed: false,
          reply: commentReplyFromRow(yield* this.#readReplyRow(command.id)),
        };
      }));
    }));
  }

  async findIdempotentReply(
    projectId: string,
    idempotencyKey: string,
  ): Promise<CommentReplyRecord | null> {
    const row = await this.#database.run(
      this.#readIdempotentReplyRowOrNull(projectId, idempotencyKey),
    );
    return row === null ? null : commentReplyFromRow(row);
  }

  async listReplies(threadId: string): Promise<readonly CommentReplyRecord[]> {
    const installationId = this.#installationId;
    return this.#database.run(Effect.gen(function*() {
      const sql = yield* SqlClient;
      const rows = yield* sql.unsafe<object>(
        `${commentReplyColumns}
         WHERE reply.installation_id = $1 AND reply.thread_id = $2
         ORDER BY reply.created_at ASC, reply.id ASC`,
        [installationId, threadId],
      );
      return z.array(commentReplyRowSchema).parse(rows).map(commentReplyFromRow);
    }));
  }

  async updateReply(command: UpdateCommentReply): Promise<CommentReplyRecord> {
    const installationId = this.#installationId;
    return this.#database.run(Effect.gen({self: this}, function*() {
      const sql = yield* SqlClient;
      return yield* sql.withTransaction(Effect.gen({self: this}, function*() {
        const thread = yield* this.#requireReplyThread(command);
        yield* sql`UPDATE comment_replies
          SET body = ${command.body}, updated_at = ${command.updatedAt}
          WHERE installation_id = ${installationId} AND id = ${command.replyId}
            AND thread_id = ${command.threadId}`;
        yield* this.#touchThread(command.threadId, command.updatedAt);
        const commentAction = commentActionIdentity(command.threadId);
        yield* this.#insertAction(
          {
            actionId: commentAction.actionId,
            artifactId: command.artifactId,
            authorizedByPrincipalId: command.authorizedByPrincipalId,
            createdAt: command.updatedAt,
            idempotencyKey: commentAction.idempotencyKey,
            principalId: command.principalId,
            projectId: command.projectId,
          },
          artifactActionKinds.commentUpdate,
          thread.versionId,
        );
        return commentReplyFromRow(yield* this.#readReplyRow(command.replyId));
      }));
    }));
  }

  async deleteReply(command: DeleteCommentReply): Promise<void> {
    const installationId = this.#installationId;
    await this.#database.run(Effect.gen({self: this}, function*() {
      const sql = yield* SqlClient;
      yield* sql.withTransaction(Effect.gen({self: this}, function*() {
        const thread = yield* this.#requireReplyThread(command);
        yield* sql`DELETE FROM comment_replies
          WHERE installation_id = ${installationId} AND id = ${command.replyId}
            AND thread_id = ${command.threadId}`;
        yield* this.#touchThread(command.threadId, command.deletedAt);
        const commentAction = commentActionIdentity(command.threadId);
        yield* this.#insertAction(
          {
            actionId: commentAction.actionId,
            artifactId: command.artifactId,
            authorizedByPrincipalId: command.authorizedByPrincipalId,
            createdAt: command.deletedAt,
            idempotencyKey: commentAction.idempotencyKey,
            principalId: command.principalId,
            projectId: command.projectId,
          },
          artifactActionKinds.commentDelete,
          thread.versionId,
        );
      }));
    }));
  }

  async versionContainsPath(
    projectId: string,
    versionId: string,
    path: string,
  ): Promise<boolean> {
    const installationId = this.#installationId;
    return this.#database.run(Effect.gen(function*() {
      const sql = yield* SqlClient;
      const rows = yield* sql`SELECT 1 AS found
        FROM manifest_entries entry
        INNER JOIN versions version
          ON version.installation_id = entry.installation_id
          AND version.id = entry.version_id
        WHERE version.installation_id = ${installationId}
          AND version.project_id = ${projectId}
          AND entry.version_id = ${versionId}
          AND entry.path = ${path}`;
      return rows.length > 0;
    }));
  }


  registerAgent(command: RegisterAgent): Promise<RegisteredAgentRecord> {
    this.#assertInstallationScope(command.installationId);
    const installationId = this.#installationId;
    return this.#database.run(Effect.gen({self: this}, function*() {
      const sql = yield* SqlClient;
      return yield* sql.withTransaction(Effect.gen({self: this}, function*() {
        // The connection key upserts back into the same id, so a restarted
        // agent keeps every dispatch already queued for it. The key is scoped
        // to the registering principal, so one principal never reclaims
        // another's row, and with it another's queued dispatches.
        const upserted = yield* sql`INSERT INTO registered_agents (
            installation_id, id, connection_key, display_name, kind,
            working_directory, agent_session_id, principal_id,
            created_at, last_seen_at, capabilities_json
          ) VALUES (
            ${installationId}, ${command.id}, ${command.connectionKey},
            ${command.displayName}, ${command.kind},
            ${command.workingDirectory}, ${command.agentSessionId},
            ${command.principalId}, ${command.registeredAt},
            ${command.registeredAt}, ${JSON.stringify(command.capabilities)}
          )
          ON CONFLICT (installation_id, principal_id, connection_key)
          DO UPDATE SET
            display_name = EXCLUDED.display_name,
            kind = EXCLUDED.kind,
            working_directory = EXCLUDED.working_directory,
            agent_session_id = EXCLUDED.agent_session_id,
            last_seen_at = EXCLUDED.last_seen_at,
            capabilities_json = EXCLUDED.capabilities_json
          RETURNING id`;
        const registered = dispatchIdentityRowSchema.nullable().parse(
          upserted[0] ?? null,
        );
        if (registered === null) {
          throw new Error("The agent registration upsert returned no row.");
        }
        return yield* this.#readRegisteredAgentRow(registered.id);
      }));
    }));
  }

  async disconnectAgent(installationId: string, agentId: string): Promise<void> {
    this.#assertInstallationScope(installationId);
    await this.#database.run(Effect.gen(function*() {
      const sql = yield* SqlClient;
      yield* sql`DELETE FROM registered_agents
        WHERE installation_id = ${installationId} AND id = ${agentId}`;
    }));
  }

  async listAgents(
    installationId: string,
    now: string,
  ): Promise<readonly RegisteredAgentPresence[]> {
    this.#assertInstallationScope(installationId);
    const reapBefore = isoBefore(now, registeredAgentRetentionMilliseconds);
    return this.#database.run(Effect.gen({self: this}, function*() {
      const sql = yield* SqlClient;
      return yield* sql.withTransaction(Effect.gen({self: this}, function*() {
        // Rows are disposable liveness records: reap what stopped polling.
        yield* sql`DELETE FROM registered_agents
          WHERE installation_id = ${installationId}
            AND last_seen_at < ${reapBefore}`;
        const rows = yield* sql.unsafe<object>(
          `${registeredAgentColumns}
           WHERE agent.installation_id = $1
           ORDER BY agent.created_at ASC, agent.id ASC`,
          [installationId],
        );
        const agents = z.array(registeredAgentRowSchema).parse(rows);
        const presences: RegisteredAgentPresence[] = [];
        for (const agent of agents) {
          presences.push(yield* this.#agentPresence(agent));
        }
        return presences;
      }));
    }));
  }

  /**
   * Presence facts per spec §3.2, joined lazily at read: the working
   * dispatch is the newest claimed/delivered one whose bundle threads are
   * not all resolved, and no activity state is ever written here.
   */
  #agentPresence(
    agent: RegisteredAgentRecord,
  ): Effect.Effect<RegisteredAgentPresence, unknown, SqlClient> {
    const installationId = this.#installationId;
    return Effect.gen({self: this}, function*() {
      const sql = yield* SqlClient;
      const latestRows = yield* sql.unsafe<object>(
        `SELECT MAX(dispatch.updated_at) AS "latestAt"
         FROM agent_dispatches dispatch
         WHERE dispatch.installation_id = $1 AND dispatch.agent_id = $2`,
        [installationId, agent.id],
      );
      const latest = latestDispatchTransitionRowSchema.parse(
        latestRows[0] ?? {latestAt: null},
      );
      const candidates = z.array(workingDispatchCandidateRowSchema).parse(
        yield* sql.unsafe<object>(
          `SELECT dispatch.id AS "id",
             dispatch.thread_ids_json AS "threadIdsJson"
           FROM agent_dispatches dispatch
           WHERE dispatch.installation_id = $1 AND dispatch.agent_id = $2
             AND dispatch.state IN ('claimed', 'delivered')
           ORDER BY dispatch.updated_at DESC, dispatch.id DESC`,
          [installationId, agent.id],
        ),
      );
      let activeDispatchId: string | null = null;
      for (const candidate of candidates) {
        if (yield* this.#holdsUnresolvedThread(candidate.threadIdsJson)) {
          activeDispatchId = candidate.id;
          break;
        }
      }
      return {
        activeDispatchId,
        agent,
        latestDispatchTransitionAt: latest.latestAt,
      };
    });
  }

  #holdsUnresolvedThread(
    threadIdsJson: string,
  ): Effect.Effect<boolean, unknown, SqlClient> {
    const installationId = this.#installationId;
    return Effect.gen(function*() {
      const threadIds = threadIdsSchema.parse(JSON.parse(threadIdsJson));
      if (threadIds.length === 0) return false;
      const sql = yield* SqlClient;
      const placeholders = [...threadIds.keys()]
        .map((index) => `$${index + 2}`)
        .join(", ");
      const counted = yield* sql.unsafe<object>(
        `SELECT COUNT(*) AS "resolvedCount" FROM comment_threads thread
         WHERE thread.installation_id = $1 AND thread.state = 'resolved'
           AND thread.id IN (${placeholders})`,
        [installationId, ...threadIds],
      );
      const resolved = resolvedCountRowSchema.parse(counted[0] ?? null);
      return resolved.resolvedCount !== threadIds.length;
    });
  }

  async recordActivity(command: RecordAgentActivity): Promise<void> {
    this.#assertInstallationScope(command.installationId);
    const installationId = this.#installationId;
    await this.#database.run(Effect.gen(function*() {
      const sql = yield* SqlClient;
      // Beacons are display metadata: the newest write wins unconditionally,
      // and the read side applies TTL decay and the liveness gate.
      yield* sql`UPDATE registered_agents
        SET activity_state = ${command.state},
          activity_at = ${command.observedAt}
        WHERE installation_id = ${installationId}
          AND id = ${command.agentId}`;
    }));
  }

  async findAgent(
    installationId: string,
    agentId: string,
  ): Promise<RegisteredAgentRecord | null> {
    this.#assertInstallationScope(installationId);
    return this.#database.run(Effect.gen(function*() {
      const sql = yield* SqlClient;
      const rows = yield* sql.unsafe<object>(
        `${registeredAgentColumns}
         WHERE agent.installation_id = $1 AND agent.id = $2`,
        [installationId, agentId],
      );
      return registeredAgentRowSchema.nullable().parse(rows[0] ?? null);
    }));
  }

  createDispatch(command: CreateAgentDispatch): Promise<AgentDispatchCreation> {
    this.#assertInstallationScope(command.installationId);
    const installationId = this.#installationId;
    return this.#database.run(Effect.gen({self: this}, function*() {
      const sql = yield* SqlClient;
      return yield* sql.withTransaction(Effect.gen({self: this}, function*() {
        // The idempotency lock serializes replicas racing one send key, so a
        // replayed create reads the original row instead of colliding on it.
        yield* lockIdempotency(
          sql,
          installationId,
          command.projectId,
          command.idempotencyKey,
        );
        const threadIdsJson = JSON.stringify(command.threadIds);
        const replayed = yield* this.#readIdempotentDispatchRowOrNull(
          command.projectId,
          command.idempotencyKey,
        );
        if (replayed !== null) {
          if (
            replayed.agentId !== command.agentId ||
            replayed.threadIdsJson !== threadIdsJson ||
            replayed.note !== command.note
          ) {
            return yield* new IdempotencyConflict({
              message: "The idempotency key was already used with different input.",
            });
          }
          return {dispatch: agentDispatchFromRow(replayed), replayed: true};
        }
        // Every thread must be open and unclaimed by another dispatch inside
        // the same transaction that stamps the markers, so two concurrent
        // sends can never double-book a thread and a rejected bundle leaves
        // no partial markers behind.
        for (const threadId of command.threadIds) {
          const checked = yield* sql`SELECT
              thread.id AS "id",
              thread.state AS "state",
              thread.dispatch_id AS "dispatchId"
            FROM comment_threads thread
            WHERE thread.installation_id = ${installationId}
              AND thread.project_id = ${command.projectId}
              AND thread.id = ${threadId}
            FOR UPDATE`;
          const row = dispatchThreadCheckRowSchema.nullable().parse(
            checked[0] ?? null,
          );
          if (row === null) {
            return yield* new InvalidDispatch({
              message:
                "The bundle references a comment thread that does not exist in this project.",
            });
          }
          if (row.state !== commentThreadStates.open) {
            return yield* new InvalidDispatch({
              message: "The bundle references a comment thread that is not open.",
            });
          }
          if (row.dispatchId !== null) {
            return yield* new InvalidDispatch({
              message:
                "The bundle references a comment thread that is already dispatched.",
            });
          }
        }
        yield* sql`INSERT INTO agent_dispatches (
          installation_id, project_id, id, agent_id, agent_display_name,
          thread_ids_json, note, state, sender_principal_id,
          sender_principal_kind, sender_display_name,
          sender_authorized_by_principal_id, idempotency_key,
          claimed_at, lease_expires_at, delivered_at, addressed_at,
          failed_at, failure_reason, canceled_at, created_at, updated_at
        ) VALUES (
          ${installationId}, ${command.projectId}, ${command.id},
          ${command.agentId}, ${command.agentDisplayName}, ${threadIdsJson},
          ${command.note}, ${agentDispatchStates.queued},
          ${command.sender.principalId}, ${command.sender.principalKind},
          ${command.sender.displayName},
          ${command.sender.authorizedByPrincipalId}, ${command.idempotencyKey},
          NULL, NULL, NULL, NULL, NULL, NULL, NULL,
          ${command.createdAt}, ${command.createdAt}
        )`;
        // The marker moves the thread off the default listings, so it counts
        // as a thread edit: an incremental `since` poller must see it leave.
        for (const threadId of command.threadIds) {
          const marked = yield* sql`UPDATE comment_threads
            SET dispatch_id = ${command.id}, updated_at = ${command.createdAt}
            WHERE installation_id = ${installationId}
              AND project_id = ${command.projectId} AND id = ${threadId}
              AND state = ${commentThreadStates.open} AND dispatch_id IS NULL
            RETURNING id`;
          if (marked.length !== 1) {
            throw new Error(
              `Comment thread ${threadId} could not be marked dispatched inside its validating transaction.`,
            );
          }
        }
        return {
          dispatch: agentDispatchFromRow(yield* this.#readDispatchRow(command.id)),
          replayed: false,
        };
      }));
    }));
  }

  claimNextDispatch(
    agentId: string,
    now: string,
    bumpHeartbeat: boolean,
  ): Promise<AgentDispatchRecord | null> {
    const installationId = this.#installationId;
    const leaseExpiresAt = isoAfter(now, agentDispatchLeaseMilliseconds);
    return this.#database.run(Effect.gen({self: this}, function*() {
      const sql = yield* SqlClient;
      // A re-check inside one held poll is a pure read while nothing is
      // claimable: the request's first attempt already stamped the heartbeat,
      // so an empty mailbox must not open a write transaction every second.
      if (!bumpHeartbeat) {
        const expired = yield* sql`SELECT id FROM agent_dispatches
          WHERE installation_id = ${installationId} AND agent_id = ${agentId}
            AND state = ${agentDispatchStates.claimed}
            AND lease_expires_at < ${now}
          LIMIT 1`;
        if (expired.length === 0) {
          const active = yield* sql`SELECT id FROM agent_dispatches
            WHERE installation_id = ${installationId} AND agent_id = ${agentId}
              AND state = ${agentDispatchStates.claimed}
            LIMIT 1`;
          if (active.length > 0) return null;
          const queued = yield* sql`SELECT id FROM agent_dispatches
            WHERE installation_id = ${installationId} AND agent_id = ${agentId}
              AND state = ${agentDispatchStates.queued}
            LIMIT 1`;
          if (queued.length === 0) return null;
        }
      }
      return yield* sql.withTransaction(Effect.gen({self: this}, function*() {
        // One claim decision per agent at a time, across replicas.
        yield* lockAgentClaim(sql, installationId, agentId);
        // The poll request is the heartbeat, and every attempt that reaches
        // the write path — heartbeat or successful claim — refreshes it.
        yield* sql`UPDATE registered_agents SET last_seen_at = ${now}
          WHERE installation_id = ${installationId} AND id = ${agentId}`;
        // An expired lease returns its dispatch to the queue before the
        // oldest-queued selection, so a dead claimer never wedges the FIFO.
        yield* sql`UPDATE agent_dispatches
          SET state = ${agentDispatchStates.queued}, claimed_at = NULL,
            lease_expires_at = NULL, updated_at = ${now}
          WHERE installation_id = ${installationId} AND agent_id = ${agentId}
            AND state = ${agentDispatchStates.claimed}
            AND lease_expires_at < ${now}`;
        const active = yield* sql`SELECT id FROM agent_dispatches
          WHERE installation_id = ${installationId} AND agent_id = ${agentId}
            AND state = ${agentDispatchStates.claimed}
          LIMIT 1`;
        // One-active-claim: while a claim is held, the next claim waits.
        if (active.length > 0) return null;
        const candidates = yield* sql`SELECT id FROM agent_dispatches
          WHERE installation_id = ${installationId} AND agent_id = ${agentId}
            AND state = ${agentDispatchStates.queued}
          ORDER BY created_at ASC, id ASC
          LIMIT 1
          FOR UPDATE`;
        const oldest = dispatchIdentityRowSchema.nullable().parse(
          candidates[0] ?? null,
        );
        if (oldest === null) return null;
        const claimed = yield* sql`UPDATE agent_dispatches
          SET state = ${agentDispatchStates.claimed}, claimed_at = ${now},
            lease_expires_at = ${leaseExpiresAt}, updated_at = ${now}
          WHERE installation_id = ${installationId} AND id = ${oldest.id}
            AND state = ${agentDispatchStates.queued}
          RETURNING id`;
        if (claimed.length !== 1) return null;
        return agentDispatchFromRow(yield* this.#readDispatchRow(oldest.id));
      }));
    }));
  }

  markDelivered(command: MarkDispatchDelivered): Promise<AgentDispatchRecord> {
    this.#assertInstallationScope(command.installationId);
    const installationId = this.#installationId;
    return this.#database.run(Effect.gen({self: this}, function*() {
      const sql = yield* SqlClient;
      return yield* sql.withTransaction(Effect.gen({self: this}, function*() {
        const row = yield* this.#readDispatchRowOrNull(command.dispatchId, true);
        if (row === null) return yield* missingDispatch();
        if (row.agentId !== command.agentId) return yield* foreignClaimReport();
        if (row.state !== agentDispatchStates.claimed) {
          return yield* new DispatchStateConflict({
            message: `A ${row.state} dispatch cannot be reported delivered.`,
          });
        }
        yield* sql`UPDATE agent_dispatches
          SET state = ${agentDispatchStates.delivered},
            delivered_at = ${command.deliveredAt},
            updated_at = ${command.deliveredAt}
          WHERE installation_id = ${installationId} AND id = ${row.id}
            AND state = ${agentDispatchStates.claimed}`;
        return agentDispatchFromRow(yield* this.#readDispatchRow(row.id));
      }));
    }));
  }

  markFailed(command: MarkDispatchFailed): Promise<AgentDispatchRecord> {
    this.#assertInstallationScope(command.installationId);
    return this.#database.run(Effect.gen({self: this}, function*() {
      const sql = yield* SqlClient;
      return yield* sql.withTransaction(Effect.gen({self: this}, function*() {
        const row = yield* this.#readDispatchRowOrNull(command.dispatchId, true);
        if (row === null) return yield* missingDispatch();
        if (row.agentId !== command.agentId) return yield* foreignClaimReport();
        if (
          row.state !== agentDispatchStates.claimed &&
          row.state !== agentDispatchStates.delivered
        ) {
          return yield* new DispatchStateConflict({
            message: `A ${row.state} dispatch cannot be reported failed.`,
          });
        }
        yield* this.#failDispatch(row.id, command.reason, command.failedAt);
        return agentDispatchFromRow(yield* this.#readDispatchRow(row.id));
      }));
    }));
  }

  cancelDispatch(command: CancelAgentDispatch): Promise<AgentDispatchRecord> {
    this.#assertInstallationScope(command.installationId);
    const installationId = this.#installationId;
    return this.#database.run(Effect.gen({self: this}, function*() {
      const sql = yield* SqlClient;
      return yield* sql.withTransaction(Effect.gen({self: this}, function*() {
        const row = yield* this.#readDispatchRowOrNull(command.dispatchId, true);
        if (row === null || row.projectId !== command.projectId) {
          return yield* missingDispatch();
        }
        if (
          row.state !== agentDispatchStates.queued &&
          row.state !== agentDispatchStates.claimed
        ) {
          return yield* new DispatchStateConflict({
            message: `A ${row.state} dispatch cannot be canceled.`,
          });
        }
        // Cancellation clears the markers so the threads reappear in the
        // default listings: work is never silently lost.
        yield* sql`UPDATE agent_dispatches
          SET state = ${agentDispatchStates.canceled},
            canceled_at = ${command.canceledAt},
            updated_at = ${command.canceledAt},
            claimed_at = NULL, lease_expires_at = NULL
          WHERE installation_id = ${installationId} AND id = ${row.id}`;
        yield* this.#clearDispatchMarkers(row.id, command.canceledAt);
        return agentDispatchFromRow(yield* this.#readDispatchRow(row.id));
      }));
    }));
  }

  listDispatches(command: ListAgentDispatches): Promise<AgentDispatchPage> {
    this.#assertInstallationScope(command.installationId);
    const installationId = this.#installationId;
    return this.#database.run(Effect.gen({self: this}, function*() {
      const sql = yield* SqlClient;
      return yield* sql.withTransaction(Effect.gen({self: this}, function*() {
        yield* this.#applyLazyProjectTransitions(command.projectId, command.now);
        const rows = yield* sql.unsafe<object>(
          `${agentDispatchColumns}
           WHERE dispatch.installation_id = $1 AND dispatch.project_id = $2
             AND ($3::text IS NULL OR dispatch.state = $3)
             AND ($4::text IS NULL OR dispatch.agent_id = $4)
             AND ($5::text IS NULL OR dispatch.created_at < $5
               OR (dispatch.created_at = $5 AND dispatch.id < $6))
           ORDER BY dispatch.created_at DESC, dispatch.id DESC
           LIMIT $7`,
          [
            installationId,
            command.projectId,
            command.state,
            command.agentId,
            command.cursor?.createdAt ?? null,
            command.cursor?.id ?? null,
            command.limit + 1,
          ],
        );
        return pageFromRows(
          z.array(agentDispatchRowSchema).parse(rows).map(agentDispatchFromRow),
          command.limit,
        );
      }));
    }));
  }

  findDispatch(
    installationId: string,
    dispatchId: string,
    now: string,
  ): Promise<AgentDispatchRecord | null> {
    this.#assertInstallationScope(installationId);
    return this.#database.run(Effect.gen({self: this}, function*() {
      const sql = yield* SqlClient;
      return yield* sql.withTransaction(Effect.gen({self: this}, function*() {
        const row = yield* this.#readDispatchRowOrNull(dispatchId, true);
        if (row === null) return null;
        yield* this.#applyLazyDispatchTransitions(row, now);
        return agentDispatchFromRow(yield* this.#readDispatchRow(dispatchId));
      }));
    }));
  }

  observeAddressed(
    dispatchId: string,
    now: string,
  ): Promise<AgentDispatchRecord | null> {
    return this.#database.run(Effect.gen({self: this}, function*() {
      const sql = yield* SqlClient;
      return yield* sql.withTransaction(Effect.gen({self: this}, function*() {
        const row = yield* this.#readDispatchRowOrNull(dispatchId, true);
        if (row === null) return null;
        yield* this.#stampAddressedWhenResolved(row, now);
        return agentDispatchFromRow(yield* this.#readDispatchRow(dispatchId));
      }));
    }));
  }

  #managementTransaction(
    command: ChangeArtifactAccessSetting,
    operation: "change_access",
    accessSetting: ArtifactRecord["accessSetting"],
    tagsJson: string | null,
    mutate: (sql: SqlClient) => Effect.Effect<readonly object[], unknown>,
  ): Promise<ArtifactState> {
    const installationId = this.#installationId;
    return this.#database.run(Effect.gen({self: this}, function*() {
      const sql = yield* SqlClient;
      return yield* sql.withTransaction(Effect.gen({self: this}, function*() {
        yield* lockIdempotency(
          sql,
          installationId,
          command.projectId,
          command.idempotencyKey,
        );
        const replayed = yield* this.#findIdempotentManagementResult(
          command.projectId,
          operation,
          command.idempotencyKey,
          command.inputDigest,
        );
        if (replayed !== null) return replayed;
        const artifact = yield* this.#readArtifact(
          command.projectId,
          command.artifactId,
          true,
        );
        yield* assertExpectedVersion(artifact, command.expectedCurrentVersionId);
        const updated = yield* mutate(sql);
        if (updated.length !== 1) return yield* changedDuringManagement();
        yield* this.#insertAction(
          command,
          operation,
          command.expectedCurrentVersionId,
        );
        yield* this.#insertIdempotency({
          accessSetting,
          artifactId: command.artifactId,
          createdAt: command.createdAt,
          idempotencyKey: command.idempotencyKey,
          inputDigest: command.inputDigest,
          operation,
          projectId: command.projectId,
          tagsJson,
          versionId: command.expectedCurrentVersionId,
        });
        return yield* this.#readArtifactState(
          command.projectId,
          command.artifactId,
          command.expectedCurrentVersionId,
          accessSetting,
          false,
        );
      }));
    }));
  }

  #readProjectOrNull(
    projectId: string,
  ): Effect.Effect<ProjectRecord | null, unknown, SqlClient> {
    const installationId = this.#installationId;
    return Effect.gen(function*() {
      const sql = yield* SqlClient;
      const rows = yield* sql.unsafe<object>(
        `SELECT installation_id AS "installationId", id, name,
          created_at AS "createdAt", archived_at AS "archivedAt"
         FROM projects
         WHERE installation_id = $1 AND id = $2`,
        [installationId, projectId],
      );
      return projectRowSchema.nullable().parse(rows[0] ?? null);
    });
  }

  #assertProjectActive(
    projectId: string,
  ) {
    const installationId = this.#installationId;
    return Effect.gen(function*() {
      const sql = yield* SqlClient;
      const rows = yield* sql.unsafe<object>(
        `SELECT archived_at AS "archivedAt"
         FROM projects
         WHERE installation_id = $1 AND id = $2
         FOR SHARE`,
        [installationId, projectId],
      );
      const project = z.object({archivedAt: z.string().nullable()})
        .nullable()
        .parse(rows[0] ?? null);
      if (project === null || project.archivedAt !== null) {
        yield* new ProjectArchived({
          message: "The project is archived and cannot accept new work.",
        });
      }
    });
  }

  #readArtifact(
    projectId: string,
    artifactId: string,
    lock: boolean,
  ): Effect.Effect<ArtifactRecord, unknown, SqlClient> {
    return Effect.gen({self: this}, function*() {
      const artifact = yield* this.#readArtifactOrNull(
        projectId,
        artifactId,
        false,
        lock,
      );
      if (artifact === null) {
        return yield* new ArtifactNotFound({message: "The artifact does not exist."});
      }
      return artifact;
    });
  }

  #readArtifactOrNull(
    projectId: string,
    artifactId: string,
    includeDeleted: boolean,
    lock = false,
  ): Effect.Effect<ArtifactRecord | null, unknown, SqlClient> {
    const installationId = this.#installationId;
    return Effect.gen({self: this}, function*() {
      const sql = yield* SqlClient;
      const rows = yield* sql.unsafe<object>(
        `SELECT id, project_id AS "projectId", name,
          access_setting AS "accessSetting",
          current_version_id AS "currentVersionId",
          created_at AS "createdAt", deleted_at AS "deletedAt"
         FROM artifacts
         WHERE installation_id = $1 AND project_id = $2 AND id = $3
           ${includeDeleted ? "" : "AND deleted_at IS NULL"}
         ${lock ? "FOR UPDATE" : ""}`,
        [installationId, projectId, artifactId],
      );
      const artifact = artifactRowSchema.nullable().parse(rows[0] ?? null);
      return artifact === null
        ? null
        : {...artifact, tags: yield* this.#readTags(artifact.id)};
    });
  }

  #readTags(artifactId: string): Effect.Effect<readonly string[], unknown, SqlClient> {
    const installationId = this.#installationId;
    return Effect.gen({self: this}, function*() {
      const sql = yield* SqlClient;
      const rows = yield* sql.unsafe<object>(
        `SELECT artifact_id AS "artifactId", tag
         FROM artifact_tags
         WHERE installation_id = $1 AND artifact_id = $2
         ORDER BY tag`,
        [installationId, artifactId],
      );
      return z.array(artifactTagRowSchema).parse(rows).map((row) => row.tag);
    });
  }

  #withTagsForArtifacts<Artifact extends z.infer<typeof artifactRowSchema>>(
    artifacts: readonly Artifact[],
  ): Effect.Effect<
    readonly (Artifact & Pick<ArtifactRecord, "tags">)[],
    unknown,
    SqlClient
  > {
    const installationId = this.#installationId;
    return Effect.gen({self: this}, function*() {
      if (artifacts.length === 0) return [];
      const sql = yield* SqlClient;
      const rows = yield* sql.unsafe<object>(
        `SELECT artifact_id AS "artifactId", tag
         FROM artifact_tags
         WHERE installation_id = $1 AND artifact_id = ANY($2::text[])
         ORDER BY artifact_id, tag`,
        [installationId, artifacts.map(({id}) => id)],
      );
      const tagsByArtifact = new Map<string, string[]>();
      for (const artifact of artifacts) tagsByArtifact.set(artifact.id, []);
      for (const row of z.array(artifactTagRowSchema).parse(rows)) {
        tagsByArtifact.get(row.artifactId)?.push(row.tag);
      }
      return artifacts.map((artifact) => ({
        ...artifact,
        tags: tagsByArtifact.get(artifact.id) ?? [],
      }));
    });
  }

  #replaceTags(
    artifactId: string,
    tags: readonly string[],
  ): Effect.Effect<void, unknown, SqlClient> {
    const installationId = this.#installationId;
    return Effect.gen({self: this}, function*() {
      const sql = yield* SqlClient;
      yield* sql`DELETE FROM artifact_tags
        WHERE installation_id = ${installationId} AND artifact_id = ${artifactId}`;
      for (const tag of tags) {
        yield* sql`INSERT INTO artifact_tags (
          installation_id, artifact_id, tag
        ) VALUES (${installationId}, ${artifactId}, ${tag})`;
      }
    });
  }

  #readVersionOrNull(
    projectId: string,
    versionId: string,
    artifactId: string,
  ): Effect.Effect<VersionRecord | null, unknown, SqlClient> {
    const installationId = this.#installationId;
    return Effect.gen({self: this}, function*() {
      const sql = yield* SqlClient;
      const rows = yield* sql.unsafe<object>(
        `SELECT id, artifact_id AS "artifactId", number,
          manifest_digest AS "manifestDigest", entry_path AS "entryPath",
          routing_mode AS "routingMode", content_token AS "contentToken",
          publisher_principal_id AS "publisherPrincipalId",
          project_id AS "projectId", created_at AS "createdAt"
         FROM versions
         WHERE installation_id = $1 AND project_id = $2
           AND id = $3 AND artifact_id = $4`,
        [installationId, projectId, versionId, artifactId],
      );
      return versionRowSchema.nullable().parse(rows[0] ?? null);
    });
  }

  #readManifest(
    version: VersionRecord,
  ): Effect.Effect<ArtifactVersion["manifest"], unknown, SqlClient> {
    const installationId = this.#installationId;
    return Effect.gen({self: this}, function*() {
      const sql = yield* SqlClient;
      const rows = yield* sql.unsafe<object>(
        `SELECT path, size, media_type AS "mediaType", sha256, disposition
         FROM manifest_entries
         WHERE installation_id = $1 AND version_id = $2
         ORDER BY path`,
        [installationId, version.id],
      );
      const storedEntries = z.array(storedManifestEntryRowSchema).parse(rows);
      const manifest = createManifest({
        entryPath: version.entryPath,
        files: storedEntries.map(({mediaType, path, sha256, size}) => ({
          mediaType,
          path,
          sha256,
          size,
        })),
        routingMode: version.routingMode,
      });
      if (manifest.digest !== version.manifestDigest) {
        throw new Error(
          `Saved version ${version.id} has an invalid manifest digest.`,
        );
      }
      const canonicalByPath = new Map(
        manifest.entries.map((entry) => [entry.path, entry] as const),
      );
      for (const stored of storedEntries) {
        if (canonicalByPath.get(stored.path)?.disposition !== stored.disposition) {
          throw new Error(
            `Saved version ${version.id} has invalid serving metadata.`,
          );
        }
      }
      return manifest;
    });
  }

  #readPublishedVersion(
    projectId: string | null,
    versionId: string,
    replayed: boolean,
  ): Effect.Effect<PublishedVersion, unknown, SqlClient> {
    const installationId = this.#installationId;
    return Effect.gen({self: this}, function*() {
      const sql = yield* SqlClient;
      const rows = yield* sql.unsafe<object>(
        `SELECT a.id AS "artifactId", a.name AS "artifactName",
          a.project_id AS "projectId",
          a.access_setting AS "accessSetting",
          a.current_version_id AS "currentVersionId",
          a.created_at AS "artifactCreatedAt", a.deleted_at AS "artifactDeletedAt",
          v.id AS "versionId", v.number AS "versionNumber",
          v.manifest_digest AS "manifestDigest", v.entry_path AS "entryPath",
          v.routing_mode AS "routingMode", v.content_token AS "contentToken",
          v.publisher_principal_id AS "publisherPrincipalId",
          v.created_at AS "versionCreatedAt"
         FROM versions v
         JOIN artifacts a
           ON a.installation_id = v.installation_id AND a.id = v.artifact_id
         WHERE v.installation_id = $1
           AND ($2::text IS NULL OR v.project_id = $2)
           AND v.id = $3 AND a.deleted_at IS NULL`,
        [installationId, projectId, versionId],
      );
      const parsed = publishedRowSchema.parse(rows[0]);
      return {
        artifact: {
          accessSetting: parsed.accessSetting,
          createdAt: parsed.artifactCreatedAt,
          currentVersionId: parsed.currentVersionId,
          deletedAt: parsed.artifactDeletedAt,
          id: parsed.artifactId,
          name: parsed.artifactName,
          projectId: parsed.projectId,
          tags: yield* this.#readTags(parsed.artifactId),
        },
        replayed,
        version: {
          artifactId: parsed.artifactId,
          contentToken: parsed.contentToken,
          createdAt: parsed.versionCreatedAt,
          entryPath: parsed.entryPath,
          id: parsed.versionId,
          manifestDigest: parsed.manifestDigest,
          number: parsed.versionNumber,
          publisherPrincipalId: parsed.publisherPrincipalId,
          projectId: parsed.projectId,
          routingMode: parsed.routingMode,
        },
      };
    });
  }

  #findIdempotency(
    projectId: string,
    idempotencyKey: string,
  ): Effect.Effect<z.infer<typeof idempotencyRowSchema> | null, unknown, SqlClient> {
    const installationId = this.#installationId;
    return Effect.gen({self: this}, function*() {
      const sql = yield* SqlClient;
      const rows = yield* sql.unsafe<object>(
        `SELECT access_setting AS "accessSetting", artifact_id AS "artifactId",
          input_digest AS "inputDigest", operation, tags_json AS "tagsJson",
          version_id AS "versionId"
         FROM idempotency_records
         WHERE installation_id = $1 AND project_id = $2
           AND idempotency_key = $3`,
        [installationId, projectId, idempotencyKey],
      );
      return idempotencyRowSchema.nullable().parse(rows[0] ?? null);
    });
  }

  #findIdempotentResult(
    projectId: string,
    idempotencyKey: string,
    inputDigest: string,
  ): Effect.Effect<PublishedVersion | null, unknown, SqlClient> {
    return Effect.gen({self: this}, function*() {
      const parsed = yield* this.#findIdempotency(projectId, idempotencyKey);
      if (parsed === null) return null;
      if (parsed.inputDigest !== inputDigest || parsed.operation !== "publish") {
        return yield* new IdempotencyConflict({
          message: "The idempotency key was already used with different input.",
        });
      }
      return yield* this.#readPublishedVersion(projectId, parsed.versionId, true);
    });
  }

  #findIdempotentManagementResult(
    projectId: string,
    operation: "change_access" | "restore",
    idempotencyKey: string,
    inputDigest: string,
  ): Effect.Effect<ArtifactState | null, unknown, SqlClient> {
    return Effect.gen({self: this}, function*() {
      const parsed = yield* this.#findIdempotency(projectId, idempotencyKey);
      if (parsed === null) return null;
      if (
        parsed.inputDigest !== inputDigest ||
        parsed.operation !== operation ||
        parsed.accessSetting === null
      ) {
        return yield* new IdempotencyConflict({
          message: "The idempotency key was already used with different input.",
        });
      }
      return yield* this.#readArtifactState(
        projectId,
        parsed.artifactId,
        parsed.versionId,
        parsed.accessSetting,
        true,
      );
    });
  }

  #findIdempotentTagResult(
    projectId: string,
    idempotencyKey: string,
    inputDigest: string,
  ): Effect.Effect<ArtifactState | null, unknown, SqlClient> {
    return Effect.gen({self: this}, function*() {
      const parsed = yield* this.#findIdempotency(projectId, idempotencyKey);
      if (parsed === null) return null;
      if (
        parsed.inputDigest !== inputDigest ||
        parsed.operation !== "change_tags" ||
        parsed.accessSetting === null ||
        parsed.tagsJson === null
      ) {
        return yield* new IdempotencyConflict({
          message: "The idempotency key was already used with different input.",
        });
      }
      const decoded: unknown = JSON.parse(parsed.tagsJson);
      const tags = z.array(z.string()).parse(decoded);
      return yield* this.#readArtifactState(
        projectId,
        parsed.artifactId,
        parsed.versionId,
        parsed.accessSetting,
        true,
        tags,
      );
    });
  }

  #findIdempotentDeletion(
    projectId: string,
    idempotencyKey: string,
    inputDigest: string,
  ): Effect.Effect<ArtifactDeletion | null, unknown, SqlClient> {
    return Effect.gen({self: this}, function*() {
      const parsed = yield* this.#findIdempotency(projectId, idempotencyKey);
      if (parsed === null) return null;
      if (parsed.inputDigest !== inputDigest || parsed.operation !== "delete") {
        return yield* new IdempotencyConflict({
          message: "The idempotency key was already used with different input.",
        });
      }
      return yield* this.#readDeletionResult(projectId, parsed.artifactId, true);
    });
  }

  #readArtifactState(
    projectId: string,
    artifactId: string,
    versionId: string,
    accessSetting: ArtifactRecord["accessSetting"],
    replayed: boolean,
    tags: readonly string[] | null = null,
  ): Effect.Effect<ArtifactState, unknown, SqlClient> {
    return Effect.gen({self: this}, function*() {
      const artifact = yield* this.#readArtifact(projectId, artifactId, false);
      const version = yield* this.#readVersionOrNull(
        projectId,
        versionId,
        artifactId,
      );
      if (version === null) {
        throw new Error(`Artifact state references missing version ${versionId}.`);
      }
      return {
        artifact: {
          ...artifact,
          accessSetting,
          currentVersionId: versionId,
          tags: tags ?? artifact.tags,
        },
        replayed,
        version,
      };
    });
  }

  #readDeletionResult(
    projectId: string,
    artifactId: string,
    replayed: boolean,
  ): Effect.Effect<ArtifactDeletion, unknown, SqlClient> {
    const installationId = this.#installationId;
    return Effect.gen({self: this}, function*() {
      const artifact = yield* this.#readArtifactOrNull(
        projectId,
        artifactId,
        true,
      );
      if (artifact === null || artifact.deletedAt === null) {
        throw new Error(`Artifact ${artifactId} has no persisted tombstone.`);
      }
      const sql = yield* SqlClient;
      const rows = yield* sql.unsafe<{retainedVersionCount: number}>(
        `SELECT COUNT(*) AS "retainedVersionCount"
         FROM versions WHERE installation_id = $1 AND project_id = $2
           AND artifact_id = $3`,
        [installationId, projectId, artifactId],
      );
      const {retainedVersionCount} = z.object({
        retainedVersionCount: nonnegativeIntegerSchema,
      }).parse(rows[0]);
      const tombstone: ArtifactTombstone = {
        ...artifact,
        deletedAt: artifact.deletedAt,
      };
      return {artifact: tombstone, replayed, retainedVersionCount};
    });
  }

  #insertVersion(
    projectId: string,
    artifactId: string,
    versionId: string,
    contentToken: string,
    createdAt: string,
    number: number,
    manifest: CommitNewArtifact["manifest"],
    publisherPrincipalId: string,
  ): Effect.Effect<void, unknown, SqlClient> {
    const installationId = this.#installationId;
    return Effect.gen({self: this}, function*() {
      const sql = yield* SqlClient;
      yield* sql`INSERT INTO versions (
        installation_id, project_id, id, artifact_id, number, manifest_digest, entry_path,
        routing_mode, content_token, publisher_principal_id, created_at
      ) VALUES (
        ${installationId}, ${projectId}, ${versionId}, ${artifactId}, ${number},
        ${manifest.digest}, ${manifest.entryPath}, ${manifest.routingMode},
        ${contentToken}, ${publisherPrincipalId}, ${createdAt}
      )`;
      for (const entry of manifest.entries) {
        yield* sql`INSERT INTO manifest_entries (
          installation_id, version_id, path, size, media_type, sha256, disposition
        ) VALUES (
          ${installationId}, ${versionId}, ${entry.path}, ${entry.size},
          ${entry.mediaType}, ${entry.sha256}, ${entry.disposition}
        )`;
      }
    });
  }

  #insertAction(
    command: {
      readonly actionId?: string | undefined;
      readonly artifactId: string;
      readonly authorizedByPrincipalId: string | null;
      readonly createdAt: string;
      readonly idempotencyKey: string;
      readonly principalId: string;
      readonly projectId: string;
    },
    action: ArtifactActionRecord["action"],
    versionId: string,
  ): Effect.Effect<void, unknown, SqlClient> {
    const installationId = this.#installationId;
    const actionId = command.actionId ?? null;
    return Effect.gen({self: this}, function*() {
      const sql = yield* SqlClient;
      yield* sql`INSERT INTO actions (
        installation_id, project_id, id, artifact_id, version_id, action, principal_id,
        authorized_by_principal_id, idempotency_key, created_at
      ) VALUES (
        ${installationId}, ${command.projectId},
        COALESCE(${actionId}::text, gen_random_uuid()::text),
        ${command.artifactId}, ${versionId}, ${action}, ${command.principalId},
        ${command.authorizedByPrincipalId}, ${command.idempotencyKey},
        ${command.createdAt}
      )`;
    });
  }

  #insertIdempotency(record: {
    readonly accessSetting: ArtifactRecord["accessSetting"] | null;
    readonly artifactId: string;
    readonly createdAt: string;
    readonly idempotencyKey: string;
    readonly inputDigest: string;
    readonly operation: z.infer<typeof idempotencyRowSchema>["operation"];
    readonly projectId: string;
    readonly tagsJson: string | null;
    readonly versionId: string;
  }): Effect.Effect<void, unknown, SqlClient> {
    const installationId = this.#installationId;
    return Effect.gen({self: this}, function*() {
      const sql = yield* SqlClient;
      yield* sql`INSERT INTO idempotency_records (
        installation_id, project_id, idempotency_key, input_digest, artifact_id, version_id,
        operation, access_setting, tags_json, created_at
      ) VALUES (
        ${installationId}, ${record.projectId}, ${record.idempotencyKey},
        ${record.inputDigest},
        ${record.artifactId}, ${record.versionId}, ${record.operation},
        ${record.accessSetting}, ${record.tagsJson}, ${record.createdAt}
      )`;
    });
  }

  #assertStagedUploadReady(
    source: PublicationSource,
    manifestDigest: string,
    commitTime: string,
  ): Effect.Effect<void, unknown, SqlClient> {
    const installationId = this.#installationId;
    return Effect.gen({self: this}, function*() {
      const sql = yield* SqlClient;
      const uploadRows = yield* sql.unsafe<object>(
        `SELECT status, expires_at AS "expiresAt",
          manifest_digest AS "manifestDigest"
         FROM staged_uploads
         WHERE installation_id = $1 AND project_id = $2
           AND id = $3 AND principal_id = $4
         FOR UPDATE`,
        [installationId, source.projectId, source.uploadId, source.principalId],
      );
      const uploadRow = z.object({
        expiresAt: z.string(),
        manifestDigest: z.string(),
        status: uploadStatusSchema,
      }).nullable().parse(uploadRows[0] ?? null);
      if (uploadRow === null) {
        return yield* new UploadNotFound({
          message: "The staged upload does not exist.",
        });
      }
      const countRows = yield* sql.unsafe<object>(
        `SELECT COUNT(*) AS "fileCount",
          COUNT(*) FILTER (WHERE uploaded_at IS NOT NULL) AS "readyCount"
         FROM staged_upload_files
         WHERE installation_id = $1 AND upload_id = $2`,
        [installationId, source.uploadId],
      );
      const counts = z.object({
        fileCount: nonnegativeIntegerSchema,
        readyCount: nonnegativeIntegerSchema,
      }).parse(countRows[0]);
      const upload = stagedUploadCommitRowSchema.parse({
        ...uploadRow,
        ...counts,
      });
      if (upload.status !== uploadStatuses.open) {
        return yield* new UploadClosed({
          message: "The staged upload is already committed.",
        });
      }
      if (upload.expiresAt <= commitTime) {
        return yield* new UploadExpired({message: "The staged upload has expired."});
      }
      if (
        upload.fileCount === 0 ||
        upload.readyCount !== upload.fileCount ||
        upload.manifestDigest !== manifestDigest
      ) {
        return yield* new UploadIncomplete({
          message: "Every declared upload file must be verified before commit.",
        });
      }
      return undefined;
    });
  }

  #sealStagedUpload(
    source: PublicationSource,
    versionId: string,
  ): Effect.Effect<void, unknown, SqlClient> {
    const installationId = this.#installationId;
    return Effect.gen({self: this}, function*() {
      const sql = yield* SqlClient;
      const updated = yield* sql`UPDATE staged_uploads
        SET status = 'committed', committed_version_id = ${versionId}
        WHERE installation_id = ${installationId}
          AND project_id = ${source.projectId}
          AND id = ${source.uploadId}
          AND principal_id = ${source.principalId}
          AND status = 'open'
        RETURNING id`;
      if (updated.length !== 1) {
        return yield* new UploadClosed({
          message: "The staged upload changed during commit.",
        });
      }
      return undefined;
    });
  }

  #readStagedUpload(
    projectId: string,
    uploadId: string,
    principalId: string,
  ): Effect.Effect<StagedUpload, unknown, SqlClient> {
    return Effect.gen({self: this}, function*() {
      const upload = yield* this.#readStagedUploadOrNull(
        projectId,
        uploadId,
        principalId,
      );
      if (upload === null) {
        throw new Error(
          `Staged upload ${uploadId} was not found after a successful write.`,
        );
      }
      return upload;
    });
  }

  #readStagedUploadOrNull(
    projectId: string,
    uploadId: string,
    principalId: string,
  ): Effect.Effect<StagedUpload | null, unknown, SqlClient> {
    const installationId = this.#installationId;
    return Effect.gen({self: this}, function*() {
      const sql = yield* SqlClient;
      const headerRows = yield* sql.unsafe<object>(
        `SELECT id, project_id AS "projectId", principal_id AS "principalId", status,
          manifest_digest AS "manifestDigest", entry_path AS "entryPath",
          routing_mode AS "routingMode", created_at AS "createdAt",
          expires_at AS "expiresAt", committed_version_id AS "committedVersionId"
         FROM staged_uploads
         WHERE installation_id = $1 AND project_id = $2
           AND id = $3 AND principal_id = $4`,
        [installationId, projectId, uploadId, principalId],
      );
      const header = stagedUploadRowSchema.nullable().parse(headerRows[0] ?? null);
      if (header === null) return null;
      const fileRows = yield* sql.unsafe<object>(
        `SELECT storage_token AS "storageToken", path, size,
          media_type AS "mediaType", sha256, disposition,
          uploaded_at AS "uploadedAt"
         FROM staged_upload_files
         WHERE installation_id = $1 AND upload_id = $2
         ORDER BY path`,
        [installationId, uploadId],
      );
      const parsedFiles = z.array(stagedUploadFileRowSchema).parse(fileRows);
      const manifest = createManifest({
        entryPath: header.entryPath,
        files: parsedFiles.map(({mediaType, path, sha256, size}) => ({
          mediaType,
          path,
          sha256,
          size,
        })),
        routingMode: header.routingMode,
      });
      if (manifest.digest !== header.manifestDigest) {
        throw new Error(
          `Staged upload ${uploadId} has an invalid persisted manifest digest.`,
        );
      }
      const manifestByPath = new Map(
        manifest.entries.map((entry) => [entry.path, entry] as const),
      );
      const files: readonly StagedUploadFile[] = parsedFiles.map((file) => {
        const entry = manifestByPath.get(file.path);
        if (entry === undefined || entry.disposition !== file.disposition) {
          throw new Error(
            `Staged upload ${uploadId} has invalid persisted file metadata.`,
          );
        }
        return {
          entry,
          storageToken: file.storageToken,
          uploadedAt: file.uploadedAt,
        };
      });
      const common = {
        createdAt: header.createdAt,
        expiresAt: header.expiresAt,
        files,
        id: header.id,
        manifest,
        principalId: header.principalId,
        projectId: header.projectId,
      };
      if (header.status === uploadStatuses.open) {
        return {
          ...common,
          committedVersionId: null,
          status: uploadStatuses.open,
        };
      }
      if (header.committedVersionId === null) {
        throw new Error(`Committed staged upload ${uploadId} has no version.`);
      }
      return {
        ...common,
        committedVersionId: header.committedVersionId,
        status: uploadStatuses.committed,
      };
    });
  }
  #requireReplyThread(
    command: DeleteCommentReply | UpdateCommentReply,
  ): Effect.Effect<z.infer<typeof commentThreadRowSchema>, unknown, SqlClient> {
    const installationId = this.#installationId;
    return Effect.gen({self: this}, function*() {
      const sql = yield* SqlClient;
      const thread = yield* this.#readThreadRowOrNull(
        command.projectId,
        command.artifactId,
        command.threadId,
      );
      if (thread === null) return yield* missingComment();
      const replyRows = yield* sql`SELECT id FROM comment_replies
        WHERE installation_id = ${installationId} AND id = ${command.replyId}
          AND thread_id = ${command.threadId}`;
      if (replyRows.length === 0) return yield* missingComment();
      return thread;
    });
  }

  #touchThread(
    threadId: string,
    updatedAt: string,
  ): Effect.Effect<void, unknown, SqlClient> {
    const installationId = this.#installationId;
    return Effect.gen(function*() {
      const sql = yield* SqlClient;
      yield* sql`UPDATE comment_threads SET updated_at = ${updatedAt}
        WHERE installation_id = ${installationId} AND id = ${threadId}`;
    });
  }

  #readThreadRow(
    projectId: string,
    artifactId: string,
    threadId: string,
  ): Effect.Effect<z.infer<typeof commentThreadRowSchema>, unknown, SqlClient> {
    return Effect.gen({self: this}, function*() {
      const row = yield* this.#readThreadRowOrNull(
        projectId,
        artifactId,
        threadId,
      );
      if (row === null) {
        throw new Error(
          `Comment thread ${threadId} was not found after a successful write.`,
        );
      }
      return row;
    });
  }

  #readThreadRowOrNull(
    projectId: string,
    artifactId: string,
    threadId: string,
    lock = false,
  ): Effect.Effect<
    z.infer<typeof commentThreadRowSchema> | null,
    unknown,
    SqlClient
  > {
    const installationId = this.#installationId;
    return Effect.gen(function*() {
      const sql = yield* SqlClient;
      const rows = yield* sql.unsafe<object>(
        `${commentThreadColumns}
         WHERE thread.installation_id = $1 AND thread.id = $2
           AND thread.project_id = $3 AND thread.artifact_id = $4
         ${lock ? "FOR UPDATE OF thread" : ""}`,
        [installationId, threadId, projectId, artifactId],
      );
      return commentThreadRowSchema.nullable().parse(rows[0] ?? null);
    });
  }

  #readIdempotentThreadRowOrNull(
    projectId: string,
    idempotencyKey: string,
  ): Effect.Effect<
    z.infer<typeof commentThreadRowSchema> | null,
    unknown,
    SqlClient
  > {
    const installationId = this.#installationId;
    return Effect.gen(function*() {
      const sql = yield* SqlClient;
      const rows = yield* sql.unsafe<object>(
        `${commentThreadColumns}
         WHERE thread.installation_id = $1 AND thread.project_id = $2
           AND thread.idempotency_key = $3`,
        [installationId, projectId, idempotencyKey],
      );
      return commentThreadRowSchema.nullable().parse(rows[0] ?? null);
    });
  }

  #readReplyRow(
    replyId: string,
  ): Effect.Effect<z.infer<typeof commentReplyRowSchema>, unknown, SqlClient> {
    const installationId = this.#installationId;
    return Effect.gen(function*() {
      const sql = yield* SqlClient;
      const rows = yield* sql.unsafe<object>(
        `${commentReplyColumns}
         WHERE reply.installation_id = $1 AND reply.id = $2`,
        [installationId, replyId],
      );
      const reply = commentReplyRowSchema.nullable().parse(rows[0] ?? null);
      if (reply === null) {
        throw new Error(
          `Comment reply ${replyId} was not found after a successful write.`,
        );
      }
      return reply;
    });
  }

  #readIdempotentReplyRowOrNull(
    projectId: string,
    idempotencyKey: string,
  ): Effect.Effect<
    z.infer<typeof commentReplyRowSchema> | null,
    unknown,
    SqlClient
  > {
    const installationId = this.#installationId;
    return Effect.gen(function*() {
      const sql = yield* SqlClient;
      const rows = yield* sql.unsafe<object>(
        `${commentReplyColumns}
         WHERE reply.installation_id = $1 AND reply.project_id = $2
           AND reply.idempotency_key = $3`,
        [installationId, projectId, idempotencyKey],
      );
      return commentReplyRowSchema.nullable().parse(rows[0] ?? null);
    });
  }

  /** A caller-selected installation never widens this repository's scope. */
  #assertInstallationScope(installationId: string): void {
    if (installationId === this.#installationId) return;
    throw new AgentDispatchNotFound({
      message: "The installation is not served by this repository.",
    });
  }

  #queueGitHistoryMirrorIfEnabled(
    projectId: string,
    artifactId: string,
    versionId: string,
    createdAt: string,
  ): Effect.Effect<void, unknown, SqlClient> {
    const installationId = this.#installationId;
    return Effect.gen({self: this}, function*() {
      const sql = yield* SqlClient;
      const rows = yield* sql.unsafe<object>(`
        SELECT file_copy_limit_bytes AS "fileCopyBytes",
          version_copy_limit_bytes AS "versionCopyBytes",
          maximum_copied_files AS "maximumCopiedFiles",
          storage_budget_bytes AS "storageBudgetBytes"
        FROM git_history_project_settings
        WHERE installation_id = $1 AND project_id = $2 AND enabled = TRUE
      `, [installationId, projectId]);
      const limits = z.object({
        fileCopyBytes: nonnegativeIntegerSchema,
        maximumCopiedFiles: positiveIntegerSchema,
        storageBudgetBytes: nonnegativeIntegerSchema.nullable(),
        versionCopyBytes: nonnegativeIntegerSchema,
      }).nullable().parse(rows[0] ?? null);
      if (limits === null) return;
      yield* this.#insertGitHistoryMirrorJob(
        projectId,
        artifactId,
        versionId,
        createdAt,
        {
          fileCopyBytes: limits.fileCopyBytes,
          logicalCopiedBytes: 0,
          logicalReservedBytes: 0,
          storageBudgetBytes: limits.storageBudgetBytes,
          versionCopyBytes: limits.versionCopyBytes,
        },
        limits.maximumCopiedFiles,
      );
    });
  }

  #insertGitHistoryMirrorJob(
    projectId: string,
    artifactId: string,
    versionId: string,
    createdAt: string,
    limits: StoreProjectGitHistorySetting["limits"],
    maximumCopiedFiles: number,
  ): Effect.Effect<void, unknown, SqlClient> {
    const installationId = this.#installationId;
    return Effect.gen(function*() {
      const sql = yield* SqlClient;
      yield* sql.unsafe(`
        INSERT INTO git_history_jobs (
          installation_id, id, project_id, artifact_id, version_id,
          kind, state, attempts, file_copy_limit_bytes,
          version_copy_limit_bytes, maximum_copied_files,
          storage_budget_bytes, copy_policy_digest, lease_expires_at,
          available_at, last_error, created_at, updated_at
        ) VALUES ($1, $2, $3, $4, $5, 'mirror-version', 'queued', 0,
          $6, $7, $8, $9, $10, NULL, $11, NULL, $11, $11)
        ON CONFLICT (installation_id, id) DO NOTHING
      `, [
        installationId,
        gitHistoryJobId(gitHistoryJobKinds.mirrorVersion, artifactId, versionId),
        projectId,
        artifactId,
        versionId,
        limits.fileCopyBytes,
        limits.versionCopyBytes,
        maximumCopiedFiles,
        limits.storageBudgetBytes,
        gitHistoryCopyPolicyDigest(limits, maximumCopiedFiles),
        createdAt,
      ]);
    });
  }

  #queueGitHistoryDeletionIfPresent(
    projectId: string,
    artifactId: string,
    createdAt: string,
  ): Effect.Effect<void, unknown, SqlClient> {
    const installationId = this.#installationId;
    return Effect.gen(function*() {
      const sql = yield* SqlClient;
      const rows = yield* sql.unsafe<{readonly artifactId: string}>(`
        SELECT artifact_id AS "artifactId" FROM git_history_repositories
        WHERE installation_id = $1 AND project_id = $2 AND artifact_id = $3
          AND status <> 'deleted'
      `, [installationId, projectId, artifactId]);
      if (rows.length === 0) return;
      yield* sql.unsafe(`
        INSERT INTO git_history_jobs (
          installation_id, id, project_id, artifact_id, version_id,
          kind, state, attempts, available_at, created_at, updated_at
        ) VALUES ($1, $2, $3, $4, NULL, 'delete-repository', 'queued', 0,
          $5, $5, $5)
        ON CONFLICT (installation_id, id) DO NOTHING
      `, [
        installationId,
        gitHistoryJobId(gitHistoryJobKinds.deleteRepository, artifactId, null),
        projectId,
        artifactId,
        createdAt,
      ]);
      yield* sql.unsafe(`
        UPDATE git_history_repositories SET status = 'deleting', updated_at = $1
        WHERE installation_id = $2 AND project_id = $3 AND artifact_id = $4
      `, [createdAt, installationId, projectId, artifactId]);
    });
  }

  #readRegisteredAgentRow(
    agentId: string,
  ): Effect.Effect<RegisteredAgentRecord, unknown, SqlClient> {
    const installationId = this.#installationId;
    return Effect.gen(function*() {
      const sql = yield* SqlClient;
      const rows = yield* sql.unsafe<object>(
        `${registeredAgentColumns}
         WHERE agent.installation_id = $1 AND agent.id = $2`,
        [installationId, agentId],
      );
      const agent = registeredAgentRowSchema.nullable().parse(rows[0] ?? null);
      if (agent === null) {
        throw new Error(
          `Registered agent ${agentId} was not found after a successful write.`,
        );
      }
      return agent;
    });
  }

  #readDispatchRow(
    dispatchId: string,
  ): Effect.Effect<z.infer<typeof agentDispatchRowSchema>, unknown, SqlClient> {
    return Effect.gen({self: this}, function*() {
      const row = yield* this.#readDispatchRowOrNull(dispatchId, false);
      if (row === null) {
        throw new Error(
          `Agent dispatch ${dispatchId} was not found after a successful write.`,
        );
      }
      return row;
    });
  }

  #readDispatchRowOrNull(
    dispatchId: string,
    lock: boolean,
  ): Effect.Effect<
    z.infer<typeof agentDispatchRowSchema> | null,
    unknown,
    SqlClient
  > {
    const installationId = this.#installationId;
    return Effect.gen(function*() {
      const sql = yield* SqlClient;
      const rows = yield* sql.unsafe<object>(
        `${agentDispatchColumns}
         WHERE dispatch.installation_id = $1 AND dispatch.id = $2
         ${lock ? "FOR UPDATE" : ""}`,
        [installationId, dispatchId],
      );
      return agentDispatchRowSchema.nullable().parse(rows[0] ?? null);
    });
  }

  #readIdempotentDispatchRowOrNull(
    projectId: string,
    idempotencyKey: string,
  ): Effect.Effect<
    z.infer<typeof agentDispatchRowSchema> | null,
    unknown,
    SqlClient
  > {
    const installationId = this.#installationId;
    return Effect.gen(function*() {
      const sql = yield* SqlClient;
      const rows = yield* sql.unsafe<object>(
        `${agentDispatchColumns}
         WHERE dispatch.installation_id = $1 AND dispatch.project_id = $2
           AND dispatch.idempotency_key = $3`,
        [installationId, projectId, idempotencyKey],
      );
      return agentDispatchRowSchema.nullable().parse(rows[0] ?? null);
    });
  }

  #failDispatch(
    dispatchId: string,
    reason: string,
    failedAt: string,
  ): Effect.Effect<void, unknown, SqlClient> {
    const installationId = this.#installationId;
    return Effect.gen({self: this}, function*() {
      const sql = yield* SqlClient;
      yield* sql`UPDATE agent_dispatches
        SET state = ${agentDispatchStates.failed}, failed_at = ${failedAt},
          failure_reason = ${reason}, updated_at = ${failedAt},
          claimed_at = NULL, lease_expires_at = NULL
        WHERE installation_id = ${installationId} AND id = ${dispatchId}`;
      // A permanent failure returns the annotations to the artifact surfaces.
      yield* this.#clearDispatchMarkers(dispatchId, failedAt);
    });
  }

  #clearDispatchMarkers(
    dispatchId: string,
    clearedAt: string,
  ): Effect.Effect<void, unknown, SqlClient> {
    const installationId = this.#installationId;
    return Effect.gen(function*() {
      const sql = yield* SqlClient;
      // Releasing the marker returns the thread to the default listings, so
      // it counts as a thread edit: a `since` poller must see it come back.
      yield* sql`UPDATE comment_threads
        SET dispatch_id = NULL, updated_at = ${clearedAt}
        WHERE installation_id = ${installationId}
          AND dispatch_id = ${dispatchId}`;
    });
  }

  /**
   * The lazy transition set applied on the read path, in machine order:
   * an expired claim lease returns to queued, a queued dispatch whose agent
   * stopped polling fails as agent_unavailable, and a delivered dispatch
   * whose every bundle thread is resolved is stamped addressed once.
   */
  #applyLazyDispatchTransitions(
    row: z.infer<typeof agentDispatchRowSchema>,
    now: string,
  ): Effect.Effect<void, unknown, SqlClient> {
    const installationId = this.#installationId;
    const staleBefore = isoBefore(now, agentUnavailableStalenessMilliseconds);
    return Effect.gen({self: this}, function*() {
      const sql = yield* SqlClient;
      yield* sql`UPDATE agent_dispatches
        SET state = ${agentDispatchStates.queued}, claimed_at = NULL,
          lease_expires_at = NULL, updated_at = ${now}
        WHERE installation_id = ${installationId} AND id = ${row.id}
          AND state = ${agentDispatchStates.claimed}
          AND lease_expires_at < ${now}`;
      const failed = yield* sql`UPDATE agent_dispatches dispatch
        SET state = ${agentDispatchStates.failed}, failed_at = ${now},
          failure_reason = 'agent_unavailable', updated_at = ${now},
          claimed_at = NULL, lease_expires_at = NULL
        WHERE dispatch.installation_id = ${installationId}
          AND dispatch.id = ${row.id}
          AND dispatch.state = ${agentDispatchStates.queued}
          AND NOT EXISTS (
            SELECT 1 FROM registered_agents agent
            WHERE agent.installation_id = dispatch.installation_id
              AND agent.id = dispatch.agent_id
              AND agent.last_seen_at >= ${staleBefore}
          )
        RETURNING dispatch.id`;
      if (failed.length === 1) {
        yield* this.#clearDispatchMarkers(row.id, now);
        return;
      }
      yield* this.#stampAddressedWhenResolved(row, now);
    });
  }

  #applyLazyProjectTransitions(
    projectId: string,
    now: string,
  ): Effect.Effect<void, unknown, SqlClient> {
    const installationId = this.#installationId;
    const staleBefore = isoBefore(now, agentUnavailableStalenessMilliseconds);
    return Effect.gen({self: this}, function*() {
      const sql = yield* SqlClient;
      yield* sql`UPDATE agent_dispatches
        SET state = ${agentDispatchStates.queued}, claimed_at = NULL,
          lease_expires_at = NULL, updated_at = ${now}
        WHERE installation_id = ${installationId} AND project_id = ${projectId}
          AND state = ${agentDispatchStates.claimed}
          AND lease_expires_at < ${now}`;
      const staleRows = yield* sql`SELECT dispatch.id AS "id"
        FROM agent_dispatches dispatch
        WHERE dispatch.installation_id = ${installationId}
          AND dispatch.project_id = ${projectId}
          AND dispatch.state = ${agentDispatchStates.queued}
          AND NOT EXISTS (
            SELECT 1 FROM registered_agents agent
            WHERE agent.installation_id = dispatch.installation_id
              AND agent.id = dispatch.agent_id
              AND agent.last_seen_at >= ${staleBefore}
          )`;
      for (const stale of z.array(dispatchIdentityRowSchema).parse(staleRows)) {
        yield* this.#failDispatch(stale.id, "agent_unavailable", now);
      }
      const deliveredRows = yield* sql.unsafe<object>(
        `${agentDispatchColumns}
         WHERE dispatch.installation_id = $1 AND dispatch.project_id = $2
           AND dispatch.state = $3`,
        [installationId, projectId, agentDispatchStates.delivered],
      );
      for (
        const delivered of z.array(agentDispatchRowSchema).parse(deliveredRows)
      ) {
        yield* this.#stampAddressedWhenResolved(delivered, now);
      }
    });
  }

  #stampAddressedWhenResolved(
    row: z.infer<typeof agentDispatchRowSchema>,
    now: string,
  ): Effect.Effect<void, unknown, SqlClient> {
    const installationId = this.#installationId;
    return Effect.gen(function*() {
      if (row.state !== agentDispatchStates.delivered) return;
      const threadIds = threadIdsSchema.parse(JSON.parse(row.threadIdsJson));
      if (threadIds.length === 0) return;
      const sql = yield* SqlClient;
      const placeholders = [...threadIds.keys()]
        .map((index) => `$${index + 2}`)
        .join(", ");
      const counted = yield* sql.unsafe<object>(
        `SELECT COUNT(*) AS "resolvedCount" FROM comment_threads thread
         WHERE thread.installation_id = $1 AND thread.state = 'resolved'
           AND thread.id IN (${placeholders})`,
        [installationId, ...threadIds],
      );
      const resolved = resolvedCountRowSchema.parse(counted[0] ?? null);
      if (resolved.resolvedCount !== threadIds.length) return;
      // Thread resolution is the ground truth; the markers stay in place
      // because the threads are resolved and already invisible.
      yield* sql`UPDATE agent_dispatches
        SET state = ${agentDispatchStates.addressed}, addressed_at = ${now},
          updated_at = ${now}
        WHERE installation_id = ${installationId} AND id = ${row.id}
          AND state = ${agentDispatchStates.delivered}`;
    });
  }
}

const commentThreadColumns = `SELECT
    thread.id AS "id",
    thread.installation_id AS "installationId",
    thread.project_id AS "projectId",
    thread.artifact_id AS "artifactId",
    thread.version_id AS "versionId",
    thread.path AS "path",
    thread.anchor_json AS "anchorJson",
    thread.body AS "body",
    thread.state AS "state",
    thread.author_principal_id AS "authorPrincipalId",
    thread.author_principal_kind AS "authorPrincipalKind",
    thread.author_display_name AS "authorDisplayName",
    thread.author_authorized_by_principal_id AS "authorAuthorizedByPrincipalId",
    thread.resolved_at AS "resolvedAt",
    thread.resolved_by_principal_id AS "resolvedByPrincipalId",
    thread.resolved_by_principal_kind AS "resolvedByPrincipalKind",
    thread.resolved_by_display_name AS "resolvedByDisplayName",
    thread.resolved_by_authorized_by_principal_id
      AS "resolvedByAuthorizedByPrincipalId",
    thread.created_at AS "createdAt",
    thread.updated_at AS "updatedAt",
    (SELECT COUNT(*) FROM comment_replies reply
      WHERE reply.installation_id = thread.installation_id
        AND reply.thread_id = thread.id) AS "replyCount"
  FROM comment_threads thread`;

const commentReplyColumns = `SELECT
    reply.id AS "id",
    reply.thread_id AS "threadId",
    reply.project_id AS "projectId",
    reply.body AS "body",
    reply.author_principal_id AS "authorPrincipalId",
    reply.author_principal_kind AS "authorPrincipalKind",
    reply.author_display_name AS "authorDisplayName",
    reply.author_authorized_by_principal_id AS "authorAuthorizedByPrincipalId",
    reply.created_at AS "createdAt",
    reply.updated_at AS "updatedAt"
  FROM comment_replies reply`;

function serializeCommentAnchor(carrier: {readonly anchor: unknown}): string | null {
  return carrier.anchor === null || carrier.anchor === undefined
    ? null
    : JSON.stringify(carrier.anchor);
}

// The actions table is unique on (installation_id, project_id, idempotency_key),
// so a comment action cannot carry the caller's key: that key already belongs to
// a publish, a restore, or another comment write in the same project. A key
// derived from a timestamp collides too when two mutations on one thread share a
// millisecond, so the action row id is the unique component.
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

function changedThreadValues(
  command: UpdateCommentThread,
  row: z.infer<typeof commentThreadRowSchema>,
): ChangedCommentThreadValues {
  const resolution = command.state?.resolvedBy ?? null;
  if (command.state === null) {
    return {
      anchorJson: command.anchor === null
        ? row.anchorJson
        : serializeCommentAnchor(command.anchor),
      body: command.body ?? row.body,
      resolvedAt: row.resolvedAt,
      resolvedByAuthorizedByPrincipalId: row.resolvedByAuthorizedByPrincipalId,
      resolvedByDisplayName: row.resolvedByDisplayName,
      resolvedByPrincipalId: row.resolvedByPrincipalId,
      resolvedByPrincipalKind: row.resolvedByPrincipalKind,
      state: row.state,
    };
  }
  return {
    anchorJson: command.anchor === null
      ? row.anchorJson
      : serializeCommentAnchor(command.anchor),
    body: command.body ?? row.body,
    resolvedAt: command.state.resolvedAt,
    resolvedByAuthorizedByPrincipalId: resolution?.authorizedByPrincipalId ?? null,
    resolvedByDisplayName: resolution?.displayName ?? null,
    resolvedByPrincipalId: resolution?.principalId ?? null,
    resolvedByPrincipalKind: resolution?.principalKind ?? null,
    state: command.state.state,
  };
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

function missingComment(): CommentNotFound {
  return new CommentNotFound({
    message: "The comment thread or reply does not exist.",
  });
}

const registeredAgentColumns = `SELECT
    agent.id AS "id",
    agent.installation_id AS "installationId",
    agent.connection_key AS "connectionKey",
    agent.display_name AS "displayName",
    agent.kind AS "kind",
    agent.working_directory AS "workingDirectory",
    agent.agent_session_id AS "agentSessionId",
    agent.principal_id AS "principalId",
    agent.created_at AS "createdAt",
    agent.last_seen_at AS "lastSeenAt",
    agent.capabilities_json AS "capabilitiesJson",
    agent.activity_state AS "activityState",
    agent.activity_at AS "activityAt"
  FROM registered_agents agent`;

const agentDispatchColumns = `SELECT
    dispatch.id AS "id",
    dispatch.installation_id AS "installationId",
    dispatch.project_id AS "projectId",
    dispatch.agent_id AS "agentId",
    dispatch.agent_display_name AS "agentDisplayName",
    dispatch.thread_ids_json AS "threadIdsJson",
    dispatch.note AS "note",
    dispatch.state AS "state",
    dispatch.sender_principal_id AS "senderPrincipalId",
    dispatch.sender_principal_kind AS "senderPrincipalKind",
    dispatch.sender_display_name AS "senderDisplayName",
    dispatch.sender_authorized_by_principal_id
      AS "senderAuthorizedByPrincipalId",
    dispatch.idempotency_key AS "idempotencyKey",
    dispatch.claimed_at AS "claimedAt",
    dispatch.lease_expires_at AS "leaseExpiresAt",
    dispatch.delivered_at AS "deliveredAt",
    dispatch.addressed_at AS "addressedAt",
    dispatch.failed_at AS "failedAt",
    dispatch.failure_reason AS "failureReason",
    dispatch.canceled_at AS "canceledAt",
    dispatch.created_at AS "createdAt",
    dispatch.updated_at AS "updatedAt"
  FROM agent_dispatches dispatch`;

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

function missingDispatch(): AgentDispatchNotFound {
  return new AgentDispatchNotFound({message: "The dispatch does not exist."});
}

function dispatchedCommentDeletionConflict(): DispatchStateConflict {
  return new DispatchStateConflict({
    message:
      "This comment has been sent to an agent and cannot be deleted until the dispatch is complete.",
  });
}

function foreignClaimReport(): DispatchStateConflict {
  return new DispatchStateConflict({
    message: "The reporting agent does not hold this dispatch.",
  });
}

// Stored timestamps are canonical millisecond ISO text, so offsets computed
// through Date round-trip into the same lexicographically comparable format.
function isoAfter(instant: string, milliseconds: number): string {
  return new Date(Date.parse(instant) + milliseconds).toISOString();
}

function isoBefore(instant: string, milliseconds: number): string {
  return new Date(Date.parse(instant) - milliseconds).toISOString();
}

/** Serialize the claim decision for one agent across replicas. */
function lockAgentClaim(
  sql: SqlClient,
  installationId: string,
  agentId: string,
): Effect.Effect<readonly object[], unknown> {
  return sql`SELECT pg_advisory_xact_lock(
    hashtextextended(${`agent-claim:${installationId}:${agentId}`}, 0)
  )`;
}

function lockIdempotency(
  sql: SqlClient,
  installationId: string,
  projectId: string,
  idempotencyKey: string,
): Effect.Effect<readonly object[], unknown> {
  return sql`SELECT pg_advisory_xact_lock(
    hashtextextended(${`${installationId}:${projectId}:${idempotencyKey}`}, 0)
  )`;
}

const assertExpectedVersion = Effect.fn(
  "PostgresArtifactRepository.assertExpectedVersion",
)(function*(
  artifact: ArtifactRecord,
  expectedCurrentVersionId: string,
): Effect.fn.Return<void, ArtifactMutationConflict> {
  if (artifact.currentVersionId !== expectedCurrentVersionId) {
    return yield* new ArtifactMutationConflict({
      message: `The artifact moved to version ${artifact.currentVersionId}.`,
    });
  }
  return yield* Effect.void;
});

function changedDuringManagement(): ArtifactMutationConflict {
  return new ArtifactMutationConflict({
    message: "The artifact changed during the management operation.",
  });
}

function pageFromRows<Item extends PageCursor>(
  rows: readonly Item[],
  limit: number,
): PageResult<Item> {
  const items = rows.slice(0, limit);
  const lastItem = items.at(-1);
  return {
    items,
    nextCursor: rows.length > limit && lastItem !== undefined
      ? {createdAt: lastItem.createdAt, id: lastItem.id}
      : null,
  };
}
