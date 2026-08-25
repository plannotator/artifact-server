import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {z} from "zod";

import {
  api,
  type CommentAnchor,
  type CommentThread,
  type CommentThreadQuery,
} from "@/api/client";
import {
  mergeThreads,
  threadWatermark,
  useCommentListOwnership,
  useCommentPoll,
} from "@/components/comments/comment-poll";
import {formatTimestamp} from "@/lib/presentation";
import {
  reviewAnchorSchema,
  type ReviewAnchor,
  type ReviewAnnotation,
} from "@/review-frame/protocol";

const threadPageSize = 100;

function threadQuery(versionId: string, since: string | null): CommentThreadQuery {
  return {
    cursor: null,
    dispatched: null,
    limit: threadPageSize,
    since,
    state: null,
    versionId,
  };
}

function toAnnotation(thread: CommentThread): ReviewAnnotation {
  const parsed = reviewAnchorSchema.safeParse(thread.anchor);
  return {
    anchor: parsed.success ? parsed.data : null,
    body: thread.body,
    state: thread.state,
    threadId: thread.id,
  };
}

export interface ReviewCommentSession {
  readonly annotations: readonly ReviewAnnotation[];
  readonly changeState: (thread: CommentThread) => Promise<void>;
  readonly error: Error | null;
  readonly loading: boolean;
  readonly reload: () => Promise<void>;
  readonly selectedThreadId: string | null;
  readonly selectThread: (threadId: string | null) => void;
  readonly submit: (
    body: string,
    anchor: ReviewAnchor | null,
    path: string,
  ) => Promise<boolean>;
  readonly threads: readonly CommentThread[];
  readonly unanchoredIds: readonly string[];
  readonly updateUnanchored: (threadIds: readonly string[]) => void;
}

/** Keep one Review version's saved threads and Plannotator projections in sync. */
export function useReviewComments({
  artifactId,
  onVersionChanged,
  projectId,
  versionId,
}: {
  readonly artifactId: string | null;
  readonly onVersionChanged: (versionId: string) => void;
  readonly projectId: string;
  readonly versionId: string | null;
}): ReviewCommentSession {
  const [threads, setThreads] = useState<readonly CommentThread[]>([]);
  const [selectedThreadId, setSelectedThreadId] = useState<string | null>(null);
  const [unanchoredIds, setUnanchoredIds] = useState<readonly string[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const watermarkRef = useRef<string | null>(null);
  const ownership = useCommentListOwnership();
  const active = artifactId !== null && projectId !== "" && versionId !== null;

  const reload = useCallback(async (): Promise<void> => {
    if (artifactId === null || projectId === "" || versionId === null) {
      setThreads([]);
      setSelectedThreadId(null);
      setUnanchoredIds([]);
      setError(null);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      await ownership.own(async () => {
        const page = await api.comments(
          projectId,
          artifactId,
          threadQuery(versionId, null),
        );
        setThreads(page.items);
      });
    } catch (caught) {
      setError(
        caught instanceof Error ? caught : new Error("Comment loading failed."),
      );
    } finally {
      setLoading(false);
    }
  }, [artifactId, ownership, projectId, versionId]);

  useEffect(() => {
    setThreads([]);
    setSelectedThreadId(null);
    setUnanchoredIds([]);
    void reload();
  }, [reload]);

  useEffect(() => {
    watermarkRef.current = threadWatermark(threads);
    if (
      selectedThreadId !== null
      && !threads.some((thread) => thread.id === selectedThreadId)
    ) {
      setSelectedThreadId(null);
    }
  }, [selectedThreadId, threads]);

  const poll = useCallback(async (): Promise<void> => {
    if (artifactId === null || projectId === "" || versionId === null) return;
    const token = ownership.open();
    if (token < 0) return;
    try {
      const page = await api.comments(
        projectId,
        artifactId,
        threadQuery(versionId, watermarkRef.current),
      );
      if (page.items.length === 0 || !ownership.settled(token)) return;
      setThreads((current) => mergeThreads(current, page.items));
    } catch {
      // A failed background refresh leaves the last readable thread set intact.
    }
  }, [artifactId, ownership, projectId, versionId]);

  useCommentPoll(poll, active);

  const submit = useCallback(async (
    body: string,
    anchor: ReviewAnchor | null,
    path: string,
  ): Promise<boolean> => {
    if (artifactId === null || projectId === "" || versionId === null) return false;
    setError(null);
    try {
      const storedAnchor: CommentAnchor = z.json().parse(anchor);
      const created = await ownership.own(() =>
        api.createComment(
          projectId,
          artifactId,
          versionId,
          {anchor: storedAnchor, body, path},
          crypto.randomUUID(),
        )
      );
      if (created.thread.versionId !== versionId) {
        onVersionChanged(created.thread.versionId);
      } else {
        await reload();
        setSelectedThreadId(created.thread.id);
      }
      return true;
    } catch (caught) {
      setError(
        caught instanceof Error ? caught : new Error("Comment creation failed."),
      );
      return false;
    }
  }, [artifactId, onVersionChanged, ownership, projectId, reload, versionId]);

  const changeState = useCallback(async (thread: CommentThread): Promise<void> => {
    if (artifactId === null || projectId === "") return;
    setError(null);
    try {
      await ownership.own(() =>
        api.updateComment(projectId, artifactId, thread.id, {
          state: thread.state === "open" ? "resolved" : "open",
        })
      );
      await reload();
    } catch (caught) {
      setError(
        caught instanceof Error ? caught : new Error("Comment state change failed."),
      );
    }
  }, [artifactId, ownership, projectId, reload]);

  const annotations = useMemo(
    () => threads.filter((thread) => thread.state === "open").map(toAnnotation),
    [threads],
  );

  return {
    annotations,
    changeState,
    error,
    loading,
    reload,
    selectedThreadId,
    selectThread: setSelectedThreadId,
    submit,
    threads,
    unanchoredIds,
    updateUnanchored: setUnanchoredIds,
  };
}

/** Review-native thread list kept beside, never over, the artifact. */
export function ReviewCommentsInspector({
  canComment,
  session,
}: {
  readonly canComment: boolean;
  readonly session: ReviewCommentSession;
}) {
  const unanchored = new Set(session.unanchoredIds);
  return (
    <div className="as-comments">
      <div className="as-comments__intro">
        <p>
          {canComment
            ? "Click any element in the HTML preview to place a comment."
            : "Comments are read-only for this account or archived project."}
        </p>
        <button
          className="as-inspector-section__action"
          disabled={session.loading}
          onClick={() => void session.reload()}
          type="button"
        >
          {session.loading ? "Loading…" : "Reload"}
        </button>
      </div>
      {session.error === null ? null : (
        <p className="as-comments__error" role="alert">{session.error.message}</p>
      )}
      {session.loading && session.threads.length === 0 ? (
        <p className="as-inspector-empty">Loading comments…</p>
      ) : null}
      {!session.loading && session.threads.length === 0 ? (
        <p className="as-inspector-empty">No comments on this version yet.</p>
      ) : null}
      <ol className="as-comment-list">
        {session.threads.map((thread) => (
          <li key={thread.id}>
            <article
              aria-current={session.selectedThreadId === thread.id ? "true" : undefined}
              className="as-comment-card"
              data-selected={session.selectedThreadId === thread.id}
            >
              <header>
                <strong>{thread.author.displayName}</strong>
                <span data-state={thread.state}>{thread.state}</span>
              </header>
              <p>{thread.body}</p>
              <footer>
                <span>
                  <time dateTime={thread.updatedAt}>{formatTimestamp(thread.updatedAt)}</time>
                  {thread.path === null ? " · Whole version" : ` · ${thread.path}`}
                </span>
                {unanchored.has(thread.id) ? (
                  <small>Original location unavailable</small>
                ) : null}
                <div>
                  {thread.path === null ? null : (
                    <button
                      className="as-button"
                      onClick={() => session.selectThread(thread.id)}
                      type="button"
                    >
                      Show in page
                    </button>
                  )}
                  {canComment ? (
                    <button
                      className="as-button"
                      onClick={() => void session.changeState(thread)}
                      type="button"
                    >
                      {thread.state === "open" ? "Resolve" : "Reopen"}
                    </button>
                  ) : null}
                </div>
              </footer>
            </article>
          </li>
        ))}
      </ol>
    </div>
  );
}
