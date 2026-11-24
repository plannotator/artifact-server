import type {DatabaseSync} from "node:sqlite";
import {z} from "zod";

import {classifyFileKind} from "../core/file-kind.js";
import {fileCatalogSqliteIndexes, fileCatalogSqliteSchemaVersion} from "../storage/sqlite-file-catalog-schema.js";
import type {IntegrityProblem} from "./integrity-check.js";

const catalogRows = z.array(z.object({
  artifactId: z.string(),
  versionId: z.string(),
  fileKind: z.string().nullable(),
  createdAt: z.string().nullable(),
  size: z.number().nullable(),
  versionCreatedAt: z.string(),
  mediaType: z.string(),
  entryPath: z.string(),
  entryCount: z.number(),
  totalSize: z.number(),
}));
const userVersion = z.object({user_version: z.number()});

/**
 * Check the denormalized current-version columns that the file overview sorts
 * and filters on (schema 13) and the overview indexes that keep its pages
 * within the section 13 budgets (schema 16). An artifact whose current entry
 * is missing is already reported as an invalid manifest.
 */
export function readCompactFileCatalogProblems(database: DatabaseSync): IntegrityProblem[] {
  if (database.prepare("SELECT 1 FROM pragma_table_info('artifacts') WHERE name = 'current_size'").get() === undefined) {
    return [];
  }
  const problems: IntegrityProblem[] = [];
  for (const row of catalogRows.parse(database.prepare(`
    WITH totals AS (
      SELECT version_id, COUNT(*) AS entryCount, SUM(size) AS totalSize FROM manifest_entries GROUP BY version_id
    )
    SELECT artifact.id AS artifactId, artifact.current_version_id AS versionId, artifact.file_kind AS fileKind,
      artifact.current_version_created_at AS createdAt, artifact.current_size AS size,
      version.created_at AS versionCreatedAt, entry.media_type AS mediaType, version.entry_path AS entryPath,
      totals.entryCount, totals.totalSize
    FROM artifacts artifact
    JOIN versions version ON version.id = artifact.current_version_id AND version.artifact_id = artifact.id
    JOIN manifest_entries entry ON entry.version_id = version.id AND entry.path = version.entry_path
    JOIN totals ON totals.version_id = version.id
    ORDER BY artifact.id
  `).all())) {
    if (
      row.fileKind !== classifyFileKind(row.mediaType, row.entryPath, row.entryCount) ||
      row.createdAt !== row.versionCreatedAt || row.size !== row.totalSize
    ) {
      problems.push({
        artifactId: row.artifactId,
        code: "file_catalog_stale",
        message: "The artifact's file overview columns disagree with its current version.",
        path: null,
        versionId: row.versionId,
      });
    }
  }
  if (userVersion.parse(database.prepare("PRAGMA user_version").get()).user_version < fileCatalogSqliteSchemaVersion) {
    return problems;
  }
  for (const name of fileCatalogSqliteIndexes) {
    if (database.prepare("SELECT 1 FROM sqlite_schema WHERE type = 'index' AND name = ?").get(name) !== undefined) {
      continue;
    }
    problems.push({
      artifactId: "unknown",
      code: "file_catalog_index_missing",
      message: `The file overview index ${name} is missing.`,
      path: null,
      versionId: null,
    });
  }
  return problems;
}
