import { useId, useState, type ReactNode } from "react";

import {
  api,
  type AgentDispatch,
  type CommentReply,
  type CommentThread,
} from "@/api/client";
import { CommentComposer } from "@/components/comments/comment-composer";
import {
  DispatchStateChip,
  dispatchIsCancelable,
} from "@/components/dispatch/dispatch-state";
import { StatusBadge } from "@/components/product";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import { formatRelativeTime, formatTimestamp } from "@/lib/presentation";

/**
 * One comment thread row with replies, moderation, and its page position.
 *
 * The same card serves both comment surfaces. In the artifact's Comments tab
 * it links out to the review view for its version (`onShowInPage` is null); in
 * the review view itself it is already beside the rendered page, so the link
 * becomes the control that focuses this thread's marker, and the card reports
 * whether it is the focused one and whether its anchor still resolves.
 *
 * Sending is consumptive, so a sent thread is normally gone from both
 * surfaces: `dispatch` is supplied only by the "Sent" filter, which is the one
 * view that shows a send's delivery state and can call it back.
 */
export function CommentThreadCard({
  artifactId,
  canDeleteAny,
  dispatch,
  maximumBodyCharacters,
  now,
  onCancelDispatch,
  onChanged,
  onError,
  onShowInPage,
  principalId,
  projectId,
  selected,
  selection,
  sendAction,
  thread,
  unanchored,
  versionLabel,
}: {
  readonly artifactId: string;
  readonly canDeleteAny: boolean;
  /** The send that carried this thread away, in the "Sent" filter only. */
  readonly dispatch: AgentDispatch | null;
  readonly maximumBodyCharacters: number;
  readonly now: number;
  /** Call that send back, or null where cancelling is not offered. */
  readonly onCancelDispatch: (() => Promise<void>) | null;
  readonly onChanged: () => Promise<void>;
  readonly onError: (error: Error) => void;
  /** Focus this thread's marker in the rendered page, or null outside review. */
  readonly onShowInPage: (() => void) | null;
  readonly principalId: string | null;
  readonly projectId: string;
  /** This thread is the one the review view currently has focused. */
  readonly selected: boolean;
  /** Multi-select state for a send bundle, or null where sending is closed. */
  readonly selection: {
    readonly checked: boolean;
    readonly onCheckedChange: (checked: boolean) => void;
  } | null;
  /** This card's own send control, rendered by the surface that owns sending. */
  readonly sendAction: ReactNode | null;
  readonly thread: CommentThread;
  /** The rendered page no longer contains the element this thread anchored to. */
  readonly unanchored: boolean;
  readonly versionLabel: string;
}) {
  const [replies, setReplies] = useState<readonly CommentReply[] | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [editing, setEditing] = useState(false);
  const [pending, setPending] = useState(false);
  const repliesId = useId();
  const resolved = thread.state === "resolved";
  const ownThread = principalId !== null
    && principalId === thread.author.principalId;
  const reviewHref = `/projects/${encodeURIComponent(projectId)}/artifacts/${
    encodeURIComponent(artifactId)
  }/versions/${encodeURIComponent(thread.versionId)}/review`;

  const loadReplies = async () => {
    setPending(true);
    try {
      const details = await api.comment(projectId, artifactId, thread.id);
      setReplies(details.replies);
    } catch (caught) {
      onError(
        caught instanceof Error ? caught : new Error("Reply loading failed."),
      );
    } finally {
      setPending(false);
    }
  };

  const toggleReplies = () => {
    const next = !expanded;
    setExpanded(next);
    if (next && replies === null) void loadReplies();
  };

  const changeState = async () => {
    setPending(true);
    try {
      await api.updateComment(projectId, artifactId, thread.id, {
        state: resolved ? "open" : "resolved",
      });
      await onChanged();
    } catch (caught) {
      onError(
        caught instanceof Error ? caught : new Error("Comment state change failed."),
      );
    } finally {
      setPending(false);
    }
  };

  const saveBody = async (body: string) => {
    try {
      await api.updateComment(projectId, artifactId, thread.id, { body });
      setEditing(false);
      await onChanged();
      return true;
    } catch (caught) {
      onError(
        caught instanceof Error ? caught : new Error("Comment edit failed."),
      );
      return false;
    }
  };

  const addReply = async (body: string, idempotencyKey: string) => {
    try {
      await api.createCommentReply(
        projectId,
        artifactId,
        thread.id,
        body,
        idempotencyKey,
      );
      await loadReplies();
      await onChanged();
      return true;
    } catch (caught) {
      onError(
        caught instanceof Error ? caught : new Error("Reply failed."),
      );
      return false;
    }
  };

  const removeThread = async () => {
    setPending(true);
    try {
      await api.deleteComment(projectId, artifactId, thread.id);
      await onChanged();
    } catch (caught) {
      onError(
        caught instanceof Error ? caught : new Error("Comment deletion failed."),
      );
    } finally {
      setPending(false);
    }
  };

  const cancelSend = async () => {
    if (onCancelDispatch === null) return;
    setPending(true);
    try {
      await onCancelDispatch();
    } finally {
      setPending(false);
    }
  };

  return (
    <article
      aria-current={selected}
      className={cn(
        "border-b p-5 last:border-b-0",
        selected && "bg-accent",
      )}
    >
      <div className="flex flex-wrap items-center gap-3">
        {selection === null
          ? null
          : (
            <Checkbox
              aria-label={`Select the comment from ${thread.author.displayName} for sending to an agent`}
              checked={selection.checked}
              onCheckedChange={(checked) => selection.onCheckedChange(checked)}
            />
          )}
        <StatusBadge tone={resolved ? "neutral" : "primary"}>
          {resolved ? "Resolved" : "Open"}
        </StatusBadge>
        {dispatch === null ? null : <DispatchStateChip state={dispatch.state} />}
        {unanchored
          ? (
            <StatusBadge tone="danger">
              Original location unavailable
            </StatusBadge>
          )
          : null}
        <h3 className="font-heading text-sm font-semibold">
          {thread.author.displayName}
        </h3>
        <time
          className="text-xs text-muted-foreground"
          dateTime={thread.updatedAt}
          title={formatTimestamp(thread.updatedAt)}
        >
          {formatRelativeTime(thread.updatedAt, now)}
        </time>
        <span className="text-xs tracking-widest text-muted-foreground uppercase">
          {versionLabel}
        </span>
        <span className="font-mono text-xs text-muted-foreground">
          {thread.path ?? "Whole version"}
        </span>
      </div>

      {editing
        ? (
          <div className="mt-4">
            <CommentComposer
              cancelLabel="Cancel"
              initialBody={thread.body}
              inputId={`${repliesId}-edit`}
              label="Edit comment"
              maximumCharacters={maximumBodyCharacters}
              onCancel={() => setEditing(false)}
              onSubmit={saveBody}
              submitLabel="Save comment"
            />
          </div>
        )
        : (
          <p className="mt-3 text-sm leading-6 whitespace-pre-wrap">
            {thread.body}
          </p>
        )}

      <div className="mt-4 flex flex-wrap gap-2">
        <Button
          aria-controls={repliesId}
          aria-expanded={expanded}
          disabled={pending}
          onClick={toggleReplies}
          size="xs"
          type="button"
          variant="ghost"
        >
          {`${expanded ? "Hide" : "Show"} replies (${thread.replyCount})`}
        </Button>
        {onShowInPage === null
          ? (
            <Button
              render={<a href={reviewHref} />}
              size="xs"
              variant="outline"
            >
              Review this version
            </Button>
          )
          : (
            <Button
              onClick={onShowInPage}
              size="xs"
              type="button"
              variant="outline"
            >
              Show in page
            </Button>
          )}
        <Button
          disabled={pending}
          onClick={() => void changeState()}
          size="xs"
          type="button"
          variant="outline"
        >
          {resolved ? "Reopen" : "Resolve"}
        </Button>
        {sendAction}
        {dispatch !== null && onCancelDispatch !== null
            && dispatchIsCancelable(dispatch.state)
          ? (
            <Button
              disabled={pending}
              onClick={() => void cancelSend()}
              size="xs"
              type="button"
              variant="outline"
            >
              Cancel send
            </Button>
          )
          : null}
        {!ownThread || editing
          ? null
          : (
            <Button
              disabled={pending}
              onClick={() => setEditing(true)}
              size="xs"
              type="button"
              variant="ghost"
            >
              Edit
            </Button>
          )}
        {ownThread || canDeleteAny
          ? (
            <Dialog>
              <DialogTrigger
                render={<Button size="xs" type="button" variant="ghost" />}
              >
                Delete
              </DialogTrigger>
              <DialogContent>
                <DialogHeader>
                  <DialogTitle>Delete this comment</DialogTitle>
                  <DialogDescription>
                    The comment and its {thread.replyCount} replies are removed for
                    everybody. The saved version they describe is untouched.
                  </DialogDescription>
                </DialogHeader>
                <DialogFooter>
                  <Button
                    disabled={pending}
                    onClick={() => void removeThread()}
                    type="button"
                    variant="destructive"
                  >
                    {pending ? "Deleting…" : "Delete comment"}
                  </Button>
                </DialogFooter>
              </DialogContent>
            </Dialog>
          )
          : null}
      </div>

      <div className="mt-4" hidden={!expanded} id={repliesId}>
        {replies === null
          ? (
            <p className="text-sm text-muted-foreground">Loading replies…</p>
          )
          : (
            <>
              {replies.length === 0
                ? (
                  <p className="text-sm text-muted-foreground">
                    No replies yet.
                  </p>
                )
                : (
                  <ol className="border-l pl-4">
                    {replies.map((reply) => (
                      <CommentReplyRow
                        artifactId={artifactId}
                        canDeleteAny={canDeleteAny}
                        key={reply.id}
                        maximumBodyCharacters={maximumBodyCharacters}
                        now={now}
                        onChanged={async () => {
                          await loadReplies();
                          await onChanged();
                        }}
                        onError={onError}
                        principalId={principalId}
                        projectId={projectId}
                        reply={reply}
                      />
                    ))}
                  </ol>
                )}
              {resolved
                ? (
                  // A resolved thread refuses replies at the server, so the
                  // composer is not offered here either.
                  <p className="mt-4 text-sm leading-6 text-muted-foreground">
                    Reopen this comment to reply.
                  </p>
                )
                : (
                  <div className="mt-4">
                    <CommentComposer
                      cancelLabel={null}
                      initialBody=""
                      inputId={`${repliesId}-reply`}
                      label="Reply"
                      maximumCharacters={maximumBodyCharacters}
                      onCancel={null}
                      onSubmit={addReply}
                      submitLabel="Post reply"
                    />
                  </div>
                )}
            </>
          )}
      </div>
    </article>
  );
}

function CommentReplyRow({
  artifactId,
  canDeleteAny,
  maximumBodyCharacters,
  now,
  onChanged,
  onError,
  principalId,
  projectId,
  reply,
}: {
  readonly artifactId: string;
  readonly canDeleteAny: boolean;
  readonly maximumBodyCharacters: number;
  readonly now: number;
  readonly onChanged: () => Promise<void>;
  readonly onError: (error: Error) => void;
  readonly principalId: string | null;
  readonly projectId: string;
  readonly reply: CommentReply;
}) {
  const [editing, setEditing] = useState(false);
  const [pending, setPending] = useState(false);
  const editorId = useId();
  const ownReply = principalId !== null
    && principalId === reply.author.principalId;

  const saveBody = async (body: string) => {
    try {
      await api.updateCommentReply(
        projectId,
        artifactId,
        reply.threadId,
        reply.id,
        body,
      );
      setEditing(false);
      await onChanged();
      return true;
    } catch (caught) {
      onError(
        caught instanceof Error ? caught : new Error("Reply edit failed."),
      );
      return false;
    }
  };

  const removeReply = async () => {
    setPending(true);
    try {
      await api.deleteCommentReply(
        projectId,
        artifactId,
        reply.threadId,
        reply.id,
      );
      await onChanged();
    } catch (caught) {
      onError(
        caught instanceof Error ? caught : new Error("Reply deletion failed."),
      );
    } finally {
      setPending(false);
    }
  };

  return (
    <li className="border-b py-3 last:border-b-0">
      <div className="flex flex-wrap items-center gap-3">
        <span className="font-heading text-sm font-semibold">
          {reply.author.displayName}
        </span>
        <time
          className="text-xs text-muted-foreground"
          dateTime={reply.updatedAt}
          title={formatTimestamp(reply.updatedAt)}
        >
          {formatRelativeTime(reply.updatedAt, now)}
        </time>
      </div>
      {editing
        ? (
          <div className="mt-3">
            <CommentComposer
              cancelLabel="Cancel"
              initialBody={reply.body}
              inputId={editorId}
              label="Edit reply"
              maximumCharacters={maximumBodyCharacters}
              onCancel={() => setEditing(false)}
              onSubmit={saveBody}
              submitLabel="Save reply"
            />
          </div>
        )
        : (
          <p className="mt-2 text-sm leading-6 whitespace-pre-wrap">
            {reply.body}
          </p>
        )}
      {(!ownReply && !canDeleteAny) || editing
        ? null
        : (
          <div className="mt-2 flex flex-wrap gap-2">
            {ownReply
              ? (
                <Button
                  disabled={pending}
                  onClick={() => setEditing(true)}
                  size="xs"
                  type="button"
                  variant="ghost"
                >
                  Edit reply
                </Button>
              )
              : null}
            <Button
              disabled={pending}
              onClick={() => void removeReply()}
              size="xs"
              type="button"
              variant="ghost"
            >
              {pending ? "Deleting…" : "Delete reply"}
            </Button>
          </div>
        )}
    </li>
  );
}
