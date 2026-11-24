import type {DatabaseSync} from "node:sqlite";
import {z} from "zod";

import {
  ArtifactNotFound, FolderFailure, IdempotencyConflict, ProjectArchived,
  ProjectNotFound, PublishConflict, TrashFailure,
} from "../core/errors.js";
import {
  type ArtifactLocation, type ArtifactPlacement, type ArtifactProjectMove, type FolderProjectMove,
  type ArtifactPlacementChange, type FolderChange, type FolderContents,
  type FolderRecord, type ListFolderContents, maximumFolderDepth,
  maximumProjectFolders, type PlacementWrite,
} from "../core/folders.js";
import type {ArtifactPage} from "../core/model.js";
import {maximumTrashGroupArtifacts} from "../core/trash.js";
import type {ArtifactPlacementRepository, FolderRepository, ListArtifacts} from "../core/ports.js";
import {SqliteProjectMoves} from "./sqlite-project-moves.js";

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

const folderColumns = `id, installation_id AS installationId, project_id AS projectId,
  parent_folder_id AS parentFolderId, name, name_key AS nameKey, revision,
  created_at AS createdAt, updated_at AS updatedAt`;

const placementSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  folderId: z.string().nullable(),
  currentVersionId: z.string(),
  name: z.string(),
});
const replaySchema = z.object({inputDigest: z.string(), result: z.string().nullable()});
const countSchema = z.object({count: z.number()});

type ArtifactWrite = Parameters<ArtifactPlacementRepository["writeArtifactPlacement"]>[0];
type FolderUpdate = Extract<FolderChange, {kind: "update"}>;
type FolderCreate = Extract<FolderChange, {kind: "create"}>;

/** Shares the compact catalog connection and write transaction with publication. */
export class SqliteFolders implements FolderRepository, ArtifactPlacementRepository {
  private readonly database: DatabaseSync;
  private readonly transaction: <A>(operation: () => A) => A;
  private readonly listArtifacts: (command: ListArtifacts, folderId: string | null) => ArtifactPage;
  private readonly moves: SqliteProjectMoves;

  constructor(
    database: DatabaseSync,
    transaction: SqliteFolders["transaction"],
    listArtifacts: SqliteFolders["listArtifacts"],
  ) {
    this.database = database;
    this.transaction = transaction;
    this.listArtifacts = listArtifacts;
    this.moves = new SqliteProjectMoves(database, transaction, {
      assertActive: (scope) => this.assertActive(scope),
      folder: (scope, id) => this.folder(scope, id),
    });
  }

  moveArtifactToProject(command: ArtifactProjectMove): Promise<ArtifactPlacement> {
    return this.moves.moveArtifactToProject(command);
  }

  moveFolderToProject(command: FolderProjectMove): Promise<FolderRecord> {
    return this.moves.moveFolderToProject(command);
  }

  locateArtifact(installationId: string, artifactId: string): Promise<ArtifactLocation | null> {
    return this.moves.locateArtifact(installationId, artifactId);
  }

  async listFolder(command: ListFolderContents): Promise<FolderContents> {
    this.database.exec("BEGIN");
    try {
      const page = this.readContents(command);
      this.database.exec("COMMIT");
      return page;
    } catch (cause) {
      this.database.exec("ROLLBACK");
      throw cause;
    }
  }

  private readContents(command: ListFolderContents): FolderContents {
    const breadcrumbs = this.ancestors(command, command.folderId);
    const cursor = command.cursor;
    const after = cursor?.kind === "folder" ? cursor.nameKey : "";
    const folders = cursor?.kind === "artifact" ? [] : z.array(folderSchema).parse(
      this.database.prepare(`SELECT ${folderColumns} FROM folders
        WHERE project_id = ? AND installation_id = ? AND parent_folder_id IS ?
          AND trashed_at IS NULL AND name_key > ? AND (? IS NULL OR instr(name_key, ?) > 0)
        ORDER BY name_key LIMIT ?`).all(
        command.projectId, command.installationId, command.folderId, after,
        command.search ?? null, command.search ?? null, command.limit + 1,
      ),
    );
    const lastFolder = folders[command.limit - 1];
    if (lastFolder !== undefined && folders.length > command.limit) {
      return {
        breadcrumbs,
        folders: folders.slice(0, command.limit),
        artifacts: [],
        nextCursor: {kind: "folder", nameKey: lastFolder.nameKey},
      };
    }
    if (command.foldersOnly === true) return {breadcrumbs, folders, artifacts: [], nextCursor: null};
    const artifacts = this.listArtifacts({
      ...command,
      cursor: cursor?.kind === "artifact" ? cursor.position : null,
      limit: Math.max(1, command.limit - folders.length),
    }, command.folderId);
    if (lastFolder !== undefined) {
      return {
        breadcrumbs,
        folders,
        artifacts: [],
        nextCursor: artifacts.items.length === 0 ? null : {kind: "folder", nameKey: lastFolder.nameKey},
      };
    }
    return {
      breadcrumbs,
      folders,
      artifacts: artifacts.items,
      nextCursor: artifacts.nextCursor === null ? null : {kind: "artifact", position: artifacts.nextCursor},
    };
  }

  async writeFolder(command: PlacementWrite, change: FolderChange): Promise<FolderRecord> {
    return this.transaction(() => {
      this.assertActive(command);
      const existing = this.database.prepare(`
        SELECT input_digest AS inputDigest, result_json AS result
        FROM folder_actions WHERE project_id = ? AND idempotency_key = ?
      `).get(command.projectId, command.idempotencyKey);
      if (existing !== undefined) return readReplay(replaySchema.parse(existing), command, folderSchema);

      if (change.kind === "create") return this.createFolder(command, change);

      const current = this.folder(command, change.id);
      if (current.revision !== change.expectedRevision) {
        throw new FolderFailure({reason: "revision", current, message: "The folder changed. Reload it and try again."});
      }
      if (change.kind === "delete") return this.trashFolder(command, current, change.trashGroupId);
      return this.updateFolder(command, current, change);
    });
  }

  private createFolder(command: PlacementWrite, change: FolderCreate): FolderRecord {
    const created = this.database.prepare(`
      SELECT input_digest AS inputDigest, result_json AS result
      FROM folder_actions WHERE folder_id = ? AND action = 'create' AND project_id = ?
    `).get(change.id, command.projectId);
    if (created !== undefined) {
      return readReplay(replaySchema.parse(created), command, folderSchema);
    }
    if (this.database.prepare("SELECT 1 FROM folder_actions WHERE folder_id = ? AND action = 'create'").get(change.id)) {
      throw new IdempotencyConflict({message: "The folder ID has already been used."});
    }
    this.checkDestination(command, change.id, change.parentFolderId, 1);
    this.checkName(command.projectId, change.parentFolderId, change.label.nameKey, change.id);
    const {count} = countSchema.parse(this.database.prepare(
      "SELECT COUNT(*) AS count FROM folders WHERE project_id = ?",
    ).get(command.projectId));
    if (count >= maximumProjectFolders) {
      throw new FolderFailure({reason: "limit", message: "The project has reached the folder limit."});
    }

    this.database.prepare(`
      INSERT INTO folders (
        id, installation_id, project_id, parent_folder_id, name, name_key, revision,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)
    `).run(
      change.id, command.installationId, command.projectId, change.parentFolderId,
      change.label.name, change.label.nameKey, command.createdAt, command.createdAt,
    );
    return this.recordFolderAction(command, "create", this.folder(command, change.id));
  }

  private updateFolder(command: PlacementWrite, current: FolderRecord, change: FolderUpdate): FolderRecord {
    const parent = change.parentFolderId === undefined ? current.parentFolderId : change.parentFolderId;
    const label = change.label ?? current;
    if (parent !== current.parentFolderId) {
      this.checkDestination(command, current.id, parent, this.subtreeHeight(command.projectId, current.id));
    }
    this.checkName(command.projectId, parent, label.nameKey, current.id);
    this.database.prepare(`
      UPDATE folders SET name = ?, name_key = ?, parent_folder_id = ?,
        revision = revision + 1, updated_at = ? WHERE id = ? AND project_id = ?
    `).run(label.name, label.nameKey, parent, command.createdAt, current.id, command.projectId);
    const action = change.parentFolderId === undefined ? "rename"
      : change.label === undefined ? "move" : "rename_move";
    return this.recordFolderAction(command, action, this.folder(command, current.id));
  }

  /** Tombstone the folder and its live subtree as one recoverable trash group. */
  private trashFolder(command: PlacementWrite, current: FolderRecord, trashGroupId: string): FolderRecord {
    const subtree = JSON.stringify(z.array(z.object({id: z.string()})).parse(this.database.prepare(`
      WITH RECURSIVE subtree(id, level) AS (
        SELECT ?, 1
        UNION ALL
        SELECT child.id, subtree.level + 1
        FROM folders child JOIN subtree ON child.parent_folder_id = subtree.id
        WHERE child.project_id = ? AND child.trashed_at IS NULL AND subtree.level <= ?
      )
      SELECT id FROM subtree
    `).all(current.id, current.projectId, maximumFolderDepth)).map(({id}) => id));
    const {count} = countSchema.parse(this.database.prepare(`
      SELECT COUNT(*) AS count FROM artifacts
      WHERE project_id = ? AND deleted_at IS NULL AND folder_id IN (SELECT value FROM json_each(?))
    `).get(current.projectId, subtree));
    if (count > maximumTrashGroupArtifacts) {
      throw new TrashFailure({
        reason: "too-large",
        message: `A folder with more than ${maximumTrashGroupArtifacts} artifacts cannot be moved to the trash at once.`,
      });
    }
    this.database.prepare(`
      UPDATE folders SET trashed_at = ?, trash_group_id = ?
      WHERE project_id = ? AND id IN (SELECT value FROM json_each(?))
    `).run(command.createdAt, trashGroupId, current.projectId, subtree);
    this.database.prepare(`
      UPDATE artifacts SET deleted_at = ?, trash_group_id = ?
      WHERE project_id = ? AND deleted_at IS NULL AND folder_id IN (SELECT value FROM json_each(?))
    `).run(command.createdAt, trashGroupId, current.projectId, subtree);
    this.database.prepare(`
      INSERT INTO actions (
        id, project_id, artifact_id, version_id, action, principal_id,
        authorized_by_principal_id, idempotency_key, created_at
      )
      SELECT lower(hex(randomblob(16))), project_id, id, current_version_id, 'delete', ?, ?, ?, ?
      FROM artifacts
      WHERE project_id = ? AND trash_group_id = ? AND current_version_id IS NOT NULL
    `).run(
      command.principalId, command.authorizedByPrincipalId, command.idempotencyKey,
      command.createdAt, current.projectId, trashGroupId,
    );
    return this.recordFolderAction(command, "delete", current);
  }

  private recordFolderAction(
    command: PlacementWrite,
    action: "create" | "rename" | "move" | "rename_move" | "delete",
    result: FolderRecord,
  ): FolderRecord {
    this.database.prepare(`
      INSERT INTO folder_actions (
        project_id, folder_id, action, principal_id, authorized_by_principal_id,
        idempotency_key, input_digest, result_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      command.projectId, result.id, action, command.principalId, command.authorizedByPrincipalId,
      command.idempotencyKey, command.inputDigest, JSON.stringify(result), command.createdAt,
    );
    return result;
  }

  async writeArtifactPlacement(command: ArtifactWrite, change: ArtifactPlacementChange) {
    return this.transaction(() => {
      this.assertActive(command);
      const current = this.artifact(command);
      const existing = this.database.prepare(`
        SELECT input_digest AS inputDigest, placement_result_json AS result
        FROM idempotency_records WHERE project_id = ? AND idempotency_key = ?
      `).get(command.projectId, command.idempotencyKey);
      if (existing !== undefined) return readReplay(replaySchema.parse(existing), command, placementSchema);
      if (current.currentVersionId !== command.expectedCurrentVersionId) {
        throw new PublishConflict({
          currentVersionId: current.currentVersionId,
          message: `The artifact moved to version ${current.currentVersionId}.`,
        });
      }
      this.updatePlacement(command, change);
      const result = this.artifact(command);
      this.recordPlacementAction(command, change.kind, result);
      return result;
    });
  }

  private updatePlacement(command: ArtifactWrite, change: ArtifactPlacementChange): void {
    if (change.kind === "move") {
      if (change.toFolderId !== null) this.folder(command, change.toFolderId);
      this.database.prepare("UPDATE artifacts SET folder_id = ? WHERE project_id = ? AND id = ?")
        .run(change.toFolderId, command.projectId, command.artifactId);
    } else {
      this.database.prepare("UPDATE artifacts SET name = ?, search_name = ? WHERE project_id = ? AND id = ?")
        .run(change.name, change.searchName, command.projectId, command.artifactId);
    }
  }

  private recordPlacementAction(
    command: ArtifactWrite,
    action: ArtifactPlacementChange["kind"],
    result: z.infer<typeof placementSchema>,
  ): void {
    this.database.prepare(`
      INSERT INTO actions (
        id, project_id, artifact_id, version_id, action, principal_id,
        authorized_by_principal_id, idempotency_key, created_at
      ) VALUES (lower(hex(randomblob(16))), ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      command.projectId, command.artifactId, command.expectedCurrentVersionId, action,
      command.principalId, command.authorizedByPrincipalId, command.idempotencyKey, command.createdAt,
    );
    this.database.prepare(`
      INSERT INTO idempotency_records (
        project_id, idempotency_key, input_digest, artifact_id, version_id, operation,
        created_at, placement_result_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      command.projectId, command.idempotencyKey, command.inputDigest, command.artifactId,
      command.expectedCurrentVersionId, action, command.createdAt, JSON.stringify(result),
    );
  }

  private artifact(command: ArtifactWrite) {
    const row = this.database.prepare(`
      SELECT id, project_id AS projectId, folder_id AS folderId,
        current_version_id AS currentVersionId, name
      FROM artifacts WHERE project_id = ? AND id = ? AND deleted_at IS NULL
    `).get(command.projectId, command.artifactId);
    if (row === undefined) throw new ArtifactNotFound({message: "The artifact does not exist."});
    return placementSchema.parse(row);
  }

  private assertActive(scope: FolderScope): void {
    const row = this.database.prepare(`
      SELECT archived_at AS archivedAt FROM projects WHERE id = ? AND installation_id = ?
    `).get(scope.projectId, scope.installationId);
    if (row === undefined) throw new ProjectNotFound({message: "The project does not exist."});
    if (row["archivedAt"] !== null) {
      throw new ProjectArchived({message: "The project is archived and cannot accept new work."});
    }
  }

  private folder(scope: FolderScope, id: string): FolderRecord {
    const row = this.database.prepare(`SELECT ${folderColumns} FROM folders
      WHERE project_id = ? AND installation_id = ? AND id = ? AND trashed_at IS NULL`)
      .get(scope.projectId, scope.installationId, id);
    if (row === undefined) throw new FolderFailure({reason: "not-found", message: "The folder does not exist."});
    return folderSchema.parse(row);
  }

  private ancestors(scope: FolderScope, id: string | null): FolderRecord[] {
    const path: FolderRecord[] = [];
    const seen = new Set<string>();
    while (id !== null) {
      if (seen.has(id)) throw folderCycle();
      if (path.length === maximumFolderDepth) throw folderDepth();
      seen.add(id);
      const folder = this.folder(scope, id);
      path.push(folder);
      id = folder.parentFolderId;
    }
    return path.toReversed();
  }

  private checkDestination(scope: FolderScope, id: string, parent: string | null, height: number): void {
    const path = this.ancestors(scope, parent);
    if (path.some((folder) => folder.id === id)) throw folderCycle();
    if (path.length + height > maximumFolderDepth) throw folderDepth();
  }

  private subtreeHeight(projectId: string, id: string): number {
    const row = this.database.prepare(`
      WITH RECURSIVE subtree(id, level) AS (
        SELECT ?, 1
        UNION ALL
        SELECT child.id, subtree.level + 1
        FROM folders child JOIN subtree ON child.parent_folder_id = subtree.id
        WHERE child.project_id = ? AND child.trashed_at IS NULL AND subtree.level <= ?
      )
      SELECT MAX(level) AS count FROM subtree
    `).get(id, projectId, maximumFolderDepth);
    return countSchema.parse(row).count;
  }

  private checkName(projectId: string, parent: string | null, key: string, id: string): void {
    const sibling = this.database.prepare(`
      SELECT 1 FROM folders WHERE project_id = ? AND parent_folder_id IS ? AND name_key = ? AND id <> ?
        AND trashed_at IS NULL
    `).get(projectId, parent, key, id);
    if (sibling !== undefined) {
      throw new FolderFailure({reason: "name-conflict", message: "A sibling folder already uses that name."});
    }
  }
}

type FolderScope = Pick<PlacementWrite, "projectId" | "installationId">;

function readReplay<Result>(
  replay: z.infer<typeof replaySchema>, command: PlacementWrite, schema: z.ZodType<Result>,
): Result {
  if (replay.inputDigest !== command.inputDigest || replay.result === null) {
    throw new IdempotencyConflict({message: "The idempotency key was already used with different input."});
  }
  return schema.parse(JSON.parse(replay.result));
}

function folderCycle(): FolderFailure {
  return new FolderFailure({reason: "cycle", message: "A folder cannot be moved into itself or a descendant."});
}

function folderDepth(): FolderFailure {
  return new FolderFailure({reason: "limit", message: "Folders can be nested at most 16 levels deep."});
}
