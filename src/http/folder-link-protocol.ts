import {z} from "zod";

import type {FolderLinkView} from "../application/linked-folders.js";
import {
  folderLinkState, type InventoryEntryRecord, maximumCaptureBatch, maximumIgnorePatternCharacters,
  maximumLinkIgnorePatterns,
} from "../core/folder-links.js";
import {folderIdSchema} from "./folder-protocol.js";

/** Shared HTTP and MCP shapes for linked folders (file-management-spec.md section 6). */

const uuid = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
export const folderLinkIdSchema = z.string().regex(new RegExp(`^flk_${uuid}$`, "u"));
export const inventoryEntryIdSchema = z.string().regex(new RegExp(`^fle_${uuid}$`, "u"));
export const folderLinkRevisionSchema = z.number().int().positive();
const ignorePatternsSchema = z.array(z.string().min(1).max(maximumIgnorePatternCharacters))
  .max(maximumLinkIgnorePatterns);

export const linkFolderSchema = z.object({
  folderId: folderIdSchema.nullable().default(null),
  ignore: ignorePatternsSchema.default([]),
  newFolderName: z.string().min(1).max(2_000).nullable().default(null),
  path: z.string().min(1).max(4_096),
});

export const updateFolderLinkSchema = z.object({
  expectedRevision: folderLinkRevisionSchema,
  ignore: ignorePatternsSchema.optional(),
  paused: z.boolean().optional(),
});

export const captureInventorySchema = z.union([
  z.object({all: z.literal(true)}).strict(),
  z.object({entryIds: z.array(z.string().max(200)).min(1).max(maximumCaptureBatch * 10)}).strict(),
]);

export const acceptRelinkSchema = z.object({
  artifactId: z.string().min(1).max(200),
  entryId: inventoryEntryIdSchema,
  expectedSha256: z.string().regex(/^[a-f0-9]{64}$/u),
});

export const inventoryQuerySchema = z.object({
  cursor: z.string().max(8_192).optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
  pending: z.enum(["true", "false"]).optional(),
  state: z.enum(["untracked", "tracked", "skipped"]).optional(),
});

/** One folder link as an authenticated local member reads it. */
export function folderLinkProjection(link: FolderLinkView) {
  return {
    createdAt: link.createdAt,
    entryCount: link.entryCount,
    folderId: link.folderId,
    id: link.id,
    ignore: link.ignore,
    ignoredCount: link.ignoredCount,
    lastScanCompletedAt: link.lastScanCompletedAt,
    lastScanStartedAt: link.lastScanStartedAt,
    overLimitReason: link.overLimitReason,
    path: link.path,
    paused: link.paused,
    pendingCount: link.pendingCount,
    projectId: link.projectId,
    revision: link.revision,
    scanActivity: link.scanActivity,
    skippedCount: link.skippedCount,
    state: folderLinkState(link),
  };
}

/** One inventory entry; the raw on-disk spelling is never projected. */
export function inventoryEntryProjection(entry: InventoryEntryRecord) {
  return {
    artifactId: entry.artifactId,
    freshness: entry.freshness,
    id: entry.id,
    observedAt: entry.observedAt,
    pending: entry.pending,
    relativePath: entry.relativePath,
    size: entry.size,
    skipReason: entry.skipReason,
    state: entry.state,
  };
}

export const folderLinkOutputSchema = z.object({
  createdAt: z.string(),
  entryCount: z.number().int(),
  folderId: z.string(),
  id: z.string(),
  ignore: z.array(z.string()),
  ignoredCount: z.number().int(),
  lastScanCompletedAt: z.string().nullable(),
  lastScanStartedAt: z.string().nullable(),
  overLimitReason: z.enum(["entries", "ignore-file"]).nullable(),
  path: z.string(),
  paused: z.boolean(),
  pendingCount: z.number().int(),
  projectId: z.string(),
  revision: z.number().int(),
  scanActivity: z.enum(["idle", "queued", "scanning"]),
  skippedCount: z.number().int(),
  state: z.enum(["active", "paused", "unavailable", "over-limit"]),
}).strict();

export const inventoryEntryOutputSchema = z.object({
  artifactId: z.string().nullable(),
  freshness: z.enum(["in-sync", "modified", "missing", "unreadable"]).nullable(),
  id: z.string(),
  observedAt: z.string(),
  pending: z.boolean(),
  relativePath: z.string(),
  size: z.number().int().nullable(),
  skipReason: z.string().nullable(),
  state: z.enum(["untracked", "tracked", "skipped"]),
}).strict();

export const captureResultOutputSchema = z.object({
  artifactId: z.string().nullable(),
  code: z.string().nullable(),
  entryId: z.string(),
  message: z.string().nullable(),
  relativePath: z.string().nullable(),
  status: z.enum(["captured", "unchanged", "refused"]),
  versionId: z.string().nullable(),
}).strict();
