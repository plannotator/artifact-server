import { ApiError, type ArtifactAction, type SourceFreshness } from "@/api/client";
import { commonText, serverErrorMessage } from "@/i18n/messages/common";
import { intlLocale, locale } from "@/i18n/locale";

/** Formats a stored ISO timestamp for the interface language. */
export function formatTimestamp(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? value
    : new Intl.DateTimeFormat(intlLocale, {
      dateStyle: "medium",
      timeStyle: "short",
    }).format(date);
}

const relativeUnits: readonly (readonly [Intl.RelativeTimeFormatUnit, number])[] = [
  ["year", 31_536_000_000],
  ["month", 2_592_000_000],
  ["week", 604_800_000],
  ["day", 86_400_000],
  ["hour", 3_600_000],
  ["minute", 60_000],
];

/** Formats a stored ISO timestamp as relative time against a caller-held clock. */
export function formatRelativeTime(value: string, now: number): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  const elapsed = date.getTime() - now;
  const formatter = new Intl.RelativeTimeFormat(intlLocale, { numeric: "auto" });
  for (const [unit, milliseconds] of relativeUnits) {
    if (Math.abs(elapsed) >= milliseconds) {
      return formatter.format(Math.round(elapsed / milliseconds), unit);
    }
  }
  return formatter.format(Math.round(elapsed / 1_000), "second");
}

/** Formats a byte count without hiding its exact value at small sizes. */
export function formatBytes(value: number): string {
  if (value < 1_000) return `${value} B`;
  if (value < 1_000_000) return `${(value / 1_000).toFixed(1)} kB`;
  if (value < 1_000_000_000) return `${(value / 1_000_000).toFixed(1)} MB`;
  return `${(value / 1_000_000_000).toFixed(1)} GB`;
}

/** Returns a useful operator-facing message for expected API failures. */
export function errorMessage(error: Error): string {
  if (!(error instanceof ApiError)) {
    return commonText.failure.generic;
  }
  if (error.status === 401) {
    return commonText.failure.sessionExpired;
  }
  if (error.status === 403) {
    return commonText.failure.forbidden;
  }
  if (
    error.code === "ARTIFACT_MUTATION_CONFLICT"
    || error.code === "PUBLISH_CONFLICT"
  ) {
    return commonText.failure.artifactChanged;
  }
  if (error.code === "PROJECT_ARCHIVED") {
    return commonText.failure.projectArchived;
  }
  // English shows the server's own words; zh-TW translates the stable code.
  return locale === "en" ? error.message : serverErrorMessage(error.code) ?? error.message;
}

/** Converts an access-setting value into the product's visible term. */
export function accessSettingLabel(value: "account_required" | "public_link"): string {
  return value === "account_required" ? commonText.access.accountRequired : commonText.access.publicLink;
}

/** Converts one action kind into compact action-history text. */
export function actionLabel(value: ArtifactAction["action"]): string {
  switch (value) {
    case "capture":
      return commonText.action.capture;
    case "link":
      return commonText.action.link;
    case "relink":
      return commonText.action.relink;
    case "change_access":
      return commonText.action.changeAccess;
    case "change_tags":
      return commonText.action.changeTags;
    case "comment_create":
      return commonText.action.commentCreate;
    case "comment_delete":
      return commonText.action.commentDelete;
    case "comment_reopen":
      return commonText.action.commentReopen;
    case "comment_reply":
      return commonText.action.commentReply;
    case "comment_resolve":
      return commonText.action.commentResolve;
    case "comment_update":
      return commonText.action.commentUpdate;
    case "delete":
      return commonText.action.delete;
    case "publish":
      return commonText.action.publish;
    case "restore":
      return commonText.action.restore;
  }
  return actionHandled(value);
}

function actionHandled(value: never): never {
  throw new Error(`Unhandled artifact action: ${String(value)}`);
}

/** Names one linked file's state against the last capture. */
export function sourceFreshnessLabel(value: SourceFreshness): string {
  switch (value) {
    case "in-sync":
      return commonText.freshness.inSync;
    case "missing":
      return commonText.freshness.missing;
    case "modified":
      return commonText.freshness.modified;
    case "unreadable":
      return commonText.freshness.unreadable;
  }
  return freshnessHandled(value);
}

/**
 * How loudly a freshness state reads. Drift is ordinary product state, so it
 * draws the eye without alarming; only a file this server can no longer read
 * is a failure worth the destructive tone.
 */
export function sourceFreshnessTone(
  value: SourceFreshness,
): "danger" | "neutral" | "primary" {
  switch (value) {
    case "in-sync":
      return "neutral";
    case "modified":
      return "primary";
    case "missing":
    case "unreadable":
      return "danger";
  }
  return freshnessHandled(value);
}

/** One sentence saying what the drift means for what is on screen. */
export function sourceDriftDescription(
  value: SourceFreshness,
  view: "captured" | "live",
): string | null {
  if (value === "missing") {
    return commonText.freshness.missingDescription;
  }
  if (value === "unreadable") {
    return commonText.freshness.unreadableDescription;
  }
  if (value !== "modified") return null;
  return view === "live"
    ? commonText.freshness.liveDescription
    : commonText.freshness.capturedDescription;
}

function freshnessHandled(value: never): never {
  throw new Error(`Unhandled source freshness: ${String(value)}`);
}
