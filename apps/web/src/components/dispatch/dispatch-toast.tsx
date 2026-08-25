import { useEffect, useRef, useState, type ReactNode } from "react";

import {
  api,
  ApiError,
  type AgentDispatch,
  type AgentPresence,
} from "@/api/client";
import { Button } from "@/components/ui/button";
import { errorMessage } from "@/lib/presentation";

/** One send that just left, with everything the undo toast needs to name it. */
export interface SentDispatch {
  readonly agent: AgentPresence;
  readonly dispatch: AgentDispatch;
}

/** How a send control reports its outcome to the surface's toast. */
export interface DispatchFeedback {
  readonly sendFailed: (error: Error) => void;
  readonly sent: (sent: SentDispatch) => void;
}

/** The surface's undo toast: the element it renders and the reporting hooks. */
export interface DispatchUndo {
  readonly element: ReactNode;
  readonly feedback: DispatchFeedback;
}

/** How long the Undo offer stands before the toast quietly leaves. */
const sentToastMilliseconds = 8_000;
const noticeToastMilliseconds = 6_000;

type Toast =
  | { readonly kind: "notice"; readonly text: string }
  | { readonly kind: "sent"; readonly sent: SentDispatch };

function threadsWord(count: number): string {
  return count === 1 ? "1 thread" : `${count} threads`;
}

/**
 * The undo toast behind one-click sends: confirmation is replaced by a short
 * window to call the send back. Undo cancels the dispatch (valid while it is
 * queued or claimed); a send the agent already carried past that point
 * reports the conflict honestly instead of pretending it was undone.
 */
export function useDispatchUndo(
  projectId: string,
  onUndone: () => Promise<void>,
): DispatchUndo {
  const [toast, setToast] = useState<Toast | null>(null);
  const [undoPending, setUndoPending] = useState(false);
  const timer = useRef<number | null>(null);

  const show = (next: Toast, lifetime: number) => {
    if (timer.current !== null) window.clearTimeout(timer.current);
    setToast(next);
    timer.current = window.setTimeout(() => setToast(null), lifetime);
  };

  useEffect(
    () => () => {
      if (timer.current !== null) window.clearTimeout(timer.current);
    },
    [],
  );

  const feedback: DispatchFeedback = {
    sendFailed: (error) => {
      show(
        { kind: "notice", text: errorMessage(error) },
        noticeToastMilliseconds,
      );
    },
    sent: (sent) => {
      show({ kind: "sent", sent }, sentToastMilliseconds);
    },
  };

  const undo = async (sent: SentDispatch) => {
    setUndoPending(true);
    try {
      await api.cancelAgentDispatch(projectId, sent.dispatch.id);
      show(
        { kind: "notice", text: "Send canceled — the annotations are back." },
        noticeToastMilliseconds,
      );
    } catch (caught) {
      const conflict = caught instanceof ApiError
        && caught.code === "DISPATCH_STATE_CONFLICT";
      show(
        {
          kind: "notice",
          text: conflict
            ? `Too late to undo — ${sent.agent.displayName} already carried this send past the point of cancelling.`
            : errorMessage(
              caught instanceof Error ? caught : new Error("Undo failed."),
            ),
        },
        noticeToastMilliseconds,
      );
    } finally {
      setUndoPending(false);
    }
    await onUndone();
  };

  const element = toast === null
    ? null
    : (
      <section
        className="fixed bottom-4 left-1/2 z-50 flex w-[min(28rem,calc(100%-2rem))] -translate-x-1/2 items-center justify-between gap-4 border bg-popover p-3 text-sm text-popover-foreground shadow-xl"
        role="status"
      >
        {toast.kind === "sent"
          ? (
            <>
              <p className="min-w-0 leading-5">
                {`Sent ${threadsWord(toast.sent.dispatch.threadIds.length)} to ${toast.sent.agent.displayName}`}
              </p>
              <Button
                className="shrink-0"
                disabled={undoPending}
                onClick={() => void undo(toast.sent)}
                size="xs"
                type="button"
                variant="outline"
              >
                {undoPending ? "Undoing…" : "Undo"}
              </Button>
            </>
          )
          : <p className="min-w-0 leading-5">{toast.text}</p>}
      </section>
    );

  return { element, feedback };
}
