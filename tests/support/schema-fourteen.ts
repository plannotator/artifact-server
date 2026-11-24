import type {DatabaseSync} from "node:sqlite";

import {fileCatalogSqliteIndexes} from "../../src/storage/sqlite-file-catalog-schema.js";

/** Remove the file-overview indexes from a populated runtime-built fixture. */
export function downgradeToSchemaFourteen(database: DatabaseSync): void {
  database.exec(`
    BEGIN IMMEDIATE;
    ${fileCatalogSqliteIndexes.map((name) => `DROP INDEX IF EXISTS ${name};`).join("\n    ")}
    PRAGMA user_version = 14;
    COMMIT;
  `);
}
