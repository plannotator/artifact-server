import type {DatabaseSync} from "node:sqlite";

/**
 * Schema revision that indexes the cross-project file overview. Kept a
 * self-contained step so it can be renumbered when parallel schema work merges.
 */
export const fileCatalogSqliteSchemaVersion = 16;

/** Overview indexes created by the schema step, named so fixtures can remove them. */
export const fileCatalogSqliteIndexes = [
  "artifacts_files_updated",
  "artifacts_files_kind_updated",
  "artifacts_files_created",
  "artifacts_files_name",
  "artifacts_files_size",
] as const;

/**
 * Index the denormalized current-version columns so overview pages never sort
 * or join version tables per row (spec section 13). Live rows only: trash has
 * its own indexes. Runs inside the caller's migration transaction.
 */
export function migrateSqliteFileCatalog(database: DatabaseSync): void {
  database.exec(`
    CREATE INDEX artifacts_files_updated
      ON artifacts (current_version_created_at DESC, id DESC) WHERE deleted_at IS NULL;
    CREATE INDEX artifacts_files_kind_updated
      ON artifacts (file_kind, current_version_created_at DESC, id DESC) WHERE deleted_at IS NULL;
    CREATE INDEX artifacts_files_created
      ON artifacts (created_at DESC, id DESC) WHERE deleted_at IS NULL;
    CREATE INDEX artifacts_files_name
      ON artifacts (search_name, id) WHERE deleted_at IS NULL;
    CREATE INDEX artifacts_files_size
      ON artifacts (current_size, id) WHERE deleted_at IS NULL;
    PRAGMA user_version = ${fileCatalogSqliteSchemaVersion};
  `);
}
