import { api, type CommentThread } from "@/api/client";
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

const gatherPageSize = 100;

/**
 * How far "send all open on this version" walks the listing.
 *
 * Threads list newest first, so the oldest ones live on the last page. Ten
 * pages reach a thousand open annotations on one version, far past the point
 * where one bundle could carry them, and the bundle says so when it stops.
 */
const maximumGatheredPages = 10;

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

/**
 * Every open, undispatched annotation on one saved version, oldest first.
 *
 * The walk reads the listing under its default exclusion, so an annotation an
 * earlier send already carried away is never gathered again. Past the page
 * bound it stops and reports its count as a floor, and the bundle is then the
 * oldest of what it read rather than the oldest that exist.
 */
export async function openVersionBundle(
  projectId: string,
  artifactId: string,
  versionId: string,
): Promise<DispatchBundle> {
  const gathered: CommentThread[] = [];
  let cursor: string | null = null;
  let truncated = false;
  for (let page = 0; page < maximumGatheredPages; page += 1) {
    // Keyset paging: each page is read with the cursor the last one returned.
    // eslint-disable-next-line no-await-in-loop
    const listed = await api.comments(projectId, artifactId, {
      cursor,
      dispatched: "exclude",
      limit: gatherPageSize,
      since: null,
      state: "open",
      versionId,
    });
    gathered.push(...listed.items);
    cursor = listed.nextCursor;
    if (cursor === null) break;
    truncated = page === maximumGatheredPages - 1;
  }
  return {
    openCount: gathered.length,
    openCountIsLowerBound: truncated,
    threadIds: oldestFirst(gathered).slice(0, maximumDispatchBundleSize),
  };
}
