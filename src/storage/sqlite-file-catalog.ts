import type {DatabaseSync, SQLInputValue} from "node:sqlite";
import {z} from "zod";

import {FolderFailure} from "../core/errors.js";
import {
  type FileCursor, type FileFacets, type FileFilters, type FileKind, fileKinds, type FileListItem,
  type FilePage, type FileSort, type ListFiles, maximumTagFacets,
} from "../core/file-catalog.js";
import {maximumFolderDepth, maximumProjectFolders} from "../core/folders.js";
import type {FileCatalogRepository} from "../core/ports.js";

/** One overview WHERE clause and the named values it binds. */
interface FilterSql {
  readonly clauses: string[];
  readonly parameters: Map<string, SQLInputValue>;
}

const freshnessSchema = z.enum(["in-sync", "modified", "missing", "unreadable"]);
const pageRowSchema = z.object({
  id: z.string(),
  name: z.string(),
  projectId: z.string(),
  projectName: z.string(),
  folderId: z.string().nullable(),
  fileKind: z.string().nullable(),
  currentVersionId: z.string(),
  size: z.number().int().nullable(),
  accessSetting: z.enum(["account_required", "public_link"]),
  linked: freshnessSchema.nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
  sortValue: z.union([z.string(), z.number()]),
});
const detailRowSchema = z.object({
  id: z.string(),
  versionNumber: z.number().int(),
  entryMediaType: z.string(),
  commentCount: z.number().int(),
  versionCount: z.number().int(),
});
const tagRowSchema = z.object({artifactId: z.string(), tag: z.string()});
const folderRowSchema = z.object({id: z.string(), name: z.string(), parentFolderId: z.string().nullable()});
const countSchema = z.object({count: z.number().int()});
const kindCountSchema = z.object({kind: z.string().nullable(), count: z.number().int()});
const projectCountSchema = z.object({projectId: z.string(), count: z.number().int()});
const tagCountSchema = z.object({tag: z.string(), count: z.number().int()});

const commentCountSql = `(SELECT COUNT(*) FROM comment_threads thread
  WHERE thread.project_id = a.project_id AND thread.artifact_id = a.id)`;

const sortColumns = {
  updated: "a.current_version_created_at",
  created: "a.created_at",
  name: "a.search_name",
  size: "a.current_size",
  comments: commentCountSql,
} as const satisfies Record<FileSort, string>;

/** Cross-project file overview over the compact catalog connection (spec section 11). */
export class SqliteFileCatalog implements FileCatalogRepository {
  private readonly database: DatabaseSync;

  constructor(database: DatabaseSync) {
    this.database = database;
  }

  async listFiles(command: ListFiles): Promise<FilePage> {
    return Promise.resolve().then(() => {
      const where = this.filterClauses(command);
      const sortColumn = sortColumns[command.sort];
      const comparison = command.direction === "desc" ? "<" : ">";
      if (command.cursor !== null) {
        where.clauses.push(`(${sortColumn} ${comparison} :cursorValue
          OR (${sortColumn} = :cursorValue AND a.id ${comparison} :cursorId))`);
        where.parameters.set("cursorValue", command.cursor.value);
        where.parameters.set("cursorId", command.cursor.id);
      }
      const direction = command.direction === "desc" ? "DESC" : "ASC";
      const rows = z.array(pageRowSchema).parse(this.database.prepare(`
        SELECT a.id, a.name, a.project_id AS projectId, p.name AS projectName,
          a.folder_id AS folderId, a.file_kind AS fileKind, a.current_version_id AS currentVersionId,
          a.current_size AS size, a.access_setting AS accessSetting,
          CASE WHEN a.source_path IS NULL THEN NULL ELSE a.source_status END AS linked,
          a.created_at AS createdAt, a.current_version_created_at AS updatedAt,
          ${sortColumn} AS sortValue
        FROM artifacts a JOIN projects p ON p.id = a.project_id
        WHERE ${where.clauses.join(" AND ")}
        ORDER BY ${sortColumn} ${direction}, a.id ${direction}
        LIMIT :limit
      `).all({...Object.fromEntries(where.parameters), limit: command.limit + 1}));
      const page = rows.slice(0, command.limit);
      const items = this.enrich(page);
      const last = page.at(-1);
      const nextCursor: FileCursor | null = rows.length > command.limit && last !== undefined
        ? {sort: command.sort, direction: command.direction, value: last.sortValue, id: last.id}
        : null;
      return {items, nextCursor};
    });
  }

  async fileFacets(command: FileFilters): Promise<FileFacets> {
    return Promise.resolve().then(() => {
      const where = this.filterClauses(command);
      const parameters = Object.fromEntries(where.parameters);
      const base = `FROM artifacts a JOIN projects p ON p.id = a.project_id WHERE ${where.clauses.join(" AND ")}`;
      const total = countSchema.parse(this.database.prepare(`SELECT COUNT(*) AS count ${base}`)
        .get(parameters)).count;
      const kinds = new Map<FileKind, number>();
      for (const row of z.array(kindCountSchema).parse(this.database.prepare(`
        SELECT a.file_kind AS kind, COUNT(*) AS count ${base} GROUP BY a.file_kind
      `).all(parameters))) {
        const kind = asFileKind(row.kind);
        kinds.set(kind, (kinds.get(kind) ?? 0) + row.count);
      }
      const projects = z.array(projectCountSchema).parse(this.database.prepare(`
        SELECT a.project_id AS projectId, COUNT(*) AS count ${base}
        GROUP BY a.project_id ORDER BY count DESC, a.project_id ASC
      `).all(parameters));
      const tags = z.array(tagCountSchema).parse(this.database.prepare(`
        SELECT tag.tag AS tag, COUNT(*) AS count
        FROM artifact_tags tag
        WHERE tag.artifact_id IN (SELECT a.id ${base})
        GROUP BY tag.tag ORDER BY count DESC, tag.tag ASC
        LIMIT :tagLimit
      `).all({...parameters, tagLimit: maximumTagFacets}));
      return {
        total,
        kinds: fileKinds.flatMap((kind) => {
          const count = kinds.get(kind);
          return count === undefined ? [] : [{kind, count}];
        }),
        projects,
        tags,
      };
    });
  }

  /** Build the shared WHERE clause; only active filters appear, so SQLite can pick an index. */
  private filterClauses(filters: FileFilters): FilterSql {
    const clauses = [
      "p.installation_id = :installationId",
      "a.deleted_at IS NULL",
      "a.current_version_created_at IS NOT NULL",
    ];
    const parameters = new Map<string, SQLInputValue>([["installationId", filters.installationId]]);
    if (filters.projectIds.length > 0) {
      clauses.push("a.project_id IN (SELECT value FROM json_each(:projectIds))");
      parameters.set("projectIds", JSON.stringify(filters.projectIds));
    }
    if (filters.folder !== null) {
      const folderIds = this.folderScope(filters.installationId, filters.folder.folderId, filters.folder.recursive);
      clauses.push("a.folder_id IN (SELECT value FROM json_each(:folderIds))");
      parameters.set("folderIds", JSON.stringify(folderIds));
    }
    if (filters.kinds.length > 0) {
      clauses.push("a.file_kind IN (SELECT value FROM json_each(:kinds))");
      parameters.set("kinds", JSON.stringify(filters.kinds));
    }
    if (filters.tags.length > 0) {
      clauses.push(`EXISTS (SELECT 1 FROM artifact_tags filtered_tag
        WHERE filtered_tag.artifact_id = a.id AND filtered_tag.tag IN (SELECT value FROM json_each(:tags)))`);
      parameters.set("tags", JSON.stringify(filters.tags));
    }
    if (filters.linked === "linked") clauses.push("a.source_path IS NOT NULL");
    if (filters.linked === "not-linked") clauses.push("a.source_path IS NULL");
    if (filters.linked === "drifted") clauses.push("a.source_path IS NOT NULL AND a.source_status = 'modified'");
    if (filters.linked === "missing") clauses.push("a.source_path IS NOT NULL AND a.source_status = 'missing'");
    const ranges = [
      ["createdAfter", "a.created_at >=", filters.createdAfter],
      ["createdBefore", "a.created_at <", filters.createdBefore],
      ["updatedAfter", "a.current_version_created_at >=", filters.updatedAfter],
      ["updatedBefore", "a.current_version_created_at <", filters.updatedBefore],
    ] as const;
    for (const [name, comparison, value] of ranges) {
      if (value === null) continue;
      clauses.push(`${comparison} :${name}`);
      parameters.set(name, value);
    }
    if (filters.search !== null) {
      clauses.push(`(instr(a.search_name, :search) > 0 OR EXISTS (
        SELECT 1 FROM artifact_tags searched_tag WHERE searched_tag.artifact_id = a.id AND searched_tag.tag = :search
      ))`);
      parameters.set("search", filters.search);
    }
    return {clauses, parameters};
  }

  /**
   * Resolve a live folder and, when recursive, its live subtree. The walk is
   * bounded by the folder depth and per-project folder limits. An unknown,
   * foreign, trashed, or purged folder answers not-found without disclosure.
   */
  private folderScope(installationId: string, folderId: string, recursive: boolean): readonly string[] {
    const found = this.database.prepare(`
      SELECT 1 FROM folders WHERE id = ? AND installation_id = ? AND trashed_at IS NULL AND purged_at IS NULL
    `).get(folderId, installationId);
    if (found === undefined) {
      throw new FolderFailure({reason: "not-found", message: "The folder does not exist."});
    }
    if (!recursive) return [folderId];
    return z.array(z.object({id: z.string()})).parse(this.database.prepare(`
      WITH RECURSIVE subtree(id, depth) AS (
        SELECT id, 0 FROM folders WHERE id = :folderId
        UNION ALL
        SELECT child.id, subtree.depth + 1 FROM folders child
        JOIN subtree ON child.parent_folder_id = subtree.id
        WHERE child.trashed_at IS NULL AND child.purged_at IS NULL AND subtree.depth < :depth
      )
      SELECT id FROM subtree LIMIT :limit
    `).all({folderId, depth: maximumFolderDepth, limit: maximumProjectFolders})).map(({id}) => id);
  }

  /** Add per-row details for one page only, so the listing never aggregates per scanned row. */
  private enrich(rows: readonly z.infer<typeof pageRowSchema>[]): FileListItem[] {
    if (rows.length === 0) return [];
    const ids = JSON.stringify(rows.map(({id}) => id));
    const details = new Map(z.array(detailRowSchema).parse(this.database.prepare(`
      SELECT a.id, version.number AS versionNumber, entry.media_type AS entryMediaType,
        ${commentCountSql} AS commentCount,
        (SELECT COUNT(*) FROM versions counted
          WHERE counted.project_id = a.project_id AND counted.artifact_id = a.id) AS versionCount
      FROM artifacts a
      JOIN versions version ON version.id = a.current_version_id
      JOIN manifest_entries entry ON entry.version_id = version.id AND entry.path = version.entry_path
      WHERE a.id IN (SELECT value FROM json_each(?))
    `).all(ids)).map((row) => [row.id, row]));
    const tags = new Map<string, string[]>();
    for (const row of z.array(tagRowSchema).parse(this.database.prepare(`
      SELECT artifact_id AS artifactId, tag FROM artifact_tags
      WHERE artifact_id IN (SELECT value FROM json_each(?)) ORDER BY tag
    `).all(ids))) {
      tags.set(row.artifactId, [...(tags.get(row.artifactId) ?? []), row.tag]);
    }
    const paths = new Map<string, FileListItem["folderPath"]>();
    return rows.map((row) => {
      const detail = details.get(row.id);
      const folderPath = row.folderId === null ? [] : paths.get(row.folderId) ?? this.folderPath(row.folderId);
      if (row.folderId !== null) paths.set(row.folderId, folderPath);
      return {
        id: row.id,
        name: row.name,
        projectId: row.projectId,
        projectName: row.projectName,
        folderId: row.folderId,
        folderPath,
        fileKind: asFileKind(row.fileKind),
        currentVersionId: row.currentVersionId,
        currentVersionNumber: detail?.versionNumber ?? 0,
        size: row.size ?? 0,
        entryMediaType: detail?.entryMediaType ?? "application/octet-stream",
        tags: tags.get(row.id) ?? [],
        commentCount: detail?.commentCount ?? 0,
        versionCount: detail?.versionCount ?? 0,
        accessSetting: row.accessSetting,
        linked: row.linked,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
      };
    });
  }

  private folderPath(folderId: string): FileListItem["folderPath"] {
    const path: {id: string; name: string}[] = [];
    let next: string | null = folderId;
    while (next !== null && path.length < maximumFolderDepth) {
      const row = folderRowSchema.optional().parse(this.database.prepare(`
        SELECT id, name, parent_folder_id AS parentFolderId FROM folders WHERE id = ?
      `).get(next));
      if (row === undefined) break;
      path.unshift({id: row.id, name: row.name});
      next = row.parentFolderId;
    }
    return path;
  }
}

function asFileKind(kind: string | null): FileKind {
  return fileKinds.find((known) => known === kind) ?? "other";
}
