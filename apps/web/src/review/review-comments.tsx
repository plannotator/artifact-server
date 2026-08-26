import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import {z} from "zod";

import {
  api,
  type CommentAnchor,
  type CommentReply,
  type CommentThread,
  type CommentThreadDetails,
  type CommentThreadQuery,
} from "@/api/client";
import {CommentComposer} from "@/components/comments/comment-composer";
import {maximumCommentBodyCharacters} from "@/components/comments/comment-limits";
import {
  mergeThreads,
  threadWatermark,
  useCommentListOwnership,
  useCommentPoll,
} from "@/components/comments/comment-poll";
import {formatTimestamp} from "@/lib/presentation";
import {bundleOfThreads} from "@/components/dispatch/dispatch-bundle";
import {useDispatchUndo} from "@/components/dispatch/dispatch-toast";
import {PresenceAvatar} from "@/components/dispatch/presence-avatar";
import {SendToAgentControl} from "@/components/dispatch/send-to-agent-dialog";
import {
  reviewAnchorSchema,
  type ReviewAnchor,
  type ReviewAnnotation,
} from "@/review-frame/protocol";

const threadPageSize = 100;
const conversationLoadConcurrency = 6;

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

async function loadConversations(
  projectId: string,
  artifactId: string,
  threads: readonly CommentThread[],
): Promise<readonly CommentThreadDetails[]> {
  const conversations = new Map<string, CommentThreadDetails>();
  const worker = async (index: number): Promise<void> => {
    const thread = threads[index];
    if (thread === undefined) return;
    const details = await api.comment(projectId, artifactId, thread.id);
    conversations.set(thread.id, details);
    await worker(index + conversationLoadConcurrency);
  };
  await Promise.all(
    Array.from(
      {length: Math.min(conversationLoadConcurrency, threads.length)},
      (_, index) => worker(index),
    ),
  );
  return threads.flatMap((thread) => {
    const details = conversations.get(thread.id);
    return details === undefined ? [] : [details];
  });
}

export interface ReviewCommentSession {
  readonly artifactId: string | null;
  readonly annotations: readonly ReviewAnnotation[];
  readonly changeState: (thread: CommentThread) => Promise<void>;
  readonly createReply: (
    thread: CommentThread,
    body: string,
    idempotencyKey: string,
  ) => Promise<boolean>;
  readonly deleteReply: (reply: CommentReply) => Promise<void>;
  readonly error: Error | null;
  readonly loading: boolean;
  readonly projectId: string;
  readonly reload: () => Promise<void>;
  readonly repliesByThread: ReadonlyMap<string, readonly CommentReply[]>;
  readonly selectedThreadId: string | null;
  readonly selectThread: (threadId: string | null) => void;
  readonly submit: (
    body: string,
    anchor: ReviewAnchor | null,
    path: string | null,
  ) => Promise<boolean>;
  readonly threads: readonly CommentThread[];
  readonly unanchoredIds: readonly string[];
  readonly updateUnanchored: (threadIds: readonly string[]) => void;
  readonly updateReply: (reply: CommentReply, body: string) => Promise<boolean>;
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
  const [repliesByThread, setRepliesByThread] = useState<ReadonlyMap<
    string,
    readonly CommentReply[]
  >>(new Map());
  const [selectedThreadId, setSelectedThreadId] = useState<string | null>(null);
  const [unanchoredIds, setUnanchoredIds] = useState<readonly string[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const watermarkRef = useRef<string | null>(null);
  const reloadGenerationRef = useRef(0);
  const threadUpdatedAtRef = useRef<ReadonlyMap<string, string>>(new Map());
  const ownership = useCommentListOwnership();
  const active = artifactId !== null && projectId !== "" && versionId !== null;

  const reload = useCallback(async (): Promise<void> => {
    const generation = reloadGenerationRef.current + 1;
    reloadGenerationRef.current = generation;
    if (artifactId === null || projectId === "" || versionId === null) {
      setThreads([]);
      setRepliesByThread(new Map());
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
        const conversations = await loadConversations(
          projectId,
          artifactId,
          page.items,
        );
        if (reloadGenerationRef.current !== generation) return;
        setThreads(conversations.map(({thread}) => thread));
        setRepliesByThread(new Map(
          conversations.map(({replies, thread}) => [thread.id, replies]),
        ));
      });
    } catch (caught) {
      if (reloadGenerationRef.current !== generation) return;
      setError(
        caught instanceof Error ? caught : new Error("Comment loading failed."),
      );
    } finally {
      if (reloadGenerationRef.current === generation) setLoading(false);
    }
  }, [artifactId, ownership, projectId, versionId]);

  useEffect(() => {
    setThreads([]);
    setRepliesByThread(new Map());
    setSelectedThreadId(null);
    setUnanchoredIds([]);
    void reload();
  }, [reload]);

  useEffect(() => {
    watermarkRef.current = threadWatermark(threads);
    threadUpdatedAtRef.current = new Map(
      threads.map((thread) => [thread.id, thread.updatedAt]),
    );
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
      const changedThreads = page.items.filter((thread) =>
        threadUpdatedAtRef.current.get(thread.id) !== thread.updatedAt
      );
      if (changedThreads.length === 0) return;
      const conversations = await loadConversations(
        projectId,
        artifactId,
        changedThreads,
      );
      if (!ownership.settled(token)) return;
      setThreads((current) => mergeThreads(
        current,
        conversations.map(({thread}) => thread),
      ));
      setRepliesByThread((current) => {
        const nextReplies = new Map(current);
        for (const conversation of conversations) {
          nextReplies.set(conversation.thread.id, conversation.replies);
        }
        return nextReplies;
      });
    } catch {
      // A failed background refresh leaves the last readable thread set intact.
    }
  }, [artifactId, ownership, projectId, versionId]);

  useCommentPoll(poll, active);

  const submit = useCallback(async (
    body: string,
    anchor: ReviewAnchor | null,
    path: string | null,
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

  const createReply = useCallback(async (
    thread: CommentThread,
    body: string,
    idempotencyKey: string,
  ): Promise<boolean> => {
    if (artifactId === null || projectId === "" || thread.state !== "open") return false;
    setError(null);
    try {
      await ownership.own(() => api.createCommentReply(
        projectId,
        artifactId,
        thread.id,
        body,
        idempotencyKey,
      ));
      await reload();
      return true;
    } catch (caught) {
      setError(caught instanceof Error ? caught : new Error("Reply creation failed."));
      return false;
    }
  }, [artifactId, ownership, projectId, reload]);

  const updateReply = useCallback(async (
    reply: CommentReply,
    body: string,
  ): Promise<boolean> => {
    if (artifactId === null || projectId === "") return false;
    setError(null);
    try {
      await ownership.own(() => api.updateCommentReply(
        projectId,
        artifactId,
        reply.threadId,
        reply.id,
        body,
      ));
      await reload();
      return true;
    } catch (caught) {
      setError(caught instanceof Error ? caught : new Error("Reply edit failed."));
      return false;
    }
  }, [artifactId, ownership, projectId, reload]);

  const deleteReply = useCallback(async (reply: CommentReply): Promise<void> => {
    if (artifactId === null || projectId === "") return;
    setError(null);
    try {
      await ownership.own(() => api.deleteCommentReply(
        projectId,
        artifactId,
        reply.threadId,
        reply.id,
      ));
      await reload();
    } catch (caught) {
      setError(caught instanceof Error ? caught : new Error("Reply deletion failed."));
    }
  }, [artifactId, ownership, projectId, reload]);

  const annotations = useMemo(
    () => threads.filter((thread) => thread.state === "open").map(toAnnotation),
    [threads],
  );

  return {
    annotations,
    artifactId,
    changeState,
    createReply,
    deleteReply,
    error,
    loading,
    projectId,
    reload,
    repliesByThread,
    selectedThreadId,
    selectThread: setSelectedThreadId,
    submit,
    threads,
    unanchoredIds,
    updateUnanchored: setUnanchoredIds,
    updateReply,
  };
}

/** Review-native thread list kept beside, never over, the artifact. */
export function ReviewCommentsInspector({
  canDeleteAny,
  canComment,
  principalId,
  session,
}: {
  readonly canDeleteAny: boolean;
  readonly canComment: boolean;
  readonly principalId: string;
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
              <ol className="as-comment-replies">
                {(session.repliesByThread.get(thread.id) ?? []).map((reply) => (
                  <ReviewReply
                    canDeleteAny={canDeleteAny}
                    key={reply.id}
                    onDelete={session.deleteReply}
                    onUpdate={session.updateReply}
                    principalId={principalId}
                    reply={reply}
                  />
                ))}
              </ol>
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
              {canComment && thread.state === "open" ? (
                <div className="as-comment-reply-composer">
                  <CommentComposer
                    cancelLabel={null}
                    initialBody=""
                    inputId={`review-reply-${thread.id}`}
                    label="Reply"
                    maximumCharacters={maximumCommentBodyCharacters}
                    onCancel={null}
                    onSubmit={(body, idempotencyKey) => session.createReply(
                      thread,
                      body,
                      idempotencyKey,
                    )}
                    submitLabel="Post reply"
                  />
                </div>
              ) : null}
            </article>
          </li>
        ))}
      </ol>
    </div>
  );
}

function ReviewReply({
  canDeleteAny,
  onDelete,
  onUpdate,
  principalId,
  reply,
}: {
  readonly canDeleteAny: boolean;
  readonly onDelete: (reply: CommentReply) => Promise<void>;
  readonly onUpdate: (reply: CommentReply, body: string) => Promise<boolean>;
  readonly principalId: string;
  readonly reply: CommentReply;
}) {
  const [editing, setEditing] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const editorId = useId();
  const ownReply = reply.author.principalId === principalId;
  const remove = async (): Promise<void> => {
    setDeleting(true);
    await onDelete(reply);
    setDeleting(false);
  };
  return (
    <li>
      <header>
        <strong>{reply.author.displayName}</strong>
        <time dateTime={reply.updatedAt}>{formatTimestamp(reply.updatedAt)}</time>
      </header>
      {editing ? (
        <CommentComposer
          cancelLabel="Cancel"
          initialBody={reply.body}
          inputId={editorId}
          label="Edit reply"
          maximumCharacters={maximumCommentBodyCharacters}
          onCancel={() => setEditing(false)}
          onSubmit={async (body) => {
            const changed = await onUpdate(reply, body);
            if (changed) setEditing(false);
            return changed;
          }}
          submitLabel="Save reply"
        />
      ) : <p>{reply.body}</p>}
      {editing || (!ownReply && !canDeleteAny) ? null : (
        <div className="as-comment-reply__actions">
          {ownReply ? (
            <button className="as-button" onClick={() => setEditing(true)} type="button">
              Edit
            </button>
          ) : null}
          <button
            className="as-button"
            disabled={deleting}
            onClick={() => void remove()}
            type="button"
          >
            {deleting ? "Deleting…" : "Delete"}
          </button>
        </div>
      )}
    </li>
  );
}
