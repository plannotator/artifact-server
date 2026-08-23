import { ApiError, type ArtifactAction, type SourceFreshness } from "@/api/client";

/** Formats a stored ISO timestamp for the current browser locale. */
export function formatTimestamp(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? value
    : new Intl.DateTimeFormat(undefined, {
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
  const formatter = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
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
    return "Artifact Server could not complete the request.";
  }
  if (error.status === 401) {
    return "Your session expired. Sign in again to continue.";
  }
  if (error.status === 403) {
    return "You are signed in, but you do not have permission for this action.";
  }
  if (
    error.code === "ARTIFACT_MUTATION_CONFLICT"
    || error.code === "PUBLISH_CONFLICT"
  ) {
    return "This artifact changed after you opened it. Reload before trying again.";
  }
  if (error.code === "PROJECT_ARCHIVED") {
    return "This project is archived. Existing artifacts remain available, but new work is blocked.";
  }
  return error.message;
}

/** Converts an access-setting value into the product's visible term. */
export function accessSettingLabel(value: "account_required" | "public_link"): string {
  return value === "account_required" ? "Account required" : "Public link";
}

/** Converts one action kind into compact action-history text. */
export function actionLabel(value: ArtifactAction["action"]): string {
  switch (value) {
    case "capture":
      return "Captured linked file";
    case "link":
      return "Linked source file";
    case "relink":
      return "Relinked source file";
    case "change_access":
      return "Changed access";
    case "change_tags":
      return "Replaced tags";
    case "comment_create":
      return "Opened comment";
    case "comment_delete":
      return "Deleted comment";
    case "comment_reopen":
      return "Reopened comment";
    case "comment_reply":
      return "Replied to comment";
    case "comment_resolve":
      return "Resolved comment";
    case "comment_update":
      return "Edited comment";
    case "delete":
      return "Tombstoned artifact";
    case "publish":
      return "Published version";
    case "restore":
      return "Restored version";
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
      return "In sync";
    case "missing":
      return "File missing";
    case "modified":
      return "Modified on disk";
    case "unreadable":
      return "Unreadable";
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
    return "The linked file is missing from disk. The last captured version is what everyone reads.";
  }
  if (value === "unreadable") {
    return "The linked file cannot be read right now. The last captured version is what everyone reads.";
  }
  if (value !== "modified") return null;
  return view === "live"
    ? "File changed on disk — showing live bytes."
    : "A newer state exists on disk. Comments and shared links stay on the captured version.";
}

function freshnessHandled(value: never): never {
  throw new Error(`Unhandled source freshness: ${String(value)}`);
}
