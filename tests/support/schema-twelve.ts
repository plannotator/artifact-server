import type {DatabaseSync} from "node:sqlite";
import {z} from "zod";

/** Remove the schema 13 and later additions from a populated runtime-built fixture. */
export function downgradeToSchemaTwelve(database: DatabaseSync): void {
  const triggers = z.array(z.object({sql: z.string()})).parse(database.prepare(
    "SELECT sql FROM sqlite_schema WHERE type = 'trigger' AND tbl_name = 'idempotency_records'",
  ).all());
  database.exec(`
    BEGIN IMMEDIATE;
    DROP TABLE IF EXISTS folder_entry_live_grants;
    DROP TABLE IF EXISTS folder_link_captures;
    DROP TABLE IF EXISTS folder_inventory;
    DROP TABLE IF EXISTS folder_links;
    DROP INDEX IF EXISTS artifacts_source_path;
    DROP INDEX artifacts_folder_catalog;
    ALTER TABLE artifacts DROP COLUMN folder_id;
    ALTER TABLE artifacts DROP COLUMN file_kind;
    ALTER TABLE artifacts DROP COLUMN current_version_created_at;
    ALTER TABLE artifacts DROP COLUMN current_size;
    DROP TABLE folder_actions;
    DROP TABLE folders;

    CREATE TABLE idempotency_records_twelve (
      project_id TEXT NOT NULL REFERENCES projects(id),
      idempotency_key TEXT NOT NULL,
      input_digest TEXT NOT NULL,
      artifact_id TEXT NOT NULL REFERENCES artifacts(id),
      version_id TEXT NOT NULL REFERENCES versions(id),
      operation TEXT NOT NULL DEFAULT 'publish' CHECK (operation IN (
        'publish', 'restore', 'change_access', 'change_tags', 'delete'
      )),
      access_setting TEXT CHECK (access_setting IS NULL OR access_setting IN ('account_required', 'public_link')),
      tags_json TEXT,
      created_at TEXT NOT NULL,
      PRIMARY KEY (project_id, idempotency_key)
    ) STRICT;
    INSERT INTO idempotency_records_twelve
    SELECT project_id, idempotency_key, input_digest, artifact_id, version_id,
      operation, access_setting, tags_json, created_at
    FROM idempotency_records;
    DROP TABLE idempotency_records;
    ALTER TABLE idempotency_records_twelve RENAME TO idempotency_records;
    PRAGMA user_version = 12;
  `);
  for (const trigger of triggers) database.exec(trigger.sql);
  database.exec("COMMIT");
}
