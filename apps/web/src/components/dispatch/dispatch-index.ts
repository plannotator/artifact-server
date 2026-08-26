import {api, type AgentDispatch} from "@/api/client";

const dispatchPageSize = 100;

async function loadDispatchIndexPage(
  projectId: string,
  wanted: Set<string>,
  index: Map<string, AgentDispatch>,
  cursor: string | null,
): Promise<ReadonlyMap<string, AgentDispatch>> {
  if (wanted.size === 0) return index;
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
  return listed.nextCursor === null
    ? index
    : loadDispatchIndexPage(projectId, wanted, index, listed.nextCursor);
}

/** The newest send that carried each named thread away. */
export function loadDispatchIndex(
  projectId: string,
  threadIds: readonly string[],
): Promise<ReadonlyMap<string, AgentDispatch>> {
  return loadDispatchIndexPage(
    projectId,
    new Set(threadIds),
    new Map<string, AgentDispatch>(),
    null,
  );
}
