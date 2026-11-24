/** Operations one batch may apply to every item (FLD-005). */
export const batchOperations = [
  "move", "trash", "recover", "purge", "tag-add", "tag-remove", "capture",
] as const;

export type BatchOperation = (typeof batchOperations)[number];

/** Most items one batch may name; larger selections run as consecutive batches. */
export const maximumBatchItems = 100;

/** One batch item, guarded exactly as it would be if sent alone. */
export type BatchItem =
  | {
    readonly kind: "artifact";
    readonly projectId: string;
    readonly artifactId: string;
    readonly expectedCurrentVersionId: string;
  }
  | {
    readonly kind: "folder";
    readonly projectId: string;
    readonly folderId: string;
    readonly expectedRevision: number;
  };

/** Operation parameters shared by every item of one batch. */
export interface BatchParameters {
  /** Move destination; `null` is the destination project's root. */
  readonly toFolderId?: string | null | undefined;
  /** Move into another project; omitted keeps each item in its own project. */
  readonly toProjectId?: string | undefined;
  /** Tags added or removed by `tag-add` and `tag-remove`. */
  readonly tags?: readonly string[] | undefined;
}

/** How one item ended; a batch is never all-or-nothing. */
export type BatchItemStatus = "ok" | "conflict" | "not-found" | "refused";

/** The typed count a purge batch must carry, so a stray click cannot purge a selection. */
export function purgeBatchConfirmation(count: number): string {
  return `purge ${count} items`;
}

/** Identity used to refuse repeated items and to derive each item's idempotency key. */
export function batchItemIdentity(item: BatchItem): string {
  return item.kind === "artifact" ? `artifact:${item.artifactId}` : `folder:${item.folderId}`;
}
