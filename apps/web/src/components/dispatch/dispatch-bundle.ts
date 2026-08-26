import type { CommentThread } from "@/api/client";
import { maximumDispatchBundleSize } from "@/components/dispatch/dispatch-limits";

/** The annotations one send control resolved, ready to become one bundle. */
export interface DispatchBundle {
  /** How many open annotations the control found before the bundle bound. */
  readonly openCount: number;
  /** The count is a floor: more annotations exist than the control walked. */
  readonly openCountIsLowerBound: boolean;
  /** Ordered oldest first and already capped at the bundle bound. */
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

/** One already-known set of annotations, oldest first, capped for one send. */
export function bundleOf(threadIds: readonly string[]): DispatchBundle {
  return {
    openCount: threadIds.length,
    openCountIsLowerBound: false,
    threadIds: threadIds.slice(0, maximumDispatchBundleSize),
  };
}

/** The same, taken from thread records so the order is the stored one. */
export function bundleOfThreads(
  threads: readonly CommentThread[],
): DispatchBundle {
  return bundleOf(oldestFirst(threads));
}
