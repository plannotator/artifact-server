import { api, type AgentDispatch } from "@/api/client";

const dispatchPageSize = 50;

/** How far the lookup pages before it gives up on the remaining threads. */
const maximumLookupPages = 5;

/**
 * The send that carried each of these threads away, newest send first.
 *
 * A thread carries no dispatch id on the wire, so the "Sent" filter reads the
 * project's sends and stops as soon as every listed thread is accounted for.
 * A thread that a failed send released and a later send carried again matches
 * the newer one, because the listing is newest first.
 */
export async function loadDispatchIndex(
  projectId: string,
  threadIds: readonly string[],
): Promise<ReadonlyMap<string, AgentDispatch>> {
  const wanted = new Set(threadIds);
  const index = new Map<string, AgentDispatch>();
  let cursor: string | null = null;
  for (let page = 0; page < maximumLookupPages && wanted.size > 0; page += 1) {
    // Keyset paging: each page is read with the cursor the last one returned.
    // eslint-disable-next-line no-await-in-loop
    const listed = await api.agentDispatches(projectId, {
      agentId: null,
      cursor,
      limit: dispatchPageSize,
      state: null,
    });
    for (const dispatch of listed.items) {
      for (const threadId of dispatch.threadIds) {
        if (wanted.delete(threadId)) index.set(threadId, dispatch);
      }
    }
    cursor = listed.nextCursor;
    if (cursor === null) break;
  }
  return index;
}
