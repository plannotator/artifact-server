import type {DatabaseSync} from "node:sqlite";
import {z} from "zod";

import {
  ArtifactNotFound, FolderFailure, IdempotencyConflict, ProjectArchived,
  ProjectNotFound, TrashFailure,
} from "../core/errors.js";
import {maximumFolderDepth} from "../core/folders.js";
import type {ArtifactRecord} from "../core/model.js";
import type {TrashRepository} from "../core/ports.js";
import type {
  ArtifactPurge, ArtifactRecovery, FolderPurge, FolderRecovery, ListTrash,
  PurgeTrash, RecoverTrash, TrashedItem, TrashLocation, TrashPage, TrashWrite,
} from "../core/trash.js";

const accessSchema = z.enum(["account_required", "public_link"]);
const folderSchema = z.object({
  id: z.string(),
  installationId: z.string(),
  projectId: z.string(),
  parentFolderId: z.string().nullable(),
  name: z.string(),
  nameKey: z.string(),
  revision: z.number().int(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
const folderStateSchema = folderSchema.extend({
  trashedAt: z.string().nullable(),
  trashGroupId: z.string().nullable(),
  purgedAt: z.string().nullable(),
});
const folderColumns = `id, installation_id AS installationId, project_id AS projectId,
  parent_folder_id AS parentFolderId, name, name_key AS nameKey, revision,
  created_at AS createdAt, updated_at AS updatedAt, trashed_at AS trashedAt,
  trash_group_id AS trashGroupId, purged_at AS purgedAt`;
const artifactStateSchema = z.object({
  id: z.string(),
  name: z.string(),
  folderId: z.string().nullable(),
  accessSetting: accessSchema,
  currentVersionId: z.string().nullable(),
  deletedAt: z.string().nullable(),
  purgedAt: z.string().nullable(),
});
const artifactRecordSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  name: z.string(),
  folderId: z.string().nullable().optional(),
  fileKind: z.string().optional(),
  currentVersionCreatedAt: z.string().optional(),
  accessSetting: accessSchema,
  createdAt: z.string(),
  currentVersionId: z.string(),
  deletedAt: z.string().nullable(),
  tags: z.array(z.string()),
});
const placementSchema = z.enum(["original", "root"]);
const artifactRecoverySchema = z.object({
  artifact: artifactRecordSchema,
  placement: placementSchema,
  previousAccessSetting: accessSchema,
});
const folderRecoverySchema = z.object({
  folder: folderSchema,
  placement: placementSchema,
  recoveredArtifactCount: z.number().int().nonnegative(),
  previouslyPublicArtifactIds: z.array(z.string()),
});
const artifactPurgeSchema = z.object({
  artifact: z.object({id: z.string(), projectId: z.string(), name: z.string(), purgedAt: z.string()}),
  retainedVersionCount: z.number().int().nonnegative(),
});
const folderPurgeSchema = z.object({
  folder: folderSchema.extend({purgedAt: z.string()}),
  purgedArtifactCount: z.number().int().nonnegative(),
});
const artifactReplaySchema = z.object({
  inputDigest: z.string(), operation: z.string(), result: z.string().nullable(),
});
const folderReplaySchema = z.object({inputDigest: z.string(), action: z.string(), result: z.string()});
const trashRowSchema = z.object({
  kind: z.enum(["artifact", "folder"]),
  id: z.string(),
  projectId: z.string(),
  name: z.string(),
  folderId: z.string().nullable(),
  trashedAt: z.string(),
  trashGroupId: z.string().nullable(),
  trashedBy: z.string().nullable(),
  accessSetting: accessSchema.nullable(),
  currentVersionId: z.string().nullable(),
  fileKind: z.string().nullable(),
  revision: z.number().int().nullable(),
  artifactCount: z.number().int().nullable(),
});
const countSchema = z.object({count: z.number().int()});
const groupArtifactSchema = z.object({id: z.string(), accessSetting: accessSchema, currentVersionId: z.string()});
const heldStates = "('queued', 'claimed', 'delivered')";

type ArtifactReader = (projectId: string, artifactId: string) => ArtifactRecord | null;
type GitDeletionQueue = (projectId: string, artifactId: string, createdAt: string) => void;

/** Shares the compact catalog connection and write transaction with publication. */
export class SqliteTrash implements TrashRepository {
  private readonly database: DatabaseSync;
  private readonly transaction: <A>(operation: () => A) => A;
  private readonly readArtifact: ArtifactReader;
  private readonly queueGitDeletion: GitDeletionQueue;

  constructor(
    database: DatabaseSync,
    transaction: SqliteTrash["transaction"],
    readArtifact: ArtifactReader,
    queueGitDeletion: GitDeletionQueue,
  ) {
    this.database = database;
    this.transaction = transaction;
    this.readArtifact = readArtifact;
    this.queueGitDeletion = queueGitDeletion;
  }

  async listTrash(command: ListTrash): Promise<TrashPage> {
    return this.transaction(() => {
      const rows = z.array(trashRowSchema).parse(this.database.prepare(`
        SELECT * FROM (
          SELECT 'artifact' AS kind, a.id AS id, a.project_id AS projectId, a.name AS name,
            a.folder_id AS folderId, a.deleted_at AS trashedAt, a.trash_group_id AS trashGroupId,
            (SELECT principal_id FROM actions
              WHERE artifact_id = a.id AND action = 'delete'
              ORDER BY created_at DESC, rowid DESC LIMIT 1) AS trashedBy,
            a.access_setting AS accessSetting, a.current_version_id AS currentVersionId,
            a.file_kind AS fileKind, NULL AS revision, NULL AS artifactCount
          FROM artifacts a JOIN projects p ON p.id = a.project_id
          WHERE p.installation_id = :installationId AND a.deleted_at IS NOT NULL
            AND a.purged_at IS NULL AND a.current_version_id IS NOT NULL
          UNION ALL
          SELECT 'folder', f.id, f.project_id, f.name, f.parent_folder_id, f.trashed_at,
            f.trash_group_id,
            (SELECT principal_id FROM folder_actions
              WHERE folder_id = f.id AND action = 'delete'
              ORDER BY created_at DESC, rowid DESC LIMIT 1),
            NULL, NULL, NULL, f.revision,
            (SELECT COUNT(*) FROM artifacts
              WHERE trash_group_id = f.trash_group_id AND deleted_at IS NOT NULL AND purged_at IS NULL)
          FROM folders f
          WHERE f.installation_id = :installationId AND f.trashed_at IS NOT NULL AND f.purged_at IS NULL
            AND NOT EXISTS (
              SELECT 1 FROM folders parent
              WHERE parent.id = f.parent_folder_id AND parent.trash_group_id = f.trash_group_id
            )
        ) item
        WHERE (:projects IS NULL OR projectId IN (SELECT value FROM json_each(:projects)))
          AND (:cursorAt IS NULL OR trashedAt < :cursorAt OR (trashedAt = :cursorAt AND id < :cursorId))
        ORDER BY trashedAt DESC, id DESC
        LIMIT :limit
      `).all({
        installationId: command.installationId,
        projects: command.projectIds === null ? null : JSON.stringify(command.projectIds),
        cursorAt: command.cursor?.trashedAt ?? null,
        cursorId: command.cursor?.id ?? null,
        limit: command.limit + 1,
      }));
      const items = rows.slice(0, command.limit).map((row) => this.trashedItem(row));
      const last = items.at(-1);
      return {
        items,
        nextCursor: rows.length > command.limit && last !== undefined
          ? {trashedAt: last.trashedAt, id: last.id}
          : null,
      };
    });
  }

  async recover(command: TrashWrite, target: RecoverTrash): Promise<ArtifactRecovery | FolderRecovery> {
    return this.transaction(() => {
      this.assertActive(command);
      return target.kind === "artifact"
        ? this.recoverArtifact(command, target.artifactId)
        : this.recoverFolder(command, target);
    });
  }

  async purge(command: TrashWrite, target: PurgeTrash): Promise<ArtifactPurge | FolderPurge> {
    return this.transaction(() => target.kind === "artifact"
      ? this.purgeArtifact(command, target.artifactId, target.confirmation)
      : this.purgeFolder(command, target.folderId, target.confirmation));
  }

  async holdsTrashedThread(projectId: string, artifactId: string, threadId: string): Promise<boolean> {
    return this.database.prepare(`
      SELECT 1 FROM comment_threads thread
      JOIN artifacts artifact ON artifact.id = thread.artifact_id
      JOIN agent_dispatches dispatch ON dispatch.id = thread.dispatch_id
      WHERE thread.id = ? AND thread.artifact_id = ? AND thread.project_id = ?
        AND artifact.deleted_at IS NOT NULL AND artifact.purged_at IS NULL
        AND dispatch.state IN ${heldStates}
    `).get(threadId, artifactId, projectId) !== undefined;
  }

  private recoverArtifact(command: TrashWrite, artifactId: string): ArtifactRecovery {
    const replay = this.artifactReplay(command, "recover", artifactRecoverySchema);
    if (replay !== null) return {...replay, replayed: true};
    const current = this.trashedArtifact(command.projectId, artifactId);
    const folderLive = current.folderId !== null && this.database.prepare(`
      SELECT 1 FROM folders WHERE id = ? AND project_id = ? AND trashed_at IS NULL
    `).get(current.folderId, command.projectId) !== undefined;
    this.database.prepare(`
      UPDATE artifacts SET deleted_at = NULL, trash_group_id = NULL,
        access_setting = 'account_required', folder_id = ?
      WHERE project_id = ? AND id = ?
    `).run(folderLive ? current.folderId : null, command.projectId, artifactId);
    this.insertAction(command, artifactId, current.currentVersionId, "recover");
    const artifact = this.readArtifact(command.projectId, artifactId);
    if (artifact === null) throw new ArtifactNotFound({message: "The artifact does not exist."});
    const result = {
      artifact,
      placement: current.folderId === null || folderLive ? "original" as const : "root" as const,
      previousAccessSetting: current.accessSetting,
    };
    this.insertIdempotency(command, artifactId, current.currentVersionId, "recover", current.accessSetting, result);
    return {...result, replayed: false};
  }

  private recoverFolder(command: TrashWrite, target: Extract<RecoverTrash, {kind: "folder"}>): FolderRecovery {
    const replay = this.folderReplay(command, "recover", folderRecoverySchema);
    if (replay !== null) return replay;
    const folder = this.trashedGroupRoot(command, target.folderId);
    const parentLive = folder.parentFolderId !== null && this.database.prepare(`
      SELECT 1 FROM folders WHERE id = ? AND project_id = ? AND trashed_at IS NULL
    `).get(folder.parentFolderId, command.projectId) !== undefined;
    const parent = parentLive ? folder.parentFolderId : null;
    const label = target.label ?? folder;
    const sibling = z.object({id: z.string()}).optional().parse(this.database.prepare(`
      SELECT id FROM folders
      WHERE project_id = ? AND parent_folder_id IS ? AND name_key = ? AND id <> ? AND trashed_at IS NULL
    `).get(command.projectId, parent, label.nameKey, folder.id));
    if (sibling !== undefined) {
      throw new FolderFailure({
        reason: "name-conflict",
        conflictingFolderId: sibling.id,
        message: "A sibling folder already uses that name. Recover the folder with a new name.",
      });
    }
    const group = folder.trashGroupId;
    const artifacts = z.array(groupArtifactSchema).parse(this.database.prepare(`
      SELECT id, access_setting AS accessSetting, current_version_id AS currentVersionId
      FROM artifacts
      WHERE project_id = ? AND trash_group_id = ? AND deleted_at IS NOT NULL
        AND purged_at IS NULL AND current_version_id IS NOT NULL
      ORDER BY id
    `).all(command.projectId, group));
    for (const artifact of artifacts) this.insertAction(command, artifact.id, artifact.currentVersionId, "recover");
    this.database.prepare(`
      UPDATE artifacts SET deleted_at = NULL, trash_group_id = NULL, access_setting = 'account_required'
      WHERE project_id = ? AND trash_group_id = ? AND purged_at IS NULL
    `).run(command.projectId, group);
    // Relabel while still trashed: the live-sibling unique index must never
    // see the old name return beside the folder that took it.
    if (parent !== folder.parentFolderId || label.name !== folder.name) {
      this.database.prepare(`
        UPDATE folders SET name = ?, name_key = ?, parent_folder_id = ?, revision = revision + 1,
          updated_at = ?
        WHERE id = ? AND project_id = ?
      `).run(label.name, label.nameKey, parent, command.createdAt, folder.id, command.projectId);
    }
    this.database.prepare(`
      UPDATE folders SET trashed_at = NULL, trash_group_id = NULL
      WHERE project_id = ? AND trash_group_id = ? AND purged_at IS NULL
    `).run(command.projectId, group);
    const recovered = folderSchema.parse(this.database.prepare(`SELECT ${folderColumns} FROM folders WHERE id = ?`)
      .get(folder.id));
    const result: FolderRecovery = {
      folder: recovered,
      placement: folder.parentFolderId === null || parentLive ? "original" : "root",
      recoveredArtifactCount: artifacts.length,
      previouslyPublicArtifactIds: artifacts
        .filter(({accessSetting}) => accessSetting === "public_link")
        .map(({id}) => id),
    };
    this.insertFolderAction(command, folder.id, "recover", result);
    return result;
  }

  private purgeArtifact(command: TrashWrite, artifactId: string, confirmation: string): ArtifactPurge {
    const replay = this.artifactReplay(command, "purge", artifactPurgeSchema);
    if (replay !== null) return replay;
    const current = this.trashedArtifact(command.projectId, artifactId);
    requireConfirmation(confirmation, current.name);
    this.refuseHeld([artifactId]);
    this.database.prepare("UPDATE artifacts SET purged_at = ? WHERE project_id = ? AND id = ?")
      .run(command.createdAt, command.projectId, artifactId);
    this.insertAction(command, artifactId, current.currentVersionId, "purge");
    this.queueGitDeletion(command.projectId, artifactId, command.createdAt);
    const result: ArtifactPurge = {
      artifact: {id: artifactId, projectId: command.projectId, name: current.name, purgedAt: command.createdAt},
      retainedVersionCount: this.versionCount(artifactId),
    };
    this.insertIdempotency(command, artifactId, current.currentVersionId, "purge", null, result);
    return result;
  }

  private purgeFolder(command: TrashWrite, folderId: string, confirmation: string): FolderPurge {
    const replay = this.folderReplay(command, "purge", folderPurgeSchema);
    if (replay !== null) return replay;
    const folder = this.trashedGroupRoot(command, folderId);
    requireConfirmation(confirmation, folder.name);
    const artifacts = z.array(groupArtifactSchema).parse(this.database.prepare(`
      SELECT id, access_setting AS accessSetting, current_version_id AS currentVersionId
      FROM artifacts
      WHERE project_id = ? AND trash_group_id = ? AND deleted_at IS NOT NULL
        AND purged_at IS NULL AND current_version_id IS NOT NULL
      ORDER BY id
    `).all(command.projectId, folder.trashGroupId));
    this.refuseHeld(artifacts.map(({id}) => id));
    for (const artifact of artifacts) {
      this.insertAction(command, artifact.id, artifact.currentVersionId, "purge");
      this.queueGitDeletion(command.projectId, artifact.id, command.createdAt);
    }
    this.database.prepare(`
      UPDATE artifacts SET purged_at = ?
      WHERE project_id = ? AND trash_group_id = ? AND deleted_at IS NOT NULL AND purged_at IS NULL
    `).run(command.createdAt, command.projectId, folder.trashGroupId);
    // Purging a linked folder removes its folder link (file-management-spec.md
    // section 10.6); inventory, capture records, and live grants cascade with it.
    // Nothing under the linked directory is touched.
    this.database.prepare(`
      DELETE FROM folder_links
      WHERE project_id = ? AND folder_id IN (
        SELECT id FROM folders WHERE project_id = ? AND trash_group_id = ? AND purged_at IS NULL
      )
    `).run(command.projectId, command.projectId, folder.trashGroupId);
    this.database.prepare(`
      UPDATE folders SET purged_at = ? WHERE project_id = ? AND trash_group_id = ? AND purged_at IS NULL
    `).run(command.createdAt, command.projectId, folder.trashGroupId);
    const {trashedAt: _trashedAt, trashGroupId: _group, purgedAt: _purged, ...record} = folder;
    const result: FolderPurge = {
      folder: {...record, purgedAt: command.createdAt},
      purgedArtifactCount: artifacts.length,
    };
    this.insertFolderAction(command, folder.id, "purge", result);
    return result;
  }

  private trashedItem(row: z.infer<typeof trashRowSchema>): TrashedItem {
    const base = {
      id: row.id,
      projectId: row.projectId,
      name: row.name,
      location: this.location(row.projectId, row.folderId),
      trashedAt: row.trashedAt,
      trashedBy: row.trashedBy,
      trashGroupId: row.trashGroupId,
    };
    if (row.kind === "folder") {
      return {...base, kind: "folder", revision: row.revision ?? 1, artifactCount: row.artifactCount ?? 0};
    }
    return {
      ...base,
      kind: "artifact",
      accessSetting: row.accessSetting ?? "account_required",
      currentVersionId: row.currentVersionId ?? "",
      fileKind: row.fileKind,
    };
  }

  /** Original placement path, including folders that are now trashed or purged. */
  private location(projectId: string, folderId: string | null): TrashLocation {
    const path: {id: string; name: string}[] = [];
    let next = folderId;
    while (next !== null && path.length < maximumFolderDepth) {
      const row = z.object({id: z.string(), name: z.string(), parentFolderId: z.string().nullable()})
        .optional()
        .parse(this.database.prepare(`
          SELECT id, name, parent_folder_id AS parentFolderId FROM folders WHERE id = ? AND project_id = ?
        `).get(next, projectId));
      if (row === undefined) break;
      path.push({id: row.id, name: row.name});
      next = row.parentFolderId;
    }
    return {projectId, folderId, path: path.toReversed()};
  }

  private trashedArtifact(projectId: string, artifactId: string) {
    const row = artifactStateSchema.optional().parse(this.database.prepare(`
      SELECT id, name, folder_id AS folderId, access_setting AS accessSetting,
        current_version_id AS currentVersionId, deleted_at AS deletedAt, purged_at AS purgedAt
      FROM artifacts WHERE project_id = ? AND id = ?
    `).get(projectId, artifactId));
    if (row === undefined || row.purgedAt !== null || row.currentVersionId === null) {
      throw new ArtifactNotFound({message: "The artifact does not exist."});
    }
    if (row.deletedAt === null) {
      throw new TrashFailure({reason: "not-in-trash", message: "The artifact is not in the trash."});
    }
    return {...row, currentVersionId: row.currentVersionId};
  }

  private trashedGroupRoot(command: TrashWrite, folderId: string) {
    const folder = folderStateSchema.optional().parse(this.database.prepare(`
      SELECT ${folderColumns} FROM folders WHERE id = ? AND project_id = ? AND installation_id = ?
    `).get(folderId, command.projectId, command.installationId));
    if (folder === undefined || folder.purgedAt !== null) {
      throw new FolderFailure({reason: "not-found", message: "The folder does not exist."});
    }
    if (folder.trashedAt === null || folder.trashGroupId === null) {
      throw new TrashFailure({reason: "not-in-trash", message: "The folder is not in the trash."});
    }
    const nested = folder.parentFolderId !== null && this.database.prepare(`
      SELECT 1 FROM folders WHERE id = ? AND trash_group_id = ?
    `).get(folder.parentFolderId, folder.trashGroupId) !== undefined;
    if (nested) {
      throw new TrashFailure({
        reason: "not-in-trash",
        message: "The folder was trashed with its parent. Recover or purge the parent folder instead.",
      });
    }
    return {...folder, trashGroupId: folder.trashGroupId, trashedAt: folder.trashedAt};
  }

  private refuseHeld(artifactIds: readonly string[]): void {
    const held = this.database.prepare(`
      SELECT 1 FROM comment_threads thread
      JOIN agent_dispatches dispatch ON dispatch.id = thread.dispatch_id
      WHERE thread.artifact_id IN (SELECT value FROM json_each(?)) AND dispatch.state IN ${heldStates}
      LIMIT 1
    `).get(JSON.stringify(artifactIds));
    if (held !== undefined) {
      throw new TrashFailure({
        reason: "dispatch-held",
        message: "An agent dispatch still holds comments on this item. Resolve or fail the dispatch before purging.",
      });
    }
  }

  private versionCount(artifactId: string): number {
    return countSchema.parse(this.database.prepare(
      "SELECT COUNT(*) AS count FROM versions WHERE artifact_id = ?",
    ).get(artifactId)).count;
  }

  private artifactReplay<Result>(
    command: TrashWrite, operation: "recover" | "purge", schema: z.ZodType<Result>,
  ): Result | null {
    const row = artifactReplaySchema.optional().parse(this.database.prepare(`
      SELECT input_digest AS inputDigest, operation, placement_result_json AS result
      FROM idempotency_records WHERE project_id = ? AND idempotency_key = ?
    `).get(command.projectId, command.idempotencyKey));
    if (row === undefined) return null;
    if (row.inputDigest !== command.inputDigest || row.operation !== operation || row.result === null) {
      throw replayConflict();
    }
    return schema.parse(JSON.parse(row.result));
  }

  private folderReplay<Result>(
    command: TrashWrite, action: "recover" | "purge", schema: z.ZodType<Result>,
  ): Result | null {
    const row = folderReplaySchema.optional().parse(this.database.prepare(`
      SELECT input_digest AS inputDigest, action, result_json AS result
      FROM folder_actions WHERE project_id = ? AND idempotency_key = ?
    `).get(command.projectId, command.idempotencyKey));
    if (row === undefined) return null;
    if (row.inputDigest !== command.inputDigest || row.action !== action) throw replayConflict();
    return schema.parse(JSON.parse(row.result));
  }

  private insertAction(command: TrashWrite, artifactId: string, versionId: string, action: "recover" | "purge"): void {
    this.database.prepare(`
      INSERT INTO actions (
        id, project_id, artifact_id, version_id, action, principal_id,
        authorized_by_principal_id, idempotency_key, created_at
      ) VALUES (lower(hex(randomblob(16))), ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      command.projectId, artifactId, versionId, action, command.principalId,
      command.authorizedByPrincipalId, command.idempotencyKey, command.createdAt,
    );
  }

  private insertIdempotency(
    command: TrashWrite,
    artifactId: string,
    versionId: string,
    operation: "recover" | "purge",
    accessSetting: string | null,
    result: Omit<ArtifactRecovery, "replayed"> | ArtifactPurge,
  ): void {
    this.database.prepare(`
      INSERT INTO idempotency_records (
        project_id, idempotency_key, input_digest, artifact_id, version_id, operation,
        access_setting, created_at, placement_result_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      command.projectId, command.idempotencyKey, command.inputDigest, artifactId, versionId,
      operation, accessSetting, command.createdAt, JSON.stringify(result),
    );
  }

  private insertFolderAction(
    command: TrashWrite, folderId: string, action: "recover" | "purge", result: FolderRecovery | FolderPurge,
  ): void {
    this.database.prepare(`
      INSERT INTO folder_actions (
        project_id, folder_id, action, principal_id, authorized_by_principal_id,
        idempotency_key, input_digest, result_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      command.projectId, folderId, action, command.principalId, command.authorizedByPrincipalId,
      command.idempotencyKey, command.inputDigest, JSON.stringify(result), command.createdAt,
    );
  }

  private assertActive(scope: TrashWrite): void {
    const row = z.object({archivedAt: z.string().nullable()}).optional().parse(this.database.prepare(`
      SELECT archived_at AS archivedAt FROM projects WHERE id = ? AND installation_id = ?
    `).get(scope.projectId, scope.installationId));
    if (row === undefined) throw new ProjectNotFound({message: "The project does not exist."});
    if (row.archivedAt !== null) {
      throw new ProjectArchived({message: "The project is archived and cannot accept new work."});
    }
  }
}

function requireConfirmation(confirmation: string, name: string): void {
  if (confirmation !== name) {
    throw new TrashFailure({
      reason: "confirmation-mismatch",
      message: "Type the item's exact name to purge it.",
    });
  }
}

function replayConflict(): IdempotencyConflict {
  return new IdempotencyConflict({message: "The idempotency key was already used with different input."});
}
