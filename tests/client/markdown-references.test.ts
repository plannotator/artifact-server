import { describe, expect, it } from "vitest";
import { resolveMarkdownReference, type MarkdownRenderOptions } from "../../apps/web/src/review/markdown-references.js";

const options: MarkdownRenderOptions = {
  baseHref: "https://preview.example.test/lease/exact-version/",
  entryPath: "docs/readme.md",
  manifestPaths: ["docs/readme.md", "docs/next.md", "assets/chart.png", "assets/space name.png"],
  isLight: true,
};

describe("MDV-003 exact-version Markdown resources", () => {
  it("resolves sibling and parent resources only when present in the immutable manifest", () => {
    expect(resolveMarkdownReference("../assets/chart.png", options, true))
      .toBe("https://preview.example.test/lease/exact-version/assets/chart.png");
    expect(resolveMarkdownReference("next.md#details", options, false))
      .toBe("https://preview.example.test/lease/exact-version/docs/next.md#details");
    expect(resolveMarkdownReference("../assets/space%20name.png", options, true))
      .toBe("https://preview.example.test/lease/exact-version/assets/space%20name.png");
    expect(resolveMarkdownReference("../assets/space name.png", options, true))
      .toBe("https://preview.example.test/lease/exact-version/assets/space%20name.png");
    expect(resolveMarkdownReference("missing.png", options, true)).toBeNull();
  });

  it("rejects traversal, absolute paths, network-path URLs and unsafe schemes", () => {
    for (const reference of ["../../outside.png", "%2e%2e/%2e%2e/outside.png", "/assets/chart.png", "//evil.test/image.png", "\\\\evil.test/image.png", "javascript:alert(1)", "data:image/svg+xml,evil", "java\nscript:evil"]) {
      expect(resolveMarkdownReference(reference, options, true)).toBeNull();
      expect(resolveMarkdownReference(reference, options, false)).toBeNull();
    }
  });

  it("permits ordinary external links and internal anchors while keeping images bundled", () => {
    expect(resolveMarkdownReference("https://example.test/help", options, false)).toBe("https://example.test/help");
    expect(resolveMarkdownReference("mailto:review@example.test", options, false)).toBe("mailto:review@example.test");
    expect(resolveMarkdownReference("#heading", options, false)).toBe("#heading");
    expect(resolveMarkdownReference("https://example.test/tracker.png", options, true)).toBeNull();
    expect(resolveMarkdownReference("#heading", options, true)).toBeNull();
  });
});
