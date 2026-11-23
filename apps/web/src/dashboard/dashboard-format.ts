import type {
  InsightActivityEvent,
  InsightActivityKind,
  InsightDispatchState,
  InsightWindow,
} from "@/api/client";

/** One choice in the window control. */
export interface DashboardWindowOption {
  readonly label: string;
  readonly value: InsightWindow;
}

/** One dispatch state row in the review section. */
export interface DispatchStateOption {
  readonly label: string;
  readonly state: InsightDispatchState;
  readonly tone: "danger" | "neutral" | "primary";
}

/** Window choices in the order the control shows them. */
export const dashboardWindows = [
  {label: "7 days", value: "7d"},
  {label: "30 days", value: "30d"},
  {label: "90 days", value: "90d"},
  {label: "All time", value: "all"},
] as const satisfies readonly DashboardWindowOption[];

/** Dispatch states in lifecycle order, with the label each one shows. */
export const dispatchStates = [
  {label: "Queued", state: "queued", tone: "neutral"},
  {label: "Claimed", state: "claimed", tone: "neutral"},
  {label: "Delivered", state: "delivered", tone: "neutral"},
  {label: "Addressed", state: "addressed", tone: "primary"},
  {label: "Failed", state: "failed", tone: "danger"},
  {label: "Canceled", state: "canceled", tone: "neutral"},
] as const satisfies readonly DispatchStateOption[];

const activityLabels = {
  "artifact.access_changed": "changed access of",
  "artifact.captured": "captured",
  "artifact.deleted": "deleted",
  "artifact.linked": "linked",
  "artifact.published": "published",
  "artifact.relinked": "relinked",
  "artifact.restored": "restored",
  "artifact.tags_changed": "retagged",
  "comment.deleted": "deleted a comment on",
  "comment.edited": "edited a comment on",
  "comment.opened": "commented on",
  "comment.reopened": "reopened a comment on",
  "comment.replied": "replied on",
  "comment.resolved": "resolved a comment on",
  "dispatch.addressed": "Dispatch addressed",
  "dispatch.canceled": "Dispatch canceled",
  "dispatch.delivered": "received a dispatch",
  "dispatch.failed": "Dispatch failed",
  "dispatch.sent": "sent a dispatch",
} as const satisfies Record<InsightActivityKind, string>;

/** The verb phrase that describes one activity kind. */
export function activityLabel(kind: InsightActivityKind): string {
  return activityLabels[kind];
}

/** Who did it, in the words the timeline shows. */
export function activityActorLabel(actor: InsightActivityEvent["actor"]): string | null {
  if (actor === null) return null;
  if (actor.displayName !== null) return actor.displayName;
  if (actor.kind === "service") return "An API key";
  if (actor.kind === "human") return "A member";
  return "Someone no longer here";
}

/** Short calendar label for one UTC growth bucket. */
export function formatDay(day: string): string {
  const date = new Date(`${day}T00:00:00.000Z`);
  return Number.isNaN(date.getTime())
    ? day
    : new Intl.DateTimeFormat(undefined, {
      day: "numeric",
      month: "short",
      timeZone: "UTC",
    }).format(date);
}

/** Whole-number percentage, or null when there is nothing to divide. */
export function percentage(part: number, whole: number): number | null {
  return whole === 0 ? null : Math.round((part / whole) * 100);
}

/** Link to one artifact inside the review application. */
export function artifactReviewHref(projectId: string, artifactId: string): string {
  return `/review?${new URLSearchParams({artifact: artifactId, project: projectId})}`;
}
