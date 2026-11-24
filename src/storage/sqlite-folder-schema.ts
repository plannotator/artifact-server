import type {DatabaseSync} from "node:sqlite";
import {z} from "zod";

import {classifyFileKind} from "../core/file-kind.js";

/** Schema revision that introduced folders and placement. */
export const folderSqliteSchemaVersion = 13;

/** Install phase-one placement schema and backfill existing current versions. */
export function migrateSqliteFolders(database: DatabaseSync): void {
  const triggers = z.array(z.object({sql: z.string()})).parse(database.prepare(
    "SELECT sql FROM sqlite_schema WHERE type = 'trigger' AND tbl_name = 'idempotency_records'",
  ).all());
  database.exec(`
    CREATE TABLE folders (
      id TEXT PRIMARY KEY,
      installation_id TEXT NOT NULL,
      project_id TEXT NOT NULL REFERENCES projects(id),
      parent_folder_id TEXT REFERENCES folders(id),
      name TEXT NOT NULL,
      name_key TEXT NOT NULL,
      revision INTEGER NOT NULL CHECK (revision > 0),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    ) STRICT;

    CREATE UNIQUE INDEX folder_sibling_names
      ON folders (project_id, COALESCE(parent_folder_id, ''), name_key);

    CREATE INDEX folder_children
      ON folders (project_id, parent_folder_id, name_key);

    CREATE TABLE folder_actions (
      project_id TEXT NOT NULL REFERENCES projects(id),
      folder_id TEXT NOT NULL,
      action TEXT NOT NULL CHECK (action IN ('create', 'rename', 'move', 'rename_move', 'delete')),
      principal_id TEXT NOT NULL,
      authorized_by_principal_id TEXT,
      idempotency_key TEXT NOT NULL,
      input_digest TEXT NOT NULL,
      result_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (project_id, idempotency_key)
    ) STRICT;

    CREATE UNIQUE INDEX folder_creation_identity
      ON folder_actions (folder_id) WHERE action = 'create';

    ALTER TABLE artifacts ADD COLUMN folder_id TEXT REFERENCES folders(id);
    ALTER TABLE artifacts ADD COLUMN file_kind TEXT;
    ALTER TABLE artifacts ADD COLUMN current_version_created_at TEXT;
    ALTER TABLE artifacts ADD COLUMN current_size INTEGER CHECK (current_size >= 0);

    CREATE INDEX artifacts_folder_catalog
      ON artifacts (project_id, folder_id, deleted_at, created_at DESC, id DESC);

    CREATE TABLE idempotency_records_placement (
      project_id TEXT NOT NULL REFERENCES projects(id),
      idempotency_key TEXT NOT NULL,
      input_digest TEXT NOT NULL,
      artifact_id TEXT NOT NULL REFERENCES artifacts(id),
      version_id TEXT NOT NULL REFERENCES versions(id),
      operation TEXT NOT NULL DEFAULT 'publish' CHECK (operation IN (
        'publish', 'restore', 'change_access', 'change_tags', 'delete', 'rename', 'move'
      )),
      access_setting TEXT CHECK (access_setting IS NULL OR access_setting IN ('account_required', 'public_link')),
      tags_json TEXT,
      created_at TEXT NOT NULL,
      placement_result_json TEXT,
      PRIMARY KEY (project_id, idempotency_key)
    ) STRICT;
    INSERT INTO idempotency_records_placement (
      project_id, idempotency_key, input_digest, artifact_id, version_id,
      operation, access_setting, tags_json, created_at
    )
    SELECT project_id, idempotency_key, input_digest, artifact_id, version_id,
      operation, access_setting, tags_json, created_at
    FROM idempotency_records;
    DROP TABLE idempotency_records;
    ALTER TABLE idempotency_records_placement RENAME TO idempotency_records;
  `);
  for (const trigger of triggers) database.exec(trigger.sql);
  const artifacts = z.array(z.object({id: z.string(), currentVersionId: z.string()})).parse(database.prepare(`
    SELECT id, current_version_id AS currentVersionId FROM artifacts WHERE current_version_id IS NOT NULL
  `).all());
  for (const artifact of artifacts) writeSqliteCurrentFileMetadata(database, artifact.id, artifact.currentVersionId);
  database.exec(`PRAGMA user_version = ${folderSqliteSchemaVersion};`);
}

const currentFileMetadata = z.object({
  createdAt: z.string(),
  entryPath: z.string(),
  mediaType: z.string(),
  entryCount: z.number().int().positive(),
  totalSize: z.number().int().nonnegative(),
});

/** Refresh denormalized fields after a current-version change inside the write transaction. */
export function writeSqliteCurrentFileMetadata(database: DatabaseSync, artifactId: string, versionId: string): void {
  const raw = database.prepare(`
    SELECT created_at AS createdAt, entry_path AS entryPath, entry.media_type AS mediaType,
      (SELECT COUNT(*) FROM manifest_entries WHERE version_id = version.id) AS entryCount,
      (SELECT SUM(size) FROM manifest_entries WHERE version_id = version.id) AS totalSize
    FROM versions version
    JOIN manifest_entries entry ON entry.version_id = version.id AND entry.path = version.entry_path
    WHERE version.id = ? AND version.artifact_id = ?
  `).get(versionId, artifactId);
  // Early data may contain an incomplete artifact. Integrity reports its missing
  // manifest and the migration preserves the original record for inspection.
  if (raw === undefined) return;
  const {createdAt, entryPath, mediaType, entryCount, totalSize} = currentFileMetadata.parse(raw);
  database.prepare(`
    UPDATE artifacts SET file_kind = ?, current_version_created_at = ?, current_size = ?
    WHERE id = ?
  `).run(classifyFileKind(mediaType, entryPath, entryCount), createdAt, totalSize, artifactId);
}
