import { describe, expect, it } from "vitest";
import { markdownHeadingId } from "../../apps/web/src/review/markdown-headings.js";

describe("Markdown heading navigation", () => {
  it("keeps duplicate and explicitly suffixed headings individually addressable", () => {
    const usedIds = new Set<string>();
    const ids = ["Foo", "Foo", "Foo-1", "Foo", "Foo-1"].map((text) => markdownHeadingId(text, usedIds));
    expect(ids).toEqual(["foo", "foo-1", "foo-1-1", "foo-2", "foo-1-2"]);
  });

  it("preserves Unicode heading targets and allocates a nonempty target for symbols", () => {
    const usedIds = new Set<string>();
    expect(markdownHeadingId("Résumé **table**", usedIds)).toBe("résumé-table");
    expect(markdownHeadingId("中文 标题", usedIds)).toBe("中文-标题");
    expect(markdownHeadingId("***", usedIds)).toBe("section");
    expect(markdownHeadingId("Section", usedIds)).toBe("section-1");
  });
});
