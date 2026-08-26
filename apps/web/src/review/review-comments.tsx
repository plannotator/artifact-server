import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import {z} from "zod";

import {
  api,
  type AgentDispatch,
  type AgentPresence,
  type CommentAnchor,
  type CommentReply,
  type CommentThread,
  type CommentThreadDetails,
  type CommentThreadQuery,
} from "@/api/client";
import {CommentComposer} from "@/components/comments/comment-composer";
import {useCommentDraft} from "@/components/comments/comment-drafts";
import {maximumCommentBodyCharacters} from "@/components/comments/comment-limits";
import {
  mergeThreads,
  threadWatermark,
  useCommentListOwnership,
  useCommentPoll,
} from "@/components/comments/comment-poll";
import {formatTimestamp} from "@/lib/presentation";
import {bundleOfThreads} from "@/components/dispatch/dispatch-bundle";
import {loadDispatchIndex} from "@/components/dispatch/dispatch-index";
import {DispatchSelectionBar} from "@/components/dispatch/dispatch-selection-bar";
import {
  dispatchIsCancelable,
  DispatchStateChip,
} from "@/components/dispatch/dispatch-state";
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

function threadQuery(
  versionId: string,
  since: string | null,
  cursor: string | null,
  dispatched: "exclude" | "include" | "only" | null = null,
): CommentThreadQuery {
  return {
    cursor,
    dispatched,
    limit: threadPageSize,
    since,
    state: null,
    versionId,
  };
}

async function loadAllThreads(
  projectId: string,
  artifactId: string,
  versionId: string,
  since: string | null,
  dispatched: "exclude" | "include" | "only" | null = null,
  cursor: string | null = null,
  collected: readonly CommentThread[] = [],
): Promise<readonly CommentThread[]> {
  const page = await api.comments(
    projectId,
    artifactId,
    threadQuery(versionId, since, cursor, dispatched),
  );
  const next = [...collected, ...page.items];
  return page.nextCursor === null
    ? next
    : loadAllThreads(
      projectId,
      artifactId,
      versionId,
      since,
      dispatched,
      page.nextCursor,
      next,
    );
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
        const listedThreads = await loadAllThreads(
          projectId,
          artifactId,
          versionId,
          null,
        );
        const conversations = await loadConversations(
          projectId,
          artifactId,
          listedThreads,
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
      const listedThreads = await loadAllThreads(
        projectId,
        artifactId,
        versionId,
        watermarkRef.current,
      );
      if (listedThreads.length === 0 || !ownership.settled(token)) return;
      const changedThreads = listedThreads.filter((thread) =>
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

/** The new-thread composer, drafted per artifact and version. */
function NewThreadComposer({
  artifactId,
  principalId,
  session,
  versionId,
}: {
  readonly artifactId: string;
  readonly principalId: string;
  readonly session: ReviewCommentSession;
  readonly versionId: string;
}) {
  const draft = useCommentDraft({
    artifactId,
    principalId,
    threadId: null,
    versionId,
  });
  return (
    <div className="mb-3 grid gap-2" data-new-thread-composer>
      <CommentComposer
        cancelLabel={null}
        draftRestored={draft.restored}
        initialBody={draft.initialBody}
        inputId={`review-new-thread-${versionId}`}
        key={`new-thread-${versionId}-${draft.restored ? "draft" : "empty"}`}
        label="Comment on this version"
        maximumCharacters={maximumCommentBodyCharacters}
        onBodyChange={draft.onBodyChange}
        onCancel={null}
        onDiscardDraft={draft.onDiscard}
        onSubmit={async (body) => {
          const saved = await session.submit(body, null, null);
          if (saved) draft.onPosted();
          return saved;
        }}
        submitLabel="Post comment"
      />
    </div>
  );
}

/** One thread's reply composer, drafted per thread. */
function ReplyComposer({
  artifactId,
  principalId,
  session,
  thread,
}: {
  readonly artifactId: string;
  readonly principalId: string;
  readonly session: ReviewCommentSession;
  readonly thread: CommentThread;
}) {
  const draft = useCommentDraft({
    artifactId,
    principalId,
    threadId: thread.id,
    versionId: null,
  });
  return (
    <CommentComposer
      cancelLabel={null}
      draftRestored={draft.restored}
      initialBody={draft.initialBody}
      inputId={`review-reply-${thread.id}`}
      label="Reply"
      maximumCharacters={maximumCommentBodyCharacters}
      onBodyChange={draft.onBodyChange}
      onCancel={null}
      onDiscardDraft={draft.onDiscard}
      onSubmit={async (body, idempotencyKey) => {
        const saved = await session.createReply(thread, body, idempotencyKey);
        if (saved) draft.onPosted();
        return saved;
      }}
      submitLabel="Post reply"
    />
  );
}

type CommentView = "all" | "open" | "resolved" | "sent";

/** Review-native thread list kept beside, never over, the artifact. */
export function ReviewCommentsInspector({
  canDeleteAny,
  canComment,
  principalId,
  session,
  versionId,
}: {
  readonly canDeleteAny: boolean;
  readonly canComment: boolean;
  readonly principalId: string;
  readonly session: ReviewCommentSession;
  readonly versionId: string | null;
}) {
  const unanchored = new Set(session.unanchoredIds);
  const [agents, setAgents] = useState<readonly AgentPresence[] | null>(null);
  const [agentError, setAgentError] = useState<Error | null>(null);
  const [view, setView] = useState<CommentView>("all");
  const [selectedThreadIds, setSelectedThreadIds] = useState<readonly string[]>([]);
  const [sentThreads, setSentThreads] = useState<readonly CommentThread[]>([]);
  const [sentReplies, setSentReplies] = useState<ReadonlyMap<
    string,
    readonly CommentReply[]
  >>(new Map());
  const [dispatchByThread, setDispatchByThread] = useState<ReadonlyMap<
    string,
    AgentDispatch
  >>(new Map());
  const [sentLoading, setSentLoading] = useState(false);
  const [sentError, setSentError] = useState<Error | null>(null);

  const loadAgents = useCallback(async (): Promise<void> => {
    try {
      setAgents(await api.agentPresence());
      setAgentError(null);
    } catch (caught) {
      setAgentError(caught instanceof Error ? caught : new Error("Agent presence failed."));
    }
  }, []);

  const loadSent = useCallback(async (): Promise<void> => {
    if (session.artifactId === null || session.projectId === "" || versionId === null) {
      setSentThreads([]);
      setSentReplies(new Map());
      setDispatchByThread(new Map());
      return;
    }
    setSentLoading(true);
    setSentError(null);
    try {
      const listed = await loadAllThreads(
        session.projectId,
        session.artifactId,
        versionId,
        null,
        "only",
      );
      const [conversations, index] = await Promise.all([
        loadConversations(session.projectId, session.artifactId, listed),
        loadDispatchIndex(session.projectId, listed.map((thread) => thread.id)),
      ]);
      setSentThreads(conversations.map(({thread}) => thread));
      setSentReplies(new Map(
        conversations.map(({replies, thread}) => [thread.id, replies]),
      ));
      setDispatchByThread(index);
    } catch (caught) {
      setSentError(caught instanceof Error ? caught : new Error("Sent comments failed."));
    } finally {
      setSentLoading(false);
    }
  }, [session.artifactId, session.projectId, versionId]);

  const reloadDispatchSurface = useCallback(async (): Promise<void> => {
    await Promise.all([session.reload(), loadSent(), loadAgents()]);
  }, [loadAgents, loadSent, session.reload]);
  const dispatchUndo = useDispatchUndo(session.projectId, reloadDispatchSurface);

  useEffect(() => {
    void Promise.all([loadAgents(), loadSent()]);
  }, [loadAgents, loadSent]);
  useCommentPoll(loadAgents, session.projectId !== "");
  useCommentPoll(
    loadSent,
    view === "sent" && session.artifactId !== null && versionId !== null,
  );

  useEffect(() => {
    setSelectedThreadIds((current) => current.filter((threadId) =>
      session.threads.some((thread) => thread.id === threadId && thread.state === "open")
    ));
  }, [session.threads]);

  const openThreads = session.threads.filter((thread) => thread.state === "open");
  const selectedThreads = openThreads.filter((thread) =>
    selectedThreadIds.includes(thread.id)
  );
  const visibleThreads = view === "sent"
    ? sentThreads
    : session.threads.filter((thread) =>
      view === "all" || thread.state === view
    );
  const visibleReplies = view === "sent" ? sentReplies : session.repliesByThread;
  const loadingVisible = view === "sent" ? sentLoading : session.loading;
  const now = Date.now();

  const toggleSelection = (threadId: string): void => {
    setSelectedThreadIds((current) => current.includes(threadId)
      ? current.filter((candidate) => candidate !== threadId)
      : [...current, threadId]);
  };

  const cancelDispatch = async (dispatch: AgentDispatch): Promise<void> => {
    setSentError(null);
    try {
      await api.cancelAgentDispatch(session.projectId, dispatch.id);
      await reloadDispatchSurface();
    } catch (caught) {
      setSentError(caught instanceof Error ? caught : new Error("Cancel failed."));
    }
  };

  const onSent = async (): Promise<void> => {
    setSelectedThreadIds([]);
    await reloadDispatchSurface();
  };

  return (
    <div className="as-comments">
      {dispatchUndo.element}
      <div className="as-comments__agents">
        <div>
          <strong>Agents</strong>
          <span>{agents?.filter((agent) => agent.connected).length ?? 0} connected</span>
        </div>
        <div>
          {agents?.map((agent) => (
            <PresenceAvatar agent={agent} key={agent.id} now={now} size="md" />
          ))}
        </div>
      </div>
      {agentError === null ? null : (
        <p className="as-comments__agent-error">{agentError.message}</p>
      )}
      {canComment ? (
        <div className="as-comments__send-all">
          <SendToAgentControl
            agents={agents}
            buttonSize="sm"
            buttonVariant="default"
            feedback={dispatchUndo.feedback}
            label={`Send all open (${openThreads.length})…`}
            onSent={onSent}
            oneAgentLabel={(name) => `Send all open (${openThreads.length}) to ${name}`}
            openCount={openThreads.length}
            principalId={principalId}
            projectId={session.projectId}
            resolveBundle={() => Promise.resolve(bundleOfThreads(openThreads))}
          />
        </div>
      ) : null}
      <div className="as-comments__intro">
        <p>
          {canComment
            ? "Click any element in the HTML preview to place a comment."
            : "Comments are read-only for this account or archived project."}
        </p>
        <button
          className="as-inspector-section__action"
          disabled={session.loading || sentLoading}
          onClick={() => void reloadDispatchSurface()}
          type="button"
        >
          {session.loading || sentLoading ? "Loading…" : "Reload"}
        </button>
      </div>
      {session.error === null ? null : (
        <p className="as-comments__error" role="alert">{session.error.message}</p>
      )}
      {sentError === null ? null : (
        <p className="as-comments__error" role="alert">{sentError.message}</p>
      )}
      <nav aria-label="Comment filters" className="as-comments__filters">
        {(["all", "open", "resolved", "sent"] as const).map((candidate) => (
          <button
            aria-pressed={view === candidate}
            className="as-button"
            key={candidate}
            onClick={() => setView(candidate)}
            type="button"
          >
            {candidate === "all"
              ? "All"
              : candidate === "sent"
                ? `Sent (${sentThreads.length})`
                : `${candidate[0]?.toUpperCase()}${candidate.slice(1)}`}
          </button>
        ))}
      </nav>
      {selectedThreads.length === 0 ? null : (
        <DispatchSelectionBar
          agents={agents}
          feedback={dispatchUndo.feedback}
          onClear={() => setSelectedThreadIds([])}
          onSent={onSent}
          principalId={principalId}
          projectId={session.projectId}
          threads={selectedThreads}
        />
      )}
      {canComment && versionId !== null && session.artifactId !== null ? (
        <NewThreadComposer
          artifactId={session.artifactId}
          key={`${session.artifactId}-${versionId}`}
          principalId={principalId}
          session={session}
          versionId={versionId}
        />
      ) : null}
      {loadingVisible && visibleThreads.length === 0 ? (
        <p className="as-inspector-empty">Loading comments…</p>
      ) : null}
      {!loadingVisible && visibleThreads.length === 0 ? (
        <p className="as-inspector-empty">
          {view === "all"
            ? "No comments on this version yet."
            : view === "sent"
              ? "No sent comments on this version."
              : `No ${view} comments on this version.`}
        </p>
      ) : null}
      <ol className="as-comment-list">
        {visibleThreads.map((thread) => {
          const sentDispatch = view === "sent" ? dispatchByThread.get(thread.id) : undefined;
          return (
            <li key={thread.id}>
              <article
                aria-current={session.selectedThreadId === thread.id ? "true" : undefined}
                className="as-comment-card"
                data-selected={session.selectedThreadId === thread.id}
              >
                <header>
                  {view !== "sent" && canComment && thread.state === "open" ? (
                    <input
                      aria-label={`Select comment: ${thread.body}`}
                      checked={selectedThreadIds.includes(thread.id)}
                      onChange={() => toggleSelection(thread.id)}
                      type="checkbox"
                    />
                  ) : null}
                  <strong>{thread.author.displayName}</strong>
                  {sentDispatch === undefined
                    ? <span data-state={thread.state}>{thread.state}</span>
                    : <DispatchStateChip state={sentDispatch.state} />}
                </header>
                <p>{thread.body}</p>
                <ol className="as-comment-replies">
                  {(visibleReplies.get(thread.id) ?? []).map((reply) => (
                    <ReviewReply
                      canDeleteAny={canDeleteAny}
                      canMutate={canComment}
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
                  {view !== "sent" && unanchored.has(thread.id) ? (
                    <small>Original location unavailable</small>
                  ) : null}
                  <div>
                    {view === "sent" ? (
                      sentDispatch !== undefined && dispatchIsCancelable(sentDispatch.state) ? (
                        <button
                          className="as-button"
                          onClick={() => void cancelDispatch(sentDispatch)}
                          type="button"
                        >
                          Cancel send
                        </button>
                      ) : null
                    ) : (
                      <>
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
                      </>
                    )}
                  </div>
                </footer>
                {view !== "sent" && canComment && thread.state === "open"
                    && session.artifactId !== null ? (
                  <div className="as-comment-reply-composer">
                    <ReplyComposer
                      artifactId={session.artifactId}
                      principalId={principalId}
                      session={session}
                      thread={thread}
                    />
                  </div>
                ) : null}
              </article>
            </li>
          );
        })}
      </ol>
    </div>
  );
}

function ReviewReply({
  canDeleteAny,
  canMutate,
  onDelete,
  onUpdate,
  principalId,
  reply,
}: {
  readonly canDeleteAny: boolean;
  readonly canMutate: boolean;
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
      {!canMutate || editing || (!ownReply && !canDeleteAny) ? null : (
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
