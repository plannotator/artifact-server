/**
 * Multi-file artifacts reference their sub-resources relatively. The viewer
 * renders the entry document from a `srcdoc` sandbox, whose base URL is the
 * frame's own document, so those references would resolve against this
 * application. When the host knows a content-domain base for the version it
 * passes it here and the tag is spliced in as the first child of `<head>`,
 * where the first `<base>` in document order wins.
 */
const absoluteHttpUrl = /^https?:\/\/[^\s"'<>]+$/u;
const headOpenTag = /<head\b[^>]*>/iu;

/** Return `html` with a `<base href>` in place, or unchanged when it cannot be. */
export function withBaseHref(html: string, baseHref: string | null): string {
  if (baseHref === null || !absoluteHttpUrl.test(baseHref)) return html;
  const tag = `<base href="${baseHref}">`;
  const match = headOpenTag.exec(html);
  if (match === null) return `${tag}${html}`;
  const insertAt = match.index + match[0].length;
  return `${html.slice(0, insertAt)}${tag}${html.slice(insertAt)}`;
}
