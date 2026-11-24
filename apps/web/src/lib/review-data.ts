import {api, type ArtifactPage, type CommentThread, type CommentThreadQuery} from "@/api/client";

/** Keep follow-up reads bounded when a catalog or dashboard spans many artifacts. */
export async function mapReviewItems<Item, Result>(
  items: readonly Item[],
  load: (item: Item) => Promise<Result>,
): Promise<Result[]> {
  const results: Result[] = [];
  const source = items.entries();
  const worker = async (): Promise<void> => {
    const next = source.next();
    if (next.done) return;
    const [index, item] = next.value;
    results[index] = await load(item);
    await worker();
  };
  await Promise.all(Array.from({length: Math.min(6, items.length)}, worker));
  return results;
}

export async function collectReviewPages<Item>(
  load: (cursor: string | null) => Promise<{readonly items: readonly Item[]; readonly nextCursor: string | null}>,
  cursor: string | null = null,
  items: Item[] = [],
): Promise<readonly Item[]> {
  const page = await load(cursor);
  items.push(...page.items);
  return page.nextCursor === null ? items : collectReviewPages(load, page.nextCursor, items);
}

export function listProjectArtifacts(projectId: string): Promise<ArtifactPage["artifacts"]> {
  return collectReviewPages(async (cursor) => {
    const page = await api.artifacts(projectId, cursor, []);
    return {items: page.artifacts, nextCursor: page.nextCursor};
  });
}

export function listArtifactThreads(
  projectId: string,
  artifactId: string,
  state: CommentThreadQuery["state"],
): Promise<readonly CommentThread[]> {
  return collectReviewPages((cursor) => api.comments(projectId, artifactId, {
    cursor, dispatched: "include", limit: 100, since: null, state, versionId: null,
  }));
}
