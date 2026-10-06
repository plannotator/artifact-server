import DOMPurify from "dompurify";
import { Marked, Renderer, type Token } from "marked";

import { resolveMarkdownReference, type MarkdownRenderOptions } from "./markdown-references.ts";
import { renderMermaidInSandbox } from "./diagram-sandbox-client.ts";
import { markdownDocumentStyle } from "./markdown-document-style.ts";
import { markdownHeadingId } from "./markdown-headings.ts";

export type { MarkdownRenderOptions } from "./markdown-references.ts";

export const markdownSourceByteLimit = 1_048_576;
const diagramCountLimit = 12;
const diagramTextLimit = 20_000;
const highlightedCodeLimit = 20_000;
const highlightedDocumentLimit = 200_000;
const highlightedBlockLimit = 128;

function escapeHtml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;");
}

function codeFallback(text: string, message?: string): string {
  const notice = message === undefined ? "" : `<p class="render-notice">${escapeHtml(message)}</p>`;
  return `${notice}<pre><code>${escapeHtml(text)}</code></pre>`;
}

const codeLanguages = {
  javascript: () => import("shiki/langs/javascript.mjs"),
  typescript: () => import("shiki/langs/typescript.mjs"),
  jsx: () => import("shiki/langs/jsx.mjs"),
  tsx: () => import("shiki/langs/tsx.mjs"),
  json: () => import("shiki/langs/json.mjs"),
  html: () => import("shiki/langs/html.mjs"),
  css: () => import("shiki/langs/css.mjs"),
  python: () => import("shiki/langs/python.mjs"),
  shellscript: () => import("shiki/langs/shellscript.mjs"),
  yaml: () => import("shiki/langs/yaml.mjs"),
  sql: () => import("shiki/langs/sql.mjs"),
  markdown: () => import("shiki/langs/markdown.mjs"),
};

const languageAliases = new Map([
  ["js", "javascript"], ["ts", "typescript"], ["py", "python"],
  ["sh", "shellscript"], ["bash", "shellscript"], ["yml", "yaml"],
]);

async function createCodeHighlighter() {
  const [core, engine, light, dark] = await Promise.all([
    import("shiki/core"), import("shiki/engine/javascript"),
    import("shiki/themes/github-light.mjs"), import("shiki/themes/github-dark.mjs"),
  ]);
  return core.createHighlighterCore({
    engine: engine.createJavaScriptRegexEngine(), themes: [light.default, dark.default], langs: [],
  });
}
let codeHighlighter: ReturnType<typeof createCodeHighlighter> | undefined;

async function highlightCode(text: string, language: string, isLight: boolean): Promise<string> {
  if (text.length > highlightedCodeLimit) return codeFallback(text);
  const canonical = languageAliases.get(language) ?? language;
  const loader = Object.entries(codeLanguages).find(([name]) => name === canonical)?.[1];
  if (loader === undefined) return codeFallback(text);
  try {
    codeHighlighter ??= createCodeHighlighter();
    const highlighter = await codeHighlighter;
    await highlighter.loadLanguage(loader);
    return highlighter.codeToHtml(text, { lang: canonical, theme: isLight ? "github-light" : "github-dark" });
  } catch {
    return codeFallback(text);
  }
}

async function renderDiagram(text: string, isLight: boolean, id: string, signal?: AbortSignal): Promise<string> {
  signal?.throwIfAborted();
  if (text.length > diagramTextLimit) return codeFallback(text, "Diagram exceeds the preview size limit.");
  // User configuration, event links, and custom CSS cannot cross the renderer's security boundary.
  if (/%%\s*\{|^\s*---|(?:^|[;\n])\s*(?:click|classDef|style|linkStyle)\s/imu.test(text)) {
    return codeFallback(text, "Diagram configuration and interactive styling are disabled in preview.");
  }
  try {
    const rendered = await renderMermaidInSandbox(text, isLight, id, signal);
    signal?.throwIfAborted();
    if (/url\s*\(\s*["']?\s*(?!#)[^\s)"']|@import/iu.test(rendered)) {
      return codeFallback(text, "Diagram contains unsupported external styling.");
    }
    // Parse only after sanitation; never mount diagram-provided markup in the application.
    const fragment = DOMPurify.sanitize(rendered, {
      USE_PROFILES: { svg: true, svgFilters: true },
      ADD_TAGS: ["style"],
      FORBID_TAGS: ["foreignObject", "foreignobject", "script", "a", "image", "use", "animate", "animateMotion", "animateTransform", "set"],
      FORBID_ATTR: ["href", "xlink:href"],
      RETURN_DOM_FRAGMENT: true,
    });
    const svg = fragment.firstElementChild;
    const extraText = Array.from(fragment.childNodes).some((node) =>
      node.nodeType !== Node.ELEMENT_NODE && (node.textContent ?? "").trim() !== ""
    );
    if (fragment.children.length !== 1 || svg?.namespaceURI !== "http://www.w3.org/2000/svg"
      || svg.localName !== "svg" || extraText) {
      return codeFallback(text, "This diagram did not produce a valid SVG preview.");
    }
    return `<figure class="markdown-diagram">${svg.outerHTML}</figure>`;
  } catch {
    signal?.throwIfAborted();
    return codeFallback(text, "This diagram could not be rendered. Its source is shown below.");
  }
}

/** Render untrusted Markdown into a safe document for the existing isolated review frame. */
export async function renderMarkdownDocument(source: string, options: MarkdownRenderOptions): Promise<string> {
  options.signal?.throwIfAborted();
  if (new TextEncoder().encode(source).byteLength > markdownSourceByteLimit) {
    throw new Error("Markdown preview is limited to 1 MiB. Download the original file to read it.");
  }
  // Stable DOM identity preserves annotation anchors across reopening the same immutable source.
  let hash = 2166136261;
  for (const character of `${options.entryPath}\n${source}`) {
    hash = Math.imul(hash ^ character.charCodeAt(0), 16777619);
  }
  const documentId = (hash >>> 0).toString(16);
  const headingIds = new Set<string>();
  const renderedCode = new WeakMap<Token, string>();
  let diagramCount = 0;
  let highlightedCharacters = 0;
  let highlightedBlocks = 0;
  const renderer = new Renderer();
  renderer.heading = function ({ depth, text, tokens }) {
    const id = markdownHeadingId(text, headingIds);
    return `<h${depth} id="${escapeHtml(id)}">${this.parser.parseInline(tokens)}</h${depth}>`;
  };
  renderer.html = ({ text }) => escapeHtml(text);
  renderer.code = (token) => renderedCode.get(token) ?? codeFallback(token.text);
  renderer.link = function ({ href, title, tokens }) {
    const label = this.parser.parseInline(tokens);
    const safeHref = resolveMarkdownReference(href, options, false);
    if (safeHref === null) return label;
    const titleAttribute = title === null || title === undefined ? "" : ` title="${escapeHtml(title)}"`;
    const external = /^https?:|^mailto:/u.test(safeHref) && !safeHref.startsWith(options.baseHref);
    return `<a href="${escapeHtml(safeHref)}"${titleAttribute}${external ? ' target="_blank" rel="noopener noreferrer"' : ""}>${label}</a>`;
  };
  renderer.image = ({ href, title, text }) => {
    const safeHref = resolveMarkdownReference(href, options, true);
    if (safeHref === null) return `<span class="render-notice">${escapeHtml(text || "Image unavailable")}</span>`;
    const titleAttribute = title === null || title === undefined ? "" : ` title="${escapeHtml(title)}"`;
    return `<img src="${escapeHtml(safeHref)}" alt="${escapeHtml(text)}"${titleAttribute} loading="lazy">`;
  };
  const markdown = new Marked({
    async: true, gfm: true, renderer,
    walkTokens: async (token) => {
      options.signal?.throwIfAborted();
      if (token.type !== "code") return;
      const language = (token.lang ?? "").trim().split(/\s/u)[0]?.toLowerCase() ?? "";
      if (language === "mermaid") {
        diagramCount += 1;
        renderedCode.set(token, diagramCount > diagramCountLimit
          ? codeFallback(token.text, "Additional diagrams are shown as source (preview limit: 12).")
          : await renderDiagram(token.text, options.isLight, `markdown-diagram-${documentId}-${diagramCount}`, options.signal));
      } else {
        const canonical = languageAliases.get(language) ?? language;
        const supported = Object.hasOwn(codeLanguages, canonical);
        const canHighlight = supported && token.text.length <= highlightedCodeLimit
          && highlightedBlocks < highlightedBlockLimit
          && highlightedCharacters + token.text.length <= highlightedDocumentLimit;
        if (canHighlight) {
          highlightedBlocks += 1;
          highlightedCharacters += token.text.length;
        }
        renderedCode.set(token, canHighlight
          ? await highlightCode(token.text, language, options.isLight)
          : codeFallback(token.text));
      }
    },
  });
  const rendered = await markdown.parse(source);
  options.signal?.throwIfAborted();
  const body = DOMPurify.sanitize(rendered, {
    USE_PROFILES: { html: true, svg: true, svgFilters: true },
    FORBID_TAGS: ["script", "iframe", "object", "embed", "form", "foreignObject", "foreignobject"],
    ADD_TAGS: ["style"],
    ADD_ATTR: ["target"],
  });
  options.signal?.throwIfAborted();
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<base href="about:srcdoc">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Markdown document</title>
<style>${markdownDocumentStyle(options.isLight)}</style>
</head>
<body><main>${body}</main></body>
</html>`;
}
