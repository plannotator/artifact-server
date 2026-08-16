import { DatabaseSync } from "node:sqlite";

import { z } from "zod";

import {
  ArtifactMutationConflict,
  ArtifactNotFound,
  IdempotencyConflict,
  PublishConflict,
  UploadClosed,
  UploadExpired,
  UploadFileNotFound,
  UploadIncomplete,
  UploadNotFound,
  VersionNotFound,
  ProjectConflict,
  ProjectArchived,
  ProjectNotFound,
} from "../core/errors.js";
import {
  accessSettings,
  artifactActionKinds,
  fileDispositions,
  routingModes,
  uploadStatuses,
  defaultProjectId,
  defaultProjectName,
  type ArtifactActionPage,
  type ArtifactActionRecord,
  type ArtifactDeletion,
  type ArtifactPage,
  type ArtifactRecord,
  type ArtifactState,
  type ArtifactTombstone,
  type ArtifactVersion,
  type ContentBootstrapRecord,
  type ContentSessionRecord,
  type ManifestEntry,
  type PageCursor,
  type PublishedVersion,
  type ProjectRecord,
  type StagedUpload,
  type StagedUploadFile,
  type VersionContent,
  type VersionRecord,
} from "../core/model.js";
import type {
  ArtifactRepository,
  ChangeArtifactAccessSetting,
  ChangeArtifactOwnership,
  ChangeArtifactTags,
  CommitArtifactVersion,
  CommitNewArtifact,
  ContentSessionRepository,
  CreateContentBootstrap,
  CreateStagedUpload,
  DeleteArtifact,
  ExchangeContentBootstrap,
  ExpiredStagedUpload,
  ListArtifactActions,
  ListArtifacts,
  PublicationSource,
  ProjectRepository,
  RenameProject,
  RestoreArtifactVersion,
  SetProjectArchive,
  StagedUploadRepository,
} from "../core/ports.js";
import { createManifest } from "../manifest/create-manifest.js";
import {requiredSqliteSchemaVersion} from "./sqlite-schema.js";

const accessSettingSchema = z.enum([
  accessSettings.accountRequired,
  accessSettings.publicLink,
]);
const dispositionSchema = z.enum([
  fileDispositions.attachment,
  fileDispositions.inline,
]);
const uploadStatusSchema = z.enum([
  uploadStatuses.committed,
  uploadStatuses.open,
]);
const routingModeSchema = z.enum([routingModes.static, routingModes.spa]);
const artifactActionKindSchema = z.enum([
  artifactActionKinds.changeAccess,
  artifactActionKinds.changeOwner,
  artifactActionKinds.changeTags,
  artifactActionKinds.delete,
  artifactActionKinds.publish,
  artifactActionKinds.restore,
]);
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
  ownerPrincipalId: z.string(),
  publisherPrincipalId: z.string(),
  projectId: z.string(),
  routingMode: routingModeSchema,
  versionCreatedAt: z.string(),
  versionId: z.string(),
  versionNumber: z.number().int().positive(),
});
const contentBootstrapRowSchema = z.object({
  artifactId: z.string(),
  contentToken: z.string(),
  createdAt: z.string(),
  expiresAt: z.string(),
  principalId: z.string(),
  projectId: z.string(),
  tokenDigest: z.string(),
  versionId: z.string(),
});
const contentSessionRowSchema = contentBootstrapRowSchema;
const idempotencyRowSchema = z.object({
  accessSetting: accessSettingSchema.nullable(),
  artifactId: z.string(),
  inputDigest: z.string(),
  operation: z.enum([
    "change_access",
    "change_owner",
    "change_tags",
    "delete",
    "publish",
    "restore",
  ]),
  tagsJson: z.string().nullable(),
  targetOwnerPrincipalId: z.string().nullable(),
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
  targetOwnerPrincipalId: z.string().nullable(),
  versionId: z.string(),
});
const artifactRowSchema = z.object({
  accessSetting: accessSettingSchema,
  createdAt: z.string(),
  currentVersionId: z.string(),
  deletedAt: z.string().nullable(),
  id: z.string(),
  name: z.string(),
  ownerPrincipalId: z.string(),
  projectId: z.string(),
});
const artifactTagRowSchema = z.object({
  artifactId: z.string(),
  tag: z.string(),
});
const versionRowSchema = z.object({
  artifactId: z.string(),
  contentToken: z.string(),
  createdAt: z.string(),
  entryPath: z.string(),
  id: z.string(),
  manifestDigest: z.string(),
  number: z.number().int().positive(),
  publisherPrincipalId: z.string(),
  projectId: z.string(),
  routingMode: routingModeSchema,
});
const storedManifestEntryRowSchema = z.object({
  disposition: dispositionSchema,
  mediaType: z.string(),
  path: z.string(),
  sha256: z.string(),
  size: z.number().int().nonnegative(),
});
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
const stagedUploadBaseRowSchema = z.object({
  createdAt: z.string(),
  entryPath: z.string(),
  expiresAt: z.string(),
  id: z.string(),
  manifestDigest: z.string(),
  principalId: z.string(),
  projectId: z.string(),
  routingMode: routingModeSchema,
});
const stagedUploadRowSchema = z.discriminatedUnion("status", [
  stagedUploadBaseRowSchema.extend({
    committedVersionId: z.null(),
    status: z.literal(uploadStatuses.open),
  }),
  stagedUploadBaseRowSchema.extend({
    committedVersionId: z.string(),
    status: z.literal(uploadStatuses.committed),
  }),
]);
const stagedUploadFileRowSchema = z.object({
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
const stagedUploadCommitRowSchema = z.object({
  expiresAt: z.string(),
  fileCount: z.number().int().nonnegative(),
  manifestDigest: z.string(),
  readyCount: z.number().int().nonnegative(),
  status: uploadStatusSchema,
});
const projectRowSchema = z.object({
  archivedAt: z.string().nullable(),
  createdAt: z.string(),
  id: z.string(),
  installationId: z.string(),
  name: z.string(),
});

interface PageResult<Item> {
  readonly items: readonly Item[];
  readonly nextCursor: PageCursor | null;
}

export class SqliteArtifactRepository implements
  ArtifactRepository,
  ContentSessionRepository,
  ProjectRepository,
  StagedUploadRepository
{
  readonly #database: DatabaseSync;
  readonly #installationId: string;

  constructor(databasePath: string, installationId = "local") {
    this.#installationId = installationId;
    this.#database = new DatabaseSync(databasePath, {
      allowExtension: false,
      enableForeignKeyConstraints: true,
      timeout: 5_000,
    });
    this.#database.enableDefensive(true);
    this.#database.exec("PRAGMA journal_mode = WAL;");
    this.#database.exec("PRAGMA synchronous = FULL;");
    this.#migrate(installationId);
  }

  createProject(command: ProjectRecord): Promise<ProjectRecord> {
    return Promise.resolve().then(() => {
      try {
        this.#database.prepare(`
          INSERT INTO projects (id, installation_id, name, created_at, archived_at)
          VALUES (?, ?, ?, ?, ?)
        `).run(
          command.id,
          this.#installationId,
          command.name,
          command.createdAt,
          command.archivedAt,
        );
      } catch (cause) {
        if (isSqliteConstraint(cause)) {
          throw new ProjectConflict({message: "The project identity is already in use."});
        }
        throw cause;
      }
      return this.#readProject(command.id);
    });
  }

  findProject(projectId: string): Promise<ProjectRecord | null> {
    return Promise.resolve().then(() => this.#readProjectOrNull(projectId));
  }

  listProjects(): Promise<readonly ProjectRecord[]> {
    return Promise.resolve().then(() => projectRowSchema.array().parse(
      this.#database.prepare(`
        SELECT id, installation_id AS installationId, name,
          created_at AS createdAt, archived_at AS archivedAt
        FROM projects
        ORDER BY created_at, id
      `).all(),
    ));
  }

  renameProject(command: RenameProject): Promise<ProjectRecord> {
    return Promise.resolve().then(() => {
      const result = this.#database.prepare(
        "UPDATE projects SET name = ? WHERE id = ?",
      ).run(command.name, command.projectId);
      if (result.changes !== 1) {
        throw new ProjectNotFound({message: "The project does not exist."});
      }
      return this.#readProject(command.projectId);
    });
  }

  setProjectArchive(command: SetProjectArchive): Promise<ProjectRecord> {
    return Promise.resolve().then(() => {
      const result = this.#database.prepare(
        "UPDATE projects SET archived_at = ? WHERE id = ?",
      ).run(command.archivedAt, command.projectId);
      if (result.changes !== 1) {
        throw new ProjectNotFound({message: "The project does not exist."});
      }
      return this.#readProject(command.projectId);
    });
  }

  close(): void {
    this.#database.close();
  }

  assertPublicationSourceReady(
    source: PublicationSource,
    manifestDigest: string,
    commitTime: string,
  ): Promise<void> {
    return Promise.resolve().then(() => {
      this.#assertStagedUploadReady(source, manifestDigest, commitTime);
      return undefined;
    });
  }

  commitNewArtifact(command: CommitNewArtifact): Promise<PublishedVersion> {
    return Promise.resolve().then(() =>
      this.#transaction(() => {
        const replayed = this.#findIdempotentResult(
          command.projectId,
          command.idempotencyKey,
          command.inputDigest,
        );
        if (replayed !== null) return replayed;
        this.#assertProjectActive(command.projectId);
        this.#assertStagedUploadReady(
          command.source,
          command.manifest.digest,
          command.createdAt,
        );

        this.#database
          .prepare(
            `INSERT INTO artifacts (
              id, project_id, name, owner_principal_id, access_setting,
              current_version_id, created_at, deleted_at
            ) VALUES (?, ?, ?, ?, ?, NULL, ?, NULL)`,
          )
          .run(
            command.artifactId,
            command.projectId,
            command.name,
            command.ownerPrincipalId,
            command.accessSetting,
            command.createdAt,
          );

        this.#replaceTags(command.artifactId, command.tags);

        this.#insertVersion(
          command.projectId,
          command.artifactId,
          command.versionId,
          command.contentToken,
          command.createdAt,
          1,
          command.manifest,
          command.principalId,
        );
        this.#database
          .prepare("UPDATE artifacts SET current_version_id = ? WHERE id = ?")
          .run(command.versionId, command.artifactId);
        this.#insertAction(
          command.projectId,
          command.artifactId,
          command.versionId,
          command.idempotencyKey,
          command.createdAt,
          "publish",
          command.principalId,
          command.authorizedByPrincipalId,
        );
        this.#insertIdempotency(
          command.projectId,
          command.idempotencyKey,
          command.inputDigest,
          command.artifactId,
          command.versionId,
          command.createdAt,
        );
        this.#sealStagedUpload(command.source, command.versionId);

        return this.#readPublishedVersion(command.projectId, command.versionId, false);
      }),
    );
  }

  commitVersion(command: CommitArtifactVersion): Promise<PublishedVersion> {
    return Promise.resolve().then(() =>
      this.#transaction(() => {
        const replayed = this.#findIdempotentResult(
          command.projectId,
          command.idempotencyKey,
          command.inputDigest,
        );
        if (replayed !== null) return replayed;
        this.#assertProjectActive(command.projectId);
        this.#assertStagedUploadReady(
          command.source,
          command.manifest.digest,
          command.createdAt,
        );

        const currentRow = this.#database
          .prepare(
            `SELECT current_version_id AS currentVersionId
             FROM artifacts
             WHERE project_id = ? AND id = ? AND deleted_at IS NULL`,
          )
          .get(command.projectId, command.artifactId);
        const current = z
          .object({currentVersionId: z.string()})
          .nullable()
          .parse(currentRow ?? null);
        if (current === null) {
          throw new ArtifactNotFound({message: "The artifact does not exist."});
        }
        if (current.currentVersionId !== command.expectedCurrentVersionId) {
          throw new PublishConflict({
            message: `The artifact moved to version ${current.currentVersionId}.`,
          });
        }

        const numberRow = this.#database
          .prepare(
            `SELECT COALESCE(MAX(number), 0) + 1 AS nextNumber
             FROM versions
             WHERE artifact_id = ?`,
          )
          .get(command.artifactId);
        const {nextNumber} = z
          .object({nextNumber: z.number().int().positive()})
          .parse(numberRow);

        this.#insertVersion(
          command.projectId,
          command.artifactId,
          command.versionId,
          command.contentToken,
          command.createdAt,
          nextNumber,
          command.manifest,
          command.principalId,
        );
        const update = this.#database
          .prepare(
            `UPDATE artifacts
             SET current_version_id = ?
             WHERE project_id = ? AND id = ? AND current_version_id = ? AND deleted_at IS NULL`,
          )
          .run(
            command.versionId,
            command.projectId,
            command.artifactId,
            command.expectedCurrentVersionId,
          );
        if (update.changes !== 1) {
          throw new PublishConflict({
            message: "The artifact changed during publication.",
          });
        }

        this.#insertAction(
          command.projectId,
          command.artifactId,
          command.versionId,
          command.idempotencyKey,
          command.createdAt,
          "publish",
          command.principalId,
          command.authorizedByPrincipalId,
        );
        this.#insertIdempotency(
          command.projectId,
          command.idempotencyKey,
          command.inputDigest,
          command.artifactId,
          command.versionId,
          command.createdAt,
        );
        this.#sealStagedUpload(command.source, command.versionId);

        return this.#readPublishedVersion(command.projectId, command.versionId, false);
      }),
    );
  }

  changeAccessSetting(
    command: ChangeArtifactAccessSetting,
  ): Promise<ArtifactState> {
    return Promise.resolve().then(() =>
      this.#transaction(() => {
        const replayed = this.#findIdempotentManagementResult(
          command.projectId,
          "change_access",
          command.idempotencyKey,
          command.inputDigest,
        );
        if (replayed !== null) return replayed;
        const artifact = this.#readArtifact(command.projectId, command.artifactId);
        this.#assertExpectedCurrentVersion(
          artifact,
          command.expectedCurrentVersionId,
        );
        const update = this.#database
          .prepare(
            `UPDATE artifacts
             SET access_setting = ?
             WHERE project_id = ? AND id = ? AND current_version_id = ? AND deleted_at IS NULL`,
          )
          .run(
            command.accessSetting,
            command.projectId,
            command.artifactId,
            command.expectedCurrentVersionId,
          );
        if (update.changes !== 1) {
          throw changedDuringManagement();
        }
        this.#insertAction(
          command.projectId,
          command.artifactId,
          command.expectedCurrentVersionId,
          command.idempotencyKey,
          command.createdAt,
          "change_access",
          command.principalId,
          command.authorizedByPrincipalId,
        );
        this.#insertIdempotency(
          command.projectId,
          command.idempotencyKey,
          command.inputDigest,
          command.artifactId,
          command.expectedCurrentVersionId,
          command.createdAt,
          "change_access",
          command.accessSetting,
        );
        return this.#readArtifactState(
          command.projectId,
          command.artifactId,
          command.expectedCurrentVersionId,
          command.accessSetting,
          false,
        );
      }),
    );
  }

  changeOwnership(command: ChangeArtifactOwnership): Promise<ArtifactState> {
    return Promise.resolve().then(() =>
      this.#transaction(() => {
        const replayed = this.#findIdempotentOwnershipResult(
          command.projectId,
          command.idempotencyKey,
          command.inputDigest,
        );
        if (replayed !== null) return replayed;
        const artifact = this.#readArtifact(command.projectId, command.artifactId);
        if (artifact.ownerPrincipalId === command.targetOwnerPrincipalId) {
          throw new ArtifactMutationConflict({
            message: "The target member already owns this artifact.",
          });
        }
        this.#assertExpectedCurrentVersion(
          artifact,
          command.expectedCurrentVersionId,
        );
        const update = this.#database
          .prepare(
            `UPDATE artifacts
             SET owner_principal_id = ?
             WHERE project_id = ? AND id = ? AND current_version_id = ?
               AND deleted_at IS NULL`,
          )
          .run(
            command.targetOwnerPrincipalId,
            command.projectId,
            command.artifactId,
            command.expectedCurrentVersionId,
          );
        if (update.changes !== 1) throw changedDuringManagement();
        this.#insertAction(
          command.projectId,
          command.artifactId,
          command.expectedCurrentVersionId,
          command.idempotencyKey,
          command.createdAt,
          artifactActionKinds.changeOwner,
          command.principalId,
          command.authorizedByPrincipalId,
          command.targetOwnerPrincipalId,
        );
        this.#insertIdempotency(
          command.projectId,
          command.idempotencyKey,
          command.inputDigest,
          command.artifactId,
          command.expectedCurrentVersionId,
          command.createdAt,
          "change_owner",
          artifact.accessSetting,
          null,
          command.targetOwnerPrincipalId,
        );
        return this.#readArtifactState(
          command.projectId,
          command.artifactId,
          command.expectedCurrentVersionId,
          artifact.accessSetting,
          false,
          null,
          command.targetOwnerPrincipalId,
        );
      }),
    );
  }

  changeTags(command: ChangeArtifactTags): Promise<ArtifactState> {
    return Promise.resolve().then(() =>
      this.#transaction(() => {
        const replayed = this.#findIdempotentTagResult(
          command.projectId,
          command.idempotencyKey,
          command.inputDigest,
        );
        if (replayed !== null) return replayed;
        const artifact = this.#readArtifact(command.projectId, command.artifactId);
        this.#assertExpectedCurrentVersion(
          artifact,
          command.expectedCurrentVersionId,
        );
        this.#replaceTags(command.artifactId, command.tags);
        this.#insertAction(
          command.projectId,
          command.artifactId,
          command.expectedCurrentVersionId,
          command.idempotencyKey,
          command.createdAt,
          artifactActionKinds.changeTags,
          command.principalId,
          command.authorizedByPrincipalId,
        );
        this.#insertIdempotency(
          command.projectId,
          command.idempotencyKey,
          command.inputDigest,
          command.artifactId,
          command.expectedCurrentVersionId,
          command.createdAt,
          "change_tags",
          artifact.accessSetting,
          JSON.stringify(command.tags),
        );
        return this.#readArtifactState(
          command.projectId,
          command.artifactId,
          command.expectedCurrentVersionId,
          artifact.accessSetting,
          false,
          command.tags,
        );
      }),
    );
  }

  deleteArtifact(command: DeleteArtifact): Promise<ArtifactDeletion> {
    return Promise.resolve().then(() =>
      this.#transaction(() => {
        const replayed = this.#findIdempotentDeletion(
          command.projectId,
          command.idempotencyKey,
          command.inputDigest,
        );
        if (replayed !== null) return replayed;

        const artifact = this.#readArtifact(command.projectId, command.artifactId);
        this.#assertExpectedCurrentVersion(
          artifact,
          command.expectedCurrentVersionId,
        );
        const update = this.#database
          .prepare(
            `UPDATE artifacts
             SET deleted_at = ?
             WHERE project_id = ? AND id = ? AND current_version_id = ? AND deleted_at IS NULL`,
          )
          .run(
            command.createdAt,
            command.projectId,
            command.artifactId,
            command.expectedCurrentVersionId,
          );
        if (update.changes !== 1) {
          throw changedDuringManagement();
        }
        this.#insertAction(
          command.projectId,
          command.artifactId,
          command.expectedCurrentVersionId,
          command.idempotencyKey,
          command.createdAt,
          artifactActionKinds.delete,
          command.principalId,
          command.authorizedByPrincipalId,
        );
        this.#insertIdempotency(
          command.projectId,
          command.idempotencyKey,
          command.inputDigest,
          command.artifactId,
          command.expectedCurrentVersionId,
          command.createdAt,
          "delete",
          artifact.accessSetting,
        );
        return this.#readDeletionResult(command.projectId, command.artifactId, false);
      }),
    );
  }

  findArtifact(projectId: string, artifactId: string): Promise<ArtifactRecord | null> {
    return Promise.resolve().then(() => this.#readArtifactOrNull(projectId, artifactId));
  }

  findArtifactForAdministration(
    projectId: string,
    artifactId: string,
  ): Promise<ArtifactRecord | null> {
    return Promise.resolve().then(() =>
      this.#readArtifactIncludingDeletedOrNull(projectId, artifactId)
    );
  }

  findArtifactVersion(
    projectId: string,
    artifactId: string,
    versionId: string,
  ): Promise<ArtifactVersion | null> {
    return Promise.resolve().then(() => {
      if (this.#readArtifactOrNull(projectId, artifactId) === null) return null;
      const version = this.#readVersionOrNull(projectId, versionId, artifactId);
      if (version === null) return null;
      return {
        manifest: this.#readManifest(version),
        version,
      };
    });
  }

  findCurrentVersion(
    projectId: string | null,
    artifactId: string,
  ): Promise<PublishedVersion | null> {
    return Promise.resolve().then(() => {
      const row = this.#database
        .prepare(
          `SELECT current_version_id AS currentVersionId
           FROM artifacts
           WHERE (? IS NULL OR project_id = ?) AND id = ? AND deleted_at IS NULL`,
        )
        .get(projectId, projectId, artifactId);
      const result = z
        .object({currentVersionId: z.string()})
        .nullable()
        .parse(row ?? null);
      return result === null
        ? null
        : projectId === null
        ? this.#readPublishedVersionById(result.currentVersionId, false)
        : this.#readPublishedVersion(projectId, result.currentVersionId, false);
    });
  }

  listArtifactVersions(
    projectId: string,
    artifactId: string,
  ): Promise<readonly VersionRecord[]> {
    return Promise.resolve().then(() => {
      if (this.#readArtifactOrNull(projectId, artifactId) === null) return [];
      const rows = this.#database
        .prepare(
          `SELECT
            id,
            project_id AS projectId,
            artifact_id AS artifactId,
            number,
            manifest_digest AS manifestDigest,
            entry_path AS entryPath,
            routing_mode AS routingMode,
            content_token AS contentToken,
            publisher_principal_id AS publisherPrincipalId,
            created_at AS createdAt
           FROM versions
           WHERE project_id = ? AND artifact_id = ?
           ORDER BY number DESC`,
        )
        .all(projectId, artifactId);
      return z.array(versionRowSchema).parse(rows);
    });
  }

  listArtifacts(command: ListArtifacts): Promise<ArtifactPage> {
    return Promise.resolve().then(() => {
      const cursorCreatedAt = command.cursor?.createdAt ?? null;
      const cursorId = command.cursor?.id ?? null;
      const rows = this.#database
        .prepare(
          `SELECT
            id,
            project_id AS projectId,
            name,
            owner_principal_id AS ownerPrincipalId,
            access_setting AS accessSetting,
            current_version_id AS currentVersionId,
            created_at AS createdAt,
            deleted_at AS deletedAt
           FROM artifacts
           WHERE project_id = ?
             AND deleted_at IS NULL
             AND (? IS NULL OR owner_principal_id = ?)
             AND (
               ? IS NULL
               OR EXISTS (
                 SELECT 1 FROM artifact_tags
                 WHERE artifact_tags.artifact_id = artifacts.id
                   AND artifact_tags.tag = ?
               )
             )
             AND (
               ? IS NULL
               OR created_at < ?
               OR (created_at = ? AND id < ?)
             )
           ORDER BY created_at DESC, id DESC
           LIMIT ?`,
        )
        .all(
          command.projectId,
          command.ownerPrincipalId,
          command.ownerPrincipalId,
          command.tag,
          command.tag,
          cursorCreatedAt,
          cursorCreatedAt,
          cursorCreatedAt,
          cursorId,
          command.limit + 1,
        );
      return pageFromRows(
        this.#withTagsForArtifacts(z.array(artifactRowSchema).parse(rows)),
        command.limit,
      );
    });
  }

  listArtifactActions(command: ListArtifactActions): Promise<ArtifactActionPage> {
    return Promise.resolve().then(() => {
      const cursorCreatedAt = command.cursor?.createdAt ?? null;
      const cursorId = command.cursor?.id ?? null;
      const rows = this.#database
        .prepare(
          `SELECT
            id,
            project_id AS projectId,
            artifact_id AS artifactId,
            version_id AS versionId,
            action,
            principal_id AS principalId,
            authorized_by_principal_id AS authorizedByPrincipalId,
            target_owner_principal_id AS targetOwnerPrincipalId,
            idempotency_key AS idempotencyKey,
            created_at AS createdAt
           FROM actions
           WHERE project_id = ? AND artifact_id = ?
             AND (
               ? IS NULL
               OR created_at < ?
               OR (created_at = ? AND id < ?)
             )
           ORDER BY created_at DESC, id DESC
           LIMIT ?`,
        )
        .all(
          command.projectId,
          command.artifactId,
          cursorCreatedAt,
          cursorCreatedAt,
          cursorCreatedAt,
          cursorId,
          command.limit + 1,
        );
      return pageFromRows(
        z.array(artifactActionRowSchema).parse(rows),
        command.limit,
      );
    });
  }

  restoreVersion(command: RestoreArtifactVersion): Promise<ArtifactState> {
    return Promise.resolve().then(() =>
      this.#transaction(() => {
        const replayed = this.#findIdempotentManagementResult(
          command.projectId,
          "restore",
          command.idempotencyKey,
          command.inputDigest,
        );
        if (replayed !== null) return replayed;
        const artifact = this.#readArtifact(command.projectId, command.artifactId);
        this.#assertExpectedCurrentVersion(
          artifact,
          command.expectedCurrentVersionId,
        );
        if (this.#readVersionOrNull(
          command.projectId,
          command.versionId,
          command.artifactId,
        ) === null) {
          throw new VersionNotFound({
            message: "The saved version does not exist on this artifact.",
          });
        }
        const update = this.#database
          .prepare(
            `UPDATE artifacts
             SET current_version_id = ?
             WHERE project_id = ? AND id = ? AND current_version_id = ? AND deleted_at IS NULL`,
          )
          .run(
            command.versionId,
            command.projectId,
            command.artifactId,
            command.expectedCurrentVersionId,
          );
        if (update.changes !== 1) {
          throw changedDuringManagement();
        }
        this.#insertAction(
          command.projectId,
          command.artifactId,
          command.versionId,
          command.idempotencyKey,
          command.createdAt,
          "restore",
          command.principalId,
          command.authorizedByPrincipalId,
        );
        this.#insertIdempotency(
          command.projectId,
          command.idempotencyKey,
          command.inputDigest,
          command.artifactId,
          command.versionId,
          command.createdAt,
          "restore",
          artifact.accessSetting,
        );
        return this.#readArtifactState(
          command.projectId,
          command.artifactId,
          command.versionId,
          artifact.accessSetting,
          false,
        );
      }),
    );
  }

  findIdempotentPublication(
    projectId: string,
    idempotencyKey: string,
    inputDigest: string,
  ): Promise<PublishedVersion | null> {
    return Promise.resolve().then(() =>
      this.#findIdempotentResult(projectId, idempotencyKey, inputDigest),
    );
  }

  findVersionContent(
    contentToken: string,
    requestedPath: string,
    fallback: "entry" | "none",
  ): Promise<VersionContent | null> {
    return Promise.resolve().then(() => {
      const row = this.#database
        .prepare(
          `SELECT
            a.access_setting AS accessSetting,
            a.id AS artifactId,
            a.project_id AS projectId,
            v.content_token AS contentToken,
            v.id AS versionId,
            e.path AS path,
            e.size AS size,
            e.media_type AS mediaType,
            e.sha256 AS sha256,
            e.disposition AS disposition
            , CASE WHEN v.id = a.current_version_id THEN 1 ELSE 0 END AS isCurrent
          FROM versions v
          JOIN artifacts a ON a.id = v.artifact_id
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
            AND a.deleted_at IS NULL`,
        )
        .get(
          contentToken,
          requestedPath,
          requestedPath,
          requestedPath,
          fallback,
          requestedPath,
        );
      const parsed = versionContentRowSchema.nullable().parse(row ?? null);
      if (parsed === null) return null;
      const entry: ManifestEntry = {
        disposition: parsed.disposition,
        mediaType: parsed.mediaType,
        path: parsed.path,
        sha256: parsed.sha256,
        size: parsed.size,
      };
      return {
        accessSetting: parsed.accessSetting,
        artifactId: parsed.artifactId,
        contentToken: parsed.contentToken,
        entry,
        isCurrent: parsed.isCurrent,
        projectId: parsed.projectId,
        versionId: parsed.versionId,
      };
    });
  }

  createContentBootstrap(
    command: CreateContentBootstrap,
  ): Promise<ContentBootstrapRecord> {
    return Promise.resolve().then(() => {
      this.#database
        .prepare(
          `INSERT INTO content_bootstraps (
            token_digest, principal_id, project_id, artifact_id, version_id,
            content_token, created_at, expires_at, consumed_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
        )
        .run(
          command.tokenDigest,
          command.principalId,
          command.projectId,
          command.artifactId,
          command.versionId,
          command.contentToken,
          command.createdAt,
          command.expiresAt,
        );
      return command;
    });
  }

  exchangeContentBootstrap(
    command: ExchangeContentBootstrap,
  ): Promise<ContentSessionRecord | null> {
    return Promise.resolve().then(() =>
      this.#transaction(() => {
        const row = this.#database
          .prepare(
            `SELECT
              b.token_digest AS tokenDigest,
              b.principal_id AS principalId,
              b.project_id AS projectId,
              b.artifact_id AS artifactId,
              b.version_id AS versionId,
              b.content_token AS contentToken,
              b.created_at AS createdAt,
              b.expires_at AS expiresAt
            FROM content_bootstraps b
            JOIN artifacts a ON a.id = b.artifact_id
            WHERE b.token_digest = ?
              AND b.content_token = ?
              AND b.consumed_at IS NULL
              AND b.expires_at > ?
              AND a.deleted_at IS NULL`,
          )
          .get(
            command.bootstrapTokenDigest,
            command.contentToken,
            command.exchangedAt,
          );
        const bootstrap = contentBootstrapRowSchema.nullable().parse(row ?? null);
        if (bootstrap === null) return null;

        const consumed = this.#database
          .prepare(
            `UPDATE content_bootstraps
             SET consumed_at = ?
             WHERE token_digest = ? AND consumed_at IS NULL`,
          )
          .run(command.exchangedAt, command.bootstrapTokenDigest);
        if (consumed.changes !== 1) return null;

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
        this.#database
          .prepare(
            `INSERT INTO content_sessions (
              token_digest, principal_id, project_id, artifact_id, version_id,
              content_token, created_at, expires_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            session.tokenDigest,
            session.principalId,
            session.projectId,
            session.artifactId,
            session.versionId,
            session.contentToken,
            session.createdAt,
            session.expiresAt,
          );
        return session;
      }),
    );
  }

  findContentSession(
    tokenDigest: string,
    contentToken: string,
    requestTime: string,
  ): Promise<ContentSessionRecord | null> {
    return Promise.resolve().then(() => {
      const row = this.#database
        .prepare(
          `SELECT
            s.token_digest AS tokenDigest,
            s.principal_id AS principalId,
            s.project_id AS projectId,
            s.artifact_id AS artifactId,
            s.version_id AS versionId,
            s.content_token AS contentToken,
            s.created_at AS createdAt,
            s.expires_at AS expiresAt
          FROM content_sessions s
          JOIN artifacts a ON a.id = s.artifact_id
          WHERE s.token_digest = ?
            AND s.content_token = ?
            AND s.expires_at > ?
            AND a.deleted_at IS NULL`,
        )
        .get(tokenDigest, contentToken, requestTime);
      return contentSessionRowSchema.nullable().parse(row ?? null);
    });
  }

  createStagedUpload(command: CreateStagedUpload): Promise<StagedUpload> {
    return Promise.resolve().then(() =>
      this.#transaction(() => {
        this.#assertProjectActive(command.projectId);
        this.#database
          .prepare(
            `INSERT INTO staged_uploads (
              id, project_id, principal_id, status, manifest_digest, entry_path,
              routing_mode, created_at, expires_at, committed_version_id
            ) VALUES (?, ?, ?, 'open', ?, ?, ?, ?, ?, NULL)`,
          )
          .run(
            command.id,
            command.projectId,
            command.principalId,
            command.manifest.digest,
            command.manifest.entryPath,
            command.manifest.routingMode,
            command.createdAt,
            command.expiresAt,
          );

        const insertFile = this.#database.prepare(
          `INSERT INTO staged_upload_files (
            upload_id, storage_token, path, size, media_type,
            sha256, disposition, uploaded_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL)`,
        );
        for (const file of command.files) {
          insertFile.run(
            command.id,
            file.storageToken,
            file.entry.path,
            file.entry.size,
            file.entry.mediaType,
            file.entry.sha256,
            file.entry.disposition,
          );
        }
        return this.#readStagedUpload(
          command.projectId,
          command.id,
          command.principalId,
        );
      }),
    );
  }

  findStagedUpload(
    projectId: string,
    uploadId: string,
    principalId: string,
  ): Promise<StagedUpload | null> {
    return Promise.resolve().then(() =>
      this.#readStagedUploadOrNull(projectId, uploadId, principalId),
    );
  }

  listExpiredStagedUploads(
    expiredBefore: string,
    limit: number,
  ): Promise<readonly ExpiredStagedUpload[]> {
    return Promise.resolve().then(() => {
      const rows = this.#database.prepare(`
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
      `).all(expiredBefore, limit);
      const grouped = new Map<string, Array<{readonly storageToken: string}>>();
      for (const row of z.array(expiredStagedUploadRowSchema).parse(rows)) {
        const files = grouped.get(row.id) ?? [];
        files.push({storageToken: row.storageToken});
        grouped.set(row.id, files);
      }
      return [...grouped].map(([id, files]) => ({files, id}));
    });
  }

  removeExpiredStagedUpload(
    uploadId: string,
    expiredBefore: string,
  ): Promise<boolean> {
    return Promise.resolve().then(() => this.#transaction(() => {
      this.#database.prepare(`
        DELETE FROM staged_upload_files
        WHERE upload_id = ? AND EXISTS (
          SELECT 1 FROM staged_uploads upload
          WHERE upload.id = staged_upload_files.upload_id
            AND upload.status = 'open' AND upload.expires_at <= ?
        )
      `).run(uploadId, expiredBefore);
      const deleted = this.#database.prepare(`
        DELETE FROM staged_uploads
        WHERE id = ? AND status = 'open' AND expires_at <= ?
      `).run(uploadId, expiredBefore);
      return deleted.changes === 1;
    }));
  }

  markStagedFileUploaded(
    projectId: string,
    uploadId: string,
    principalId: string,
    storageToken: string,
    uploadedAt: string,
  ): Promise<StagedUpload> {
    return Promise.resolve().then(() =>
      this.#transaction(() => {
        this.#assertProjectActive(projectId);
        const update = this.#database
          .prepare(
            `UPDATE staged_upload_files
             SET uploaded_at = ?
             WHERE upload_id = ?
               AND storage_token = ?
               AND EXISTS (
                 SELECT 1 FROM staged_uploads u
                 WHERE u.id = staged_upload_files.upload_id
                   AND u.project_id = ?
                   AND u.principal_id = ?
                   AND u.status = 'open'
                   AND u.expires_at > ?
               )`,
          )
          .run(
            uploadedAt,
            uploadId,
            storageToken,
            projectId,
            principalId,
            uploadedAt,
          );
        if (update.changes !== 1) {
          const upload = this.#readStagedUploadOrNull(
            projectId,
            uploadId,
            principalId,
          );
          if (upload === null) {
            throw new UploadNotFound({
              message: "The staged upload does not exist.",
            });
          }
          if (upload.status !== uploadStatuses.open) {
            throw new UploadClosed({
              message: "The staged upload is already committed.",
            });
          }
          if (upload.expiresAt <= uploadedAt) {
            throw new UploadExpired({message: "The staged upload has expired."});
          }
          throw new UploadFileNotFound({
            message: "The staged upload file does not exist.",
          });
        }
        return this.#readStagedUpload(projectId, uploadId, principalId);
      }),
    );
  }

  #assertExpectedCurrentVersion(
    artifact: ArtifactRecord,
    expectedCurrentVersionId: string,
  ): void {
    if (artifact.currentVersionId !== expectedCurrentVersionId) {
      throw new ArtifactMutationConflict({
        message: `The artifact moved to version ${artifact.currentVersionId}.`,
      });
    }
  }

  #assertProjectActive(projectId: string): void {
    const row = this.#database.prepare(
      "SELECT archived_at AS archivedAt FROM projects WHERE id = ?",
    ).get(projectId);
    const project = z.object({archivedAt: z.string().nullable()})
      .nullable()
      .parse(row ?? null);
    if (project === null || project.archivedAt !== null) {
      throw new ProjectArchived({
        message: "The project is archived and cannot accept new work.",
      });
    }
  }

  #findIdempotentManagementResult(
    projectId: string,
    operation: "change_access" | "restore",
    idempotencyKey: string,
    inputDigest: string,
  ): ArtifactState | null {
    const row = this.#database
      .prepare(
        `SELECT
          access_setting AS accessSetting,
          artifact_id AS artifactId,
          input_digest AS inputDigest,
          operation,
          tags_json AS tagsJson,
          target_owner_principal_id AS targetOwnerPrincipalId,
          version_id AS versionId
         FROM idempotency_records
         WHERE project_id = ? AND idempotency_key = ?`,
      )
      .get(projectId, idempotencyKey);
    const parsed = idempotencyRowSchema.nullable().parse(row ?? null);
    if (parsed === null) return null;
    if (
      parsed.inputDigest !== inputDigest ||
      parsed.operation !== operation ||
      parsed.accessSetting === null
    ) {
      throw new IdempotencyConflict({
        message: "The idempotency key was already used with different input.",
      });
    }
    return this.#readArtifactState(
      projectId,
      parsed.artifactId,
      parsed.versionId,
      parsed.accessSetting,
      true,
    );
  }

  #findIdempotentOwnershipResult(
    projectId: string,
    idempotencyKey: string,
    inputDigest: string,
  ): ArtifactState | null {
    const row = this.#database
      .prepare(
        `SELECT
          access_setting AS accessSetting,
          artifact_id AS artifactId,
          input_digest AS inputDigest,
          operation,
          tags_json AS tagsJson,
          target_owner_principal_id AS targetOwnerPrincipalId,
          version_id AS versionId
         FROM idempotency_records
         WHERE project_id = ? AND idempotency_key = ?`,
      )
      .get(projectId, idempotencyKey);
    const parsed = idempotencyRowSchema.nullable().parse(row ?? null);
    if (parsed === null) return null;
    if (
      parsed.inputDigest !== inputDigest ||
      parsed.operation !== "change_owner" ||
      parsed.accessSetting === null ||
      parsed.targetOwnerPrincipalId === null
    ) {
      throw new IdempotencyConflict({
        message: "The idempotency key was already used with different input.",
      });
    }
    return this.#readArtifactState(
      projectId,
      parsed.artifactId,
      parsed.versionId,
      parsed.accessSetting,
      true,
      null,
      parsed.targetOwnerPrincipalId,
    );
  }

  #findIdempotentTagResult(
    projectId: string,
    idempotencyKey: string,
    inputDigest: string,
  ): ArtifactState | null {
    const row = this.#database
      .prepare(
        `SELECT
          access_setting AS accessSetting,
          artifact_id AS artifactId,
          input_digest AS inputDigest,
          operation,
          tags_json AS tagsJson,
          target_owner_principal_id AS targetOwnerPrincipalId,
          version_id AS versionId
         FROM idempotency_records
         WHERE project_id = ? AND idempotency_key = ?`,
      )
      .get(projectId, idempotencyKey);
    const parsed = idempotencyRowSchema.nullable().parse(row ?? null);
    if (parsed === null) return null;
    if (
      parsed.inputDigest !== inputDigest ||
      parsed.operation !== "change_tags" ||
      parsed.accessSetting === null ||
      parsed.tagsJson === null
    ) {
      throw new IdempotencyConflict({
        message: "The idempotency key was already used with different input.",
      });
    }
    const decoded: unknown = JSON.parse(parsed.tagsJson);
    const tags = z.array(z.string()).parse(decoded);
    return this.#readArtifactState(
      projectId,
      parsed.artifactId,
      parsed.versionId,
      parsed.accessSetting,
      true,
      tags,
    );
  }

  #findIdempotentDeletion(
    projectId: string,
    idempotencyKey: string,
    inputDigest: string,
  ): ArtifactDeletion | null {
    const row = this.#database
      .prepare(
        `SELECT
          access_setting AS accessSetting,
          artifact_id AS artifactId,
          input_digest AS inputDigest,
          operation,
          tags_json AS tagsJson,
          target_owner_principal_id AS targetOwnerPrincipalId,
          version_id AS versionId
         FROM idempotency_records
         WHERE project_id = ? AND idempotency_key = ?`,
      )
      .get(projectId, idempotencyKey);
    const parsed = idempotencyRowSchema.nullable().parse(row ?? null);
    if (parsed === null) return null;
    if (parsed.inputDigest !== inputDigest || parsed.operation !== "delete") {
      throw new IdempotencyConflict({
        message: "The idempotency key was already used with different input.",
      });
    }
    return this.#readDeletionResult(projectId, parsed.artifactId, true);
  }

  #readArtifact(projectId: string, artifactId: string): ArtifactRecord {
    const artifact = this.#readArtifactOrNull(projectId, artifactId);
    if (artifact === null) {
      throw new ArtifactNotFound({message: "The artifact does not exist."});
    }
    return artifact;
  }

  #readArtifactOrNull(projectId: string, artifactId: string): ArtifactRecord | null {
    const row = this.#database
      .prepare(
        `SELECT
          id,
          project_id AS projectId,
          name,
          owner_principal_id AS ownerPrincipalId,
          access_setting AS accessSetting,
          current_version_id AS currentVersionId,
          created_at AS createdAt,
          deleted_at AS deletedAt
         FROM artifacts
         WHERE project_id = ? AND id = ? AND deleted_at IS NULL`,
      )
      .get(projectId, artifactId);
    const artifact = artifactRowSchema.nullable().parse(row ?? null);
    return artifact === null ? null : this.#withTags(artifact);
  }

  #readArtifactIncludingDeletedOrNull(
    projectId: string,
    artifactId: string,
  ): ArtifactRecord | null {
    const row = this.#database
      .prepare(
        `SELECT
          id,
          project_id AS projectId,
          name,
          owner_principal_id AS ownerPrincipalId,
          access_setting AS accessSetting,
          current_version_id AS currentVersionId,
          created_at AS createdAt,
          deleted_at AS deletedAt
         FROM artifacts
         WHERE project_id = ? AND id = ?`,
      )
      .get(projectId, artifactId);
    const artifact = artifactRowSchema.nullable().parse(row ?? null);
    return artifact === null ? null : this.#withTags(artifact);
  }

  #withTags(artifact: z.infer<typeof artifactRowSchema>): ArtifactRecord {
    return {...artifact, tags: this.#readTags(artifact.id)};
  }

  #withTagsForArtifacts(
    artifacts: readonly z.infer<typeof artifactRowSchema>[],
  ): readonly ArtifactRecord[] {
    if (artifacts.length === 0) return [];
    const tagsByArtifact = new Map<string, string[]>();
    for (const artifact of artifacts) tagsByArtifact.set(artifact.id, []);
    const placeholders = artifacts.map(() => "?").join(", ");
    const rows = this.#database
      .prepare(
        `SELECT artifact_id AS artifactId, tag
         FROM artifact_tags
         WHERE artifact_id IN (${placeholders})
         ORDER BY artifact_id, tag`,
      )
      .all(...artifacts.map((artifact) => artifact.id));
    for (const row of z.array(artifactTagRowSchema).parse(rows)) {
      tagsByArtifact.get(row.artifactId)?.push(row.tag);
    }
    return artifacts.map((artifact) => ({
      ...artifact,
      tags: tagsByArtifact.get(artifact.id) ?? [],
    }));
  }

  #readTags(artifactId: string): readonly string[] {
    const rows = this.#database
      .prepare(
        `SELECT artifact_id AS artifactId, tag
         FROM artifact_tags
         WHERE artifact_id = ?
         ORDER BY tag`,
      )
      .all(artifactId);
    return z.array(artifactTagRowSchema).parse(rows).map((row) => row.tag);
  }

  #replaceTags(artifactId: string, tags: readonly string[]): void {
    this.#database.prepare("DELETE FROM artifact_tags WHERE artifact_id = ?")
      .run(artifactId);
    const insert = this.#database.prepare(
      "INSERT INTO artifact_tags (artifact_id, tag) VALUES (?, ?)",
    );
    for (const tag of tags) insert.run(artifactId, tag);
  }

  #readDeletionResult(
    projectId: string,
    artifactId: string,
    replayed: boolean,
  ): ArtifactDeletion {
    const artifact = this.#readArtifactIncludingDeletedOrNull(projectId, artifactId);
    if (artifact === null || artifact.deletedAt === null) {
      throw new Error(`Artifact ${artifactId} has no persisted tombstone.`);
    }
    const tombstone: ArtifactTombstone = {
      ...artifact,
      deletedAt: artifact.deletedAt,
    };
    const row = this.#database
      .prepare(
        `SELECT COUNT(*) AS retainedVersionCount
         FROM versions
         WHERE project_id = ? AND artifact_id = ?`,
      )
      .get(projectId, artifactId);
    const {retainedVersionCount} = z.object({
      retainedVersionCount: z.number().int().nonnegative(),
    }).parse(row);
    return {artifact: tombstone, replayed, retainedVersionCount};
  }

  #readArtifactState(
    projectId: string,
    artifactId: string,
    versionId: string,
    accessSetting: ArtifactRecord["accessSetting"],
    replayed: boolean,
    tags: readonly string[] | null = null,
    ownerPrincipalId: string | null = null,
  ): ArtifactState {
    const artifact = this.#readArtifact(projectId, artifactId);
    const version = this.#readVersionOrNull(projectId, versionId, artifactId);
    if (version === null) {
      throw new Error(`Artifact state references missing version ${versionId}.`);
    }
    return {
      artifact: {
        ...artifact,
        accessSetting,
        currentVersionId: versionId,
        ownerPrincipalId: ownerPrincipalId ?? artifact.ownerPrincipalId,
        tags: tags ?? artifact.tags,
      },
      replayed,
      version,
    };
  }

  #readManifest(version: VersionRecord) {
    const rows = this.#database
      .prepare(
        `SELECT
          path,
          size,
          media_type AS mediaType,
          sha256,
          disposition
         FROM manifest_entries
         WHERE version_id = ?
         ORDER BY path`,
      )
      .all(version.id);
    const storedEntries = z.array(storedManifestEntryRowSchema).parse(rows);
    const manifest = createManifest({
      entryPath: version.entryPath,
      files: storedEntries.map((entry) => ({
        mediaType: entry.mediaType,
        path: entry.path,
        sha256: entry.sha256,
        size: entry.size,
      })),
      routingMode: version.routingMode,
    });
    if (manifest.digest !== version.manifestDigest) {
      throw new Error(`Saved version ${version.id} has an invalid manifest digest.`);
    }
    const canonicalByPath = new Map(
      manifest.entries.map((entry) => [entry.path, entry] as const),
    );
    for (const stored of storedEntries) {
      const canonical = canonicalByPath.get(stored.path);
      if (canonical?.disposition !== stored.disposition) {
        throw new Error(`Saved version ${version.id} has invalid serving metadata.`);
      }
    }
    return manifest;
  }

  #readVersionOrNull(
    projectId: string,
    versionId: string,
    artifactId: string,
  ): VersionRecord | null {
    const row = this.#database
      .prepare(
        `SELECT
          id,
          project_id AS projectId,
          artifact_id AS artifactId,
          number,
          manifest_digest AS manifestDigest,
          entry_path AS entryPath,
          routing_mode AS routingMode,
          content_token AS contentToken,
          publisher_principal_id AS publisherPrincipalId,
          created_at AS createdAt
         FROM versions
         WHERE project_id = ? AND id = ? AND artifact_id = ?`,
      )
      .get(projectId, versionId, artifactId);
    return versionRowSchema.nullable().parse(row ?? null);
  }

  #findIdempotentResult(
    projectId: string,
    idempotencyKey: string,
    inputDigest: string,
  ): PublishedVersion | null {
    const row = this.#database
      .prepare(
        `SELECT
          access_setting AS accessSetting,
          artifact_id AS artifactId,
          input_digest AS inputDigest,
          operation,
          tags_json AS tagsJson,
          target_owner_principal_id AS targetOwnerPrincipalId,
          version_id AS versionId
         FROM idempotency_records
         WHERE project_id = ? AND idempotency_key = ?`,
      )
      .get(projectId, idempotencyKey);
    const parsed = idempotencyRowSchema.nullable().parse(row ?? null);
    if (parsed === null) return null;
    if (parsed.inputDigest !== inputDigest || parsed.operation !== "publish") {
      throw new IdempotencyConflict({
        message: "The idempotency key was already used with different input.",
      });
    }
    return this.#readPublishedVersion(projectId, parsed.versionId, true);
  }

  #insertAction(
    projectId: string,
    artifactId: string,
    versionId: string,
    idempotencyKey: string,
    createdAt: string,
    action: ArtifactActionRecord["action"],
    principalId: string,
    authorizedByPrincipalId: string | null,
    targetOwnerPrincipalId: string | null = null,
  ): void {
    this.#database
      .prepare(
        `INSERT INTO actions (
          id, project_id, artifact_id, version_id, action, principal_id,
          authorized_by_principal_id, target_owner_principal_id,
          idempotency_key, created_at
        ) VALUES (lower(hex(randomblob(16))), ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        projectId,
        artifactId,
        versionId,
        action,
        principalId,
        authorizedByPrincipalId,
        targetOwnerPrincipalId,
        idempotencyKey,
        createdAt,
      );
  }

  #assertStagedUploadReady(
    source: PublicationSource,
    manifestDigest: string,
    commitTime: string,
  ): void {
    const row = this.#database
      .prepare(
        `SELECT
          u.status AS status,
          u.expires_at AS expiresAt,
          u.manifest_digest AS manifestDigest,
          COUNT(f.storage_token) AS fileCount,
          COALESCE(SUM(CASE WHEN f.uploaded_at IS NOT NULL THEN 1 ELSE 0 END), 0) AS readyCount
        FROM staged_uploads u
        LEFT JOIN staged_upload_files f ON f.upload_id = u.id
        WHERE u.project_id = ? AND u.id = ? AND u.principal_id = ?
        GROUP BY u.id`,
      )
      .get(source.projectId, source.uploadId, source.principalId);
    const upload = stagedUploadCommitRowSchema.nullable().parse(row ?? null);
    if (upload === null) {
      throw new UploadNotFound({message: "The staged upload does not exist."});
    }
    if (upload.status !== uploadStatuses.open) {
      throw new UploadClosed({
        message: "The staged upload is already committed.",
      });
    }
    if (upload.expiresAt <= commitTime) {
      throw new UploadExpired({message: "The staged upload has expired."});
    }
    if (
      upload.fileCount === 0 ||
      upload.readyCount !== upload.fileCount ||
      upload.manifestDigest !== manifestDigest
    ) {
      throw new UploadIncomplete({
        message: "Every declared upload file must be verified before commit.",
      });
    }
  }

  #sealStagedUpload(source: PublicationSource, versionId: string): void {
    const update = this.#database
      .prepare(
        `UPDATE staged_uploads
         SET status = 'committed', committed_version_id = ?
         WHERE project_id = ? AND id = ? AND principal_id = ? AND status = 'open'`,
      )
      .run(versionId, source.projectId, source.uploadId, source.principalId);
    if (update.changes !== 1) {
      throw new UploadClosed({
        message: "The staged upload changed during commit.",
      });
    }
  }

  #insertIdempotency(
    projectId: string,
    idempotencyKey: string,
    inputDigest: string,
    artifactId: string,
    versionId: string,
    createdAt: string,
    operation:
      | "change_access"
      | "change_owner"
      | "change_tags"
      | "delete"
      | "publish"
      | "restore" = "publish",
    accessSetting: ArtifactRecord["accessSetting"] | null = null,
    tagsJson: string | null = null,
    targetOwnerPrincipalId: string | null = null,
  ): void {
    this.#database
      .prepare(
        `INSERT INTO idempotency_records (
          project_id, idempotency_key, input_digest, artifact_id, version_id,
          operation, access_setting, tags_json, target_owner_principal_id,
          created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        projectId,
        idempotencyKey,
        inputDigest,
        artifactId,
        versionId,
        operation,
        accessSetting,
        tagsJson,
        targetOwnerPrincipalId,
        createdAt,
      );
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
  ): void {
    this.#database
      .prepare(
        `INSERT INTO versions (
          id, project_id, artifact_id, number, manifest_digest, entry_path,
          routing_mode, content_token, publisher_principal_id, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        versionId,
        projectId,
        artifactId,
        number,
        manifest.digest,
        manifest.entryPath,
        manifest.routingMode,
        contentToken,
        publisherPrincipalId,
        createdAt,
      );

    const insertEntry = this.#database.prepare(
      `INSERT INTO manifest_entries (
        version_id, path, size, media_type, sha256, disposition
      ) VALUES (?, ?, ?, ?, ?, ?)`,
    );
    for (const entry of manifest.entries) {
      insertEntry.run(
        versionId,
        entry.path,
        entry.size,
        entry.mediaType,
        entry.sha256,
        entry.disposition,
      );
    }
  }

  #migrate(installationId: string): void {
    this.#database.exec(`
      CREATE TABLE IF NOT EXISTS projects (
        id TEXT PRIMARY KEY,
        installation_id TEXT NOT NULL,
        name TEXT NOT NULL,
        created_at TEXT NOT NULL,
        archived_at TEXT
      ) STRICT;

      CREATE TABLE IF NOT EXISTS artifacts (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id),
        name TEXT NOT NULL,
        owner_principal_id TEXT NOT NULL,
        access_setting TEXT NOT NULL CHECK (access_setting IN ('account_required', 'public_link')),
        current_version_id TEXT,
        created_at TEXT NOT NULL,
        deleted_at TEXT
      ) STRICT;

      CREATE TABLE IF NOT EXISTS versions (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id),
        artifact_id TEXT NOT NULL REFERENCES artifacts(id),
        number INTEGER NOT NULL CHECK (number > 0),
        manifest_digest TEXT NOT NULL,
        entry_path TEXT NOT NULL,
        routing_mode TEXT NOT NULL CHECK (routing_mode IN ('static', 'spa')),
        content_token TEXT NOT NULL UNIQUE,
        publisher_principal_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE (artifact_id, number)
      ) STRICT;

      CREATE TABLE IF NOT EXISTS manifest_entries (
        version_id TEXT NOT NULL REFERENCES versions(id),
        path TEXT NOT NULL,
        size INTEGER NOT NULL CHECK (size >= 0),
        media_type TEXT NOT NULL,
        sha256 TEXT NOT NULL,
        disposition TEXT NOT NULL CHECK (disposition IN ('inline', 'attachment')),
        PRIMARY KEY (version_id, path)
      ) STRICT;

      CREATE TABLE IF NOT EXISTS artifact_tags (
        artifact_id TEXT NOT NULL REFERENCES artifacts(id),
        tag TEXT NOT NULL,
        PRIMARY KEY (artifact_id, tag)
      ) STRICT;

      CREATE TABLE IF NOT EXISTS idempotency_records (
        project_id TEXT NOT NULL REFERENCES projects(id),
        idempotency_key TEXT NOT NULL,
        input_digest TEXT NOT NULL,
        artifact_id TEXT NOT NULL REFERENCES artifacts(id),
        version_id TEXT NOT NULL REFERENCES versions(id),
        operation TEXT NOT NULL DEFAULT 'publish' CHECK (operation IN ('publish', 'restore', 'change_access', 'change_owner', 'change_tags', 'delete')),
        access_setting TEXT CHECK (access_setting IS NULL OR access_setting IN ('account_required', 'public_link')),
        tags_json TEXT,
        target_owner_principal_id TEXT,
        created_at TEXT NOT NULL,
        PRIMARY KEY (project_id, idempotency_key)
      ) STRICT;

      CREATE TABLE IF NOT EXISTS actions (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id),
        artifact_id TEXT NOT NULL REFERENCES artifacts(id),
        version_id TEXT NOT NULL REFERENCES versions(id),
        action TEXT NOT NULL,
        principal_id TEXT NOT NULL,
        authorized_by_principal_id TEXT,
        target_owner_principal_id TEXT,
        idempotency_key TEXT NOT NULL,
        created_at TEXT NOT NULL
      ) STRICT;

      CREATE TABLE IF NOT EXISTS staged_uploads (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id),
        principal_id TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('open', 'committed')),
        manifest_digest TEXT NOT NULL,
        entry_path TEXT NOT NULL,
        routing_mode TEXT NOT NULL CHECK (routing_mode IN ('static', 'spa')),
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        committed_version_id TEXT REFERENCES versions(id),
        CHECK (
          (status = 'open' AND committed_version_id IS NULL)
          OR (status = 'committed' AND committed_version_id IS NOT NULL)
        )
      ) STRICT;

      CREATE TABLE IF NOT EXISTS staged_upload_files (
        upload_id TEXT NOT NULL REFERENCES staged_uploads(id),
        storage_token TEXT NOT NULL UNIQUE,
        path TEXT NOT NULL,
        size INTEGER NOT NULL CHECK (size >= 0),
        media_type TEXT NOT NULL,
        sha256 TEXT NOT NULL,
        disposition TEXT NOT NULL CHECK (disposition IN ('inline', 'attachment')),
        uploaded_at TEXT,
        PRIMARY KEY (upload_id, path)
      ) STRICT;

      CREATE TABLE IF NOT EXISTS content_bootstraps (
        token_digest TEXT PRIMARY KEY,
        principal_id TEXT NOT NULL,
        project_id TEXT NOT NULL REFERENCES projects(id),
        artifact_id TEXT NOT NULL REFERENCES artifacts(id),
        version_id TEXT NOT NULL REFERENCES versions(id),
        content_token TEXT NOT NULL,
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        consumed_at TEXT
      ) STRICT;

      CREATE TABLE IF NOT EXISTS content_sessions (
        token_digest TEXT PRIMARY KEY,
        principal_id TEXT NOT NULL,
        project_id TEXT NOT NULL REFERENCES projects(id),
        artifact_id TEXT NOT NULL REFERENCES artifacts(id),
        version_id TEXT NOT NULL REFERENCES versions(id),
        content_token TEXT NOT NULL,
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL
      ) STRICT;

      CREATE INDEX IF NOT EXISTS versions_artifact_id
        ON versions (artifact_id, number);
      CREATE INDEX IF NOT EXISTS artifacts_active_created
        ON artifacts (deleted_at, created_at DESC, id DESC);
      CREATE INDEX IF NOT EXISTS artifact_tags_tag_artifact
        ON artifact_tags (tag, artifact_id);
      CREATE INDEX IF NOT EXISTS actions_artifact_created
        ON actions (artifact_id, created_at DESC, id DESC);
      CREATE INDEX IF NOT EXISTS manifest_entries_sha256
        ON manifest_entries (sha256);
      CREATE INDEX IF NOT EXISTS staged_uploads_expiry
        ON staged_uploads (status, expires_at);
      CREATE INDEX IF NOT EXISTS content_bootstraps_expiry
        ON content_bootstraps (expires_at, consumed_at);
      CREATE INDEX IF NOT EXISTS content_sessions_expiry
        ON content_sessions (expires_at);
    `);
    this.#addArtifactOwnerColumnIfMissing();
    this.#addVersionPublisherColumnIfMissing();
    this.#addActionAuthorizerColumnIfMissing();
    this.#addIdempotencyOperationColumnsIfMissing();
    this.#addTagIdempotencyOperationIfMissing();
    this.#addProjectScopeIfMissing(installationId);
    this.#addSpaRoutingModeIfMissing();
    this.#addProjectScopeIfMissing(installationId);
    this.#addOwnershipOperationIfMissing();
    this.#addProjectScopeIfMissing(installationId);
    this.#database.exec(`
      CREATE INDEX IF NOT EXISTS artifacts_owner_active_created
        ON artifacts (
          project_id, owner_principal_id, deleted_at, created_at DESC, id DESC
        );
      CREATE INDEX IF NOT EXISTS projects_active_created
        ON projects (archived_at, created_at, id);
    `);
  }

  #addSpaRoutingModeIfMissing(): void {
    const rows = this.#database.prepare(
      `SELECT name, sql FROM sqlite_schema
       WHERE type = 'table' AND name IN ('versions', 'staged_uploads')`,
    ).all();
    const schemas = z.array(z.object({name: z.string(), sql: z.string()})).parse(rows);
    if (schemas.every(({sql}) => sql.includes("'spa'"))) return;

    this.#database.exec("PRAGMA foreign_keys = OFF;");
    try {
      this.#database.exec(`
        BEGIN IMMEDIATE;

        DROP TRIGGER IF EXISTS artifacts_project_insert;
        DROP TRIGGER IF EXISTS artifacts_project_update;
        DROP TRIGGER IF EXISTS artifacts_current_version_update;
        DROP TRIGGER IF EXISTS staged_uploads_project_insert;
        DROP TRIGGER IF EXISTS staged_uploads_project_update;
        DROP TRIGGER IF EXISTS versions_project_insert;
        DROP TRIGGER IF EXISTS versions_project_update;
        DROP TRIGGER IF EXISTS actions_project_insert;
        DROP TRIGGER IF EXISTS actions_project_update;
        DROP TRIGGER IF EXISTS idempotency_project_insert;
        DROP TRIGGER IF EXISTS idempotency_project_update;
        DROP TRIGGER IF EXISTS content_bootstrap_project_insert;
        DROP TRIGGER IF EXISTS content_bootstrap_project_update;
        DROP TRIGGER IF EXISTS content_session_project_insert;
        DROP TRIGGER IF EXISTS content_session_project_update;

        CREATE TABLE versions_next (
          id TEXT PRIMARY KEY,
          project_id TEXT NOT NULL REFERENCES projects(id),
          artifact_id TEXT NOT NULL REFERENCES artifacts(id),
          number INTEGER NOT NULL CHECK (number > 0),
          manifest_digest TEXT NOT NULL,
          entry_path TEXT NOT NULL,
          routing_mode TEXT NOT NULL CHECK (routing_mode IN ('static', 'spa')),
          content_token TEXT NOT NULL UNIQUE,
          publisher_principal_id TEXT NOT NULL,
          created_at TEXT NOT NULL,
          UNIQUE (artifact_id, number)
        ) STRICT;
        INSERT INTO versions_next (
          id, project_id, artifact_id, number, manifest_digest, entry_path,
          routing_mode, content_token, publisher_principal_id, created_at
        ) SELECT
          id, project_id, artifact_id, number, manifest_digest, entry_path,
          routing_mode, content_token, publisher_principal_id, created_at
        FROM versions;
        DROP TABLE versions;
        ALTER TABLE versions_next RENAME TO versions;

        CREATE TABLE staged_uploads_next (
          id TEXT PRIMARY KEY,
          project_id TEXT NOT NULL REFERENCES projects(id),
          principal_id TEXT NOT NULL,
          status TEXT NOT NULL CHECK (status IN ('open', 'committed')),
          manifest_digest TEXT NOT NULL,
          entry_path TEXT NOT NULL,
          routing_mode TEXT NOT NULL CHECK (routing_mode IN ('static', 'spa')),
          created_at TEXT NOT NULL,
          expires_at TEXT NOT NULL,
          committed_version_id TEXT REFERENCES versions(id),
          CHECK (
            (status = 'open' AND committed_version_id IS NULL)
            OR (status = 'committed' AND committed_version_id IS NOT NULL)
          )
        ) STRICT;
        INSERT INTO staged_uploads_next (
          id, project_id, principal_id, status, manifest_digest, entry_path,
          routing_mode, created_at, expires_at, committed_version_id
        ) SELECT
          id, project_id, principal_id, status, manifest_digest, entry_path,
          routing_mode, created_at, expires_at, committed_version_id
        FROM staged_uploads;
        DROP TABLE staged_uploads;
        ALTER TABLE staged_uploads_next RENAME TO staged_uploads;

        COMMIT;
      `);
    } catch (cause) {
      this.#database.exec("ROLLBACK;");
      throw cause;
    } finally {
      this.#database.exec("PRAGMA foreign_keys = ON;");
    }
    const failures = this.#database.prepare("PRAGMA foreign_key_check").all();
    if (failures.length > 0) {
      throw new Error("SQLite routing migration produced invalid foreign keys.");
    }
  }

  #addOwnershipOperationIfMissing(): void {
    if (!this.#tableColumns("actions").includes("target_owner_principal_id")) {
      this.#database.exec(
        "ALTER TABLE actions ADD COLUMN target_owner_principal_id TEXT",
      );
    }
    const row = this.#database
      .prepare(
        "SELECT sql FROM sqlite_schema WHERE type = 'table' AND name = 'idempotency_records'",
      )
      .get();
    const {sql} = z.object({sql: z.string()}).parse(row);
    if (
      sql.includes("'change_owner'") &&
      this.#tableColumns("idempotency_records").includes(
        "target_owner_principal_id",
      )
    ) return;

    this.#database.exec("PRAGMA foreign_keys = OFF;");
    try {
      this.#database.exec(`
        BEGIN IMMEDIATE;
        DROP TRIGGER IF EXISTS idempotency_project_insert;
        DROP TRIGGER IF EXISTS idempotency_project_update;

        CREATE TABLE idempotency_records_next (
          project_id TEXT NOT NULL REFERENCES projects(id),
          idempotency_key TEXT NOT NULL,
          input_digest TEXT NOT NULL,
          artifact_id TEXT NOT NULL REFERENCES artifacts(id),
          version_id TEXT NOT NULL REFERENCES versions(id),
          operation TEXT NOT NULL DEFAULT 'publish'
            CHECK (operation IN ('publish', 'restore', 'change_access', 'change_owner', 'change_tags', 'delete')),
          access_setting TEXT
            CHECK (access_setting IS NULL OR access_setting IN ('account_required', 'public_link')),
          tags_json TEXT,
          target_owner_principal_id TEXT,
          created_at TEXT NOT NULL,
          PRIMARY KEY (project_id, idempotency_key)
        ) STRICT;

        INSERT INTO idempotency_records_next (
          project_id, idempotency_key, input_digest, artifact_id, version_id,
          operation, access_setting, tags_json, target_owner_principal_id,
          created_at
        ) SELECT
          project_id, idempotency_key, input_digest, artifact_id, version_id,
          operation, access_setting, tags_json, NULL, created_at
        FROM idempotency_records;

        DROP TABLE idempotency_records;
        ALTER TABLE idempotency_records_next RENAME TO idempotency_records;
        COMMIT;
      `);
    } catch (cause) {
      this.#database.exec("ROLLBACK;");
      throw cause;
    } finally {
      this.#database.exec("PRAGMA foreign_keys = ON;");
    }
    const failures = this.#database.prepare("PRAGMA foreign_key_check").all();
    if (failures.length > 0) {
      throw new Error("SQLite ownership migration produced invalid foreign keys.");
    }
  }

  #addTagIdempotencyOperationIfMissing(): void {
    const row = this.#database
      .prepare(
        "SELECT sql FROM sqlite_schema WHERE type = 'table' AND name = 'idempotency_records'",
      )
      .get();
    const {sql} = z.object({sql: z.string()}).parse(row);
    if (sql.includes("'change_tags'")) return;
    this.#transaction(() => {
      this.#database.exec(`
        CREATE TABLE idempotency_records_next (
          idempotency_key TEXT PRIMARY KEY,
          input_digest TEXT NOT NULL,
          artifact_id TEXT NOT NULL REFERENCES artifacts(id),
          version_id TEXT NOT NULL REFERENCES versions(id),
          operation TEXT NOT NULL DEFAULT 'publish' CHECK (operation IN ('publish', 'restore', 'change_access', 'change_tags', 'delete')),
          access_setting TEXT CHECK (access_setting IS NULL OR access_setting IN ('account_required', 'public_link')),
          tags_json TEXT,
          created_at TEXT NOT NULL
        ) STRICT;

        INSERT INTO idempotency_records_next (
          idempotency_key, input_digest, artifact_id, version_id,
          operation, access_setting, tags_json, created_at
        )
        SELECT
          idempotency_key, input_digest, artifact_id, version_id,
          operation, access_setting, tags_json, created_at
        FROM idempotency_records;

        DROP TABLE idempotency_records;
        ALTER TABLE idempotency_records_next RENAME TO idempotency_records;
      `);
    });
  }

  #addProjectScopeIfMissing(installationId: string): void {
    this.#transaction(() => {
      this.#database.prepare(`
        INSERT OR IGNORE INTO projects (
          id, installation_id, name, created_at, archived_at
        )
        SELECT ?, ?, ?,
          COALESCE(MIN(created_at), strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
          NULL
        FROM artifacts
      `).run(defaultProjectId, installationId, defaultProjectName);

      if (!this.#tableColumns("artifacts").includes("project_id")) {
        this.#database.exec(
          `ALTER TABLE artifacts ADD COLUMN project_id TEXT NOT NULL DEFAULT '${defaultProjectId}'`,
        );
      }
      if (!this.#tableColumns("versions").includes("project_id")) {
        this.#database.exec(
          `ALTER TABLE versions ADD COLUMN project_id TEXT NOT NULL DEFAULT '${defaultProjectId}'`,
        );
      }
      if (!this.#tableColumns("actions").includes("project_id")) {
        this.#database.exec(
          `ALTER TABLE actions ADD COLUMN project_id TEXT NOT NULL DEFAULT '${defaultProjectId}'`,
        );
      }
      if (!this.#tableColumns("staged_uploads").includes("project_id")) {
        this.#database.exec(
          `ALTER TABLE staged_uploads ADD COLUMN project_id TEXT NOT NULL DEFAULT '${defaultProjectId}'`,
        );
      }
      if (!this.#tableColumns("content_bootstraps").includes("project_id")) {
        this.#database.exec(
          `ALTER TABLE content_bootstraps ADD COLUMN project_id TEXT NOT NULL DEFAULT '${defaultProjectId}'`,
        );
      }
      if (!this.#tableColumns("content_sessions").includes("project_id")) {
        this.#database.exec(
          `ALTER TABLE content_sessions ADD COLUMN project_id TEXT NOT NULL DEFAULT '${defaultProjectId}'`,
        );
      }
      if (!this.#tableColumns("idempotency_records").includes("project_id")) {
        this.#database.exec(`
          CREATE TABLE idempotency_records_projected (
            project_id TEXT NOT NULL REFERENCES projects(id),
            idempotency_key TEXT NOT NULL,
            input_digest TEXT NOT NULL,
            artifact_id TEXT NOT NULL REFERENCES artifacts(id),
            version_id TEXT NOT NULL REFERENCES versions(id),
            operation TEXT NOT NULL DEFAULT 'publish'
              CHECK (operation IN ('publish', 'restore', 'change_access', 'change_tags', 'delete')),
            access_setting TEXT
              CHECK (access_setting IS NULL OR access_setting IN ('account_required', 'public_link')),
            tags_json TEXT,
            created_at TEXT NOT NULL,
            PRIMARY KEY (project_id, idempotency_key)
          ) STRICT;

          INSERT INTO idempotency_records_projected (
            project_id, idempotency_key, input_digest, artifact_id, version_id,
            operation, access_setting, tags_json, created_at
          )
          SELECT
            '${defaultProjectId}', idempotency_key, input_digest, artifact_id,
            version_id, operation, access_setting, tags_json, created_at
          FROM idempotency_records;

          DROP TABLE idempotency_records;
          ALTER TABLE idempotency_records_projected
            RENAME TO idempotency_records;
        `);
      }

      this.#database.exec(`
        DROP INDEX IF EXISTS versions_artifact_id;
        DROP INDEX IF EXISTS artifacts_active_created;
        DROP INDEX IF EXISTS artifacts_owner_active_created;
        DROP INDEX IF EXISTS actions_artifact_created;
        DROP INDEX IF EXISTS staged_uploads_expiry;

        CREATE INDEX versions_artifact_id
          ON versions (project_id, artifact_id, number);
        CREATE INDEX artifacts_active_created
          ON artifacts (project_id, deleted_at, created_at DESC, id DESC);
        CREATE INDEX artifacts_owner_active_created
          ON artifacts (
            project_id, owner_principal_id, deleted_at, created_at DESC, id DESC
          );
        CREATE INDEX actions_artifact_created
          ON actions (project_id, artifact_id, created_at DESC, id DESC);
        CREATE INDEX staged_uploads_expiry
          ON staged_uploads (project_id, status, expires_at);

        CREATE TRIGGER IF NOT EXISTS artifacts_project_insert
        BEFORE INSERT ON artifacts
        WHEN NOT EXISTS (
          SELECT 1 FROM projects WHERE id = NEW.project_id
        )
        BEGIN
          SELECT RAISE(ABORT, 'artifact project not found');
        END;

        CREATE TRIGGER IF NOT EXISTS artifacts_project_update
        BEFORE UPDATE OF project_id ON artifacts
        WHEN NEW.project_id <> OLD.project_id
        BEGIN
          SELECT RAISE(ABORT, 'artifact project cannot change');
        END;

        CREATE TRIGGER IF NOT EXISTS artifacts_current_version_update
        BEFORE UPDATE OF current_version_id ON artifacts
        WHEN NEW.current_version_id IS NOT NULL AND NOT EXISTS (
          SELECT 1 FROM versions
          WHERE id = NEW.current_version_id
            AND artifact_id = NEW.id
            AND project_id = NEW.project_id
        )
        BEGIN
          SELECT RAISE(ABORT, 'artifact current version project mismatch');
        END;

        CREATE TRIGGER IF NOT EXISTS staged_uploads_project_insert
        BEFORE INSERT ON staged_uploads
        WHEN NOT EXISTS (
          SELECT 1 FROM projects WHERE id = NEW.project_id
        )
        BEGIN
          SELECT RAISE(ABORT, 'staged upload project not found');
        END;

        CREATE TRIGGER IF NOT EXISTS staged_uploads_project_update
        BEFORE UPDATE OF project_id ON staged_uploads
        WHEN NEW.project_id <> OLD.project_id
        BEGIN
          SELECT RAISE(ABORT, 'staged upload project cannot change');
        END;

        CREATE TRIGGER IF NOT EXISTS versions_project_insert
        BEFORE INSERT ON versions
        WHEN NOT EXISTS (
          SELECT 1 FROM artifacts
          WHERE id = NEW.artifact_id AND project_id = NEW.project_id
        )
        BEGIN
          SELECT RAISE(ABORT, 'version project mismatch');
        END;

        CREATE TRIGGER IF NOT EXISTS versions_project_update
        BEFORE UPDATE OF project_id ON versions
        WHEN NEW.project_id <> OLD.project_id
        BEGIN
          SELECT RAISE(ABORT, 'version project cannot change');
        END;

        CREATE TRIGGER IF NOT EXISTS actions_project_insert
        BEFORE INSERT ON actions
        WHEN NOT EXISTS (
          SELECT 1 FROM artifacts
          WHERE id = NEW.artifact_id AND project_id = NEW.project_id
        ) OR NOT EXISTS (
          SELECT 1 FROM versions
          WHERE id = NEW.version_id AND project_id = NEW.project_id
        )
        BEGIN
          SELECT RAISE(ABORT, 'action project mismatch');
        END;

        CREATE TRIGGER IF NOT EXISTS actions_project_update
        BEFORE UPDATE OF project_id ON actions
        WHEN NEW.project_id <> OLD.project_id
        BEGIN
          SELECT RAISE(ABORT, 'action project cannot change');
        END;

        CREATE TRIGGER IF NOT EXISTS idempotency_project_insert
        BEFORE INSERT ON idempotency_records
        WHEN NOT EXISTS (
          SELECT 1 FROM artifacts
          WHERE id = NEW.artifact_id AND project_id = NEW.project_id
        ) OR NOT EXISTS (
          SELECT 1 FROM versions
          WHERE id = NEW.version_id AND project_id = NEW.project_id
        )
        BEGIN
          SELECT RAISE(ABORT, 'idempotency project mismatch');
        END;

        CREATE TRIGGER IF NOT EXISTS idempotency_project_update
        BEFORE UPDATE OF project_id ON idempotency_records
        WHEN NEW.project_id <> OLD.project_id
        BEGIN
          SELECT RAISE(ABORT, 'idempotency project cannot change');
        END;

        CREATE TRIGGER IF NOT EXISTS content_bootstrap_project_insert
        BEFORE INSERT ON content_bootstraps
        WHEN NOT EXISTS (
          SELECT 1 FROM artifacts
          WHERE id = NEW.artifact_id AND project_id = NEW.project_id
        ) OR NOT EXISTS (
          SELECT 1 FROM versions
          WHERE id = NEW.version_id AND project_id = NEW.project_id
        )
        BEGIN
          SELECT RAISE(ABORT, 'content bootstrap project mismatch');
        END;

        CREATE TRIGGER IF NOT EXISTS content_bootstrap_project_update
        BEFORE UPDATE OF project_id ON content_bootstraps
        WHEN NEW.project_id <> OLD.project_id
        BEGIN
          SELECT RAISE(ABORT, 'content bootstrap project cannot change');
        END;

        CREATE TRIGGER IF NOT EXISTS content_session_project_insert
        BEFORE INSERT ON content_sessions
        WHEN NOT EXISTS (
          SELECT 1 FROM artifacts
          WHERE id = NEW.artifact_id AND project_id = NEW.project_id
        ) OR NOT EXISTS (
          SELECT 1 FROM versions
          WHERE id = NEW.version_id AND project_id = NEW.project_id
        )
        BEGIN
          SELECT RAISE(ABORT, 'content session project mismatch');
        END;

        CREATE TRIGGER IF NOT EXISTS content_session_project_update
        BEFORE UPDATE OF project_id ON content_sessions
        WHEN NEW.project_id <> OLD.project_id
        BEGIN
          SELECT RAISE(ABORT, 'content session project cannot change');
        END;
      `);
    });
    this.#database.exec(`PRAGMA user_version = ${requiredSqliteSchemaVersion};`);
  }

  #addActionAuthorizerColumnIfMissing(): void {
    const columns = this.#tableColumns("actions");
    if (columns.includes("authorized_by_principal_id")) return;
    this.#database.exec(
      "ALTER TABLE actions ADD COLUMN authorized_by_principal_id TEXT",
    );
  }

  #addArtifactOwnerColumnIfMissing(): void {
    const columns = this.#tableColumns("artifacts");
    if (columns.includes("owner_principal_id")) return;
    this.#database.exec(
      "ALTER TABLE artifacts ADD COLUMN owner_principal_id TEXT NOT NULL DEFAULT 'local-api-token'",
    );
  }

  #addIdempotencyOperationColumnsIfMissing(): void {
    const columns = this.#tableColumns("idempotency_records");
    if (!columns.includes("operation")) {
      this.#database.exec(
        "ALTER TABLE idempotency_records ADD COLUMN operation TEXT NOT NULL DEFAULT 'publish' CHECK (operation IN ('publish', 'restore', 'change_access', 'delete'))",
      );
    }
    if (!columns.includes("access_setting")) {
      this.#database.exec(
        "ALTER TABLE idempotency_records ADD COLUMN access_setting TEXT CHECK (access_setting IS NULL OR access_setting IN ('account_required', 'public_link'))",
      );
    }
    if (!columns.includes("tags_json")) {
      this.#database.exec(
        "ALTER TABLE idempotency_records ADD COLUMN tags_json TEXT",
      );
    }
  }

  #addVersionPublisherColumnIfMissing(): void {
    const columns = this.#tableColumns("versions");
    if (columns.includes("publisher_principal_id")) return;
    this.#database.exec(
      "ALTER TABLE versions ADD COLUMN publisher_principal_id TEXT NOT NULL DEFAULT 'local-api-token'",
    );
  }

  #tableColumns(
    table:
      | "actions"
      | "artifacts"
      | "content_bootstraps"
      | "content_sessions"
      | "idempotency_records"
      | "staged_uploads"
      | "versions",
  ): readonly string[] {
    const rows = this.#database.prepare(`PRAGMA table_info(${table})`).all();
    const columns = z.array(z.object({name: z.string()})).parse(rows);
    return columns.map((column) => column.name);
  }

  #readStagedUpload(
    projectId: string,
    uploadId: string,
    principalId: string,
  ): StagedUpload {
    const upload = this.#readStagedUploadOrNull(projectId, uploadId, principalId);
    if (upload === null) {
      throw new Error(`Staged upload ${uploadId} was not found after a successful write.`);
    }
    return upload;
  }

  #readStagedUploadOrNull(
    projectId: string,
    uploadId: string,
    principalId: string,
  ): StagedUpload | null {
    const row = this.#database
      .prepare(
        `SELECT
          id AS id,
          project_id AS projectId,
          principal_id AS principalId,
          status AS status,
          manifest_digest AS manifestDigest,
          entry_path AS entryPath,
          routing_mode AS routingMode,
          created_at AS createdAt,
          expires_at AS expiresAt,
          committed_version_id AS committedVersionId
        FROM staged_uploads
        WHERE project_id = ? AND id = ? AND principal_id = ?`,
      )
      .get(projectId, uploadId, principalId);
    const header = stagedUploadRowSchema.nullable().parse(row ?? null);
    if (header === null) return null;

    const fileRows = this.#database
      .prepare(
        `SELECT
          storage_token AS storageToken,
          path AS path,
          size AS size,
          media_type AS mediaType,
          sha256 AS sha256,
          disposition AS disposition,
          uploaded_at AS uploadedAt
        FROM staged_upload_files
        WHERE upload_id = ?
        ORDER BY path`,
      )
      .all(uploadId);
    const parsedFiles = z.array(stagedUploadFileRowSchema).parse(fileRows);
    const manifest = createManifest({
      entryPath: header.entryPath,
      files: parsedFiles.map((file) => ({
        mediaType: file.mediaType,
        path: file.path,
        sha256: file.sha256,
        size: file.size,
      })),
      routingMode: header.routingMode,
    });
    if (manifest.digest !== header.manifestDigest) {
      throw new Error(`Staged upload ${uploadId} has an invalid persisted manifest digest.`);
    }
    const manifestByPath = new Map(
      manifest.entries.map((entry) => [entry.path, entry] as const),
    );
    const files: readonly StagedUploadFile[] = parsedFiles.map((file) => {
      const entry = manifestByPath.get(file.path);
      if (entry === undefined || entry.disposition !== file.disposition) {
        throw new Error(`Staged upload ${uploadId} has invalid persisted file metadata.`);
      }
      return {
        entry,
        storageToken: file.storageToken,
        uploadedAt: file.uploadedAt,
      };
    });
    const commonUpload = {
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
        ...commonUpload,
        committedVersionId: header.committedVersionId,
        status: header.status,
      };
    }
    return {
      ...commonUpload,
      committedVersionId: header.committedVersionId,
      status: header.status,
    };
  }

  #readPublishedVersion(
    projectId: string,
    versionId: string,
    replayed: boolean,
  ): PublishedVersion {
    const row = this.#database
      .prepare(
        `SELECT
          a.id AS artifactId,
          a.project_id AS projectId,
          a.name AS artifactName,
          a.owner_principal_id AS ownerPrincipalId,
          a.access_setting AS accessSetting,
          a.current_version_id AS currentVersionId,
          a.created_at AS artifactCreatedAt,
          a.deleted_at AS artifactDeletedAt,
          v.id AS versionId,
          v.number AS versionNumber,
          v.manifest_digest AS manifestDigest,
          v.entry_path AS entryPath,
          v.routing_mode AS routingMode,
          v.content_token AS contentToken,
          v.publisher_principal_id AS publisherPrincipalId,
          v.created_at AS versionCreatedAt
        FROM versions v
        JOIN artifacts a ON a.id = v.artifact_id
        WHERE v.project_id = ? AND v.id = ? AND a.deleted_at IS NULL`,
      )
      .get(projectId, versionId);
    const parsed = publishedRowSchema.parse(row);
    const artifact: ArtifactRecord = {
      accessSetting: parsed.accessSetting,
      createdAt: parsed.artifactCreatedAt,
      currentVersionId: parsed.currentVersionId,
      deletedAt: parsed.artifactDeletedAt,
      id: parsed.artifactId,
      name: parsed.artifactName,
      ownerPrincipalId: parsed.ownerPrincipalId,
      projectId: parsed.projectId,
      tags: this.#readTags(parsed.artifactId),
    };
    const version: VersionRecord = {
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
    };
    return {artifact, replayed, version};
  }

  #readPublishedVersionById(
    versionId: string,
    replayed: boolean,
  ): PublishedVersion {
    const row = this.#database.prepare(
      "SELECT project_id AS projectId FROM versions WHERE id = ?",
    ).get(versionId);
    const {projectId} = z.object({projectId: z.string()}).parse(row);
    return this.#readPublishedVersion(projectId, versionId, replayed);
  }

  #readProject(projectId: string): ProjectRecord {
    const project = this.#readProjectOrNull(projectId);
    if (project === null) {
      throw new ProjectNotFound({message: "The project does not exist."});
    }
    return project;
  }

  #readProjectOrNull(projectId: string): ProjectRecord | null {
    const row = this.#database.prepare(`
      SELECT id, installation_id AS installationId, name,
        created_at AS createdAt, archived_at AS archivedAt
      FROM projects
      WHERE id = ?
    `).get(projectId);
    return projectRowSchema.nullable().parse(row ?? null);
  }

  #transaction<Result>(operation: () => Result): Result {
    this.#database.exec("BEGIN IMMEDIATE;");
    try {
      const result = operation();
      this.#database.exec("COMMIT;");
      return result;
    } catch (error) {
      this.#database.exec("ROLLBACK;");
      throw error;
    }
  }
}

function isSqliteConstraint(cause: unknown): boolean {
  return cause instanceof Error && cause.message.includes("constraint failed");
}

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
