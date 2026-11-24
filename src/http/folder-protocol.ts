import {z} from "zod";

import {folderIdPattern} from "../application/folders.js";
import {InvalidPagination} from "../core/errors.js";
import type {FolderContents, FolderCursor} from "../core/folders.js";
import type {ArtifactPage} from "../core/model.js";
import {artifactBrowserUrl} from "./artifact-http-links.js";

export const folderIdSchema = z.string().regex(folderIdPattern);
export const folderLocationSchema = z.union([folderIdSchema, z.literal("root")])
  .transform((id) => id === "root" ? null : id);

export const createFolderSchema = z.object({
  id: folderIdSchema.optional(),
  name: z.string().max(2_000),
  parentFolderId: folderIdSchema.nullable().default(null),
});

export const folderRevisionSchema = z.number().int().positive();

export const updateFolderSchema = z.object({
  name: z.string().max(2_000).optional(),
  parentFolderId: folderIdSchema.nullable().optional(),
  expectedRevision: folderRevisionSchema,
});

export const artifactRenameSchema = z.object({
  name: z.string().max(2_000),
  expectedCurrentVersionId: z.string().min(1).max(200),
});

export const artifactMoveSchema = z.object({
  toFolderId: folderIdSchema.nullable(),
  expectedCurrentVersionId: z.string().min(1).max(200),
});

const cursorSchema = z.discriminatedUnion("kind", [
  z.object({kind: z.literal("folder"), nameKey: z.string().min(1)}),
  z.object({
    kind: z.literal("artifact"),
    position: z.object({
      createdAt: z.string(),
      id: z.string(),
      rank: z.number().int().nonnegative().optional(),
    }),
  }),
]);

export function decodeFolderCursor(cursor: string | null): FolderCursor | null {
  if (cursor === null) return null;
  try {
    const decoded = cursorSchema.parse(JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")));
    if (decoded.kind === "folder") return decoded;
    const {rank, ...position} = decoded.position;
    return {...decoded, position: rank === undefined ? position : {...position, rank}};
  } catch {
    throw new InvalidPagination({message: "The folder page cursor is invalid."});
  }
}

export function encodeFolderCursor(cursor: FolderCursor | null): string | null {
  return cursor === null ? null : Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

export function folderCreateKey(id: string | undefined, key: string | undefined): string {
  return key ?? (id === undefined ? "" : `create:${id}`);
}

export function folderContentsResponse(applicationUrl: URL, page: FolderContents) {
  return {
    ...page,
    artifacts: artifactPageItems(applicationUrl, page.artifacts),
    nextCursor: encodeFolderCursor(page.nextCursor),
  };
}

export function artifactPageItems(applicationUrl: URL, artifacts: ArtifactPage["items"]) {
  return artifacts.map(({commentCount, versionCount, ...artifact}) => ({
    artifact,
    commentCount,
    links: {
      artifact: artifactBrowserUrl(applicationUrl, artifact.id),
      management: new URL(`/api/v1/artifacts/${artifact.id}`, applicationUrl).toString(),
    },
    versionCount,
  }));
}
