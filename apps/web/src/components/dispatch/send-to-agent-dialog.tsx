import { useId, useRef, useState } from "react";

import { api, type RegisteredAgent } from "@/api/client";
import type { DispatchBundle } from "@/components/dispatch/dispatch-bundle";
import {
  maximumDispatchBundleSize,
  maximumDispatchNoteCharacters,
} from "@/components/dispatch/dispatch-limits";
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
 * The control resolves its bundle when it opens, so the agent list and the
 * annotations are read against the same moment. Confirming creates exactly one
 * dispatch: one idempotency key is minted for the attempt and reused for every
 * retry of it, so a lost response can never send the bundle twice. Choosing a
 * different agent starts a new attempt, because a replayed key would answer
 * with the dispatch the first agent already holds.
 */
export function SendToAgentDialog({
  buttonSize = "xs",
  buttonVariant = "outline",
  label,
  onSent,
  projectId,
  resolveBundle,
}: {
  readonly buttonSize?: "default" | "sm" | "xs";
  readonly buttonVariant?: "default" | "outline" | "secondary";
  readonly label: string;
  readonly onSent: () => Promise<void>;
  readonly projectId: string;
  readonly resolveBundle: () => Promise<DispatchBundle>;
}) {
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [pending, setPending] = useState(false);
  const [agents, setAgents] = useState<readonly RegisteredAgent[]>([]);
  const [bundle, setBundle] = useState<DispatchBundle | null>(null);
  const [agentId, setAgentId] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const [error, setError] = useState<Error | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const attemptKey = useRef<string | null>(null);
  const dialogId = useId();
  const trimmedNote = note.trim();
  const noteTooLong = trimmedNote.length > maximumDispatchNoteCharacters;
  const connectedAgents = agents.filter((agent) => agent.connected);
  const threadIds = bundle?.threadIds ?? [];

  const prepare = async () => {
    setLoading(true);
    setError(null);
    attemptKey.current = null;
    try {
      const [listedAgents, resolved] = await Promise.all([
        api.agents(),
        resolveBundle(),
      ]);
      setAgents(listedAgents);
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
      setAgents([]);
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
      await api.createAgentDispatch(
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
      await onSent();
    } catch (caught) {
      setError(
        caught instanceof Error ? caught : new Error("Sending failed."),
      );
    } finally {
      setPending(false);
    }
  };

  return (
    <Dialog onOpenChange={changeOpen} open={open}>
      <DialogTrigger
        render={<Button size={buttonSize} type="button" variant={buttonVariant} />}
      >
        {label}
      </DialogTrigger>
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
                  {agents.map((agent) => (
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
