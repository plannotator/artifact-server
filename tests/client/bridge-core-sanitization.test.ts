import {describe, expect, test} from "vitest";

import {
  renderBundleMessage,
  sanitizeBundleText,
} from "../../integrations/bridge-core/index.js";

/** U+202A-202E and U+2066-2069: embedding, override, and isolate controls. */
const bidirectionalControls = [
  "\u202A",
  "\u202B",
  "\u202C",
  "\u202D",
  "\u202E",
  "\u2066",
  "\u2067",
  "\u2068",
  "\u2069",
];

/** U+200B-200F, U+2060, U+FEFF: zero-width and invisible characters. */
const invisibleCharacters = [
  "\u200B",
  "\u200C",
  "\u200D",
  "\u200E",
  "\u200F",
  "\u2060",
  "\uFEFF",
];

describe("bundle text sanitization", () => {
  test("strips every bidirectional control while keeping the visible text", () => {
    for (const control of bidirectionalControls) {
      expect(sanitizeBundleText(`fix${control}the header`))
        .toBe("fixthe header");
    }
  });

  test("strips every zero-width and invisible character", () => {
    for (const invisible of invisibleCharacters) {
      expect(sanitizeBundleText(`pass${invisible}word`)).toBe("password");
    }
  });

  test("defuses a trojan-source style reordering attack in one pass", () => {
    const hostile =
      "access\u202E \u2066// safe\u2069 \u2066\u200Blevel = \"admin\"";
    const sanitized = sanitizeBundleText(hostile);
    expect(sanitized).toBe("access // safe level = \"admin\"");
    expect(sanitizeBundleText(sanitized)).toBe(sanitized);
  });

  test("leaves ordinary multilingual text, whitespace, and punctuation alone", () => {
    const benign = "Fix caf\u00E9 \u2014 \u00E9tat, \u65E5\u672C\u8A9E, \u05E2\u05D1\u05E8\u05D9\u05EA, emoji \u{1F3AF}\n\tindented";
    expect(sanitizeBundleText(benign)).toBe(benign);
  });

  test("the rendered bundle strips hostile controls from body, note, and quoted selection", () => {
    const message = renderBundleMessage({
      items: [{
        artifactName: "Report",
        body: "Line\u202E one.\n\u200BLine two.",
        path: "index.html",
        quotedSelection: "quoted\u2066 text\uFEFF",
        threadId: "cmt_hostile_unicode",
        versionNumber: 2,
      }],
      note: "\u200Furgent\u2069 note",
      senderDisplayName: "Ada",
    });
    for (
      const character of [...bidirectionalControls, ...invisibleCharacters]
    ) {
      expect(message.includes(character)).toBe(false);
    }
    expect(message).toContain("urgent note");
    expect(message).toContain("   Line one.");
    expect(message).toContain("   Line two.");
    expect(message).toContain("\"quoted text\"");
  });
});
