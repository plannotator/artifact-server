/**
 * The structured-data parsers and the Markdown document builder run on
 * untrusted file bytes. These checks pin their bounds and their refusal of
 * hostile input; the browser suites prove the rendered behavior.
 */

import {describe, expect, test} from "vitest";

import {
  dataRowLimit,
  jsonDepthLimit,
  parseCsv,
  parseDataPreview,
  parseJsonTree,
} from "../../apps/web/src/review/data-parse.js";
import {
  markdownPreviewDocument,
  safeMarkdownUrl,
} from "../../apps/web/src/review/markdown-document.js";
import {previewPresenter} from "../../apps/web/src/review/preview-kind.js";

const encoder = new TextEncoder();

function request(format: "csv" | "json" | "ndjson" | "tsv", text: string, complete = true) {
  const bytes = encoder.encode(text);
  return {bytes: bytes.slice().buffer, complete, format};
}

describe("Preview presenter classification", () => {
  test("uses only the declared media type essence", () => {
    expect(previewPresenter("TEXT/MARKDOWN; charset=utf-8")).toEqual({kind: "markdown"});
    expect(previewPresenter("application/geo+json")).toEqual({format: "json", kind: "data"});
    expect(previewPresenter("application/x-ndjson")).toEqual({format: "ndjson", kind: "data"});
    expect(previewPresenter("text/x-python")).toEqual({kind: "text"});
    expect(previewPresenter("audio/ogg")).toEqual({kind: "audio"});
    expect(previewPresenter("application/pdf")).toEqual({kind: "pdf"});
    expect(previewPresenter("application/octet-stream")).toEqual({kind: "unsupported"});
    expect(previewPresenter("application/zip")).toEqual({kind: "unsupported"});
  });
});

describe("Structured data parsing", () => {
  test("strict CSV keeps quoted delimiters, quotes, and line breaks inside one field", () => {
    expect(parseCsv('a,b\r\n"x, y","say ""hi""\nthere"\r\n', true).rows).toEqual([
      ["a", "b"],
      ["x, y", 'say "hi"\nthere'],
    ]);
  });

  test("CSV stops at the row bound and a cut file drops its partial record", () => {
    const rows = Array.from({length: dataRowLimit + 50}, (_, index) => `${index},v`);
    const bounded = parseCsv(`id,value\n${rows.join("\n")}\n`, true);
    expect(bounded.rows).toHaveLength(dataRowLimit + 1);
    expect(bounded.truncated).toBe(true);
    const cut = parseCsv("id,value\n1,a\n2,partial", false);
    expect(cut.rows).toEqual([["id", "value"], ["1", "a"]]);
  });

  test("malformed and pathological CSV is refused in linear time", () => {
    expect(parseDataPreview(request("csv", 'a,b\n"never closes,1\n')))
      .toEqual({kind: "failed", reason: "malformed"});
    expect(parseDataPreview(request("csv", 'a,b\nbare"quote,1\n')))
      .toEqual({kind: "failed", reason: "malformed"});
    const started = performance.now();
    const pathological = `name,value\n"${'""'.repeat(2_000_000)}x,1\n`;
    expect(parseDataPreview(request("csv", pathological)))
      .toEqual({kind: "failed", reason: "malformed"});
    expect(performance.now() - started).toBeLessThan(2_000);
  });

  test("JSON parses into a tagged tree and refuses malformed, deep, or cut input", () => {
    expect(parseJsonTree('{"a":[1,"two",true,null],"b":{}}')).toEqual({
      entries: [
        ["a", {items: [
          {kind: "number", value: 1},
          {kind: "string", value: "two"},
          {kind: "boolean", value: true},
          {kind: "null"},
        ], kind: "array"}],
        ["b", {entries: [], kind: "object"}],
      ],
      kind: "object",
    });
    expect(parseJsonTree('"\\u00e9\\n"')).toEqual({kind: "string", value: "é\n"});
    for (const malformed of ['{"a": }', "[1,]", '{"a":1} x', '"\\x"', "01", '{"a" 1}']) {
      expect(parseDataPreview(request("json", malformed)))
        .toEqual({kind: "failed", reason: "malformed"});
    }
    const deep = `${"[".repeat(jsonDepthLimit + 1)}${"]".repeat(jsonDepthLimit + 1)}`;
    expect(parseDataPreview(request("json", deep)))
      .toEqual({kind: "failed", reason: "malformed"});
    expect(parseDataPreview(request("json", "[1,2]", false)))
      .toEqual({kind: "failed", reason: "too-large"});
  });

  test("NDJSON skips blank lines and refuses any malformed record", () => {
    const parsed = parseDataPreview(request("ndjson", '{"a":1}\n\n[2]\r\n'));
    expect(parsed).toMatchObject({kind: "tree", root: {kind: "array"}, truncated: false});
    expect(parseDataPreview(request("ndjson", '{"a":1}\nnope\n')))
      .toEqual({kind: "failed", reason: "malformed"});
  });

  test("TSV splits records on tabs without quoting rules", () => {
    expect(parseDataPreview(request("tsv", 'name\tnote\nx\t"quoted"\n'))).toEqual({
      columns: ["name", "note"],
      kind: "table",
      rows: [["x", '"quoted"']],
      truncated: false,
    });
  });
});

describe("Markdown preview documents", () => {
  const base = "http://pvl_token.localhost:8787/docs/";

  test("keeps relative URLs inside the exact version and drops unsafe schemes", () => {
    expect(safeMarkdownUrl("guide.md", base, "link")).toBe("http://pvl_token.localhost:8787/docs/guide.md");
    expect(safeMarkdownUrl("../../../etc/passwd", base, "link"))
      .toBe("http://pvl_token.localhost:8787/etc/passwd");
    expect(safeMarkdownUrl("#usage", base, "link")).toBe("#usage");
    expect(safeMarkdownUrl("https://example.com/x", base, "link")).toBe("https://example.com/x");
    expect(safeMarkdownUrl("mailto:someone@example.com", base, "link")).toBe("mailto:someone@example.com");
    for (const unsafe of [
      "javascript:alert(1)",
      "JaVaScRiPt:alert(1)",
      "java\tscript:alert(1)",
      "data:text/html,<script>alert(1)</script>",
      "vbscript:msgbox",
      "file:///etc/passwd",
    ]) {
      expect(safeMarkdownUrl(unsafe, base, "link")).toBeNull();
    }
    expect(safeMarkdownUrl("data:image/png;base64,AAAA", base, "image")).toBeNull();
    expect(safeMarkdownUrl("mailto:someone@example.com", base, "image")).toBeNull();
  });

  test("escapes raw HTML and never emits file-controlled markup", () => {
    const document = markdownPreviewDocument([
      "<script>alert(1)</script>",
      "",
      "inline <img src=x onerror=alert(1)> tag and <script>a<b</script>",
      "",
      "[bad](javascript:alert(1)) ![bad](data:text/html,x)",
      "",
      '[ok](guide.md "Guide")',
    ].join("\n"), base);
    const body = document.slice(document.indexOf("<body>"));
    expect(body).not.toMatch(/<script/iu);
    expect(body).not.toMatch(/<img[^>]*onerror/iu);
    expect(body).not.toMatch(/href="javascript:/iu);
    expect(body).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(body).toContain("&lt;script&gt;a&lt;b&lt;/script&gt;");
    expect(body).toContain('<a href="http://pvl_token.localhost:8787/docs/guide.md" title="Guide">ok</a>');
    expect(document).toContain('<meta name="plannotator-theme" content="host">');
  });
});
