import { useEffect, useId, useRef, useState } from "react";

import {
  api,
  type AgentDispatch,
  type CommentThread,
  type CommentThreadQuery,
  type CommentThreadState,
  type Version,
} from "@/api/client";
import { CommentComposer } from "@/components/comments/comment-composer";
import { maximumCommentBodyCharacters } from "@/components/comments/comment-limits";
import {
  mergeThreads,
  threadWatermark,
  useCommentListOwnership,
  useCommentPoll,
} from "@/components/comments/comment-poll";
import { CommentThreadCard } from "@/components/comments/comment-thread-card";
import {
  bundleOfThreads,
  openVersionBundle,
} from "@/components/dispatch/dispatch-bundle";
import { loadDispatchIndex } from "@/components/dispatch/dispatch-index";
import { DispatchSelectionBar } from "@/components/dispatch/dispatch-selection-bar";
import { SendToAgentDialog } from "@/components/dispatch/send-to-agent-dialog";
import { ErrorPanel, StatePanel } from "@/components/product";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";

const pageSize = 50;
const allVersions = "all";
const anyState = "all";
/** The one view that shows threads an active send carries. */
const sentThreads = "sent";

type StateFilter = CommentThreadState | typeof anyState | typeof sentThreads;

/** Whole-version anchor written by the Comments tab; the review view anchors elements. */
const wholeVersionAnchor = { kind: "page" };

/** Comment threads for one artifact with state, version, and reply management. */
export function CommentsPanel({
  artifactId,
  canManage,
  canSend,
  currentVersionId,
  onThreadsChanged,
  projectId,
  versions,
}: {
  readonly artifactId: string;
  readonly canManage: boolean;
  /** This reader may send annotations to a connected agent. */
  readonly canSend: boolean;
  readonly currentVersionId: string;
  readonly onThreadsChanged: () => Promise<void>;
  readonly projectId: string;
  readonly versions: readonly Version[];
}) {
  const [threads, setThreads] = useState<readonly CommentThread[]>([]);
  const [dispatches, setDispatches] = useState<
    ReadonlyMap<string, AgentDispatch>
  >(new Map());
  const [selectedIds, setSelectedIds] = useState<readonly string[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [principalId, setPrincipalId] = useState<string | null>(null);
  const [stateFilter, setStateFilter] = useState<StateFilter>(anyState);
  const [versionFilter, setVersionFilter] = useState<string>(allVersions);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const stateFilterId = useId();
  const versionFilterId = useId();
  const composerId = useId();

  const watermarkRef = useRef<string | null>(null);
  const ownership = useCommentListOwnership();

  const sentView = stateFilter === sentThreads;

  const threadQuery = (
    cursor: string | null,
    since: string | null,
  ): CommentThreadQuery => ({
    cursor,
    // The server's own default hides dispatched threads, which is what makes
    // a send consumptive here without any filtering of its own.
    dispatched: sentView ? "only" : null,
    limit: pageSize,
    since,
    state: stateFilter === "open" || stateFilter === "resolved"
      ? stateFilter
      : null,
    versionId: versionFilter === allVersions ? null : versionFilter,
  });

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      await ownership.own(async () => {
        const page = await api.comments(
          projectId,
          artifactId,
          threadQuery(null, null),
        );
        const listed = new Set(page.items.map((thread) => thread.id));
        setThreads(page.items);
        setNextCursor(page.nextCursor);
        setDispatches(
          sentView
            ? await loadDispatchIndex(projectId, [...listed])
            : new Map(),
        );
        // Selection belongs to the views that can send; the "Sent" view cannot.
        setSelectedIds((current) =>
          sentView ? [] : current.filter((id) => listed.has(id))
        );
        setNow(Date.now());
      });
    } catch (caught) {
      setError(
        caught instanceof Error ? caught : new Error("Comment loading failed."),
      );
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
  }, [artifactId, projectId, stateFilter, versionFilter]);

  useEffect(() => {
    watermarkRef.current = threadWatermark(threads);
  }, [threads]);

  /**
   * Ask only for what changed since the newest thread on screen and fold the
   * answer in, so an agent's or another reader's comment appears without a
   * reload. The "Sent" view stays out of it: its cards are drawn from a
   * separate dispatch index that only a full load builds.
   */
  const pollThreads = async () => {
    const token = ownership.open();
    if (token < 0) return;
    try {
      const page = await api.comments(
        projectId,
        artifactId,
        threadQuery(null, watermarkRef.current),
      );
      if (page.items.length === 0 || !ownership.settled(token)) return;
      setThreads((current) => mergeThreads(current, page.items));
      setNow(Date.now());
    } catch {
      // A failed poll changes nothing on screen; Reload reports for itself.
    }
  };

  useCommentPoll(pollThreads, !sentView);

  useEffect(() => {
    const readPrincipal = async () => {
      try {
        const session = await api.session();
        setPrincipalId(session.principal.id);
      } catch {
        // Without a readable session the panel simply hides author-only controls.
        setPrincipalId(null);
      }
    };
    void readPrincipal();
  }, []);

  const loadMore = async () => {
    if (nextCursor === null) return;
    setLoadingMore(true);
    setError(null);
    try {
      const page = await ownership.own(() =>
        api.comments(projectId, artifactId, threadQuery(nextCursor, null))
      );
      setThreads((current) => [...current, ...page.items]);
      setNextCursor(page.nextCursor);
      if (sentView) {
        const moreDispatches = await loadDispatchIndex(
          projectId,
          page.items.map((thread) => thread.id),
        );
        setDispatches((current) => new Map([...current, ...moreDispatches]));
      }
    } catch (caught) {
      setError(
        caught instanceof Error ? caught : new Error("Comment loading failed."),
      );
    } finally {
      setLoadingMore(false);
    }
  };

  const reload = async () => {
    await load();
    await onThreadsChanged();
  };

  const cancelSend = async (dispatchId: string) => {
    setError(null);
    try {
      await api.cancelAgentDispatch(projectId, dispatchId);
      await reload();
    } catch (caught) {
      setError(
        caught instanceof Error ? caught : new Error("Cancelling the send failed."),
      );
    }
  };

  const changeSelected = (threadId: string, checked: boolean) => {
    setSelectedIds((current) =>
      checked
        ? [...current, threadId]
        : current.filter((id) => id !== threadId)
    );
  };

  const composeVersionId = versionFilter === allVersions
    ? currentVersionId
    : versionFilter;

  const createThread = async (body: string, idempotencyKey: string) => {
    setError(null);
    try {
      await ownership.own(() =>
        api.createComment(
          projectId,
          artifactId,
          composeVersionId,
          { anchor: wholeVersionAnchor, body, path: null },
          idempotencyKey,
        )
      );
      await reload();
      return true;
    } catch (caught) {
      setError(
        caught instanceof Error ? caught : new Error("Comment creation failed."),
      );
      return false;
    }
  };

  const versionNumbers = new Map(
    versions.map((version) => [version.id, version.number]),
  );
  const versionLabel = (versionId: string) => {
    const number = versionNumbers.get(versionId);
    return number === undefined ? "Unknown version" : `Version ${number}`;
  };
  const ordered = threads.toSorted((left, right) =>
    right.updatedAt.localeCompare(left.updatedAt)
    || right.createdAt.localeCompare(left.createdAt)
    || right.id.localeCompare(left.id)
  );
  const filtered = stateFilter !== anyState || versionFilter !== allVersions;
  /** Open annotations no send has taken yet are the ones a bundle can carry. */
  const sendable = (thread: CommentThread) =>
    canSend && !sentView && thread.state === "open";
  const selectedThreads = ordered.filter((thread) =>
    selectedIds.includes(thread.id)
  );
  const cancelDispatchAction = (threadId: string) => {
    const dispatch = dispatches.get(threadId);
    if (!canSend || dispatch === undefined) return null;
    return async () => {
      await cancelSend(dispatch.id);
    };
  };

  return (
    <div className="flex flex-col gap-6">
      <section className="border p-5" aria-labelledby={`${composerId}-heading`}>
        <h2
          className="mb-1 font-heading text-lg font-semibold"
          id={`${composerId}-heading`}
        >
          Comment on {versionLabel(composeVersionId)}
        </h2>
        <p className="mb-4 text-sm leading-6 text-muted-foreground">
          A comment is attached to one exact saved version and stays readable
          after newer versions are published.
        </p>
        <CommentComposer
          cancelLabel={null}
          initialBody=""
          inputId={composerId}
          label="New comment"
          maximumCharacters={maximumCommentBodyCharacters}
          onCancel={null}
          onSubmit={createThread}
          submitLabel="Post comment"
        />
      </section>

      <div className="flex flex-wrap items-end gap-4">
        <div className="grid gap-2">
          <Label htmlFor={stateFilterId}>State</Label>
          <NativeSelect
            className="w-44"
            id={stateFilterId}
            onChange={(event) => {
              const value = event.currentTarget.value;
              setStateFilter(
                value === "open"
                  ? "open"
                  : value === "resolved"
                    ? "resolved"
                    : value === sentThreads
                      ? sentThreads
                      : anyState,
              );
            }}
            value={stateFilter}
          >
            <NativeSelectOption value={anyState}>All comments</NativeSelectOption>
            <NativeSelectOption value="open">Open</NativeSelectOption>
            <NativeSelectOption value="resolved">Resolved</NativeSelectOption>
            <NativeSelectOption value={sentThreads}>
              Sent to an agent
            </NativeSelectOption>
          </NativeSelect>
        </div>
        <div className="grid gap-2">
          <Label htmlFor={versionFilterId}>Version</Label>
          <NativeSelect
            className="w-64"
            id={versionFilterId}
            onChange={(event) => setVersionFilter(event.currentTarget.value)}
            value={versionFilter}
          >
            <NativeSelectOption value={allVersions}>All versions</NativeSelectOption>
            {versions.map((version) => (
              <NativeSelectOption key={version.id} value={version.id}>
                Version {version.number}
              </NativeSelectOption>
            ))}
          </NativeSelect>
        </div>
        <Button
          disabled={loading}
          onClick={() => void reload()}
          type="button"
          variant="outline"
        >
          {loading ? "Loading…" : "Reload comments"}
        </Button>
        {!canSend || sentView
          ? null
          : versionFilter === allVersions
            ? (
              <p className="max-w-xs pb-3 text-xs leading-5 text-muted-foreground">
                Choose one version to send all of its open annotations to an
                agent as a single bundle.
              </p>
            )
            : (
              <SendToAgentDialog
                buttonSize="default"
                buttonVariant="default"
                label="Send all open on this version"
                onSent={reload}
                projectId={projectId}
                resolveBundle={() =>
                  openVersionBundle(projectId, artifactId, versionFilter)}
              />
            )}
      </div>

      {error === null ? null : <ErrorPanel error={error} onRetry={() => void load()} />}

      {sentView
        ? (
          <p className="text-sm leading-6 text-muted-foreground">
            These annotations are with an agent. A send that fails or is
            canceled returns its annotations to the other views automatically.
          </p>
        )
        : null}

      {selectedThreads.length === 0
        ? null
        : (
          <DispatchSelectionBar
            onClear={() => setSelectedIds([])}
            onSent={reload}
            projectId={projectId}
            threads={selectedThreads}
          />
        )}

      {loading && threads.length === 0
        ? (
          <StatePanel
            description="Reading comment threads for this artifact."
            title="Loading comments"
          />
        )
        : ordered.length === 0
          ? (
            <StatePanel
              description={sentView
                ? "No annotation on this artifact is with an agent. A send that fails or is canceled returns its annotations to the other views."
                : filtered
                  ? "No comment thread matches this state and version filter."
                  : "Nobody has commented on a saved version of this artifact yet."}
              title={sentView
                ? "Nothing sent"
                : filtered
                  ? "No matching comments"
                  : "No comments"}
            />
          )
          : (
            <div className="border">
              {ordered.map((thread) => (
                <CommentThreadCard
                  artifactId={artifactId}
                  canDeleteAny={canManage}
                  dispatch={dispatches.get(thread.id) ?? null}
                  key={thread.id}
                  maximumBodyCharacters={maximumCommentBodyCharacters}
                  now={now}
                  onCancelDispatch={cancelDispatchAction(thread.id)}
                  onChanged={reload}
                  onError={setError}
                  onShowInPage={null}
                  principalId={principalId}
                  projectId={projectId}
                  selected={false}
                  selection={sendable(thread)
                    ? {
                      checked: selectedIds.includes(thread.id),
                      onCheckedChange: (checked) =>
                        changeSelected(thread.id, checked),
                    }
                    : null}
                  sendAction={sendable(thread)
                    ? (
                      <SendToAgentDialog
                        label="Send to agent"
                        onSent={reload}
                        projectId={projectId}
                        resolveBundle={() =>
                          Promise.resolve(bundleOfThreads([thread]))}
                      />
                    )
                    : null}
                  thread={thread}
                  unanchored={false}
                  versionLabel={versionLabel(thread.versionId)}
                />
              ))}
            </div>
          )}

      {nextCursor === null
        ? null
        : (
          <div>
            <Button
              disabled={loadingMore}
              onClick={() => void loadMore()}
              type="button"
              variant="outline"
            >
              {loadingMore ? "Loading…" : "Load more"}
            </Button>
          </div>
        )}
    </div>
  );
}
