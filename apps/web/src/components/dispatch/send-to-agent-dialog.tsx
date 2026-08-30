import {useEffect, useId, useRef, useState} from "react";
import {z} from "zod";

import {ArrowDown01Icon} from "@hugeicons/core-free-icons";
import {HugeiconsIcon} from "@hugeicons/react";

import {api, type AgentDispatch, type AgentPresence} from "@/api/client";
import type {DispatchBundle} from "@/components/dispatch/dispatch-bundle";
import {
  maximumDispatchBundleSize,
  maximumDispatchNoteCharacters,
} from "@/components/dispatch/dispatch-limits";
import type {DispatchFeedback} from "@/components/dispatch/dispatch-toast";
import {PresenceGlyph, presenceRing} from "@/components/dispatch/presence-avatar";
import {Button} from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {Label} from "@/components/ui/label";
import {Popover, PopoverContent, PopoverTrigger} from "@/components/ui/popover";
import {Textarea} from "@/components/ui/textarea";
import {errorMessage, formatRelativeTime} from "@/lib/presentation";

function annotationCount(count: number): string {
  return count === 1 ? "1 annotation" : `${count} annotations`;
}

function defaultAgentStorageKey(principalId: string, projectId: string): string {
  return `dispatch-default:${principalId}:${projectId}`;
}

interface RememberedAgent {
  readonly displayName: string;
  readonly id: string;
}

interface RememberedAgentPreference {
  readonly agent: RememberedAgent | null;
  readonly storageKey: string;
}

const rememberedAgentSchema = z.object({
  displayName: z.string().min(1),
  id: z.string().min(1),
});

function readRememberedAgent(storageKey: string): RememberedAgent | null {
  const stored = window.localStorage.getItem(storageKey);
  if (stored === null) return null;
  try {
    const parsed = rememberedAgentSchema.safeParse(JSON.parse(stored));
    if (parsed.success) return parsed.data;
  } catch {
    // Invalid local convenience state is disposable; it is never authority.
  }
  window.localStorage.removeItem(storageKey);
  return null;
}

function dispatchBatches(threadIds: readonly string[]): readonly (readonly string[])[] {
  return Array.from(
    {length: Math.ceil(threadIds.length / maximumDispatchBundleSize)},
    (_, index) => threadIds.slice(
      index * maximumDispatchBundleSize,
      (index + 1) * maximumDispatchBundleSize,
    ),
  );
}

interface DispatchAttemptResult {
  readonly dispatches: readonly AgentDispatch[];
  readonly failure: Error | null;
}

async function createDispatchBatches(
  projectId: string,
  agentId: string,
  note: string | null,
  batches: readonly (readonly string[])[],
  idempotencyKeys: readonly string[],
  index = 0,
  created: readonly AgentDispatch[] = [],
): Promise<DispatchAttemptResult> {
  const threadIds = batches[index];
  if (threadIds === undefined) return {dispatches: created, failure: null};
  try {
    const result = await api.createAgentDispatch(
      projectId,
      {agentId, note, threadIds},
      idempotencyKeys[index] ?? crypto.randomUUID(),
    );
    return createDispatchBatches(
      projectId,
      agentId,
      note,
      batches,
      idempotencyKeys,
      index + 1,
      [...created, result.dispatch],
    );
  } catch (caught) {
    return {
      dispatches: created,
      failure: caught instanceof Error ? caught : new Error("Sending failed."),
    };
  }
}

/**
 * Send one exact annotation set to an agent with an honest tier-aware control.
 *
 * The remembered destination is a per-principal, per-project convenience. A
 * disconnected remembered agent disables the main action instead of silently
 * choosing another. The caret remains available to pick a connected agent or
 * add the optional bundle note. Sets above the server's per-dispatch bound are
 * split into ordered batches while one human click remains the initiating act.
 */
export function SendToAgentControl({
  agents,
  buttonSize = "xs",
  buttonVariant = "outline",
  feedback,
  label,
  onSent,
  oneAgentLabel,
  openCount,
  principalId,
  projectId,
  resolveBundle,
}: {
  /** The polled presence list, or null while the surface is reading it. */
  readonly agents: readonly AgentPresence[] | null;
  readonly buttonSize?: "default" | "sm" | "xs";
  readonly buttonVariant?: "default" | "outline" | "secondary";
  readonly feedback: DispatchFeedback;
  /** Label used before the first destination is chosen. */
  readonly label: string;
  readonly onSent: () => Promise<void>;
  /** Exact number of open, undispatched annotations represented. */
  readonly openCount: number;
  readonly oneAgentLabel?: (name: string) => string;
  readonly principalId: string;
  readonly projectId: string;
  readonly resolveBundle: () => Promise<DispatchBundle>;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [noteOpen, setNoteOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [pending, setPending] = useState(false);
  const [quickPending, setQuickPending] = useState(false);
  const [dialogAgents, setDialogAgents] = useState<readonly AgentPresence[]>([]);
  const [bundle, setBundle] = useState<DispatchBundle | null>(null);
  const [agentId, setAgentId] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const [error, setError] = useState<Error | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const attemptKeys = useRef<readonly string[]>([]);
  const dialogId = useId();
  const storageKey = defaultAgentStorageKey(principalId, projectId);
  const [rememberedPreference, setRememberedPreference] =
    useState<RememberedAgentPreference>(() => ({
      agent: readRememberedAgent(storageKey),
      storageKey,
    }));

  useEffect(() => {
    setRememberedPreference({
      agent: readRememberedAgent(storageKey),
      storageKey,
    });
  }, [storageKey]);

  const rememberedDefault = rememberedPreference.storageKey === storageKey
    ? rememberedPreference.agent
    : null;
  const knownConnected = agents?.filter((agent) => agent.connected) ?? null;
  const rememberedAgent = agents?.find((agent) => agent.id === rememberedDefault?.id) ?? null;
  const rememberedDefaultMissing = agents !== null
    && rememberedDefault !== null
    && rememberedAgent === null;

  useEffect(() => {
    if (!rememberedDefaultMissing) return;
    window.localStorage.removeItem(storageKey);
    setRememberedPreference({agent: null, storageKey});
  }, [rememberedDefaultMissing, storageKey]);

  const mainAgent = rememberedAgent?.connected === true
    ? rememberedAgent
    : (rememberedDefault === null || rememberedDefaultMissing)
        && knownConnected?.length === 1
      ? knownConnected[0] ?? null
      : null;
  const disconnectedDefaultName = rememberedAgent !== null && !rememberedAgent.connected
    ? rememberedAgent.displayName
    : null;
  const noAgents = knownConnected !== null && knownConnected.length === 0;
  const nothingToSend = openCount === 0;
  const mainReason = nothingToSend
    ? "Nothing open to send."
    : disconnectedDefaultName !== null
      ? `${disconnectedDefaultName} disconnected — pick another`
      : noAgents
        ? "No agent connected — connect one to send."
        : null;
  const mainLabel = mainAgent === null
    ? disconnectedDefaultName === null || oneAgentLabel === undefined
      ? label
      : oneAgentLabel(disconnectedDefaultName)
    : oneAgentLabel === undefined
      ? label
      : oneAgentLabel(mainAgent.displayName);
  const trimmedNote = note.trim();
  const noteTooLong = trimmedNote.length > maximumDispatchNoteCharacters;
  const connectedDialogAgents = dialogAgents.filter((agent) => agent.connected);
  const threadIds = bundle?.threadIds ?? [];

  const rememberAgent = (agent: AgentPresence): void => {
    const next = {displayName: agent.displayName, id: agent.id};
    window.localStorage.setItem(storageKey, JSON.stringify(next));
    setRememberedPreference({agent: next, storageKey});
  };

  const reportAttempt = async (
    agent: AgentPresence,
    resolved: DispatchBundle,
    result: DispatchAttemptResult,
  ): Promise<void> => {
    if (result.dispatches.length > 0) {
      rememberAgent(agent);
      const sentCount = result.dispatches.reduce(
        (count, dispatch) => count + dispatch.threadIds.length,
        0,
      );
      if (result.failure === null) {
        feedback.sent({agent, dispatches: result.dispatches});
      } else {
        feedback.sent({
          agent,
          dispatches: result.dispatches,
          incompleteCount: resolved.threadIds.length - sentCount,
        });
      }
      await onSent();
      return;
    }
    feedback.sendFailed(result.failure ?? new Error("Sending failed."));
  };

  const dispatchTo = async (
    agent: AgentPresence,
    resolved: DispatchBundle,
    dispatchNote: string | null,
    keys: readonly string[],
  ): Promise<void> => {
    const result = await createDispatchBatches(
      projectId,
      agent.id,
      dispatchNote,
      dispatchBatches(resolved.threadIds),
      keys,
    );
    await reportAttempt(agent, resolved, result);
  };

  const quickSend = async (agent: AgentPresence): Promise<void> => {
    setQuickPending(true);
    try {
      const resolved = await resolveBundle();
      if (resolved.threadIds.length === 0) {
        feedback.sendFailed(new Error("Nothing open to send."));
        return;
      }
      await dispatchTo(
        agent,
        resolved,
        null,
        dispatchBatches(resolved.threadIds).map(() => crypto.randomUUID()),
      );
    } catch (caught) {
      feedback.sendFailed(
        caught instanceof Error ? caught : new Error("Sending failed."),
      );
    } finally {
      setQuickPending(false);
    }
  };

  const prepareNote = async (): Promise<void> => {
    setLoading(true);
    setError(null);
    attemptKeys.current = [];
    try {
      const [listedAgents, resolved] = await Promise.all([
        api.agentPresence(),
        resolveBundle(),
      ]);
      setDialogAgents(listedAgents);
      setBundle(resolved);
      const preferred = listedAgents.find((agent) =>
        agent.id === rememberedDefault?.id && agent.connected
      ) ?? listedAgents.find((agent) => agent.connected) ?? null;
      setAgentId(preferred?.id ?? null);
      setNow(Date.now());
    } catch (caught) {
      setError(
        caught instanceof Error ? caught : new Error("Agent loading failed."),
      );
    } finally {
      setLoading(false);
    }
  };

  const changeNoteOpen = (nextOpen: boolean): void => {
    setNoteOpen(nextOpen);
    if (nextOpen) {
      void prepareNote();
      return;
    }
    setDialogAgents([]);
    setBundle(null);
    setAgentId(null);
    setNote("");
    setError(null);
    attemptKeys.current = [];
  };

  const sendWithNote = async (): Promise<void> => {
    const chosen = dialogAgents.find((agent) =>
      agent.id === agentId && agent.connected
    ) ?? null;
    if (chosen === null || bundle === null || threadIds.length === 0 || noteTooLong) return;
    const batches = dispatchBatches(threadIds);
    if (attemptKeys.current.length !== batches.length) {
      attemptKeys.current = batches.map(() => crypto.randomUUID());
    }
    setPending(true);
    setError(null);
    try {
      await dispatchTo(
        chosen,
        bundle,
        trimmedNote === "" ? null : trimmedNote,
        attemptKeys.current,
      );
      changeNoteOpen(false);
    } catch (caught) {
      setError(caught instanceof Error ? caught : new Error("Sending failed."));
    } finally {
      setPending(false);
    }
  };

  const menuAgents = knownConnected?.filter((agent) =>
    mainAgent === null || agent.id !== mainAgent.id
  ) ?? [];
  const caretDisabled = agents === null || noAgents || nothingToSend || quickPending;

  return (
    <div className="as-send-to-agent inline-flex flex-wrap items-center gap-2">
      <span className="as-send-to-agent__buttons inline-flex">
        <Button
          aria-busy={quickPending || agents === null}
          className="as-send-to-agent__primary"
          disabled={mainAgent === null || mainReason !== null || quickPending}
          onClick={() => {
            if (mainAgent !== null) void quickSend(mainAgent);
          }}
          size={buttonSize}
          type="button"
          variant={buttonVariant}
        >
          {agents === null ? (
            <span
              aria-hidden
              className="size-3 animate-spin rounded-full border border-current border-t-transparent motion-reduce:animate-none"
            />
          ) : mainAgent === null ? null : (
            <PresenceGlyph
              className="-my-1"
              kind={mainAgent.kind}
              ring={presenceRing(mainAgent)}
            />
          )}
          <span className="min-w-0 truncate">
            {quickPending ? "Sending…" : mainLabel}
          </span>
        </Button>
        <Popover onOpenChange={setMenuOpen} open={menuOpen}>
          <PopoverTrigger
            render={(
              <Button
                aria-label="Choose agent or send with a note"
                className="as-send-to-agent__menu -ml-px px-1.5"
                disabled={caretDisabled}
                size={buttonSize}
                type="button"
                variant={buttonVariant}
              />
            )}
          >
            <HugeiconsIcon icon={ArrowDown01Icon} strokeWidth={1.8} />
          </PopoverTrigger>
          <PopoverContent align="end" className="w-80 gap-2 p-2">
            {menuAgents.length === 0 ? null : (
              <div className="grid gap-1">
                {menuAgents.map((agent) => (
                  <button
                    className="flex items-center gap-3 p-2 text-left hover:bg-muted focus-visible:outline-2 focus-visible:outline-primary"
                    key={agent.id}
                    onClick={() => {
                      setMenuOpen(false);
                      void quickSend(agent);
                    }}
                    type="button"
                  >
                    <PresenceGlyph kind={agent.kind} ring={presenceRing(agent)} />
                    <span className="min-w-0">
                      <strong className="block truncate text-sm">{agent.displayName}</strong>
                      <span className="block truncate text-xs text-muted-foreground">
                        {agent.workingDirectory}
                      </span>
                    </span>
                  </button>
                ))}
              </div>
            )}
            <button
              className="border-t p-2 text-left text-sm hover:bg-muted focus-visible:outline-2 focus-visible:outline-primary"
              onClick={() => {
                setMenuOpen(false);
                changeNoteOpen(true);
              }}
              type="button"
            >
              Send with a note…
            </button>
          </PopoverContent>
        </Popover>
      </span>
      {mainReason === null ? null : (
        <span className="text-xs text-muted-foreground" role="status">
          {mainReason}
        </span>
      )}

      <Dialog onOpenChange={changeNoteOpen} open={noteOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Send with a note</DialogTitle>
            <DialogDescription>
              The selected annotations leave the open list when the send succeeds.
              Undo can call them back while the agent has not completed the send.
            </DialogDescription>
          </DialogHeader>

          {error === null ? null : (
            <p className="text-sm leading-6 text-destructive">{errorMessage(error)}</p>
          )}

          {loading ? (
            <p className="text-sm text-muted-foreground">Reading connected agents…</p>
          ) : connectedDialogAgents.length === 0 ? (
            <p className="text-sm leading-6 text-muted-foreground">
              No agent connected — connect one to send.
            </p>
          ) : (
            <>
              <fieldset className="grid gap-2">
                <legend className="mb-2 text-xs font-semibold tracking-wide uppercase">
                  Connected agents
                </legend>
                {dialogAgents.map((agent) => (
                  <label className="flex items-start gap-3 border p-3" key={agent.id}>
                    <input
                      checked={agentId === agent.id}
                      className="mt-1 size-4 accent-primary"
                      disabled={!agent.connected || pending}
                      name={`${dialogId}-agent`}
                      onChange={() => {
                        setAgentId(agent.id);
                        attemptKeys.current = [];
                      }}
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
                          : `Not connected, last seen ${formatRelativeTime(agent.lastSeenAt, now)}`}
                      </span>
                    </span>
                  </label>
                ))}
              </fieldset>

              <div className="grid gap-2">
                <Label htmlFor={`${dialogId}-note`}>Note for the agent</Label>
                <Textarea
                  aria-describedby={noteTooLong ? `${dialogId}-note-limit` : undefined}
                  aria-invalid={noteTooLong}
                  disabled={pending}
                  id={`${dialogId}-note`}
                  onChange={(event) => setNote(event.currentTarget.value)}
                  placeholder="Optional context for the whole bundle."
                  value={note}
                />
                {noteTooLong ? (
                  <p className="text-xs text-destructive" id={`${dialogId}-note-limit`}>
                    {`A note holds at most ${maximumDispatchNoteCharacters} characters. Remove ${
                      trimmedNote.length - maximumDispatchNoteCharacters
                    }.`}
                  </p>
                ) : null}
              </div>
            </>
          )}

          <DialogFooter>
            <DialogClose render={<Button type="button" variant="ghost" />}>
              Cancel
            </DialogClose>
            {connectedDialogAgents.length === 0 ? null : (
              <Button
                disabled={pending || loading || agentId === null
                  || threadIds.length === 0 || noteTooLong}
                onClick={() => void sendWithNote()}
                type="button"
              >
                {pending ? "Sending…" : `Send ${annotationCount(threadIds.length)}`}
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
