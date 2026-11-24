import type {DatabaseSync} from "node:sqlite";
import {z} from "zod";

import type {IntegrityProblem} from "./integrity-check.js";

const artifactRows = z.array(z.object({artifactId: z.string(), versionId: z.string().nullable()}));
const folderIds = z.array(z.object({folderId: z.string()}));
const groupFolderRows = z.array(z.object({
  id: z.string(),
  projectId: z.string(),
  parentId: z.string().nullable(),
  trashGroupId: z.string(),
  trashedAt: z.string().nullable(),
  purged: z.number(),
}));

/**
 * Check trash state written by schema 14 (ADR 0030): tombstone and group marks
 * agree, every trash group is one subtree with one purge state, and no live
 * row sits under a trashed or purged folder.
 */
export function readCompactTrashProblems(database: DatabaseSync): IntegrityProblem[] {
  const trash = database.prepare("SELECT 1 FROM pragma_table_info('folders') WHERE name = 'trash_group_id'")
    .get() !== undefined;
  if (!trash) return [];
  const problems: IntegrityProblem[] = [];
  for (const {folderId} of folderIds.parse(database.prepare(`
    SELECT id AS folderId FROM folders
    WHERE (trashed_at IS NULL) <> (trash_group_id IS NULL) OR (purged_at IS NOT NULL AND trashed_at IS NULL)
    ORDER BY id
  `).all())) {
    problems.push(folderProblem("trash_state_invalid", folderId,
      "The folder's trash, trash group, and purge marks disagree."));
  }
  for (const row of artifactRows.parse(database.prepare(`
    SELECT id AS artifactId, current_version_id AS versionId FROM artifacts
    WHERE deleted_at IS NULL AND (trash_group_id IS NOT NULL OR purged_at IS NOT NULL)
    ORDER BY id
  `).all())) {
    problems.push(artifactProblem("trash_state_invalid", row,
      "A live artifact carries a trash group or purge mark."));
  }
  problems.push(...readGroupProblems(database));
  for (const row of artifactRows.parse(database.prepare(`
    SELECT artifact.id AS artifactId, artifact.current_version_id AS versionId
    FROM artifacts artifact JOIN folders folder ON folder.id = artifact.folder_id
    WHERE artifact.deleted_at IS NULL AND (folder.trashed_at IS NOT NULL OR folder.purged_at IS NOT NULL)
    ORDER BY artifact.id
  `).all())) {
    problems.push(artifactProblem("trash_placement_invalid", row,
      "A live artifact sits in a trashed or purged folder."));
  }
  for (const {folderId} of folderIds.parse(database.prepare(`
    SELECT child.id AS folderId
    FROM folders child JOIN folders parent ON parent.id = child.parent_folder_id
    WHERE child.trashed_at IS NULL AND (parent.trashed_at IS NOT NULL OR parent.purged_at IS NOT NULL)
    ORDER BY child.id
  `).all())) {
    problems.push(folderProblem("trash_placement_invalid", folderId,
      "A live folder sits in a trashed or purged folder."));
  }
  return problems;
}

/**
 * A folder trash marks one live subtree: its folders share one project, one
 * trash time, one root, and one purge state, and each grouped artifact sits in
 * one of the group's folders. A group purge purges every grouped artifact.
 */
function readGroupProblems(database: DatabaseSync): IntegrityProblem[] {
  const problems: IntegrityProblem[] = [];
  const groups = new Map<string, z.infer<typeof groupFolderRows>>();
  for (const folder of groupFolderRows.parse(database.prepare(`
    SELECT id, project_id AS projectId, parent_folder_id AS parentId, trash_group_id AS trashGroupId,
      trashed_at AS trashedAt, (purged_at IS NOT NULL) AS purged
    FROM folders WHERE trash_group_id IS NOT NULL
    ORDER BY trash_group_id, id
  `).all())) {
    const members = groups.get(folder.trashGroupId) ?? [];
    members.push(folder);
    groups.set(folder.trashGroupId, members);
  }
  for (const members of groups.values()) {
    const ids = new Set(members.map(({id}) => id));
    const roots = members.filter(({parentId}) => parentId === null || !ids.has(parentId));
    const first = members[0];
    const uniform = members.every((member) => member.projectId === first?.projectId &&
      member.trashedAt === first.trashedAt && member.purged === first.purged);
    if (roots.length !== 1 || !uniform) {
      problems.push(folderProblem("trash_group_mismatch", roots[0]?.id ?? first?.id ?? "unknown",
        "The folder trash group is not one subtree with one trash and purge state."));
    }
  }
  for (const row of artifactRows.parse(database.prepare(`
    SELECT artifact.id AS artifactId, artifact.current_version_id AS versionId
    FROM artifacts artifact LEFT JOIN folders folder ON folder.id = artifact.folder_id
      AND folder.project_id = artifact.project_id AND folder.trash_group_id = artifact.trash_group_id
    WHERE artifact.trash_group_id IS NOT NULL
      AND (folder.id IS NULL OR (artifact.purged_at IS NULL AND folder.purged_at IS NOT NULL))
    ORDER BY artifact.id
  `).all())) {
    problems.push(artifactProblem("trash_group_mismatch", row,
      "The artifact's trash group does not hold its folder in the same purge state."));
  }
  return problems;
}

type TrashProblemCode = Extract<IntegrityProblem["code"], `trash_${string}`>;

function folderProblem(code: TrashProblemCode, folderId: string, message: string): IntegrityProblem {
  return {artifactId: "unknown", folderId, code, message, path: null, versionId: null};
}

function artifactProblem(
  code: TrashProblemCode,
  row: z.infer<typeof artifactRows>[number],
  message: string,
): IntegrityProblem {
  return {artifactId: row.artifactId, code, message, path: null, versionId: row.versionId};
}
