import type { AgentDispatchState } from "@/api/client";
import { StatusBadge } from "@/components/product";

const stateLabels = {
  addressed: "Addressed",
  canceled: "Canceled",
  claimed: "Claimed",
  delivered: "Delivered",
  failed: "Failed",
  queued: "Queued",
} satisfies Record<AgentDispatchState, string>;

/** True while a send can still be called back from its agent. */
export function dispatchIsCancelable(state: AgentDispatchState): boolean {
  return state === "queued" || state === "claimed";
}

/**
 * Delivery state of the send that carried one annotation away.
 *
 * Only the "Sent" filter renders it. Sending is consumptive, so no send status
 * ever decorates the artifact surfaces: the annotations are simply gone from
 * them until a failed or canceled send returns them.
 */
export function DispatchStateChip({
  state,
}: {
  readonly state: AgentDispatchState;
}) {
  return (
    <StatusBadge
      tone={state === "failed" || state === "canceled"
        ? "danger"
        : state === "addressed"
          ? "neutral"
          : "primary"}
    >
      {stateLabels[state]}
    </StatusBadge>
  );
}
