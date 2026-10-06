export interface MarkdownRenderOptions {
  readonly baseHref: string;
  readonly entryPath: string;
  readonly manifestPaths: readonly string[];
  readonly isLight: boolean;
  readonly signal?: AbortSignal;
}

/** Resolve only bundled resources inside this exact version, or ordinary external links. */
export function resolveMarkdownReference(
  reference: string,
  options: MarkdownRenderOptions,
  image: boolean,
): string | null {
  const value = reference.trim();
  const hasUnsafeCharacter = Array.from(value).some((character) =>
    character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127 || character === "\\"
  );
  if (value === "" || hasUnsafeCharacter || value.startsWith("//")) return null;
  if (value.startsWith("#")) return image ? null : value;
  if (/^[a-z][a-z\d+.-]*:/iu.test(value)) {
    try {
      const url = new URL(value);
      if (!image && (url.protocol === "https:" || url.protocol === "http:" || url.protocol === "mailto:")) {
        return url.href;
      }
    } catch {
      return null;
    }
    return null;
  }
  if (value.startsWith("/")) return null;
  try {
    // A fixed virtual root validates traversal independently of the secret lease URL.
    const root = new URL("https://markdown.invalid/version/");
    const entryUrl = new URL(options.entryPath.split("/").map(encodeURIComponent).join("/"), root);
    const resolved = new URL(value, entryUrl);
    if (resolved.origin !== root.origin || !resolved.pathname.startsWith(root.pathname)) return null;
    const path = decodeURIComponent(resolved.pathname.slice(root.pathname.length));
    if (!options.manifestPaths.includes(path)) return null;
    const leaseRoot = new URL(options.baseHref);
    if (!leaseRoot.pathname.endsWith("/")) return null;
    const target = new URL(path.split("/").map(encodeURIComponent).join("/"), leaseRoot);
    target.hash = resolved.hash;
    target.search = resolved.search;
    return target.href;
  } catch {
    return null;
  }
}
