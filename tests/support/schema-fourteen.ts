import type {DatabaseSync} from "node:sqlite";

import {downgradeToSchemaFifteen} from "./schema-fifteen.js";

/**
 * Remove the schema 16 file-overview indexes and the schema 15 folder-link
 * additions from a populated runtime-built fixture.
 */
export function downgradeToSchemaFourteen(database: DatabaseSync): void {
  downgradeToSchemaFifteen(database);
  database.exec(`
    BEGIN IMMEDIATE;
    DROP TABLE folder_entry_live_grants;
    DROP TABLE folder_link_captures;
    DROP TABLE folder_inventory;
    DROP TABLE folder_links;
    DROP INDEX artifacts_source_path;
    PRAGMA user_version = 14;
    COMMIT;
  `);
}
