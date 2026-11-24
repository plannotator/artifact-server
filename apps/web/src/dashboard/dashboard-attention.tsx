import {useEffect, useState} from "react";

import {api, type AgentDispatch, type CommentThread} from "@/api/client";
import {refinementText} from "@/i18n/messages/review-refinements";
import {collectReviewPages, listArtifactThreads, listProjectArtifacts, mapReviewItems} from "@/lib/review-data";
import {readReviewVisits} from "@/lib/review-visits";

const text = refinementText.attention;

interface AttentionItem {
  readonly href: string;
  readonly id: string;
  readonly label: string;
}

interface Attention {
  readonly addressed: readonly AttentionItem[];
  readonly failed: readonly AttentionItem[];
  readonly versions: readonly AttentionItem[] | null;
}

function listDispatches(projectId: string): Promise<readonly AgentDispatch[]> {
  return collectReviewPages((cursor) => api.agentDispatches(projectId, {
    agentId: null, cursor, limit: 100, state: null,
  }));
}

function threadHref(thread: CommentThread): string {
  return `/review?${new URLSearchParams({
    artifact: thread.artifactId,
    project: thread.projectId,
    thread: thread.id,
    version: thread.versionId,
  })}`;
}

async function loadProjectAttention(
  projectId: string,
  principalId: string,
  visits: ReturnType<typeof readReviewVisits>,
): Promise<Attention> {
  const [artifacts, dispatches] = await Promise.all([
    listProjectArtifacts(projectId),
    listDispatches(projectId),
  ]);
  const latestByThread = new Map<string, AgentDispatch>();
  const wantedThreads = new Set<string>();
  for (const dispatch of dispatches) {
    for (const id of dispatch.threadIds) {
      if (!latestByThread.has(id)) latestByThread.set(id, dispatch);
      if (dispatch.state === "addressed" || dispatch.state === "failed") wantedThreads.add(id);
    }
  }
  const groups = await mapReviewItems(artifacts, async ({artifact, commentCount}) => {
    const visitedAt = visits?.[`${principalId}:${artifact.id}`];
    const [threads, versionList] = await Promise.all([
      commentCount === 0 || wantedThreads.size === 0
        ? [] : listArtifactThreads(projectId, artifact.id, null),
      visitedAt === undefined ? [] : api.versions(projectId, artifact.id),
    ]);
    const versions = visitedAt === undefined ? [] : versionList.flatMap(({version}) =>
      Date.parse(version.createdAt) > visitedAt ? [{
        href: `/review?${new URLSearchParams({artifact: artifact.id, project: projectId, version: version.id})}`,
        id: version.id,
        label: `${artifact.name} · v${version.number}`,
      }] : [],
    );
    return {name: artifact.name, threads: threads.filter((thread) => wantedThreads.has(thread.id)), versions};
  });
  const threadItems = new Map<string, AttentionItem>();
  const addressed: AttentionItem[] = [];
  for (const {name, threads} of groups) {
    for (const thread of threads) {
      const item = {href: threadHref(thread), id: thread.id, label: `${name} · ${thread.body}`};
      threadItems.set(thread.id, item);
      if (thread.state === "open" && latestByThread.get(thread.id)?.state === "addressed") addressed.push(item);
    }
  }
  const failed = dispatches.filter((dispatch) => dispatch.state === "failed").map((dispatch) => {
    const thread = dispatch.threadIds.map((id) => threadItems.get(id)).find((item) => item !== undefined);
    return {
      href: thread?.href ?? `/review/dashboard?${new URLSearchParams({project: projectId})}#dispatches`,
      id: dispatch.id,
      label: thread?.label ?? dispatch.failureReason ?? dispatch.agentDisplayName,
    };
  });
  return {addressed, failed, versions: visits === null ? null : groups.flatMap((group) => group.versions)};
}

export function DashboardAttention({
  principalId,
  projectId,
  projectIds,
}: {
  readonly principalId: string;
  readonly projectId: string | null;
  readonly projectIds: readonly string[];
}) {
  const [attention, setAttention] = useState<Attention | null>(null);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    let current = true;
    setLoading(true);
    const visits = readReviewVisits();
    const scope = projectId === null ? projectIds : [projectId];
    const load = async (): Promise<void> => {
      try {
        const projects = await mapReviewItems(scope, (id) => loadProjectAttention(id, principalId, visits));
        if (!current) return;
        setAttention({
          addressed: projects.flatMap((project) => project.addressed),
          failed: projects.flatMap((project) => project.failed),
          versions: visits === null ? null : projects.flatMap((project) => project.versions ?? []),
        });
      } catch {
        if (current) setAttention(null);
      } finally {
        if (current) setLoading(false);
      }
    };
    void load();
    return () => { current = false; };
  }, [principalId, projectId, projectIds]);

  return (
    <section aria-busy={loading} aria-labelledby="dashboard-attention-title" className="grid gap-3 rounded-[var(--radius-card)] border border-border bg-card p-4 sm:p-6">
      <h2 className="text-lg font-semibold" id="dashboard-attention-title">{text.title}</h2>
      <dl className="grid gap-4 sm:grid-cols-3">
        {([
          [text.addressed, attention?.addressed],
          [text.versions, attention?.versions],
          [text.failed, attention?.failed],
        ] as const).map(([label, items]) => (
          <div className="grid min-w-0 content-start gap-1 border-t border-border pt-3" key={label}>
            <dt className="text-sm text-muted-foreground">{label}</dt>
            <dd className="font-mono text-xl tabular-nums">{loading ? "…" : items?.length ?? text.unknown}</dd>
            {loading || !items?.length ? null : (
              <dd className="text-sm">
                <ul className="grid max-h-40 gap-1 overflow-auto">
                  {items.map((item) => (
                    <li className="min-w-0 break-words" key={item.id}>
                      <a className="underline decoration-border underline-offset-4 hover:decoration-current" href={item.href}>{item.label}</a>
                    </li>
                  ))}
                </ul>
              </dd>
            )}
          </div>
        ))}
      </dl>
    </section>
  );
}
