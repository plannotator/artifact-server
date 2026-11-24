import {randomUUID} from "node:crypto";
import type {DatabaseSync} from "node:sqlite";
import {z} from "zod";

import {
  FolderFailure, FolderLinkFailure, IdempotencyConflict, ProjectArchived, ProjectNotFound,
} from "../core/errors.js";
import {
  type CaptureEntryResult, directoriesOverlap, escapeDisplayPath, type FolderLinkRecord,
  type FolderLinkStatus, type InventoryEntryRecord, type LinkedBindingSummary,
  maximumFolderLinks, type OverLimitReason,
} from "../core/folder-links.js";
import {maximumFolderDepth, maximumProjectFolders} from "../core/folders.js";
import type {
  ApplyScanPage, CreateFolderLink, EntryLiveGrant, EntryLiveGrantWrite, FinishScan,
  FolderLinkRepository, ListInventory, UpdateFolderLink,
} from "../core/ports.js";

const linkRowSchema = z.object({
  id: z.string(),
  installationId: z.string(),
  projectId: z.string(),
  folderId: z.string(),
  path: z.string(),
  rootDevice: z.string(),
  ignoreJson: z.string(),
  status: z.enum(["active", "unavailable", "over-limit"]),
  paused: z.number().int(),
  inTrash: z.number().int(),
  overLimitReason: z.enum(["entries", "ignore-file"]).nullable(),
  lastScanStartedAt: z.string().nullable(),
  lastScanCompletedAt: z.string().nullable(),
  entryCount: z.number().int(),
  pendingCount: z.number().int(),
  skippedCount: z.number().int(),
  ignoredCount: z.number().int(),
  revision: z.number().int(),
  createdAt: z.string(),
  createdByPrincipalId: z.string(),
});

const linkColumns = `id, installation_id AS installationId, project_id AS projectId,
  folder_id AS folderId, path, root_device AS rootDevice, ignore_json AS ignoreJson, status, paused,
  EXISTS (SELECT 1 FROM folders f WHERE f.id = folder_links.folder_id AND f.trashed_at IS NOT NULL) AS inTrash,
  over_limit_reason AS overLimitReason, last_scan_started_at AS lastScanStartedAt,
  last_scan_completed_at AS lastScanCompletedAt,
  (SELECT COUNT(*) FROM folder_inventory i WHERE i.folder_link_id = folder_links.id
    AND i.state IN ('untracked', 'tracked')) AS entryCount,
  (SELECT COUNT(*) FROM folder_inventory i WHERE i.folder_link_id = folder_links.id
    AND i.pending = 1) AS pendingCount,
  (SELECT COUNT(*) FROM folder_inventory i WHERE i.folder_link_id = folder_links.id
    AND i.state = 'skipped') AS skippedCount,
  ignored_count AS ignoredCount, revision, created_at AS createdAt,
  created_by_principal_id AS createdByPrincipalId`;

const entryRowSchema = z.object({
  id: z.string(),
  folderLinkId: z.string(),
  relativePath: z.string(),
  diskPath: z.string(),
  fingerprint: z.string().nullable(),
  size: z.number().int().nullable(),
  observedAt: z.string(),
  state: z.enum(["untracked", "tracked", "skipped"]),
  skipReason: z.enum([
    "symlink", "special", "too-large", "too-deep", "unreadable", "hostile-name",
    "other-device", "bound-elsewhere",
  ]).nullable(),
  artifactId: z.string().nullable(),
  pending: z.number().int(),
  freshness: z.enum(["in-sync", "modified", "missing", "unreadable"]).nullable(),
});

const entryColumns = `i.id, i.folder_link_id AS folderLinkId, i.relative_path AS relativePath,
  i.disk_path AS diskPath, i.fingerprint, i.size, i.observed_at AS observedAt, i.state,
  i.skip_reason AS skipReason, i.artifact_id AS artifactId, i.pending,
  CASE WHEN i.state = 'tracked' THEN a.source_status ELSE NULL END AS freshness`;
const entryFrom = `folder_inventory i LEFT JOIN artifacts a ON a.id = i.artifact_id`;

const bindingRowSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  fingerprint: z.string(),
  freshness: z.enum(["in-sync", "modified", "missing", "unreadable"]),
});

const captureRowSchema = z.object({inputDigest: z.string(), resultJson: z.string()});
const captureResultSchema = z.object({
  entryId: z.string(),
  relativePath: z.string().nullable(),
  status: z.enum(["captured", "unchanged", "refused"]),
  code: z.string().nullable(),
  message: z.string().nullable(),
  artifactId: z.string().nullable(),
  versionId: z.string().nullable(),
});
const grantSchema = z.object({
  principalId: z.string(),
  projectId: z.string(),
  folderLinkId: z.string(),
  entryId: z.string(),
  expiresAt: z.string(),
});
const countSchema = z.object({count: z.number().int()});
const priorEntrySchema = z.object({
  id: z.string(),
  relativePath: z.string(),
  fingerprint: z.string().nullable(),
  size: z.number().int().nullable(),
  state: z.enum(["untracked", "tracked", "skipped"]),
  skipReason: z.string().nullable(),
  artifactId: z.string().nullable(),
  pending: z.number().int(),
});
type PriorEntry = z.infer<typeof priorEntrySchema>;
type ObservedEntry = Omit<PriorEntry, "id">;

/** Whether an observation would leave every indexed and reported column of its entry unchanged. */
function sameEntry(prior: PriorEntry, next: ObservedEntry): boolean {
  return prior.relativePath === next.relativePath && prior.fingerprint === next.fingerprint
    && prior.size === next.size && prior.state === next.state && prior.skipReason === next.skipReason
    && prior.artifactId === next.artifactId && prior.pending === next.pending;
}

const idSchema = z.object({id: z.string()});

/**
 * SQLite folder links share the catalog connection and its write transaction.
 * Every scan page is one short transaction; nothing here writes an artifact,
 * version, folder, or action except `ensureFolderPath`, which runs only inside
 * an explicit, attributed capture.
 */
export class SqliteFolderLinks implements FolderLinkRepository {
  private readonly database: DatabaseSync;
  private readonly transaction: <A>(operation: () => A) => A;

  constructor(database: DatabaseSync, transaction: SqliteFolderLinks["transaction"]) {
    this.database = database;
    this.transaction = transaction;
  }

  async createFolderLink(command: CreateFolderLink): Promise<FolderLinkRecord> {
    return this.transaction(() => {
      const replay = this.database.prepare(`
        SELECT id, input_digest AS inputDigest FROM folder_links
        WHERE project_id = ? AND idempotency_key = ?
      `).get(command.projectId, command.idempotencyKey);
      if (replay !== undefined) {
        const parsed = z.object({id: z.string(), inputDigest: z.string()}).parse(replay);
        if (parsed.inputDigest !== command.inputDigest) {
          throw new IdempotencyConflict({message: "The idempotency key was already used with different input."});
        }
        return this.requireLink(command.installationId, parsed.id);
      }
      this.assertProjectActive(command.installationId, command.projectId);
      const folder = this.database.prepare(
        "SELECT id FROM folders WHERE id = ? AND project_id = ? AND installation_id = ? AND trashed_at IS NULL",
      ).get(command.folderId, command.projectId, command.installationId);
      if (folder === undefined) {
        throw new FolderFailure({reason: "not-found", message: "The folder does not exist."});
      }
      const existing = z.array(z.object({path: z.string(), folderId: z.string()})).parse(this.database.prepare(
        "SELECT path, folder_id AS folderId FROM folder_links WHERE installation_id = ?",
      ).all(command.installationId));
      if (existing.length >= maximumFolderLinks) {
        throw new FolderLinkFailure({reason: "limit", message: `An installation can hold at most ${maximumFolderLinks} folder links.`});
      }
      if (existing.some((link) => link.folderId === command.folderId || directoriesOverlap(link.path, command.path))) {
        throw new FolderLinkFailure({
          reason: "overlap",
          message: "The directory or folder overlaps an existing folder link.",
        });
      }
      this.database.prepare(`
        INSERT INTO folder_links (
          id, installation_id, project_id, folder_id, path, root_device, ignore_json, status,
          paused, over_limit_reason, revision, created_at, created_by_principal_id,
          idempotency_key, input_digest
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 'active', 0, NULL, 1, ?, ?, ?, ?)
      `).run(
        command.id, command.installationId, command.projectId, command.folderId, command.path,
        command.rootDevice, JSON.stringify(command.ignore), command.createdAt, command.principalId,
        command.idempotencyKey, command.inputDigest,
      );
      return this.requireLink(command.installationId, command.id);
    });
  }

  async findFolderLink(installationId: string, folderLinkId: string): Promise<FolderLinkRecord | null> {
    return this.readLink(installationId, folderLinkId);
  }

  async findFolderLinkReplay(projectId: string, idempotencyKey: string) {
    const row = this.database.prepare(`
      SELECT id, installation_id AS installationId, input_digest AS inputDigest FROM folder_links
      WHERE project_id = ? AND idempotency_key = ?
    `).get(projectId, idempotencyKey);
    if (row === undefined) return null;
    const parsed = z.object({id: z.string(), installationId: z.string(), inputDigest: z.string()}).parse(row);
    return {inputDigest: parsed.inputDigest, link: this.requireLink(parsed.installationId, parsed.id)};
  }

  async listFolderLinks(installationId: string, projectId: string | null): Promise<readonly FolderLinkRecord[]> {
    return z.array(linkRowSchema).parse(this.database.prepare(`
      SELECT ${linkColumns} FROM folder_links
      WHERE installation_id = ? AND (? IS NULL OR project_id = ?)
      ORDER BY created_at, id
    `).all(installationId, projectId, projectId)).map(toLinkRecord);
  }

  async updateFolderLink(command: UpdateFolderLink): Promise<FolderLinkRecord> {
    return this.transaction(() => {
      const current = this.requireLink(command.installationId, command.folderLinkId);
      if (current.revision !== command.expectedRevision) {
        throw new FolderLinkFailure({reason: "revision", message: "The folder link changed. Reload it and try again."});
      }
      const paused = command.paused ?? current.paused;
      const ignore = command.ignore ?? current.ignore;
      this.database.prepare(`
        UPDATE folder_links SET paused = ?, ignore_json = ?, revision = revision + 1
        WHERE id = ? AND installation_id = ?
      `).run(paused ? 1 : 0, JSON.stringify(ignore), current.id, command.installationId);
      return this.requireLink(command.installationId, current.id);
    });
  }

  async removeFolderLink(installationId: string, folderLinkId: string, expectedRevision: number): Promise<FolderLinkRecord> {
    return this.transaction(() => {
      const current = this.requireLink(installationId, folderLinkId);
      if (current.revision !== expectedRevision) {
        throw new FolderLinkFailure({reason: "revision", message: "The folder link changed. Reload it and try again."});
      }
      this.database.prepare("DELETE FROM folder_links WHERE id = ? AND installation_id = ?")
        .run(folderLinkId, installationId);
      return current;
    });
  }

  async setFolderLinkStatus(
    folderLinkId: string,
    status: FolderLinkStatus,
    overLimitReason: OverLimitReason | null,
  ): Promise<FolderLinkRecord> {
    return this.transaction(() => {
      this.database.prepare("UPDATE folder_links SET status = ?, over_limit_reason = ? WHERE id = ?")
        .run(status, overLimitReason, folderLinkId);
      return this.requireLinkById(folderLinkId);
    });
  }

  async markAllFolderLinksUnverified(installationId: string): Promise<void> {
    this.transaction(() => {
      this.database.prepare(`
        UPDATE folder_links SET status = 'unavailable', over_limit_reason = NULL
        WHERE installation_id = ?
      `).run(installationId);
    });
  }

  async beginScan(folderLinkId: string, startedAt: string): Promise<number> {
    return this.transaction(() => {
      this.database.prepare(`
        UPDATE folder_links SET scan_generation = scan_generation + 1, last_scan_started_at = ?
        WHERE id = ?
      `).run(startedAt, folderLinkId);
      const row = this.database.prepare("SELECT scan_generation AS count FROM folder_links WHERE id = ?")
        .get(folderLinkId);
      if (row === undefined) throw linkNotFound();
      return countSchema.parse(row).count;
    });
  }

  async applyScanPage(command: ApplyScanPage): Promise<{readonly overLimit: boolean}> {
    return this.transaction(() => {
      if (this.database.prepare("SELECT 1 FROM folder_links WHERE id = ?").get(command.folderLinkId) === undefined) {
        throw linkNotFound();
      }
      let entries = countSchema.parse(this.database.prepare(`
        SELECT COUNT(*) AS count FROM folder_inventory
        WHERE folder_link_id = ? AND state IN ('untracked', 'tracked')
      `).get(command.folderLinkId)).count;
      let overLimit = false;
      const existingEntry = this.database.prepare(`
        SELECT id, relative_path AS relativePath, fingerprint, size, state, skip_reason AS skipReason,
          artifact_id AS artifactId, pending
        FROM folder_inventory WHERE folder_link_id = ? AND disk_path = ?
      `);
      const findBinding = this.database.prepare(`
        SELECT id, project_id AS projectId, source_fingerprint AS fingerprint, source_status AS freshness
        FROM artifacts
        WHERE source_path = ? AND deleted_at IS NULL
        ORDER BY project_id = ? DESC, id LIMIT 1
      `);
      const refreshFreshness = this.database.prepare(`
        UPDATE artifacts SET source_status = ?, source_verified_at = ?
        WHERE id = ? AND source_status <> ?
      `);
      const upsert = this.database.prepare(`
        INSERT INTO folder_inventory (
          id, folder_link_id, relative_path, disk_path, fingerprint, size, observed_at, state,
          skip_reason, artifact_id, pending, seen_generation
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT (folder_link_id, disk_path) DO UPDATE SET
          relative_path = excluded.relative_path,
          fingerprint = excluded.fingerprint,
          size = excluded.size,
          observed_at = CASE WHEN folder_inventory.fingerprint IS excluded.fingerprint
            AND folder_inventory.state = excluded.state
            THEN folder_inventory.observed_at ELSE excluded.observed_at END,
          state = excluded.state,
          skip_reason = excluded.skip_reason,
          artifact_id = excluded.artifact_id,
          pending = excluded.pending,
          seen_generation = excluded.seen_generation
      `);
      // A warm rescan mostly re-observes unchanged entries. Those only take
      // the scan generation, which no index covers, so a page stays short.
      const stamp = this.database.prepare("UPDATE folder_inventory SET seen_generation = ? WHERE id = ?");
      const write = (prior: PriorEntry | null, diskPath: string, next: ObservedEntry) => {
        if (prior !== null && sameEntry(prior, next)) {
          stamp.run(command.generation, prior.id);
          return;
        }
        upsert.run(
          `fle_${randomUUID()}`, command.folderLinkId, next.relativePath, diskPath, next.fingerprint, next.size,
          command.observedAt, next.state, next.skipReason, next.artifactId, next.pending, command.generation,
        );
      };
      for (const observation of command.observations) {
        const priorRow = existingEntry.get(command.folderLinkId, observation.diskPath);
        const prior = priorRow === undefined ? null : priorEntrySchema.parse(priorRow);
        if (observation.kind === "skipped") {
          write(prior, observation.diskPath, {
            relativePath: observation.reason === "hostile-name"
              ? escapeDisplayPath(observation.diskPath)
              : observation.diskPath.normalize("NFC"),
            fingerprint: null, size: observation.size, state: "skipped", skipReason: observation.reason,
            artifactId: null, pending: 0,
          });
          continue;
        }
        const relativePath = observation.diskPath.normalize("NFC");
        const absolute = `${command.linkPath}/${observation.diskPath}`;
        const bindingRow = findBinding.get(absolute, command.projectId);
        const binding = bindingRow === undefined ? null : bindingRowSchema.parse(bindingRow);
        const counted = prior !== null && (prior.state === "untracked" || prior.state === "tracked");
        if (binding !== null && binding.projectId !== command.projectId) {
          write(prior, observation.diskPath, {
            relativePath, fingerprint: observation.fingerprint, size: observation.size, state: "skipped",
            skipReason: "bound-elsewhere", artifactId: binding.id, pending: 0,
          });
          if (counted) entries -= 1;
          continue;
        }
        if (!counted) {
          if (entries >= command.entryLimit) {
            overLimit = true;
            continue;
          }
          entries += 1;
        }
        if (binding === null) {
          write(prior, observation.diskPath, {
            relativePath, fingerprint: observation.fingerprint, size: observation.size, state: "untracked",
            skipReason: null, artifactId: null, pending: 1,
          });
          continue;
        }
        const modified = binding.fingerprint !== observation.fingerprint;
        const freshness = modified ? "modified" : "in-sync";
        refreshFreshness.run(freshness, command.observedAt, binding.id, freshness);
        write(prior, observation.diskPath, {
          relativePath, fingerprint: observation.fingerprint, size: observation.size, state: "tracked",
          skipReason: null, artifactId: binding.id, pending: modified ? 1 : 0,
        });
      }
      return {overLimit};
    });
  }

  async finishScan(command: FinishScan): Promise<FolderLinkRecord> {
    return this.transaction(() => {
      const removed = z.array(z.object({artifactId: z.string(), diskPath: z.string()})).parse(this.database.prepare(`
        SELECT artifact_id AS artifactId, disk_path AS diskPath FROM folder_inventory
        WHERE folder_link_id = ? AND seen_generation < ? AND state = 'tracked'
      `).all(command.folderLinkId, command.generation));
      const markMissing = this.database.prepare(`
        UPDATE artifacts SET source_status = 'missing', source_verified_at = ?
        WHERE id = ? AND source_path = ? AND source_status <> 'missing'
      `);
      for (const entry of removed) {
        markMissing.run(command.completedAt, entry.artifactId, `${command.linkPath}/${entry.diskPath}`);
      }
      this.database.prepare("DELETE FROM folder_inventory WHERE folder_link_id = ? AND seen_generation < ?")
        .run(command.folderLinkId, command.generation);
      this.database.prepare(`
        UPDATE folder_links SET status = ?, over_limit_reason = ?, last_scan_completed_at = ?,
          ignored_count = ?
        WHERE id = ?
      `).run(
        command.overLimitReason === null ? "active" : "over-limit", command.overLimitReason,
        command.completedAt, command.ignoredCount, command.folderLinkId,
      );
      return this.requireLinkById(command.folderLinkId);
    });
  }

  async listInventory(command: ListInventory): Promise<readonly InventoryEntryRecord[]> {
    return z.array(entryRowSchema).parse(this.database.prepare(`
      SELECT ${entryColumns} FROM ${entryFrom}
      WHERE i.folder_link_id = ? AND (? IS NULL OR i.state = ?) AND (? = 0 OR i.pending = 1)
        AND (? IS NULL OR i.relative_path > ?)
      ORDER BY i.relative_path LIMIT ?
    `).all(
      command.folderLinkId, command.state, command.state, command.pendingOnly ? 1 : 0,
      command.afterRelativePath, command.afterRelativePath, command.limit,
    )).map(toEntryRecord);
  }

  async findInventoryEntries(folderLinkId: string, entryIds: readonly string[]): Promise<readonly InventoryEntryRecord[]> {
    const find = this.database.prepare(`SELECT ${entryColumns} FROM ${entryFrom} WHERE i.folder_link_id = ? AND i.id = ?`);
    return entryIds.flatMap((entryId) => {
      const row = find.get(folderLinkId, entryId);
      return row === undefined ? [] : [toEntryRecord(entryRowSchema.parse(row))];
    });
  }

  async listPendingEntries(folderLinkId: string, limit: number): Promise<readonly InventoryEntryRecord[]> {
    return z.array(entryRowSchema).parse(this.database.prepare(`
      SELECT ${entryColumns} FROM ${entryFrom}
      WHERE i.folder_link_id = ? AND i.pending = 1 ORDER BY i.relative_path LIMIT ?
    `).all(folderLinkId, limit)).map(toEntryRecord);
  }

  async markEntryTracked(folderLinkId: string, entryId: string, artifactId: string, fingerprint: string | null): Promise<void> {
    this.transaction(() => {
      this.database.prepare(`
        UPDATE folder_inventory SET state = 'tracked', skip_reason = NULL, artifact_id = ?, pending = 0,
          fingerprint = COALESCE(?, fingerprint)
        WHERE folder_link_id = ? AND id = ?
      `).run(artifactId, fingerprint, folderLinkId, entryId);
    });
  }

  async ensureFolderPath(command: Parameters<FolderLinkRepository["ensureFolderPath"]>[0]): Promise<string> {
    return this.transaction(() => {
      this.assertProjectActive(command.installationId, command.projectId);
      let parentId = command.rootFolderId;
      let depth = this.folderDepth(command.projectId, parentId);
      for (const segment of command.segments) {
        const child = this.database.prepare(`
          SELECT id FROM folders
          WHERE project_id = ? AND parent_folder_id = ? AND name_key = ? AND trashed_at IS NULL
        `).get(command.projectId, parentId, segment.nameKey);
        if (child !== undefined) {
          parentId = idSchema.parse(child).id;
          depth += 1;
          continue;
        }
        depth += 1;
        if (depth > maximumFolderDepth) {
          throw new FolderFailure({reason: "limit", message: "Folders can be nested at most 16 levels deep."});
        }
        const {count} = countSchema.parse(this.database.prepare(
          "SELECT COUNT(*) AS count FROM folders WHERE project_id = ?",
        ).get(command.projectId));
        if (count >= maximumProjectFolders) {
          throw new FolderFailure({reason: "limit", message: "The project has reached the folder limit."});
        }
        const id = `fld_${randomUUID()}`;
        this.database.prepare(`
          INSERT INTO folders (
            id, installation_id, project_id, parent_folder_id, name, name_key, revision, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)
        `).run(
          id, command.installationId, command.projectId, parentId, segment.name, segment.nameKey,
          command.createdAt, command.createdAt,
        );
        const created = this.database.prepare(`SELECT id, installation_id AS installationId,
          project_id AS projectId, parent_folder_id AS parentFolderId, name, name_key AS nameKey,
          revision, created_at AS createdAt, updated_at AS updatedAt FROM folders WHERE id = ?`).get(id);
        this.database.prepare(`
          INSERT INTO folder_actions (
            project_id, folder_id, action, principal_id, authorized_by_principal_id,
            idempotency_key, input_digest, result_json, created_at
          ) VALUES (?, ?, 'create', ?, ?, ?, ?, ?, ?)
        `).run(
          command.projectId, id, command.principalId, command.authorizedByPrincipalId,
          `folder-link-mirror:${id}`, command.inputDigest, JSON.stringify(created), command.createdAt,
        );
        parentId = id;
      }
      return parentId;
    });
  }

  async readCaptureResults(folderLinkId: string, batchKey: string) {
    const rows = z.array(captureRowSchema).parse(this.database.prepare(`
      SELECT input_digest AS inputDigest, result_json AS resultJson FROM folder_link_captures
      WHERE folder_link_id = ? AND batch_key = ? ORDER BY position
    `).all(folderLinkId, batchKey));
    const first = rows[0];
    if (first === undefined) return null;
    return {
      inputDigest: first.inputDigest,
      results: rows.map((row): CaptureEntryResult => captureResultSchema.parse(JSON.parse(row.resultJson))),
    };
  }

  async recordCaptureResult(
    folderLinkId: string,
    batchKey: string,
    inputDigest: string,
    position: number,
    result: CaptureEntryResult,
  ): Promise<void> {
    this.transaction(() => {
      this.database.prepare(`
        INSERT INTO folder_link_captures (folder_link_id, batch_key, input_digest, position, entry_id, result_json)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT (folder_link_id, batch_key, entry_id) DO NOTHING
      `).run(folderLinkId, batchKey, inputDigest, position, result.entryId, JSON.stringify(result));
    });
  }

  async listLinkBindings(folderLinkId: string): Promise<readonly LinkedBindingSummary[]> {
    const link = this.requireLinkById(folderLinkId);
    const prefix = `${link.path}/`;
    return z.array(z.object({
      artifactId: z.string(),
      artifactName: z.string(),
      path: z.string(),
      freshness: z.enum(["in-sync", "modified", "missing", "unreadable"]),
      capturedSize: z.number().int(),
      capturedSha256: z.string(),
    })).parse(this.database.prepare(`
      SELECT a.id AS artifactId, a.name AS artifactName, a.source_path AS path,
        a.source_status AS freshness, entry.size AS capturedSize, entry.sha256 AS capturedSha256
      FROM artifacts a
      JOIN versions version ON version.id = a.current_version_id
      JOIN manifest_entries entry ON entry.version_id = version.id AND entry.path = version.entry_path
      WHERE a.project_id = ? AND a.deleted_at IS NULL AND a.source_path IS NOT NULL
        AND substr(a.source_path, 1, ?) = ?
      ORDER BY a.source_path
    `).all(link.projectId, prefix.length, prefix));
  }

  async storeEntryLiveGrant(command: EntryLiveGrantWrite): Promise<void> {
    this.transaction(() => {
      this.database.prepare("DELETE FROM folder_entry_live_grants WHERE expires_at <= ?").run(command.createdAt);
      this.database.prepare(`
        INSERT INTO folder_entry_live_grants (
          token_digest, kind, principal_id, project_id, folder_link_id, entry_id, content_token,
          created_at, expires_at, consumed_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
      `).run(
        command.tokenDigest, command.kind, command.principalId, command.projectId,
        command.folderLinkId, command.entryId, command.contentToken, command.createdAt, command.expiresAt,
      );
    });
  }

  async consumeEntryLiveBootstrap(tokenDigest: string, contentToken: string, now: string): Promise<EntryLiveGrant | null> {
    return this.transaction(() => {
      const row = this.database.prepare(`
        UPDATE folder_entry_live_grants SET consumed_at = ?
        WHERE token_digest = ? AND kind = 'bootstrap' AND content_token = ?
          AND consumed_at IS NULL AND expires_at > ?
        RETURNING principal_id AS principalId, project_id AS projectId,
          folder_link_id AS folderLinkId, entry_id AS entryId, expires_at AS expiresAt
      `).get(now, tokenDigest, contentToken, now);
      return row === undefined ? null : grantSchema.parse(row);
    });
  }

  async findEntryLiveSession(tokenDigest: string, contentToken: string, now: string): Promise<EntryLiveGrant | null> {
    const row = this.database.prepare(`
      SELECT principal_id AS principalId, project_id AS projectId, folder_link_id AS folderLinkId,
        entry_id AS entryId, expires_at AS expiresAt
      FROM folder_entry_live_grants
      WHERE token_digest = ? AND kind = 'session' AND content_token = ? AND expires_at > ?
    `).get(tokenDigest, contentToken, now);
    return row === undefined ? null : grantSchema.parse(row);
  }

  private readLink(installationId: string, folderLinkId: string): FolderLinkRecord | null {
    const row = this.database.prepare(`SELECT ${linkColumns} FROM folder_links WHERE id = ? AND installation_id = ?`)
      .get(folderLinkId, installationId);
    return row === undefined ? null : toLinkRecord(linkRowSchema.parse(row));
  }

  private requireLink(installationId: string, folderLinkId: string): FolderLinkRecord {
    const link = this.readLink(installationId, folderLinkId);
    if (link === null) throw linkNotFound();
    return link;
  }

  private requireLinkById(folderLinkId: string): FolderLinkRecord {
    const row = this.database.prepare(`SELECT ${linkColumns} FROM folder_links WHERE id = ?`).get(folderLinkId);
    if (row === undefined) throw linkNotFound();
    return toLinkRecord(linkRowSchema.parse(row));
  }

  private folderDepth(projectId: string, folderId: string): number {
    const row = this.database.prepare(`
      WITH RECURSIVE chain(id, parent, level) AS (
        SELECT id, parent_folder_id, 1 FROM folders WHERE id = ? AND project_id = ?
        UNION ALL
        SELECT f.id, f.parent_folder_id, chain.level + 1 FROM folders f JOIN chain ON f.id = chain.parent
        WHERE chain.level <= ?
      )
      SELECT COALESCE(MAX(level), 0) AS count FROM chain
    `).get(folderId, projectId, maximumFolderDepth);
    const depth = countSchema.parse(row).count;
    if (depth === 0) throw new FolderFailure({reason: "not-found", message: "The folder does not exist."});
    return depth;
  }

  private assertProjectActive(installationId: string, projectId: string): void {
    const row = this.database.prepare(
      "SELECT archived_at AS archivedAt FROM projects WHERE id = ? AND installation_id = ?",
    ).get(projectId, installationId);
    if (row === undefined) throw new ProjectNotFound({message: "The project does not exist."});
    if (row["archivedAt"] !== null) {
      throw new ProjectArchived({message: "The project is archived and cannot accept new work."});
    }
  }
}

function toLinkRecord(row: z.infer<typeof linkRowSchema>): FolderLinkRecord {
  const {ignoreJson, inTrash, paused, ...rest} = row;
  return {
    ...rest,
    ignore: z.array(z.string()).parse(JSON.parse(ignoreJson)),
    inTrash: inTrash === 1,
    paused: paused === 1,
  };
}

function toEntryRecord(row: z.infer<typeof entryRowSchema>): InventoryEntryRecord {
  return {...row, pending: row.pending === 1};
}

function linkNotFound(): FolderLinkFailure {
  return new FolderLinkFailure({reason: "not-found", message: "The folder link does not exist."});
}
