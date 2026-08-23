import {existsSync} from "node:fs";
import {DatabaseSync} from "node:sqlite";

import {z} from "zod";

const userVersionRowSchema = z.object({user_version: z.number().int().nonnegative()});

/** SQLite schema revision required by this Artifact Server build. */
export const requiredSqliteSchemaVersion = 10;

/** Compact database compatibility observed without changing the file. */
export interface SqliteMigrationStatus {
  readonly compatibility: "current" | "missing" | "newer" | "pending";
  readonly currentVersion: number;
  readonly requiredVersion: number;
}

/** Inspect the compact schema revision without creating or migrating SQLite. */
export function readSqliteMigrationStatus(
  databasePath: string,
): SqliteMigrationStatus {
  if (!existsSync(databasePath)) {
    return {
      compatibility: "missing",
      currentVersion: 0,
      requiredVersion: requiredSqliteSchemaVersion,
    };
  }
  const database = new DatabaseSync(databasePath, {
    allowExtension: false,
    enableForeignKeyConstraints: true,
    open: true,
    readOnly: true,
    timeout: 5_000,
  });
  try {
    const row = userVersionRowSchema.parse(
      database.prepare("PRAGMA user_version").get(),
    );
    const currentVersion = row.user_version;
    return {
      compatibility: currentVersion === requiredSqliteSchemaVersion
        ? "current"
        : currentVersion < requiredSqliteSchemaVersion
        ? "pending"
        : "newer",
      currentVersion,
      requiredVersion: requiredSqliteSchemaVersion,
    };
  } finally {
    database.close();
  }
}
