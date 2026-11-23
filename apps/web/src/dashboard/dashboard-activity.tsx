import {useEffect, useState} from "react";

import {api, type InsightActivityEvent, type InsightWindow} from "@/api/client";
import {ErrorPanel} from "@/components/product";
import {Button} from "@/components/ui/button";
import {Card, CardContent, CardDescription, CardHeader, CardTitle} from "@/components/ui/card";
import {Skeleton} from "@/components/ui/skeleton";
import {formatRelativeTime, formatTimestamp} from "@/lib/presentation";
import {activityActorLabel, activityLabel, artifactReviewHref} from "./dashboard-format.ts";

type ActivityState =
  | {readonly status: "loading"}
  | {readonly error: Error; readonly status: "failed"}
  | {
    readonly events: readonly InsightActivityEvent[];
    readonly loadingMore: boolean;
    readonly nextCursor: string | null;
    readonly status: "ready";
  };

/** Newest-first durable changes for the selected scope and window. */
export function ActivitySection({
  now,
  projectId,
  projectNames,
  window,
}: {
  readonly now: number;
  readonly projectId: string | null;
  readonly projectNames: ReadonlyMap<string, string>;
  readonly window: InsightWindow;
}) {
  const [state, setState] = useState<ActivityState>({status: "loading"});
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let current = true;
    setState({status: "loading"});
    const load = async () => {
      try {
        const page = await api.insightActivity(projectId, window, null);
        if (!current) return;
        setState({
          events: page.items,
          loadingMore: false,
          nextCursor: page.nextCursor,
          status: "ready",
        });
      } catch (caught) {
        if (current) setState({error: caught instanceof Error ? caught : new Error("The activity could not be loaded."), status: "failed"});
      }
    };
    void load();
    return () => {
      current = false;
    };
  }, [attempt, projectId, window]);

  const loadMore = async (cursor: string, events: readonly InsightActivityEvent[]) => {
    setState({events, loadingMore: true, nextCursor: cursor, status: "ready"});
    try {
      const page = await api.insightActivity(projectId, window, cursor);
      setState({
        events: [...events, ...page.items],
        loadingMore: false,
        nextCursor: page.nextCursor,
        status: "ready",
      });
    } catch (caught) {
      setState({error: caught instanceof Error ? caught : new Error("The activity could not be loaded."), status: "failed"});
    }
  };

  return (
    <Card className="min-w-0">
      <CardHeader>
        <CardTitle>Activity</CardTitle>
        <CardDescription>Who published, changed, commented, or dispatched, newest first.</CardDescription>
      </CardHeader>
      <CardContent>
        {state.status === "loading"
          ? (
            <div className="grid gap-3">
              <Skeleton className="h-5 w-full" />
              <Skeleton className="h-5 w-11/12" />
              <Skeleton className="h-5 w-10/12" />
            </div>
          )
          : null}
        {state.status === "failed"
          ? <ErrorPanel error={state.error} onRetry={() => setAttempt((value) => value + 1)} />
          : null}
        {state.status === "ready"
          ? (
            <div className="grid gap-4">
              {state.events.length === 0
                ? <p className="text-sm text-muted-foreground">Nothing happened in this window.</p>
                : (
                  <ol className="grid divide-y">
                    {state.events.map((event) => (
                      <ActivityRow
                        event={event}
                        key={event.id}
                        now={now}
                        projectName={projectId === null ? projectNames.get(event.projectId) ?? null : null}
                      />
                    ))}
                  </ol>
                )}
              {state.nextCursor === null
                ? null
                : (
                  <Button
                    className="justify-self-start"
                    disabled={state.loadingMore}
                    onClick={() => {
                      if (state.nextCursor !== null) void loadMore(state.nextCursor, state.events);
                    }}
                    size="sm"
                    type="button"
                    variant="outline"
                  >
                    {state.loadingMore ? "Loading…" : "Show older activity"}
                  </Button>
                )}
            </div>
          )
          : null}
      </CardContent>
    </Card>
  );
}

function ActivityRow({
  event,
  now,
  projectName,
}: {
  readonly event: InsightActivityEvent;
  readonly now: number;
  readonly projectName: string | null;
}) {
  const actor = activityActorLabel(event.actor);
  const label = activityLabel(event.kind);
  return (
    <li className="flex flex-col gap-1 py-3 text-sm sm:flex-row sm:items-baseline sm:gap-4">
      <time
        className="w-28 shrink-0 text-xs text-muted-foreground"
        dateTime={event.occurredAt}
        title={formatTimestamp(event.occurredAt)}
      >
        {formatRelativeTime(event.occurredAt, now)}
      </time>
      <p className="min-w-0">
        {actor === null ? null : <span className="font-medium">{actor} </span>}
        <span>{label}</span>
        {event.artifactId === null || event.artifactName === null
          ? null
          : (
            <>
              {" "}
              <a
                className="underline-offset-4 hover:underline"
                href={artifactReviewHref(event.projectId, event.artifactId)}
              >
                {event.artifactName}
              </a>
              {event.versionNumber === null
                ? null
                : <span className="font-mono text-muted-foreground"> v{event.versionNumber}</span>}
            </>
          )}
        {projectName === null
          ? null
          : <span className="text-muted-foreground"> · {projectName}</span>}
      </p>
    </li>
  );
}
