import {z} from "zod";

import type {ListFilesInput} from "../application/file-catalog.js";
import {batchOperations, maximumBatchItems} from "../core/batch.js";
import {InvalidPagination, isArtifactServerFailure} from "../core/errors.js";
import {
  type FileCursor, fileKinds, fileLinkFilters, type FilePage, fileSorts, type FileSort,
  type FileSortDirection, maximumFilePageSize, maximumFilterValues,
} from "../core/file-catalog.js";
import type {Principal} from "../core/identity.js";
import {artifactServerFailureResponse} from "./artifact-http-failure.js";
import {folderIdSchema, folderRevisionSchema} from "./folder-protocol.js";

const idSchema = z.string().trim().min(1).max(200);
const instantSchema = z.string().min(1).max(64);

/** Overview filters shared by HTTP query strings and the MCP tool input. */
export const fileFilterFields = {
  projectIds: z.array(idSchema).max(maximumFilterValues).default([]),
  folderId: z.string().min(1).max(200).nullable().default(null),
  recursive: z.boolean().default(true),
  kinds: z.array(z.enum(fileKinds)).max(maximumFilterValues).default([]),
  tags: z.array(z.string().max(200)).max(maximumFilterValues).default([]),
  linked: z.enum(fileLinkFilters).default("any"),
  createdAfter: instantSchema.nullable().default(null),
  createdBefore: instantSchema.nullable().default(null),
  updatedAfter: instantSchema.nullable().default(null),
  updatedBefore: instantSchema.nullable().default(null),
  search: z.string().max(500).nullable().default(null),
};

export const fileListFields = {
  ...fileFilterFields,
  sort: z.enum(fileSorts).default("updated"),
  direction: z.enum(["asc", "desc"]).optional(),
  cursor: z.string().max(1_024).nullable().default(null),
  limit: z.number().int().min(1).max(maximumFilePageSize).default(50),
};

const fileListSchema = z.object(fileListFields).strict();

/** Read repeatable and single query parameters into the shared overview input. */
export function parseFileQuery(query: {
  readonly single: Record<string, string>;
  readonly repeated: (name: string) => readonly string[];
}) {
  const optional = (name: string) => query.single[name] ?? null;
  return fileListSchema.parse({
    projectIds: query.repeated("projectId"),
    folderId: optional("folderId"),
    recursive: optional("recursive") === null ? true : z.enum(["true", "false"]).parse(optional("recursive")) === "true",
    kinds: query.repeated("kind"),
    tags: query.repeated("tag"),
    linked: query.single["linked"] ?? "any",
    createdAfter: optional("createdAfter"),
    createdBefore: optional("createdBefore"),
    updatedAfter: optional("updatedAfter"),
    updatedBefore: optional("updatedBefore"),
    search: optional("search"),
    sort: query.single["sort"] ?? "updated",
    direction: query.single["direction"],
    cursor: optional("cursor"),
    limit: z.coerce.number().int().min(1).max(maximumFilePageSize).default(50).parse(query.single["limit"]),
  });
}

/** Name sorts read A→Z by default; every other sort reads largest or newest first. */
export function defaultFileDirection(sort: FileSort): FileSortDirection {
  return sort === "name" ? "asc" : "desc";
}

/** Turn decoded overview input into the application command for one principal. */
export function fileListCommand(principal: Principal, input: z.infer<typeof fileListSchema>): ListFilesInput {
  return {
    ...input,
    principal,
    direction: input.direction ?? defaultFileDirection(input.sort),
    cursor: decodeFileCursor(input.cursor),
  };
}

const cursorSchema = z.object({
  sort: z.enum(fileSorts),
  direction: z.enum(["asc", "desc"]),
  value: z.union([z.string(), z.number()]),
  id: z.string().min(1),
});

export function decodeFileCursor(cursor: string | null): FileCursor | null {
  if (cursor === null) return null;
  try {
    return cursorSchema.parse(JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")));
  } catch {
    throw new InvalidPagination({message: "The file page cursor is invalid."});
  }
}

export function filePageResponse(page: FilePage) {
  return {
    items: page.items,
    nextCursor: page.nextCursor === null
      ? null
      : Buffer.from(JSON.stringify(page.nextCursor), "utf8").toString("base64url"),
  };
}

const batchItemSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("artifact"),
    projectId: idSchema,
    artifactId: idSchema,
    expectedCurrentVersionId: idSchema,
  }).strict(),
  z.object({
    kind: z.literal("folder"),
    projectId: idSchema,
    folderId: folderIdSchema,
    expectedRevision: folderRevisionSchema,
  }).strict(),
]);

/**
 * Batch body shared by HTTP and MCP. The item array is bounded generously for
 * the body only; the application refuses more than 100 items with INVALID_INPUT.
 */
export const batchFields = {
  operation: z.enum(batchOperations),
  items: z.array(batchItemSchema).max(maximumBatchItems * 10),
  params: z.object({
    toFolderId: folderIdSchema.nullable().optional(),
    toProjectId: idSchema.optional(),
    tags: z.array(z.string().max(200)).max(maximumFilterValues).optional(),
  }).strict().default({}),
  idempotencyKey: z.string().max(200),
  confirm: z.string().max(200).optional(),
};

export const batchRequestSchema = z.object(batchFields).strict();

interface BatchResults {
  readonly operation: string;
  readonly results: readonly ({
    readonly index: number;
    readonly item: z.infer<typeof batchItemSchema>;
  } & ({readonly status: "ok"; readonly result: object} | {
    readonly status: "conflict" | "not-found" | "refused";
    readonly failure: Error;
  }))[];
}

/** Project per-item failures onto the same codes a single request would answer. */
export function batchResponse(batch: BatchResults) {
  return {
    operation: batch.operation,
    results: batch.results.map((entry) => {
      if (entry.status === "ok") return {index: entry.index, item: entry.item, status: entry.status, result: entry.result};
      const projection = isArtifactServerFailure(entry.failure)
        ? artifactServerFailureResponse(entry.failure)
        : {code: "INTERNAL_ERROR", message: "The server could not complete the request.", status: 500};
      // The HTTP status belongs to a single request; a batch answers 200 with per-item codes.
      const error = Object.fromEntries(Object.entries(projection).filter(([field]) => field !== "status"));
      return {index: entry.index, item: entry.item, status: entry.status, error};
    }),
  };
}
