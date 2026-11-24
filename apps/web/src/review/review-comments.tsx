import {
  forwardRef,
  useCallback,
  useEffect,
  useId,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from "react";
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
import {componentsText} from "@/i18n/messages/components";
import {refinementText} from "@/i18n/messages/review-refinements";
import {reviewPartsText} from "@/i18n/messages/review-parts";
import {formatTimestamp, displayError} from "@/lib/presentation";
import {bundleOfThreads} from "@/components/dispatch/dispatch-bundle";
import {loadDispatchIndex} from "@/components/dispatch/dispatch-index";
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
const text = reviewPartsText.comments;

function agentPresenceSummary(agents: readonly AgentPresence[] | null): string {
  if (agents === null) return text.presence.checking;
  const connectedCount = agents.filter((agent) => agent.connected).length;
  const offlineCount = agents.length - connectedCount;
  if (offlineCount === 0) {
    return connectedCount === 0 ? text.presence.none : text.presence.connected(connectedCount);
  }
  return text.presence.mixed(connectedCount, offlineCount);
}

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
  readonly revealThread: (thread: CommentThread) => void;
  readonly repliesByThread: ReadonlyMap<string, readonly CommentReply[]>;
  readonly selectionAttempt: number;
  readonly selectedThreadId: string | null;
  readonly selectThread: (threadId: string | null) => void;
  readonly submit: (
    body: string,
    anchor: ReviewAnchor | null,
    path: string | null,
    idempotencyKey?: string,
  ) => Promise<boolean>;
  readonly threads: readonly CommentThread[];
  readonly unanchoredIds: readonly string[];
  readonly updateUnanchored: (threadIds: readonly string[]) => void;
  readonly updateReply: (reply: CommentReply, body: string) => Promise<boolean>;
}

/** Keep one Review version's saved threads and Plannotator projections in sync. */
export function useReviewComments({
  artifactId,
  onPathChanged,
  onVersionChanged,
  projectId,
  versionId,
}: {
  readonly artifactId: string | null;
  readonly onPathChanged: (path: string) => void;
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
  const [selectionAttempt, setSelectionAttempt] = useState(0);
  const [extraSelection, setExtraSelection] = useState<CommentThread | null>(null);
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
        caught instanceof Error ? caught : new Error(text.failure.load),
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
    setExtraSelection(null);
    void reload();
  }, [reload]);

  useEffect(() => {
    watermarkRef.current = threadWatermark(threads);
    threadUpdatedAtRef.current = new Map(
      threads.map((thread) => [thread.id, thread.updatedAt]),
    );
    if (
      selectedThreadId !== null
      && extraSelection?.id !== selectedThreadId
      && !threads.some((thread) => thread.id === selectedThreadId)
    ) {
      setSelectedThreadId(null);
    }
  }, [extraSelection, selectedThreadId, threads]);

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
    idempotencyKey: string = crypto.randomUUID(),
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
          idempotencyKey,
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
        caught instanceof Error ? caught : new Error(text.failure.create),
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
        caught instanceof Error ? caught : new Error(text.failure.changeState),
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
      setError(caught instanceof Error ? caught : new Error(text.failure.createReply));
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
      setError(caught instanceof Error ? caught : new Error(text.failure.editReply));
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
      setError(caught instanceof Error ? caught : new Error(text.failure.deleteReply));
    }
  }, [artifactId, ownership, projectId, reload]);

  const annotations = useMemo(() => {
    const open = threads.filter((thread) => thread.state === "open");
    if (extraSelection !== null && !open.some((thread) => thread.id === extraSelection.id)) {
      open.push(extraSelection);
    }
    return open.map(toAnnotation);
  }, [extraSelection, threads]);

  const selectThread = useCallback((threadId: string | null): void => {
    setExtraSelection((current) => current?.id === threadId ? current : null);
    setSelectedThreadId(threadId);
    setSelectionAttempt((current) => current + 1);
  }, []);
  const revealThread = useCallback((thread: CommentThread): void => {
    selectThread(thread.id);
    if (thread.state === "resolved" || !threads.some((shown) => shown.id === thread.id)) {
      setExtraSelection(thread);
    }
    if (thread.path !== null) onPathChanged(thread.path);
  }, [onPathChanged, selectThread, threads]);

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
    revealThread,
    repliesByThread,
    selectedThreadId,
    selectionAttempt,
    selectThread,
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
    <div data-new-thread-composer>
      <CommentComposer
        cancelLabel={null}
        draftRestored={draft.restored}
        initialBody={draft.initialBody}
        inputId={`review-new-thread-${versionId}`}
        key={`new-thread-${versionId}-${draft.restored ? "draft" : "empty"}`}
        label={text.addComment}
        maximumCharacters={maximumCommentBodyCharacters}
        onBodyChange={draft.onBodyChange}
        onCancel={null}
        onDiscardDraft={draft.onDiscard}
        onSubmit={async (body, idempotencyKey) => {
          const saved = await session.submit(body, null, null, idempotencyKey);
          if (saved) draft.onPosted();
          return saved;
        }}
        submitLabel={text.postComment}
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
  const [expanded, setExpanded] = useState(draft.restored);
  const [replyBody, setReplyBody] = useState(draft.initialBody);

  if (!expanded) {
    return (
      <div className="as-comment-reply-composer" data-expanded="false">
        <button
          className="as-button as-comment-reply-trigger"
          onClick={() => setExpanded(true)}
          type="button"
        >
          {text.reply}
        </button>
      </div>
    );
  }

  return (
    <div className="as-comment-reply-composer" data-expanded="true">
      <CommentComposer
        cancelLabel={text.cancel}
        draftRestored={draft.restored}
        initialBody={replyBody}
        inputId={`review-reply-${thread.id}`}
        label={text.reply}
        maximumCharacters={maximumCommentBodyCharacters}
        onBodyChange={(body) => {
          setReplyBody(body);
          draft.onBodyChange(body);
        }}
        onCancel={() => setExpanded(false)}
        onDiscardDraft={() => {
          setReplyBody("");
          draft.onDiscard();
        }}
        onSubmit={async (body, idempotencyKey) => {
          const saved = await session.createReply(thread, body, idempotencyKey);
          if (saved) {
            setReplyBody("");
            draft.onPosted();
            setExpanded(false);
          }
          return saved;
        }}
        submitLabel={text.postReply}
      />
    </div>
  );
}

type CommentView = "all" | "awaiting" | "open" | "resolved" | "sent";

export interface ReviewCommentsInspectorHandle {
  readonly reload: () => Promise<void>;
}

/** Review-native thread list kept beside, never over, the artifact. */
export const ReviewCommentsInspector = forwardRef<ReviewCommentsInspectorHandle, {
  readonly canDeleteAny: boolean;
  readonly canComment: boolean;
  readonly linkedThreadId?: string | null;
  readonly principalId: string;
  readonly onSendRequestHandled?: () => void;
  readonly sendRequested?: boolean;
  readonly session: ReviewCommentSession;
  readonly versionId: string | null;
}>(function ReviewCommentsInspector({
  canDeleteAny,
  canComment,
  linkedThreadId = null,
  principalId,
  onSendRequestHandled,
  sendRequested = false,
  session,
  versionId,
}, ref) {
  const unanchored = new Set(session.unanchoredIds);
  const [agents, setAgents] = useState<readonly AgentPresence[] | null>(null);
  const [agentError, setAgentError] = useState<Error | null>(null);
  const [view, setView] = useState<CommentView>(linkedThreadId === null ? "open" : "all");
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
  const sendAllRef = useRef<HTMLDivElement>(null);
  const dispatchGeneration = useRef(0);
  const linkedCard = useRef<HTMLElement>(null);
  const revealedLink = useRef<string | null>(null);

  const loadAgents = useCallback(async (): Promise<void> => {
    try {
      setAgents(await api.agentPresence());
      setAgentError(null);
    } catch (caught) {
      setAgentError(caught instanceof Error ? caught : new Error(text.failure.presence));
    }
  }, []);

  const loadSent = useCallback(async (): Promise<void> => {
    const generation = ++dispatchGeneration.current;
    if (session.artifactId === null || session.projectId === "" || versionId === null) {
      setSentThreads([]);
      setSentReplies(new Map());
      setDispatchByThread(new Map());
      return;
    }
    setSentLoading(true);
    setSentError(null);
    try {
      const [listed, all] = await Promise.all([
        loadAllThreads(session.projectId, session.artifactId, versionId, null, "only"),
        loadAllThreads(session.projectId, session.artifactId, versionId, null, "include"),
      ]);
      const [conversations, index] = await Promise.all([
        loadConversations(session.projectId, session.artifactId, listed),
        loadDispatchIndex(session.projectId, all.map((thread) => thread.id)),
      ]);
      if (generation !== dispatchGeneration.current) return;
      setSentThreads(conversations.map(({thread}) => thread));
      setSentReplies(new Map(
        conversations.map(({replies, thread}) => [thread.id, replies]),
      ));
      setDispatchByThread(index);
    } catch (caught) {
      if (generation === dispatchGeneration.current) {
        setSentError(caught instanceof Error ? caught : new Error(text.failure.sent));
      }
    } finally {
      if (generation === dispatchGeneration.current) setSentLoading(false);
    }
  }, [session.artifactId, session.projectId, versionId]);

  const reloadDispatchSurface = useCallback(async (): Promise<void> => {
    await Promise.all([session.reload(), loadSent(), loadAgents()]);
  }, [loadAgents, loadSent, session.reload]);
  useImperativeHandle(ref, () => ({reload: reloadDispatchSurface}), [reloadDispatchSurface]);
  useEffect(() => {
    if (!sendRequested || agents === null) return;
    onSendRequestHandled?.();
    const control = sendAllRef.current?.querySelector<HTMLElement>("button:not([disabled]), a");
    if (control instanceof HTMLButtonElement) control.click();
    else control?.focus();
  }, [agents, onSendRequestHandled, sendRequested]);
  const dispatchUndo = useDispatchUndo(session.projectId, reloadDispatchSurface);

  useEffect(() => {
    setSentThreads([]);
    setSentReplies(new Map());
    setDispatchByThread(new Map());
    void Promise.all([loadAgents(), loadSent()]);
    return () => { dispatchGeneration.current += 1; };
  }, [loadAgents, loadSent]);
  useCommentPoll(loadAgents, session.projectId !== "");
  useCommentPoll(
    loadSent,
    session.artifactId !== null && versionId !== null,
  );

  const openThreads = session.threads.filter((thread) => thread.state === "open");
  const awaitingThreads = openThreads.filter((thread) => dispatchByThread.get(thread.id)?.state === "addressed");
  const resolvedThreads = session.threads.filter((thread) => thread.state === "resolved");
  const visibleThreads = view === "sent"
    ? sentThreads
    : view === "all"
      ? [...openThreads, ...resolvedThreads]
      : view === "open"
        ? openThreads
        : view === "awaiting" ? awaitingThreads : resolvedThreads;
  const visibleReplies = view === "sent" ? sentReplies : session.repliesByThread;
  const loadingVisible = view === "sent" ? sentLoading : session.loading;
  const now = Date.now();
  const linkedThread = visibleThreads.find((thread) => thread.id === linkedThreadId);
  useEffect(() => {
    if (linkedThread === undefined || revealedLink.current === linkedThread.id) return;
    revealedLink.current = linkedThread.id;
    session.revealThread(linkedThread);
    linkedCard.current?.scrollIntoView({block: "nearest"});
  }, [linkedThread, session.revealThread]);

  const cancelDispatch = async (dispatch: AgentDispatch): Promise<void> => {
    setSentError(null);
    try {
      await api.cancelAgentDispatch(session.projectId, dispatch.id);
      await reloadDispatchSurface();
    } catch (caught) {
      setSentError(caught instanceof Error ? caught : new Error(text.failure.cancel));
    }
  };

  const onSent = async (): Promise<void> => {
    await reloadDispatchSurface();
  };

  return (
    <div className="as-comments">
      {dispatchUndo.element}
      <div className="as-comments__agents">
        <div>
          <strong>{text.agentsHeading}</strong>
          <span>{agentPresenceSummary(agents)}</span>
        </div>
        <div aria-label={text.presenceLabel} role="group">
          {agents?.map((agent) => (
            <PresenceAvatar agent={agent} key={agent.id} now={now} />
          ))}
        </div>
      </div>
      {agentError === null ? null : (
        <p className="as-comments__agent-error">{displayError(agentError)}</p>
      )}
      {canComment ? (
        <div className="as-comments__send-all" ref={sendAllRef}>
          {agents !== null && !agents.some((agent) => agent.connected) ? (
            <p className="as-comments__connect">
              {componentsText.dispatch.noAgentConnected}{" "}
              <a href="/review/settings/mcp">{refinementText.connect}</a>
            </p>
          ) : <SendToAgentControl
            agents={agents}
            buttonSize="xs"
            buttonVariant="default"
            feedback={dispatchUndo.feedback}
            label={text.sendAllOpen(openThreads.length)}
            onSent={onSent}
            oneAgentLabel={(name) => text.sendAllOpenTo(openThreads.length, name)}
            openCount={openThreads.length}
            principalId={principalId}
            projectId={session.projectId}
            resolveBundle={() => Promise.resolve(bundleOfThreads(openThreads))}
          />}
        </div>
      ) : null}
      {canComment ? null : (
        <p className="as-comments__read-only">
          {text.readOnly}
        </p>
      )}
      {session.error === null ? null : (
        <p className="as-comments__error" role="alert">{displayError(session.error)}</p>
      )}
      {sentError === null ? null : (
        <p className="as-comments__error" role="alert">{displayError(sentError)}</p>
      )}
      <nav aria-label={text.filtersLabel} className="as-comments__filters">
        {(["open", "awaiting", "all", "resolved", "sent"] as const).map((candidate) => (
          <button
            aria-pressed={view === candidate}
            className="as-button"
            key={candidate}
            onClick={() => setView(candidate)}
            type="button"
          >
            {candidate === "sent"
              ? text.filter.sent(sentThreads.length)
              : candidate === "awaiting" ? refinementText.awaiting(awaitingThreads.length) : text.filter[candidate]}
          </button>
        ))}
      </nav>
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
        <p className="as-inspector-empty">{text.loading}</p>
      ) : null}
      {!loadingVisible && visibleThreads.length === 0 ? (
        <p className="as-inspector-empty">
          {view === "open" && resolvedThreads.length > 0
            ? text.empty.allResolved
            : view === "awaiting" ? refinementText.awaitingEmpty : text.empty[view]}
        </p>
      ) : null}
      <ol className="as-comment-list">
        {visibleThreads.map((thread) => {
          const sentDispatch = view === "sent" || view === "awaiting" || view === "open" || thread.id === linkedThreadId
            ? dispatchByThread.get(thread.id)
            : undefined;
          const selected = session.selectedThreadId === thread.id;
          const replies = visibleReplies.get(thread.id) ?? [];
          return (
            <li key={thread.id}>
              <article
                aria-current={selected ? "true" : undefined}
                aria-keyshortcuts="Enter"
                className="as-comment-card"
                data-selected={selected}
                onClick={(event) => {
                  if (!(event.target instanceof Element) || event.target.closest("button, a, input, textarea, label, [role='dialog']")) return;
                  session.revealThread(thread);
                }}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && event.target === event.currentTarget && !event.nativeEvent.isComposing) {
                    event.preventDefault();
                    session.revealThread(thread);
                  }
                }}
                ref={linkedThreadId === thread.id ? linkedCard : undefined}
                tabIndex={0}
              >
                <header>
                  <strong>{thread.author.displayName}</strong>
                  {sentDispatch === undefined
                    ? <span data-state={thread.state}>{text.state[thread.state]}</span>
                    : <DispatchStateChip state={sentDispatch.state} />}
                </header>
                <div className="as-comment-card__body">
                  <p>{thread.body}</p>
                  <footer>
                    <div className="as-comment-card__meta">
                      <span>
                        {text.updatedPrefix}<time dateTime={thread.updatedAt}>
                          {formatTimestamp(thread.updatedAt)}
                        </time>
                      </span>
                      <span>
                        {thread.path === null ? text.wholeVersion : (
                          <>{text.pagePrefix}<code>{thread.path}</code></>
                        )}
                      </span>
                    </div>
                    {view !== "sent" && unanchored.has(thread.id) ? (
                      <small>{text.locationUnavailable}</small>
                    ) : null}
                    <div className="as-comment-card__actions">
                      {view === "sent" && sentDispatch !== undefined && dispatchIsCancelable(sentDispatch.state) ? (
                        <button
                          className="as-button"
                          onClick={() => void cancelDispatch(sentDispatch)}
                          type="button"
                        >
                          {text.cancelSend}
                        </button>
                      ) : null}
                      {canComment && thread.state === "open" ? (
                        <div className="as-comment-card__secondary">
                          <SendToAgentControl
                            agents={agents}
                            buttonSize="xs"
                            buttonVariant="outline"
                            feedback={dispatchUndo.feedback}
                            label={text.send}
                            onSent={onSent}
                            oneAgentLabel={(name) => text.sendTo(name)}
                            openCount={1}
                            principalId={principalId}
                            projectId={session.projectId}
                            reasonDisplay="hidden"
                            resolveBundle={() => Promise.resolve(bundleOfThreads([thread]))}
                          />
                        </div>
                      ) : null}
                      {canComment ? (
                        <button
                          className="as-button"
                          onClick={() => void session.changeState(thread).then(loadSent)}
                          type="button"
                        >
                          {thread.state === "open" ? text.resolve : text.reopen}
                        </button>
                      ) : null}
                    </div>
                  </footer>
                </div>
                {replies.length === 0 ? null : (
                  <section
                    aria-label={text.replies(replies.length)}
                    className="as-comment-card__conversation"
                  >
                    <p className="as-comment-card__conversation-label">
                      {text.replies(replies.length)}
                    </p>
                    <ol className="as-comment-replies">
                      {replies.map((reply) => (
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
                  </section>
                )}
                {view !== "sent" && canComment && thread.state === "open"
                    && session.artifactId !== null ? (
                  <ReplyComposer
                    artifactId={session.artifactId}
                    principalId={principalId}
                    session={session}
                    thread={thread}
                  />
                ) : null}
              </article>
            </li>
          );
        })}
      </ol>
    </div>
  );
});

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
          cancelLabel={text.cancel}
          initialBody={reply.body}
          inputId={editorId}
          label={text.editReply}
          maximumCharacters={maximumCommentBodyCharacters}
          onCancel={() => setEditing(false)}
          onSubmit={async (body) => {
            const changed = await onUpdate(reply, body);
            if (changed) setEditing(false);
            return changed;
          }}
          submitLabel={text.saveReply}
        />
      ) : <p>{reply.body}</p>}
      {!canMutate || editing || (!ownReply && !canDeleteAny) ? null : (
        <div className="as-comment-reply__actions">
          {ownReply ? (
            <button className="as-button" onClick={() => setEditing(true)} type="button">
              {text.edit}
            </button>
          ) : null}
          <button
            className="as-button"
            disabled={deleting}
            onClick={() => void remove()}
            type="button"
          >
            {deleting ? text.deleting : text.delete}
          </button>
        </div>
      )}
    </li>
  );
}
