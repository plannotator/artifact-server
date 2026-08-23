const localHttpHostnames = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);
const trailingSlashes = /\/+$/u;

/** Normalize one configured or discovered OIDC issuer, or refuse it. */
export function normalizeOidcIssuer(value: string): string | null {
  const trimmed = value.trim();
  if (trimmed === "") return null;
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return null;
  }
  if (url.search !== "" || url.hash !== "") return null;
  if (url.username !== "" || url.password !== "") return null;
  if (!isAllowedOidcTransport(url)) return null;
  return url.toString().replace(trailingSlashes, "");
}

/** Normalize one issuer or refuse the configuration by name. */
export function requireOidcIssuer(value: string, name: string): string {
  const issuer = normalizeOidcIssuer(value);
  if (issuer === null) {
    throw new Error(
      `${name} must be an HTTPS URL without query or fragment. Plain http is allowed only for localhost, 127.0.0.1, and ::1.`,
    );
  }
  return issuer;
}

/** Report whether a normalized issuer is one of the local development origins. */
export function isLocalOidcIssuer(issuer: string): boolean {
  const url = new URL(issuer);
  return url.protocol === "http:" && localHttpHostnames.has(url.hostname);
}

/** Validate one discovered endpoint URL under the issuer transport rules. */
export function normalizeOidcEndpoint(
  value: string,
  allowLocalHttp: boolean,
): string | null {
  const trimmed = value.trim();
  if (trimmed === "") return null;
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return null;
  }
  if (url.username !== "" || url.password !== "" || url.hash !== "") return null;
  const allowed = url.protocol === "https:" ||
    (allowLocalHttp && url.protocol === "http:" &&
      localHttpHostnames.has(url.hostname));
  return allowed ? url.toString() : null;
}

function isAllowedOidcTransport(url: URL): boolean {
  return url.protocol === "https:" ||
    (url.protocol === "http:" && localHttpHostnames.has(url.hostname));
}
