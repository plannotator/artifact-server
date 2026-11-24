import type {DatabaseSync} from "node:sqlite";
import {z} from "zod";

import {normalizeArtifactSearchText} from "../application/artifact-tags.js";
import {maximumFolderDepth} from "../core/folders.js";
import type {IntegrityProblem} from "./integrity-check.js";

const folderRows = z.array(z.object({
  id: z.string(),
  projectId: z.string(),
  parentId: z.string().nullable(),
  name: z.string(),
  nameKey: z.string(),
  validScope: z.number(),
}));

/** Check the compact folder graph and artifact placements in the catalog snapshot. */
export function readCompactFolderProblems(database: DatabaseSync): IntegrityProblem[] {
  if (database.prepare("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'folders'").get() === undefined) {
    return [];
  }
  const folders = folderRows.parse(database.prepare(`
    SELECT folder.id, folder.project_id AS projectId, folder.parent_folder_id AS parentId,
      folder.name, folder.name_key AS nameKey, (project.id IS NOT NULL) AS validScope
    FROM folders folder LEFT JOIN projects project
      ON project.id = folder.project_id AND project.installation_id = folder.installation_id
    ORDER BY folder.id
  `).all());
  const byId = new Map(folders.map((folder) => [folder.id, folder]));
  const siblingNames = new Set<string>();
  const problems: IntegrityProblem[] = [];
  for (const folder of folders) {
    const normalized = normalizeArtifactSearchText(folder.name);
    const name = JSON.stringify([folder.projectId, folder.parentId, normalized]);
    if (folder.nameKey !== normalized) {
      problems.push(folderProblem("folder_name_key_invalid", folder.id, "The folder name and normalized key disagree."));
    }
    if (siblingNames.has(name)) {
      problems.push(folderProblem("folder_duplicate_name", folder.id, "Sibling folders have the same normalized name."));
    }
    siblingNames.add(name);
    const ancestry = ancestryProblem(folder, byId);
    if (ancestry !== null) problems.push(ancestry);
  }
  const invalidPlacements = z.array(z.object({
    artifactId: z.string(), versionId: z.string().nullable(), folderId: z.string(),
  })).parse(database.prepare(`
    SELECT artifact.id AS artifactId, artifact.current_version_id AS versionId,
      artifact.folder_id AS folderId
    FROM artifacts artifact
    JOIN projects project ON project.id = artifact.project_id
    LEFT JOIN folders folder ON folder.id = artifact.folder_id
      AND folder.project_id = artifact.project_id AND folder.installation_id = project.installation_id
    WHERE artifact.folder_id IS NOT NULL AND folder.id IS NULL
    ORDER BY artifact.id
  `).all());
  for (const placement of invalidPlacements) {
    problems.push({
      ...placement, path: null, code: "folder_placement_mismatch",
      message: "The artifact's folder does not exist in its project.",
    });
  }
  return problems;
}

type FolderRow = z.infer<typeof folderRows>[number];

function ancestryProblem(folder: FolderRow, byId: ReadonlyMap<string, FolderRow>): IntegrityProblem | null {
  if (!folder.validScope) {
    return folderProblem("folder_scope_mismatch", folder.id, "The folder does not belong to its project installation.");
  }
  const seen = new Set([folder.id]);
  let parentId = folder.parentId;
  while (parentId !== null) {
    const parent = byId.get(parentId);
    if (parent?.projectId !== folder.projectId || !parent.validScope) {
      return folderProblem("folder_scope_mismatch", folder.id, "The parent is missing from the folder's project.");
    }
    if (seen.has(parent.id)) {
      return folderProblem("folder_cycle", folder.id, "The folder appears in its own ancestry.");
    }
    if (seen.size === maximumFolderDepth) {
      return folderProblem("folder_depth_exceeded", folder.id, "The folder exceeds the maximum nesting depth.");
    }
    seen.add(parent.id);
    parentId = parent.parentId;
  }
  return null;
}

type FolderProblemCode = Extract<IntegrityProblem["code"], `folder_${string}`>;

function folderProblem(code: FolderProblemCode, folderId: string, message: string): IntegrityProblem {
  return {artifactId: "unknown", folderId, code, message, path: null, versionId: null};
}

const relocationRows = z.array(z.object({artifactId: z.string(), projectId: z.string()}));

/**
 * Read every recorded cross-project move as (artifact, source project). A
 * single-artifact move stores its source in the move's idempotency result; a
 * folder move stores it in the folder action written by the same transaction
 * as each artifact's move action.
 */
export function readCompactRelocations(database: DatabaseSync): z.infer<typeof relocationRows> {
  if (database.prepare("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'folder_actions'").get() === undefined) {
    return [];
  }
  return relocationRows.parse(database.prepare(`
    SELECT artifact_id AS artifactId, json_extract(placement_result_json, '$.movedFromProjectId') AS projectId
    FROM idempotency_records
    WHERE operation = 'move' AND json_extract(placement_result_json, '$.movedFromProjectId') IS NOT NULL
    UNION
    SELECT action.artifact_id, json_extract(folder.result_json, '$.movedFromProjectId')
    FROM actions action JOIN folder_actions folder
      ON folder.idempotency_key = action.idempotency_key AND folder.created_at = action.created_at
        AND folder.action = 'move'
    WHERE action.action = 'move' AND json_extract(folder.result_json, '$.movedFromProjectId') IS NOT NULL
    ORDER BY artifactId, projectId
  `).all());
}
