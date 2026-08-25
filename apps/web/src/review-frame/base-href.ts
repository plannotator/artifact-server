/**
 * Multi-file artifacts reference their sub-resources relatively. The viewer
 * renders the entry document from a `srcdoc` sandbox, whose base URL is the
 * frame's own document, so those references would resolve against this
 * application. When the host knows a content-domain base for the version it
 * passes it here and the tag is spliced in as the first child of `<head>`,
 * where the first `<base>` in document order wins.
 */
const absoluteHttpUrl = /^https?:\/\/[^\s"'<>]+$/u;
const doctypeTag = /<!doctype\b[^>]*>/iu;
const resourceUrlAttributes = [
  ["[src]", "src"],
  ["link[href]", "href"],
  ["[poster]", "poster"],
  ["object[data]", "data"],
] as const;

/** Return `html` with a `<base href>` in place, or unchanged when it cannot be. */
export function withBaseHref(html: string, baseHref: string | null): string {
  if (baseHref === null || !absoluteHttpUrl.test(baseHref)) return html;
  return withResolvedDocumentResources(html, baseHref);
}

/**
 * Resolve parser-fetched resources before `srcdoc` navigation starts.
 *
 * Firefox can begin an image request against the frame document before a
 * dynamically supplied base URL settles, then retain the failed image even
 * after it retries the correct URL. Parsing here does not execute or fetch
 * anything. It makes eager resource attributes absolute up front, while the
 * base element still governs CSS, modules, runtime fetches, and navigation.
 */
function withResolvedDocumentResources(html: string, baseHref: string): string {
  const parsed = new DOMParser().parseFromString(html, "text/html");
  const base = parsed.createElement("base");
  base.href = baseHref;
  parsed.head.prepend(base);
  for (const [selector, attribute] of resourceUrlAttributes) {
    for (const element of parsed.querySelectorAll(selector)) {
      const value = element.getAttribute(attribute);
      if (value === null || value.trim() === "") continue;
      try {
        element.setAttribute(attribute, new URL(value, baseHref).toString());
      } catch {
        // Leave invalid authored URLs intact so the browser reports them in
        // the artifact instead of turning Review into an HTML validator.
      }
    }
  }
  const doctype = doctypeTag.exec(html)?.[0] ?? "";
  return `${doctype}${parsed.documentElement.outerHTML}`;
}
