/** One canonical settings destination inside the Artifact Server application. */
export type SettingsRoute =
  | {readonly kind: "projects"}
  | {readonly kind: "project"; readonly projectId: string}
  | {readonly kind: "members"}
  | {readonly kind: "apiKeys"}
  | {readonly kind: "publicLinks"}
  | {readonly kind: "notFound"};

/** Return whether the current document path belongs to the settings mode. */
export function isSettingsPath(pathname: string): boolean {
  return pathname === "/review/settings"
    || pathname.startsWith("/review/settings/");
}

/** Parse one refresh-safe settings URL without guessing a missing identity. */
export function parseSettingsRoute(pathname: string): SettingsRoute {
  if (pathname === "/review/settings" || pathname === "/review/settings/") {
    return {kind: "projects"};
  }
  const segments = pathname.split("/").filter((segment) => segment !== "");
  if (segments[0] !== "review" || segments[1] !== "settings") {
    return {kind: "notFound"};
  }
  if (segments.length === 3) {
    switch (segments[2]) {
      case "projects":
        return {kind: "projects"};
      case "members":
        return {kind: "members"};
      case "api-keys":
        return {kind: "apiKeys"};
      case "public-links":
        return {kind: "publicLinks"};
      default:
        return {kind: "notFound"};
    }
  }
  if (segments.length === 4 && segments[2] === "projects") {
    const projectId = parsePathSegment(segments[3]);
    return projectId === null
      ? {kind: "notFound"}
      : {kind: "project", projectId};
  }
  return {kind: "notFound"};
}

/** Build the canonical settings URL for one project. */
export function projectSettingsHref(projectId: string): string {
  return `/review/settings/projects/${encodeURIComponent(projectId)}`;
}

function parsePathSegment(segment: string | undefined): string | null {
  if (segment === undefined || segment === "") return null;
  try {
    const decoded = decodeURIComponent(segment);
    return decoded === "" || decoded.includes("/") ? null : decoded;
  } catch {
    return null;
  }
}
