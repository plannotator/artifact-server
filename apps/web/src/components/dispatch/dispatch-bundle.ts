import type { CommentThread } from "@/api/client";
/** The annotations one send control resolved, ready to become one bundle. */
export interface DispatchBundle {
  /** Exact number of open annotations the control found. */
  readonly openCount: number;
  /** Ordered oldest first. The send control batches server-bounded dispatches. */
  readonly threadIds: readonly string[];
}

function oldestFirst(threads: readonly CommentThread[]): readonly string[] {
  return threads
    .toSorted((left, right) =>
      left.createdAt.localeCompare(right.createdAt)
      || left.id.localeCompare(right.id)
    )
    .map((thread) => thread.id);
}

/** One already-known set of annotations, oldest first. */
export function bundleOf(threadIds: readonly string[]): DispatchBundle {
  return {
    openCount: threadIds.length,
    threadIds,
  };
}

/** The same, taken from thread records so the order is the stored one. */
export function bundleOfThreads(
  threads: readonly CommentThread[],
): DispatchBundle {
  return bundleOf(oldestFirst(threads));
}
