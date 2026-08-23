import { useEffect, useMemo, useRef } from "react";

import type { CommentThread } from "@/api/client";

/**
 * How long an open comment surface waits between asking the server for the
 * threads that changed. Short enough that a second reviewer's comment lands
 * while the page is still open, long enough that a reading tab costs one
 * small request a minute.
 */
export const commentPollIntervalMilliseconds = 7_000;

/**
 * The instant an incremental poll asks from: the newest change on screen.
 *
 * Stored instants are canonical millisecond ISO text, so the newest one is
 * also the largest in ordinary string order. The server's filter is inclusive
 * (`updated_at >= since`), so the thread that set the watermark comes back
 * with every poll and simply replaces itself.
 */
export function threadWatermark(
  threads: readonly CommentThread[],
): string | null {
  let newest: string | null = null;
  for (const thread of threads) {
    if (newest === null || thread.updatedAt > newest) newest = thread.updatedAt;
  }
  return newest;
}

/**
 * Fold one incremental page into the threads on screen: a listed id takes the
 * server's newer record, an unlisted id joins the list. The result carries the
 * listing route's own order (newest thread first), so a polled thread lands
 * where a reload would have put it.
 *
 * A poll only ever reports threads the filter still matches, so it cannot see
 * a thread leave one: an annotation another reader sends to an agent keeps its
 * card here until this surface reloads.
 */
export function mergeThreads(
  current: readonly CommentThread[],
  incoming: readonly CommentThread[],
): readonly CommentThread[] {
  if (incoming.length === 0) return current;
  const merged = new Map(current.map((thread) => [thread.id, thread]));
  for (const thread of incoming) merged.set(thread.id, thread);
  return [...merged.values()].toSorted((left, right) =>
    right.createdAt.localeCompare(left.createdAt)
    || right.id.localeCompare(left.id)
  );
}

/**
 * Which writer owns the thread list. Loads, reloads, and mutations run through
 * `own`; a poll takes a token from `open` before its request and keeps its
 * answer only when `settled` still holds it, so a background poll can never
 * overwrite what an owning write has just put on screen.
 */
export interface CommentListOwnership {
  /** A token for one poll, or a negative number while a write is in flight. */
  readonly open: () => number;
  readonly own: <T>(work: () => Promise<T>) => Promise<T>;
  /** Whether no owning write started or finished while the poll was open. */
  readonly settled: (token: number) => boolean;
}

export function useCommentListOwnership(): CommentListOwnership {
  const inFlight = useRef(0);
  const generation = useRef(0);
  return useMemo(
    () => ({
      open: () => (inFlight.current > 0 ? -1 : generation.current),
      own: async <T,>(work: () => Promise<T>): Promise<T> => {
        inFlight.current += 1;
        generation.current += 1;
        try {
          return await work();
        } finally {
          inFlight.current -= 1;
        }
      },
      settled: (token: number) =>
        token >= 0 && inFlight.current === 0 && token === generation.current,
    }),
    [],
  );
}

/**
 * Run one poll on an interval for as long as the document is visible. A hidden
 * tab polls nothing at all and asks once the moment it comes back, so a
 * backgrounded review costs no requests and still opens up to date.
 */
export function useCommentPoll(
  poll: () => Promise<void>,
  enabled: boolean,
): void {
  const latest = useRef(poll);
  useEffect(() => {
    latest.current = poll;
  }, [poll]);

  useEffect(() => {
    let timer: number | null = null;
    const stop = (): void => {
      if (timer !== null) window.clearInterval(timer);
      timer = null;
    };
    const start = (): void => {
      stop();
      timer = window.setInterval(() => {
        void latest.current();
      }, commentPollIntervalMilliseconds);
    };
    const onVisibility = (): void => {
      if (document.hidden) {
        stop();
        return;
      }
      void latest.current();
      start();
    };
    if (enabled) {
      if (!document.hidden) start();
      document.addEventListener("visibilitychange", onVisibility);
    }
    return () => {
      stop();
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [enabled]);
}
