import {useEffect, useState} from "react";

import {api, type InsightActivityEvent, type InsightWindow} from "@/api/client";
import {ErrorPanel} from "@/components/product";
import {Button} from "@/components/ui/button";
import {Card, CardContent, CardDescription, CardHeader, CardTitle} from "@/components/ui/card";
import {Skeleton} from "@/components/ui/skeleton";
import {refinementText} from "@/i18n/messages/review-refinements";
import {dashboardText} from "@/i18n/messages/dashboard";
import {formatRelativeTime, formatTimestamp} from "@/lib/presentation";
import {activityActorLabel, activityLabel, artifactReviewHref} from "./dashboard-format.ts";

const text = dashboardText.activity;

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
        <CardTitle>{text.title}</CardTitle>
        <CardDescription>{text.description}</CardDescription>
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
                ? <p className="text-sm text-muted-foreground">{text.empty}</p>
                : (
                  <ol aria-label={text.trail} className="ml-1 grid border-l border-[var(--color-rule-2)]">
                    {groupActivity(state.events).map(([first, ...repeated]) => {
                      const row = (event: InsightActivityEvent) => (
                        <ActivityRow
                          event={event}
                          key={event.id}
                          now={now}
                          projectName={projectId === null ? projectNames.get(event.projectId) ?? null : null}
                        />
                      );
                      if (repeated.length === 0) return row(first);
                      const label = activityLabel(first.kind);
                      const verb = (label.lead || label.trail).trim();
                      return (
                        <li className="py-2.5 pl-6 text-sm" key={first.id}>
                          <details>
                            <summary className="cursor-pointer font-medium">
                              {refinementText.activityGroup(activityActorLabel(first.actor) ?? "", verb, repeated.length + 1)}
                            </summary>
                            <ol className="ml-2 border-l border-border">{[first, ...repeated].map(row)}</ol>
                          </details>
                        </li>
                      );
                    })}
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
                    {state.loadingMore ? text.loading : text.showOlder}
                  </Button>
                )}
            </div>
          )
          : null}
      </CardContent>
    </Card>
  );
}

function groupActivity(events: readonly InsightActivityEvent[]): [InsightActivityEvent, ...InsightActivityEvent[]][] {
  const groups: [InsightActivityEvent, ...InsightActivityEvent[]][] = [];
  for (const event of events) {
    const previous = groups.at(-1);
    if (previous !== undefined && event.actor !== null
      && previous[0].actor?.principalId === event.actor.principalId && previous[0].kind === event.kind) {
      previous.push(event);
    } else {
      groups.push([event]);
    }
  }
  return groups;
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
  // Workbench: violet is a person, teal is an instrument (an agent, a key, the
  // local token); an actor the record does not keep reads in muted ink.
  const actorTone = event.actor?.kind === "human"
    ? "text-[var(--color-accent)]"
    : event.actor?.kind === "service"
      ? "text-[var(--color-cool)]"
      : "text-muted-foreground";
  return (
    <li className="relative grid gap-1 py-2.5 pl-6 text-sm before:absolute before:top-[1rem] before:left-[-4px] before:size-[7px] before:rounded-full before:border before:border-[var(--color-rule-2)] before:bg-card sm:grid-cols-[6rem_minmax(0,1fr)] sm:gap-3">
      <time
        className="pt-px text-xs text-[var(--color-cool)] tabular-nums"
        dateTime={event.occurredAt}
        title={formatTimestamp(event.occurredAt)}
      >
        {formatRelativeTime(event.occurredAt, now)}
      </time>
      <p className="min-w-0">
        {actor === null ? null : <span className={`font-medium ${actorTone}`}>{actor} </span>}
        {label.lead === "" ? null : <span className="text-[var(--color-ink-2)]">{label.lead}</span>}
        {event.artifactId === null || event.artifactName === null
          ? label.trail === ""
            ? null
            : <span className="text-[var(--color-ink-2)]">{` ${text.unknownArtifact}${label.trail}`}</span>
          : (
            <>
              {" "}
              <a
                className="text-foreground underline-offset-4 hover:text-[var(--color-accent)] hover:underline"
                href={artifactReviewHref(event.projectId, event.artifactId)}
              >
                {event.artifactName}
              </a>
              {event.versionNumber === null
                ? null
                : <span className="font-mono text-[var(--color-cool)]"> v{event.versionNumber}</span>}
              {label.trail === "" ? null : <span className="text-[var(--color-ink-2)]">{label.trail}</span>}
            </>
          )}
        {projectName === null
          ? null
          : <span className="block text-sm text-muted-foreground">{projectName}</span>}
      </p>
    </li>
  );
}
