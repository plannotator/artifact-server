import type {
  InsightActivityEvent,
  InsightActivityKind,
  InsightDispatchState,
  InsightWindow,
} from "@/api/client";
import {intlLocale} from "@/i18n/locale";
import {dashboardText} from "@/i18n/messages/dashboard";

const windowText = dashboardText.window;
const stateText = dashboardText.dispatchState;
const phrase = dashboardText.activity.phrase;

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
  {label: windowText.days7, value: "7d"},
  {label: windowText.days30, value: "30d"},
  {label: windowText.days90, value: "90d"},
  {label: windowText.all, value: "all"},
] as const satisfies readonly DashboardWindowOption[];

/** Dispatch states in lifecycle order, with the label each one shows. */
export const dispatchStates = [
  {label: stateText.queued, state: "queued", tone: "neutral"},
  {label: stateText.claimed, state: "claimed", tone: "neutral"},
  {label: stateText.delivered, state: "delivered", tone: "neutral"},
  {label: stateText.addressed, state: "addressed", tone: "primary"},
  {label: stateText.failed, state: "failed", tone: "danger"},
  {label: stateText.canceled, state: "canceled", tone: "neutral"},
] as const satisfies readonly DispatchStateOption[];

/** One activity phrase: words before the artifact link, then words after it. */
export interface ActivityPhrase {
  readonly lead: string;
  readonly trail: string;
}

const activityLabels = {
  "artifact.access_changed": phrase.accessChanged,
  "artifact.captured": phrase.captured,
  "artifact.deleted": phrase.deleted,
  "artifact.linked": phrase.linked,
  "artifact.published": phrase.published,
  "artifact.relinked": phrase.relinked,
  "artifact.restored": phrase.restored,
  "artifact.tags_changed": phrase.tagsChanged,
  "comment.deleted": phrase.commentDeleted,
  "comment.edited": phrase.commentEdited,
  "comment.opened": phrase.commentOpened,
  "comment.reopened": phrase.commentReopened,
  "comment.replied": phrase.commentReplied,
  "comment.resolved": phrase.commentResolved,
  "dispatch.addressed": phrase.dispatchAddressed,
  "dispatch.canceled": phrase.dispatchCanceled,
  "dispatch.delivered": phrase.dispatchDelivered,
  "dispatch.failed": phrase.dispatchFailed,
  "dispatch.sent": phrase.dispatchSent,
} as const satisfies Record<InsightActivityKind, ActivityPhrase>;

/** The phrase that describes one activity kind, split around its artifact. */
export function activityLabel(kind: InsightActivityKind): ActivityPhrase {
  return activityLabels[kind];
}

/** Who did it, in the words the timeline shows. */
export function activityActorLabel(actor: InsightActivityEvent["actor"]): string | null {
  if (actor === null) return null;
  if (actor.displayName !== null) return actor.displayName;
  if (actor.kind === "service") return dashboardText.activity.actor.service;
  if (actor.kind === "human") return dashboardText.activity.actor.human;
  return dashboardText.activity.actor.gone;
}

/** Short calendar label for one UTC growth bucket. */
export function formatDay(day: string): string {
  const date = new Date(`${day}T00:00:00.000Z`);
  return Number.isNaN(date.getTime())
    ? day
    : new Intl.DateTimeFormat(intlLocale, {
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
