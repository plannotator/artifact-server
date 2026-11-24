import type {DatabaseSync} from "node:sqlite";
import {z} from "zod";

import {
  ArtifactNotFound, FolderFailure, IdempotencyConflict, ProjectMoveRefused, PublishConflict,
} from "../core/errors.js";
import {
  type ArtifactLocation, type ArtifactPlacement, type ArtifactProjectMove, type FolderProjectMove,
  type FolderRecord, maximumFolderDepth, maximumProjectFolders, maximumProjectMoveArtifacts,
  type ProjectMoveWrite,
} from "../core/folders.js";

/**
 * The project-immutability triggers guard every ordinary write path. A
 * cross-project move is the one sanctioned scope rewrite, so it lifts exactly
 * these triggers inside its own write transaction and reinstalls their stored
 * definitions before commit; a failure rolls the schema back with the rows.
 */
const scopeTriggerNames = ["artifacts_project_update", "versions_project_update", "actions_project_update"] as const;

const placementSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  folderId: z.string().nullable(),
  currentVersionId: z.string(),
  name: z.string(),
});
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
const movedArtifactSchema = z.object({id: z.string(), folderId: z.string().nullable(), currentVersionId: z.string()});
const replaySchema = z.object({inputDigest: z.string(), result: z.string().nullable()});
const triggerSchema = z.array(z.object({name: z.string(), sql: z.string()}));
const subtreeSchema = z.array(z.object({id: z.string(), level: z.number().int()}));
const countSchema = z.object({count: z.number()});
const locationSchema = z.object({artifactId: z.string(), projectId: z.string(), folderId: z.string().nullable()});

type Scope = Pick<ProjectMoveWrite, "installationId" | "projectId">;
type MovedArtifact = z.infer<typeof movedArtifactSchema>;

interface FolderAccess {
  readonly assertActive: (scope: Scope) => void;
  readonly folder: (scope: Scope, id: string) => FolderRecord;
}

/** Cross-project placement that shares the compact catalog's write transaction. */
export class SqliteProjectMoves {
  private readonly database: DatabaseSync;
  private readonly transaction: <A>(operation: () => A) => A;
  private readonly folders: FolderAccess;

  constructor(database: DatabaseSync, transaction: SqliteProjectMoves["transaction"], folders: FolderAccess) {
    this.database = database;
    this.transaction = transaction;
    this.folders = folders;
  }

  async moveArtifactToProject(command: ArtifactProjectMove): Promise<ArtifactPlacement> {
    return this.transaction(() => {
      const destination = this.assertProjects(command);
      const existing = this.database.prepare(`
        SELECT input_digest AS inputDigest, placement_result_json AS result
        FROM idempotency_records WHERE project_id = ? AND idempotency_key = ?
      `).get(command.toProjectId, command.idempotencyKey);
      if (existing !== undefined) return readReplay(replaySchema.parse(existing), command, placementSchema);
      const artifact = this.placement(command.projectId, command.artifactId);
      if (artifact.currentVersionId !== command.expectedCurrentVersionId) {
        throw new PublishConflict({
          currentVersionId: artifact.currentVersionId,
          message: `The artifact moved to version ${artifact.currentVersionId}.`,
        });
      }
      if (command.toFolderId !== null) this.folders.folder(destination, command.toFolderId);
      this.rewrite(command, [{...artifact, folderId: command.toFolderId}]);
      const result = this.placement(command.toProjectId, command.artifactId);
      this.database.prepare(`
        INSERT INTO idempotency_records (
          project_id, idempotency_key, input_digest, artifact_id, version_id, operation,
          created_at, placement_result_json
        ) VALUES (?, ?, ?, ?, ?, 'move', ?, ?)
      `).run(
        command.toProjectId, command.idempotencyKey, command.inputDigest, command.artifactId,
        result.currentVersionId, command.createdAt,
        JSON.stringify({...result, movedFromProjectId: command.projectId}),
      );
      return result;
    });
  }

  async moveFolderToProject(command: FolderProjectMove): Promise<FolderRecord> {
    return this.transaction(() => {
      const destination = this.assertProjects(command);
      const existing = this.database.prepare(`
        SELECT input_digest AS inputDigest, result_json AS result
        FROM folder_actions WHERE project_id = ? AND idempotency_key = ?
      `).get(command.toProjectId, command.idempotencyKey);
      if (existing !== undefined) return readReplay(replaySchema.parse(existing), command, folderSchema);

      const current = this.folders.folder(command, command.folderId);
      if (current.revision !== command.expectedRevision) {
        throw new FolderFailure({reason: "revision", current, message: "The folder changed. Reload it and try again."});
      }
      const subtree = this.subtree(command, current.id);
      const height = Math.max(...subtree.map(({level}) => level));
      if (this.depth(destination, command.toParentFolderId) + height > maximumFolderDepth) {
        throw new FolderFailure({reason: "limit", message: "Folders can be nested at most 16 levels deep."});
      }
      const sibling = this.database.prepare(`
        SELECT 1 FROM folders
        WHERE project_id = ? AND parent_folder_id IS ? AND name_key = ? AND trashed_at IS NULL
      `).get(command.toProjectId, command.toParentFolderId, current.nameKey);
      if (sibling !== undefined) {
        throw new FolderFailure({reason: "name-conflict", message: "A sibling folder already uses that name."});
      }
      const {count} = countSchema.parse(this.database.prepare(
        "SELECT COUNT(*) AS count FROM folders WHERE project_id = ?",
      ).get(command.toProjectId));
      if (count + subtree.length > maximumProjectFolders) {
        throw new FolderFailure({reason: "limit", message: "The destination project has reached the folder limit."});
      }
      const folderIds = JSON.stringify(subtree.map(({id}) => id));
      const artifacts = z.array(movedArtifactSchema).parse(this.database.prepare(`
        SELECT id, folder_id AS folderId, current_version_id AS currentVersionId
        FROM artifacts
        WHERE project_id = ? AND deleted_at IS NULL AND folder_id IN (SELECT value FROM json_each(?))
        ORDER BY id LIMIT ?
      `).all(command.projectId, folderIds, maximumProjectMoveArtifacts + 1));
      if (artifacts.length > maximumProjectMoveArtifacts) {
        throw new ProjectMoveRefused({
          reason: "too-large",
          message: `A folder move can carry at most ${maximumProjectMoveArtifacts} artifacts.`,
        });
      }
      // Trash never changes project: a move carries only the live subtree.
      // Trashed or purged items directly inside a moving folder drop to the
      // source project's root, where recovery returns them; anything inside a
      // trashed folder keeps its place under it, so the trash group stays whole.
      this.database.prepare(`
        UPDATE artifacts SET folder_id = NULL
        WHERE project_id = ? AND deleted_at IS NOT NULL AND folder_id IN (SELECT value FROM json_each(?))
      `).run(command.projectId, folderIds);
      this.database.prepare(`
        UPDATE folders SET parent_folder_id = NULL, revision = revision + 1, updated_at = ?
        WHERE project_id = ? AND trashed_at IS NOT NULL AND parent_folder_id IN (SELECT value FROM json_each(?))
      `).run(command.createdAt, command.projectId, folderIds);
      this.rewrite(command, artifacts);
      this.moveFolderLinks(command, folderIds);
      // One statement re-parents the subtree root as it changes scope, so the
      // sibling-name index never sees it under its old parent in the destination.
      this.database.prepare(`
        UPDATE folders SET project_id = ?,
          parent_folder_id = CASE WHEN id = ? THEN ? ELSE parent_folder_id END,
          revision = CASE WHEN id = ? THEN revision + 1 ELSE revision END,
          updated_at = CASE WHEN id = ? THEN ? ELSE updated_at END
        WHERE project_id = ? AND id IN (SELECT value FROM json_each(?))
      `).run(
        command.toProjectId, current.id, command.toParentFolderId, current.id, current.id,
        command.createdAt, command.projectId, folderIds,
      );
      const result = this.folders.folder(destination, current.id);
      this.database.prepare(`
        INSERT INTO folder_actions (
          project_id, folder_id, action, principal_id, authorized_by_principal_id,
          idempotency_key, input_digest, result_json, created_at
        ) VALUES (?, ?, 'move', ?, ?, ?, ?, ?, ?)
      `).run(
        command.toProjectId, result.id, command.principalId, command.authorizedByPrincipalId,
        command.idempotencyKey, command.inputDigest,
        JSON.stringify({...result, movedFromProjectId: command.projectId}), command.createdAt,
      );
      return result;
    });
  }

  /**
   * A folder link follows its live folder into the destination project, so its
   * scans keep tracking the moved captures. Live-preview grants were issued
   * for the source project and end with the move.
   */
  private moveFolderLinks(command: FolderProjectMove, folderIds: string): void {
    const links = `SELECT id FROM folder_links WHERE project_id = ? AND folder_id IN (SELECT value FROM json_each(?))`;
    const collision = this.database.prepare(`
      SELECT 1 FROM folder_links moving JOIN folder_links taken
        ON taken.project_id = ? AND taken.idempotency_key = moving.idempotency_key
      WHERE moving.id IN (${links})
    `).get(command.toProjectId, command.projectId, folderIds);
    if (collision !== undefined) {
      throw new IdempotencyConflict({
        message: "A folder link in the destination project already uses this link's idempotency key.",
      });
    }
    this.database.prepare(`DELETE FROM folder_entry_live_grants WHERE folder_link_id IN (${links})`)
      .run(command.projectId, folderIds);
    this.database.prepare(`UPDATE folder_links SET project_id = ? WHERE id IN (${links})`)
      .run(command.toProjectId, command.projectId, folderIds);
  }

  async locateArtifact(installationId: string, artifactId: string): Promise<ArtifactLocation | null> {
    const row = this.database.prepare(`
      SELECT artifact.id AS artifactId, artifact.project_id AS projectId, artifact.folder_id AS folderId
      FROM artifacts artifact JOIN projects project ON project.id = artifact.project_id
      WHERE artifact.id = ? AND project.installation_id = ?
    `).get(artifactId, installationId);
    return row === undefined ? null : locationSchema.parse(row);
  }

  private assertProjects(command: ProjectMoveWrite): Scope {
    const destination = {installationId: command.installationId, projectId: command.toProjectId};
    this.folders.assertActive(command);
    this.folders.assertActive(destination);
    return destination;
  }

  private placement(projectId: string, artifactId: string): ArtifactPlacement {
    const row = this.database.prepare(`
      SELECT id, project_id AS projectId, folder_id AS folderId,
        current_version_id AS currentVersionId, name
      FROM artifacts WHERE project_id = ? AND id = ? AND deleted_at IS NULL
    `).get(projectId, artifactId);
    if (row === undefined) throw new ArtifactNotFound({message: "The artifact does not exist."});
    return placementSchema.parse(row);
  }

  private subtree(scope: Scope, id: string) {
    return subtreeSchema.parse(this.database.prepare(`
      WITH RECURSIVE subtree(id, level) AS (
        SELECT ?, 1
        UNION ALL
        SELECT child.id, subtree.level + 1
        FROM folders child JOIN subtree ON child.parent_folder_id = subtree.id
        WHERE child.project_id = ? AND child.trashed_at IS NULL AND subtree.level <= ?
      )
      SELECT id, level FROM subtree
    `).all(id, scope.projectId, maximumFolderDepth));
  }

  private depth(scope: Scope, parent: string | null): number {
    let depth = 0;
    for (let id = parent; id !== null; id = this.folders.folder(scope, id).parentFolderId) {
      depth += 1;
      if (depth > maximumFolderDepth) {
        throw new FolderFailure({reason: "limit", message: "Folders can be nested at most 16 levels deep."});
      }
    }
    return depth;
  }

  /** Refuse, then rewrite every row that copies the moved artifacts' project scope. */
  private rewrite(command: ProjectMoveWrite, artifacts: readonly MovedArtifact[]): void {
    const ids = JSON.stringify(artifacts.map(({id}) => id));
    this.assertMovable(command, ids);
    const triggers = triggerSchema.parse(this.database.prepare(`
      SELECT name, sql FROM sqlite_schema WHERE type = 'trigger' AND name IN (?, ?, ?)
    `).all(...scopeTriggerNames));
    for (const {name} of triggers) this.database.exec(`DROP TRIGGER "${name}"`);
    const moveArtifact = this.database.prepare("UPDATE artifacts SET project_id = ?, folder_id = ? WHERE id = ?");
    for (const artifact of artifacts) moveArtifact.run(command.toProjectId, artifact.folderId, artifact.id);
    for (const table of ["versions", "actions", "comment_threads"] as const) {
      this.database.prepare(`UPDATE ${table} SET project_id = ? WHERE artifact_id IN (SELECT value FROM json_each(?))`)
        .run(command.toProjectId, ids);
    }
    this.database.prepare(`
      UPDATE comment_replies SET project_id = ? WHERE thread_id IN (
        SELECT id FROM comment_threads WHERE artifact_id IN (SELECT value FROM json_each(?))
      )
    `).run(command.toProjectId, ids);
    // Browser sessions and Review leases are bound to the old project; a reader
    // opening the artifact again simply receives a new one.
    for (const table of ["content_bootstraps", "content_sessions"] as const) {
      this.database.prepare(`DELETE FROM ${table} WHERE artifact_id IN (SELECT value FROM json_each(?))`).run(ids);
    }
    for (const {sql} of triggers) this.database.exec(sql);
    const action = this.database.prepare(`
      INSERT INTO actions (
        id, project_id, artifact_id, version_id, action, principal_id,
        authorized_by_principal_id, idempotency_key, created_at
      ) VALUES (lower(hex(randomblob(16))), ?, ?, ?, 'move', ?, ?, ?, ?)
    `);
    for (const artifact of artifacts) {
      action.run(
        command.toProjectId, artifact.id, artifact.currentVersionId, command.principalId,
        command.authorizedByPrincipalId, command.idempotencyKey, command.createdAt,
      );
    }
  }

  private assertMovable(command: ProjectMoveWrite, ids: string): void {
    const held = this.database.prepare(`
      SELECT 1 FROM comment_threads thread JOIN agent_dispatches dispatch ON dispatch.id = thread.dispatch_id
      WHERE thread.artifact_id IN (SELECT value FROM json_each(?))
        AND dispatch.state IN ('queued', 'claimed', 'delivered')
      LIMIT 1
    `).get(ids);
    if (held !== undefined) {
      throw new ProjectMoveRefused({
        reason: "dispatch-held",
        message: "An agent dispatch holds this artifact's comments. Wait for it to finish, or resolve or fail it first.",
      });
    }
    const gitHistory = this.database.prepare(`
      SELECT 1 FROM git_history_project_settings WHERE enabled = 1 AND project_id IN (?, ?)
      UNION ALL SELECT 1 FROM git_history_repositories WHERE artifact_id IN (SELECT value FROM json_each(?))
      UNION ALL SELECT 1 FROM git_history_jobs WHERE artifact_id IN (SELECT value FROM json_each(?))
      UNION ALL SELECT 1 FROM git_history_mappings WHERE artifact_id IN (SELECT value FROM json_each(?))
      LIMIT 1
    `).get(command.projectId, command.toProjectId, ids, ids, ids);
    if (gitHistory !== undefined) {
      throw new ProjectMoveRefused({
        reason: "git-history-enabled",
        message: "Git history is enabled for one of these projects or already holds this artifact, so it cannot change project.",
      });
    }
    const collision = this.database.prepare(`
      SELECT 1 FROM comment_threads moved JOIN comment_threads existing
        ON existing.project_id = ? AND existing.idempotency_key = moved.idempotency_key
      WHERE moved.artifact_id IN (SELECT value FROM json_each(?))
      UNION ALL
      SELECT 1 FROM comment_replies moved
        JOIN comment_threads thread ON thread.id = moved.thread_id
        JOIN comment_replies existing
          ON existing.project_id = ? AND existing.idempotency_key = moved.idempotency_key
      WHERE thread.artifact_id IN (SELECT value FROM json_each(?))
      LIMIT 1
    `).get(command.toProjectId, ids, command.toProjectId, ids);
    if (collision !== undefined) {
      throw new IdempotencyConflict({
        message: "A comment in the destination project already uses an idempotency key from this artifact.",
      });
    }
  }
}

function readReplay<Result>(
  replay: z.infer<typeof replaySchema>, command: Pick<ProjectMoveWrite, "inputDigest">, schema: z.ZodType<Result>,
): Result {
  if (replay.inputDigest !== command.inputDigest || replay.result === null) {
    throw new IdempotencyConflict({message: "The idempotency key was already used with different input."});
  }
  return schema.parse(JSON.parse(replay.result));
}
