import type {DatabaseSync} from "node:sqlite";
import {z} from "zod";

import {downgradeToSchemaFourteen} from "./schema-fourteen.js";

/** Remove the schema 14 trash additions from a populated runtime-built fixture. */
export function downgradeToSchemaThirteen(database: DatabaseSync): void {
  downgradeToSchemaFourteen(database);
  const triggers = z.array(z.object({sql: z.string()})).parse(database.prepare(
    "SELECT sql FROM sqlite_schema WHERE type = 'trigger' AND tbl_name = 'idempotency_records'",
  ).all());
  database.exec(`
    BEGIN IMMEDIATE;
    DROP INDEX artifacts_trash;
    DROP INDEX artifacts_trash_group;
    ALTER TABLE artifacts DROP COLUMN trash_group_id;
    ALTER TABLE artifacts DROP COLUMN purged_at;
    DROP INDEX folders_trash;
    DROP INDEX folders_trash_group;
    DROP INDEX folder_sibling_names;
    DELETE FROM folders WHERE trashed_at IS NOT NULL;
    ALTER TABLE folders DROP COLUMN trashed_at;
    ALTER TABLE folders DROP COLUMN trash_group_id;
    ALTER TABLE folders DROP COLUMN purged_at;
    CREATE UNIQUE INDEX folder_sibling_names
      ON folders (project_id, COALESCE(parent_folder_id, ''), name_key);

    CREATE TABLE folder_actions_thirteen (
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
    INSERT INTO folder_actions_thirteen SELECT * FROM folder_actions
      WHERE action IN ('create', 'rename', 'move', 'rename_move', 'delete');
    DROP TABLE folder_actions;
    ALTER TABLE folder_actions_thirteen RENAME TO folder_actions;
    CREATE UNIQUE INDEX folder_creation_identity
      ON folder_actions (folder_id) WHERE action = 'create';

    CREATE TABLE idempotency_records_thirteen (
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
    INSERT INTO idempotency_records_thirteen SELECT * FROM idempotency_records
      WHERE operation NOT IN ('recover', 'purge');
    DROP TABLE idempotency_records;
    ALTER TABLE idempotency_records_thirteen RENAME TO idempotency_records;
    PRAGMA user_version = 13;
  `);
  for (const trigger of triggers) database.exec(trigger.sql);
  database.exec("COMMIT");
}
