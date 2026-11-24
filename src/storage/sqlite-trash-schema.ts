import type {DatabaseSync} from "node:sqlite";
import {z} from "zod";

/** Schema revision that makes tombstones recoverable trash entries. */
export const trashSqliteSchemaVersion = 14;

/**
 * Add trash groups and purge marks. Existing tombstones need no backfill:
 * `deleted_at` without `purged_at` is exactly a recoverable trash entry.
 * Runs inside the caller's migration transaction.
 */
export function migrateSqliteTrash(database: DatabaseSync): void {
  const triggers = z.array(z.object({sql: z.string()})).parse(database.prepare(
    "SELECT sql FROM sqlite_schema WHERE type = 'trigger' AND tbl_name = 'idempotency_records'",
  ).all());
  database.exec(`
    ALTER TABLE artifacts ADD COLUMN trash_group_id TEXT;
    ALTER TABLE artifacts ADD COLUMN purged_at TEXT;
    CREATE INDEX artifacts_trash
      ON artifacts (deleted_at DESC, id DESC) WHERE deleted_at IS NOT NULL AND purged_at IS NULL;
    CREATE INDEX artifacts_trash_group
      ON artifacts (trash_group_id) WHERE trash_group_id IS NOT NULL;

    ALTER TABLE folders ADD COLUMN trashed_at TEXT;
    ALTER TABLE folders ADD COLUMN trash_group_id TEXT;
    ALTER TABLE folders ADD COLUMN purged_at TEXT;
    DROP INDEX folder_sibling_names;
    CREATE UNIQUE INDEX folder_sibling_names
      ON folders (project_id, COALESCE(parent_folder_id, ''), name_key) WHERE trashed_at IS NULL;
    CREATE INDEX folders_trash
      ON folders (trashed_at DESC, id DESC) WHERE trashed_at IS NOT NULL AND purged_at IS NULL;
    CREATE INDEX folders_trash_group
      ON folders (trash_group_id) WHERE trash_group_id IS NOT NULL;

    CREATE TABLE folder_actions_trash (
      project_id TEXT NOT NULL REFERENCES projects(id),
      folder_id TEXT NOT NULL,
      action TEXT NOT NULL CHECK (action IN (
        'create', 'rename', 'move', 'rename_move', 'delete', 'recover', 'purge'
      )),
      principal_id TEXT NOT NULL,
      authorized_by_principal_id TEXT,
      idempotency_key TEXT NOT NULL,
      input_digest TEXT NOT NULL,
      result_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (project_id, idempotency_key)
    ) STRICT;
    INSERT INTO folder_actions_trash SELECT
      project_id, folder_id, action, principal_id, authorized_by_principal_id,
      idempotency_key, input_digest, result_json, created_at
    FROM folder_actions;
    DROP TABLE folder_actions;
    ALTER TABLE folder_actions_trash RENAME TO folder_actions;
    CREATE UNIQUE INDEX folder_creation_identity
      ON folder_actions (folder_id) WHERE action = 'create';

    CREATE TABLE idempotency_records_trash (
      project_id TEXT NOT NULL REFERENCES projects(id),
      idempotency_key TEXT NOT NULL,
      input_digest TEXT NOT NULL,
      artifact_id TEXT NOT NULL REFERENCES artifacts(id),
      version_id TEXT NOT NULL REFERENCES versions(id),
      operation TEXT NOT NULL DEFAULT 'publish' CHECK (operation IN (
        'publish', 'restore', 'change_access', 'change_tags', 'delete', 'rename', 'move',
        'recover', 'purge'
      )),
      access_setting TEXT CHECK (access_setting IS NULL OR access_setting IN ('account_required', 'public_link')),
      tags_json TEXT,
      created_at TEXT NOT NULL,
      placement_result_json TEXT,
      PRIMARY KEY (project_id, idempotency_key)
    ) STRICT;
    INSERT INTO idempotency_records_trash SELECT
      project_id, idempotency_key, input_digest, artifact_id, version_id,
      operation, access_setting, tags_json, created_at, placement_result_json
    FROM idempotency_records;
    DROP TABLE idempotency_records;
    ALTER TABLE idempotency_records_trash RENAME TO idempotency_records;
  `);
  for (const trigger of triggers) database.exec(trigger.sql);
  database.exec(`PRAGMA user_version = ${trashSqliteSchemaVersion};`);
}
