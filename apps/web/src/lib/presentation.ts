import { ApiError } from "@/api/client";

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
export function actionLabel(
  value: "change_access" | "change_tags" | "delete" | "publish" | "restore",
): string {
  switch (value) {
    case "change_access":
      return "Changed access";
    case "change_tags":
      return "Replaced tags";
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
