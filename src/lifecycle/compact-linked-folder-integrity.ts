import type {DatabaseSync} from "node:sqlite";
import {z} from "zod";

import {artifactActionKinds} from "../core/model.js";
import type {IntegrityProblem} from "./integrity-check.js";

const linkRows = z.array(z.object({folderLinkId: z.string(), folderId: z.string()}));
const inventoryRows = z.array(z.object({
  folderLinkId: z.string(),
  folderId: z.string(),
  diskPath: z.string(),
  artifactId: z.string().nullable(),
  versionId: z.string().nullable(),
}));
const captureRows = z.array(z.object({
  folderLinkId: z.string(),
  folderId: z.string(),
  artifactId: z.string().nullable(),
  versionId: z.string().nullable(),
}));

/**
 * Check the local-only linked-folder records of schema 15 (ADR 0031). Links
 * name a folder that still exists in their own project; inventory, capture
 * records, and live-preview grants belong to an existing link; a tracked entry
 * names the artifact bound to exactly that file. Restore treats inventory as
 * stale until the first scan, but a stale row must still be self-consistent.
 */
export function readCompactLinkedFolderProblems(database: DatabaseSync): IntegrityProblem[] {
  if (database.prepare("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'folder_links'").get() === undefined) {
    return [];
  }
  const problems: IntegrityProblem[] = [];
  for (const link of linkRows.parse(database.prepare(`
    SELECT link.id AS folderLinkId, link.folder_id AS folderId
    FROM folder_links link
    LEFT JOIN projects project ON project.id = link.project_id
      AND project.installation_id = link.installation_id
    LEFT JOIN folders folder ON folder.id = link.folder_id AND folder.project_id = link.project_id
      AND folder.installation_id = link.installation_id AND folder.purged_at IS NULL
    WHERE project.id IS NULL OR folder.id IS NULL
    ORDER BY link.id
  `).all())) {
    problems.push(linkProblem("folder_link_target_invalid", link,
      "The folder link does not name a folder that still exists in its project."));
  }
  for (const entry of inventoryRows.parse(database.prepare(`
    SELECT entry.folder_link_id AS folderLinkId, COALESCE(link.folder_id, 'unknown') AS folderId, entry.disk_path AS diskPath,
      entry.artifact_id AS artifactId, artifact.current_version_id AS versionId
    FROM folder_inventory entry
    LEFT JOIN folder_links link ON link.id = entry.folder_link_id
    LEFT JOIN artifacts artifact ON artifact.id = entry.artifact_id
    WHERE link.id IS NULL OR (entry.artifact_id IS NOT NULL AND artifact.id IS NULL)
    ORDER BY entry.folder_link_id, entry.disk_path
  `).all())) {
    problems.push(entryProblem("folder_inventory_orphan", entry,
      "An inventory entry names a folder link or artifact that does not exist."));
  }
  // A relink rebinds the artifact at once; the inventory follows on the link's
  // next scan. Only a relink after the last completed scan explains drift.
  for (const entry of inventoryRows.parse(database.prepare(`
    SELECT entry.folder_link_id AS folderLinkId, COALESCE(link.folder_id, 'unknown') AS folderId, entry.disk_path AS diskPath,
      entry.artifact_id AS artifactId, artifact.current_version_id AS versionId
    FROM folder_inventory entry
    JOIN folder_links link ON link.id = entry.folder_link_id
    JOIN artifacts artifact ON artifact.id = entry.artifact_id
    WHERE entry.state = 'tracked'
      AND artifact.source_path IS NOT link.path || '/' || entry.disk_path
      AND NOT EXISTS (
        SELECT 1 FROM actions action
        WHERE action.artifact_id = artifact.id AND action.action = ?
          AND (link.last_scan_completed_at IS NULL OR action.created_at > link.last_scan_completed_at)
      )
    ORDER BY entry.folder_link_id, entry.disk_path
  `).all(artifactActionKinds.relink))) {
    problems.push(entryProblem("folder_inventory_binding_mismatch", entry,
      "A tracked inventory entry names an artifact bound to a different file."));
  }
  for (const capture of captureRows.parse(database.prepare(`
    SELECT capture.folder_link_id AS folderLinkId, COALESCE(link.folder_id, 'unknown') AS folderId,
      capture.artifact_id AS artifactId, capture.version_id AS versionId
    FROM (
      SELECT folder_link_id, entry_id,
        CASE WHEN json_valid(result_json) THEN json_extract(result_json, '$.artifactId') END AS artifact_id,
        CASE WHEN json_valid(result_json) THEN json_extract(result_json, '$.versionId') END AS version_id,
        json_valid(result_json) AS valid
      FROM folder_link_captures
    ) capture
    LEFT JOIN folder_links link ON link.id = capture.folder_link_id
    LEFT JOIN artifacts artifact ON artifact.id = capture.artifact_id
    LEFT JOIN versions version ON version.id = capture.version_id AND version.artifact_id = capture.artifact_id
    WHERE link.id IS NULL OR NOT capture.valid
      OR (capture.artifact_id IS NOT NULL AND artifact.id IS NULL)
      OR (capture.version_id IS NOT NULL AND version.id IS NULL)
    ORDER BY capture.folder_link_id, capture.entry_id
  `).all())) {
    problems.push({
      artifactId: capture.artifactId ?? "unknown",
      code: "folder_capture_orphan",
      folderId: capture.folderId,
      folderLinkId: capture.folderLinkId,
      message: "A capture record names a folder link, artifact, or version that does not exist.",
      path: null,
      versionId: capture.versionId,
    });
  }
  // Cross-project moves drop a moved link's grants, so a grant always shares its link's project.
  for (const link of linkRows.parse(database.prepare(`
    SELECT grant_row.folder_link_id AS folderLinkId, COALESCE(link.folder_id, 'unknown') AS folderId
    FROM folder_entry_live_grants grant_row
    LEFT JOIN folder_links link ON link.id = grant_row.folder_link_id
    WHERE link.id IS NULL OR link.project_id <> grant_row.project_id
    ORDER BY grant_row.folder_link_id, grant_row.created_at
  `).all())) {
    problems.push(linkProblem("folder_live_grant_invalid", link,
      "A live-preview grant names a folder link that does not exist in its project."));
  }
  return problems;
}

type LinkedFolderProblemCode = Extract<IntegrityProblem["code"], `folder_${"link" | "live" | "inventory"}_${string}`>;

function linkProblem(
  code: LinkedFolderProblemCode,
  link: z.infer<typeof linkRows>[number],
  message: string,
): IntegrityProblem {
  return {
    artifactId: "unknown", code, folderId: link.folderId, folderLinkId: link.folderLinkId,
    message, path: null, versionId: null,
  };
}

function entryProblem(
  code: LinkedFolderProblemCode,
  entry: z.infer<typeof inventoryRows>[number],
  message: string,
): IntegrityProblem {
  return {
    artifactId: entry.artifactId ?? "unknown",
    code,
    folderId: entry.folderId,
    folderLinkId: entry.folderLinkId,
    message,
    path: entry.diskPath,
    versionId: entry.versionId,
  };
}
