import {Marked, type Tokens} from "marked";

/**
 * Turn one Markdown file into a self-contained HTML document for the review
 * frame's opaque-origin sandbox.
 *
 * This is string work only: the application never parses the output as HTML
 * or inserts it into its own document. The output is safe by construction
 * rather than by after-the-fact cleanup:
 *
 * - Raw HTML anywhere in the file is escaped and shows as literal text, so no
 *   element, attribute, or event handler from the file reaches the markup.
 * - Every text, code span, and code block is escaped.
 * - Link and image URLs pass a protocol allowlist. Relative URLs resolve
 *   against the exact version's content-host directory, so they stay inside
 *   the selected version; anything else (`javascript:`, `data:`, `vbscript:`,
 *   `file:`, ...) loses its URL and keeps only its text.
 *
 * The sandbox that renders the document is the second, independent boundary.
 */
export function markdownPreviewDocument(
  source: string,
  documentBaseHref: string,
): string {
  const body = markdownRenderer(documentBaseHref).parse(source, {async: false});
  return [
    "<!doctype html>",
    '<html lang="und">',
    "<head>",
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    // Opt in to the review frame's host theme so the document follows the
    // application palette instead of hard-coding its own colors.
    '<meta name="plannotator-theme" content="host">',
    `<style>${markdownDocumentStyle}</style>`,
    "</head>",
    `<body><main class="markdown-body">${body}</main></body>`,
    "</html>",
  ].join("");
}

const linkProtocols = new Set(["http:", "https:", "mailto:"]);
const imageProtocols = new Set(["http:", "https:"]);
const explicitScheme = /^[a-z][a-z0-9+.-]*:/iu;

/**
 * Resolve one authored URL, or answer `null` when it must not become a URL.
 * Fragments stay document-local. The WHATWG parser normalizes the scheme
 * (dropping embedded tabs and newlines) before the allowlist reads it.
 */
export function safeMarkdownUrl(
  authored: string,
  documentBaseHref: string,
  kind: "image" | "link",
): string | null {
  const value = authored.trim();
  if (value.length === 0) return null;
  if (kind === "link" && value.startsWith("#")) return value;
  let resolved: URL;
  try {
    resolved = new URL(value, documentBaseHref);
  } catch {
    return null;
  }
  const allowed = kind === "link" ? linkProtocols : imageProtocols;
  if (!allowed.has(resolved.protocol)) return null;
  const relative = !explicitScheme.test(value) && !value.startsWith("//");
  if (relative && resolved.origin !== new URL(documentBaseHref).origin) {
    return null;
  }
  return resolved.href;
}

function markdownRenderer(documentBaseHref: string): Marked {
  return new Marked({
    async: false,
    gfm: true,
    renderer: {
      code({text}: Tokens.Code): string {
        return `<pre><code>${escapeHtml(text)}</code></pre>\n`;
      },
      html({text}: Tokens.HTML | Tokens.Tag): string {
        return escapeHtml(text);
      },
      image({href, text, title}: Tokens.Image): string {
        const source = safeMarkdownUrl(href, documentBaseHref, "image");
        if (source === null) return escapeHtml(text);
        const titleAttribute = title === null || title === ""
          ? ""
          : ` title="${escapeHtml(title)}"`;
        return `<img src="${escapeHtml(source)}" alt="${escapeHtml(text)}"${titleAttribute}>`;
      },
      link({href, title, tokens}: Tokens.Link): string {
        const label = this.parser.parseInline(tokens);
        const target = safeMarkdownUrl(href, documentBaseHref, "link");
        if (target === null) return label;
        const titleAttribute = title === null || title === undefined || title === ""
          ? ""
          : ` title="${escapeHtml(title)}"`;
        return `<a href="${escapeHtml(target)}"${titleAttribute}>${label}</a>`;
      },
      text(token: Tokens.Text | Tokens.Escape): string {
        // Marked passes text after a raw `<script>` or `<pre>` tag through
        // unescaped. Raw HTML is never markup here, so text is always escaped.
        if ("tokens" in token && token.tokens !== undefined) {
          return this.parser.parseInline(token.tokens);
        }
        return escapeHtml(token.text);
      },
    },
  });
}

function escapeHtml(value: string): string {
  return value.replaceAll(/["&'<>]/gu, htmlEscape);
}

function htmlEscape(character: string): string {
  if (character === "&") return "&amp;";
  if (character === "<") return "&lt;";
  if (character === ">") return "&gt;";
  if (character === '"') return "&quot;";
  return "&#39;";
}

/**
 * Colors come only from the host theme tokens the review frame pushes into
 * host-themed documents; nothing here names a literal color.
 */
const markdownDocumentStyle = [
  ":root{color-scheme:light dark}",
  "html,body{margin:0;background:var(--background);color:var(--foreground)}",
  "body{font-family:var(--font-sans);font-size:15px;line-height:1.65}",
  ".markdown-body{box-sizing:border-box;max-width:52rem;margin:0 auto;padding:2rem 1.5rem 4rem;overflow-wrap:anywhere}",
  ".markdown-body h1,.markdown-body h2,.markdown-body h3,.markdown-body h4,.markdown-body h5,.markdown-body h6{line-height:1.25;margin:1.6em 0 .6em}",
  ".markdown-body h1{font-size:1.9em}.markdown-body h2{font-size:1.45em}.markdown-body h3{font-size:1.2em}",
  ".markdown-body h1,.markdown-body h2{border-bottom:1px solid var(--border);padding-bottom:.3em}",
  ".markdown-body a{color:var(--primary)}",
  ".markdown-body code{font-family:var(--font-mono);font-size:.9em;background:var(--code-bg);border-radius:4px;padding:.1em .35em}",
  ".markdown-body pre{background:var(--code-bg);border:1px solid var(--border);border-radius:var(--radius);overflow:auto;padding:1rem}",
  ".markdown-body pre code{background:none;padding:0}",
  ".markdown-body blockquote{border-left:3px solid var(--border);color:var(--muted-foreground);margin:1em 0;padding:0 1em}",
  ".markdown-body table{border-collapse:collapse;display:block;max-width:100%;overflow:auto}",
  ".markdown-body th,.markdown-body td{border:1px solid var(--border);padding:.4em .75em}",
  ".markdown-body th{background:var(--muted)}",
  ".markdown-body img{max-width:100%;height:auto}",
  ".markdown-body hr{border:0;border-top:1px solid var(--border);margin:2em 0}",
].join("");
