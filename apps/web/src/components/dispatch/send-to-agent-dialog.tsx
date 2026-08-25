import { useId, useRef, useState } from "react";

import { ArrowDown01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";

import { api, type AgentPresence } from "@/api/client";
import type { DispatchBundle } from "@/components/dispatch/dispatch-bundle";
import {
  maximumDispatchBundleSize,
  maximumDispatchNoteCharacters,
} from "@/components/dispatch/dispatch-limits";
import type { DispatchFeedback } from "@/components/dispatch/dispatch-toast";
import {
  PresenceGlyph,
  presenceRing,
} from "@/components/dispatch/presence-avatar";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { errorMessage, formatRelativeTime } from "@/lib/presentation";

function annotationCount(count: number): string {
  return count === 1 ? "1 annotation" : `${count} annotations`;
}

/**
 * Send annotations to one connected agent as a single bundle.
 *
 * With exactly one connected agent the button itself is the send: one click
 * dispatches immediately, the button names the destination with the agent's
 * presence avatar, and the surface's undo toast replaces confirmation. The
 * dialog remains only where there is a choice to make — no agent connected
 * (how to connect one), two or more agents (the picker), or the split-button
 * caret that opens it to add a bundle note.
 *
 * Confirming creates exactly one dispatch: one idempotency key is minted for
 * the attempt and reused for every retry of it, so a lost response can never
 * send the bundle twice. Choosing a different agent starts a new attempt,
 * because a replayed key would answer with the dispatch the first agent
 * already holds.
 */
export function SendToAgentControl({
  agents,
  buttonSize = "xs",
  buttonVariant = "outline",
  feedback,
  label,
  onSent,
  oneAgentLabel,
  projectId,
  resolveBundle,
}: {
  /** The polled presence list, or null while the surface is still reading it. */
  readonly agents: readonly AgentPresence[] | null;
  readonly buttonSize?: "default" | "sm" | "xs";
  readonly buttonVariant?: "default" | "outline" | "secondary";
  /** Where a one-click send reports itself, for the undo toast. */
  readonly feedback: DispatchFeedback;
  readonly label: string;
  readonly onSent: () => Promise<void>;
  /** Replaces the label when exactly one agent is connected, naming it. */
  readonly oneAgentLabel?: (name: string) => string;
  readonly projectId: string;
  readonly resolveBundle: () => Promise<DispatchBundle>;
}) {
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [pending, setPending] = useState(false);
  const [quickPending, setQuickPending] = useState(false);
  const [dialogAgents, setDialogAgents] = useState<readonly AgentPresence[]>([]);
  const [bundle, setBundle] = useState<DispatchBundle | null>(null);
  const [agentId, setAgentId] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const [error, setError] = useState<Error | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const attemptKey = useRef<string | null>(null);
  const dialogId = useId();
  const trimmedNote = note.trim();
  const noteTooLong = trimmedNote.length > maximumDispatchNoteCharacters;
  const connectedAgents = dialogAgents.filter((agent) => agent.connected);
  const threadIds = bundle?.threadIds ?? [];

  const knownConnected = agents?.filter((agent) => agent.connected) ?? null;
  const onlyAgent = knownConnected !== null && knownConnected.length === 1
    ? knownConnected[0] ?? null
    : null;

  const prepare = async () => {
    setLoading(true);
    setError(null);
    attemptKey.current = null;
    try {
      const [listedAgents, resolved] = await Promise.all([
        api.agentPresence(),
        resolveBundle(),
      ]);
      setDialogAgents(listedAgents);
      setBundle(resolved);
      setAgentId(listedAgents.find((agent) => agent.connected)?.id ?? null);
      setNow(Date.now());
    } catch (caught) {
      setError(
        caught instanceof Error ? caught : new Error("Agent loading failed."),
      );
    } finally {
      setLoading(false);
    }
  };

  const changeOpen = (nextOpen: boolean) => {
    setOpen(nextOpen);
    if (!nextOpen) {
      setDialogAgents([]);
      setBundle(null);
      setAgentId(null);
      setNote("");
      setError(null);
      attemptKey.current = null;
      return;
    }
    void prepare();
  };

  const selectAgent = (nextAgentId: string) => {
    setAgentId(nextAgentId);
    attemptKey.current = null;
  };

  const send = async () => {
    if (agentId === null || threadIds.length === 0 || noteTooLong) return;
    attemptKey.current ??= crypto.randomUUID();
    setPending(true);
    setError(null);
    try {
      const chosen = dialogAgents.find((agent) => agent.id === agentId) ?? null;
      const created = await api.createAgentDispatch(
        projectId,
        {
          agentId,
          note: trimmedNote === "" ? null : trimmedNote,
          threadIds,
        },
        attemptKey.current,
      );
      attemptKey.current = null;
      changeOpen(false);
      if (chosen !== null) {
        feedback.sent({ agent: chosen, dispatch: created.dispatch });
      }
      await onSent();
    } catch (caught) {
      setError(
        caught instanceof Error ? caught : new Error("Sending failed."),
      );
    } finally {
      setPending(false);
    }
  };

  /**
   * The one-click path: resolve the bundle and dispatch it in one motion.
   * Success and failure both report through the surface's toast — including
   * an agent whose heartbeat went stale between paint and click.
   */
  const quickSend = async (agent: AgentPresence) => {
    setQuickPending(true);
    try {
      const resolved = await resolveBundle();
      if (resolved.threadIds.length === 0) {
        feedback.sendFailed(
          new Error("Nothing to send: no open annotations remain."),
        );
        return;
      }
      const created = await api.createAgentDispatch(
        projectId,
        {
          agentId: agent.id,
          note: null,
          threadIds: resolved.threadIds,
        },
        crypto.randomUUID(),
      );
      feedback.sent({ agent, dispatch: created.dispatch });
      await onSent();
    } catch (caught) {
      feedback.sendFailed(
        caught instanceof Error ? caught : new Error("Sending failed."),
      );
    } finally {
      setQuickPending(false);
    }
  };

  return (
    <Dialog onOpenChange={changeOpen} open={open}>
      {onlyAgent === null
        ? (
          <DialogTrigger
            render={(
              <Button
                aria-busy={agents === null}
                className={knownConnected !== null && knownConnected.length === 0
                  ? "opacity-60"
                  : undefined}
                size={buttonSize}
                title={knownConnected !== null && knownConnected.length === 0
                  ? "Connect an agent"
                  : undefined}
                type="button"
                variant={buttonVariant}
              />
            )}
          >
            {agents === null
              ? (
                <span
                  aria-hidden
                  className="size-3 animate-spin rounded-full border border-current border-t-transparent motion-reduce:animate-none"
                />
              )
              : null}
            {label}
          </DialogTrigger>
        )
        : (
          <span className="inline-flex">
            <Button
              disabled={quickPending}
              onClick={() => void quickSend(onlyAgent)}
              size={buttonSize}
              type="button"
              variant={buttonVariant}
            >
              <PresenceGlyph
                className="-my-1"
                kind={onlyAgent.kind}
                ring={presenceRing(onlyAgent)}
              />
              {quickPending
                ? "Sending…"
                : oneAgentLabel === undefined
                  ? label
                  : oneAgentLabel(onlyAgent.displayName)}
            </Button>
            <DialogTrigger
              render={(
                <Button
                  aria-label="Send with a note"
                  className="-ml-px px-1.5"
                  size={buttonSize}
                  type="button"
                  variant={buttonVariant}
                />
              )}
            >
              <HugeiconsIcon icon={ArrowDown01Icon} strokeWidth={1.8} />
            </DialogTrigger>
          </span>
        )}
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Send to agent</DialogTitle>
          <DialogDescription>
            The agent receives the selected annotations as one message when it
            finishes its current work. They leave this artifact as soon as the
            send succeeds and come back only if it fails or is canceled.
          </DialogDescription>
        </DialogHeader>

        {error === null
          ? null
          : (
            <p className="text-sm leading-6 text-destructive">
              {errorMessage(error)}
            </p>
          )}

        {loading
          ? <p className="text-sm text-muted-foreground">Reading connected agents…</p>
          : connectedAgents.length === 0
            ? (
              <div>
                <p className="font-heading text-sm font-semibold">
                  No agents connected
                </p>
                <p className="mt-2 text-sm leading-6 text-muted-foreground">
                  Install the Pi extension with
                  {" "}
                  <code className="font-mono">
                    pi install npm:@artifact-server/pi-extension
                  </code>
                  {" "}
                  and start Pi in the working directory you want to send to.
                </p>
              </div>
            )
            : (
              <>
                <fieldset className="grid gap-2">
                  <legend className="mb-2 text-xs font-semibold tracking-wide uppercase">
                    Connected agents
                  </legend>
                  {dialogAgents.map((agent) => (
                    <label
                      className="flex items-start gap-3 border p-3"
                      key={agent.id}
                    >
                      <input
                        checked={agentId === agent.id}
                        className="mt-1 size-4 accent-primary"
                        disabled={!agent.connected || pending}
                        name={`${dialogId}-agent`}
                        onChange={() => selectAgent(agent.id)}
                        type="radio"
                        value={agent.id}
                      />
                      <PresenceGlyph
                        className="mt-0.5"
                        kind={agent.kind}
                        ring={presenceRing(agent)}
                      />
                      <span className="min-w-0">
                        <span className="block font-heading text-sm font-semibold">
                          {agent.displayName}
                        </span>
                        <span className="block font-mono text-xs break-all text-muted-foreground">
                          {agent.workingDirectory}
                        </span>
                        <span className="block text-xs text-muted-foreground">
                          {agent.connected
                            ? "Connected"
                            : `Not connected, last seen ${
                              formatRelativeTime(agent.lastSeenAt, now)
                            }`}
                        </span>
                      </span>
                    </label>
                  ))}
                </fieldset>

                {bundle !== null && bundle.openCount > threadIds.length
                  ? (
                    <p className="text-sm leading-6 text-muted-foreground">
                      {`One bundle carries at most ${maximumDispatchBundleSize} annotations. The oldest ${threadIds.length} of ${bundle.openCount}${
                        bundle.openCountIsLowerBound ? " or more" : ""
                      } are sent; send the rest afterwards.`}
                    </p>
                  )
                  : null}

                <div className="grid gap-2">
                  <Label htmlFor={`${dialogId}-note`}>Note for the agent</Label>
                  <Textarea
                    aria-describedby={noteTooLong
                      ? `${dialogId}-note-limit`
                      : undefined}
                    aria-invalid={noteTooLong}
                    disabled={pending}
                    id={`${dialogId}-note`}
                    onChange={(event) => setNote(event.currentTarget.value)}
                    placeholder="Optional context for the whole bundle."
                    value={note}
                  />
                  {noteTooLong
                    ? (
                      <p
                        className="text-xs text-destructive"
                        id={`${dialogId}-note-limit`}
                      >
                        {`A note holds at most ${maximumDispatchNoteCharacters} characters. Remove ${
                          trimmedNote.length - maximumDispatchNoteCharacters
                        }.`}
                      </p>
                    )
                    : null}
                </div>
              </>
            )}

        <DialogFooter>
          <DialogClose render={<Button type="button" variant="ghost" />}>
            Cancel
          </DialogClose>
          {connectedAgents.length === 0
            ? null
            : (
              <Button
                disabled={pending || loading || agentId === null
                  || threadIds.length === 0 || noteTooLong}
                onClick={() => void send()}
                type="button"
              >
                {pending ? "Sending…" : `Send ${annotationCount(threadIds.length)}`}
              </Button>
            )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
