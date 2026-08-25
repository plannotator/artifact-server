import type { AgentPresence, CommentThread } from "@/api/client";
import { bundleOfThreads } from "@/components/dispatch/dispatch-bundle";
import type { DispatchFeedback } from "@/components/dispatch/dispatch-toast";
import { SendToAgentControl } from "@/components/dispatch/send-to-agent-dialog";
import { Button } from "@/components/ui/button";

/**
 * The multi-select send bar: one confirm turns every selected annotation into
 * one bundle, never several.
 */
export function DispatchSelectionBar({
  agents,
  feedback,
  onClear,
  onSent,
  projectId,
  threads,
}: {
  /** The surface's polled presence list, or null while it is still reading. */
  readonly agents: readonly AgentPresence[] | null;
  /** The surface's undo toast, where the send reports its outcome. */
  readonly feedback: DispatchFeedback;
  readonly onClear: () => void;
  readonly onSent: () => Promise<void>;
  readonly projectId: string;
  /** Every selected annotation; the bundle orders them oldest first. */
  readonly threads: readonly CommentThread[];
}) {
  return (
    <div
      aria-label="Selected annotations"
      className="flex flex-wrap items-center gap-3 border p-3"
      role="group"
    >
      <p className="text-sm">
        {threads.length === 1
          ? "1 annotation selected"
          : `${threads.length} annotations selected`}
      </p>
      <SendToAgentControl
        agents={agents}
        buttonVariant="default"
        feedback={feedback}
        label={`Send ${threads.length} to agent`}
        onSent={onSent}
        oneAgentLabel={(name) => `Send ${threads.length} to ${name}`}
        projectId={projectId}
        resolveBundle={() => Promise.resolve(bundleOfThreads(threads))}
      />
      <Button onClick={onClear} size="xs" type="button" variant="ghost">
        Clear selection
      </Button>
    </div>
  );
}
