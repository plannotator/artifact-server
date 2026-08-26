import type {AgentPresence, CommentThread} from "@/api/client";
import {bundleOfThreads} from "@/components/dispatch/dispatch-bundle";
import type {DispatchFeedback} from "@/components/dispatch/dispatch-toast";
import {SendToAgentControl} from "@/components/dispatch/send-to-agent-dialog";
import {Button} from "@/components/ui/button";

/** The secondary path for sending only the annotations a reviewer selected. */
export function DispatchSelectionBar({
  agents,
  feedback,
  onClear,
  onSent,
  principalId,
  projectId,
  threads,
}: {
  readonly agents: readonly AgentPresence[] | null;
  readonly feedback: DispatchFeedback;
  readonly onClear: () => void;
  readonly onSent: () => Promise<void>;
  readonly principalId: string;
  readonly projectId: string;
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
        label={`Send ${threads.length}…`}
        onSent={onSent}
        oneAgentLabel={(name) => `Send ${threads.length} to ${name}`}
        openCount={threads.length}
        principalId={principalId}
        projectId={projectId}
        resolveBundle={() => Promise.resolve(bundleOfThreads(threads))}
      />
      <Button onClick={onClear} size="xs" type="button" variant="ghost">
        Clear selection
      </Button>
    </div>
  );
}
