import {z} from "zod";

import {InvalidPagination} from "../core/errors.js";
import {maximumTrashPageSize, type TrashCursor, type TrashPage} from "../core/trash.js";

export const trashPageQuerySchema = z.object({
  cursor: z.string().max(1_024).optional(),
  limit: z.coerce.number().int().min(1).max(maximumTrashPageSize).default(50),
});

export const folderRecoverSchema = z.object({name: z.string().max(2_000).optional()});
export const purgeSchema = z.object({confirm: z.string().max(2_000)});

const cursorSchema = z.object({trashedAt: z.string().min(1), id: z.string().min(1)});

export function decodeTrashCursor(cursor: string | null): TrashCursor | null {
  if (cursor === null) return null;
  try {
    return cursorSchema.parse(JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")));
  } catch {
    throw new InvalidPagination({message: "The trash page cursor is invalid."});
  }
}

export function trashPageResponse(page: TrashPage) {
  return {
    items: page.items,
    nextCursor: page.nextCursor === null
      ? null
      : Buffer.from(JSON.stringify(page.nextCursor), "utf8").toString("base64url"),
  };
}
