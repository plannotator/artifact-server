import {useEffect, useMemo, useState} from "react";

import type {ArtifactPage, CommentThread} from "@/api/client";
import {listArtifactThreads, mapReviewItems} from "@/lib/review-data";

export function useCatalogOpenCounts({
  comments,
  items,
  projectId,
  selectedArtifactId,
}: {
  readonly comments: readonly CommentThread[];
  readonly items: ArtifactPage["artifacts"];
  readonly projectId: string;
  readonly selectedArtifactId: string | null;
}): ReadonlyMap<string, number> {
  const [counts, setCounts] = useState<ReadonlyMap<string, number>>(new Map());
  const [selectedCount, setSelectedCount] = useState<{
    readonly artifactId: string;
    readonly count: number;
  } | null>(null);
  useEffect(() => {
    let current = true;
    const withComments = items.filter(({artifact, commentCount}) =>
      artifact.projectId === projectId && commentCount > 0
    );
    const load = async (): Promise<void> => {
      const entries = await mapReviewItems(withComments, async ({artifact}) => {
        try {
          const threads = await listArtifactThreads(projectId, artifact.id, "open");
          return [artifact.id, threads.length] as const;
        } catch {
          return [artifact.id, 0] as const;
        }
      });
      if (current) setCounts(new Map(entries));
    };
    void load();
    return () => { current = false; };
  }, [items, projectId]);

  useEffect(() => {
    if (selectedArtifactId === null || projectId === "") return undefined;
    let current = true;
    const load = async (): Promise<void> => {
      try {
        const threads = await listArtifactThreads(projectId, selectedArtifactId, "open");
        if (current) setSelectedCount({artifactId: selectedArtifactId, count: threads.length});
      } catch {
        // Keep the last readable count until the next catalog or comment refresh.
      }
    };
    void load();
    return () => { current = false; };
  }, [comments, projectId, selectedArtifactId]);
  return useMemo(() => {
    if (selectedCount === null || selectedCount.artifactId !== selectedArtifactId) return counts;
    return new Map(counts).set(selectedCount.artifactId, selectedCount.count);
  }, [counts, selectedArtifactId, selectedCount]);
}
