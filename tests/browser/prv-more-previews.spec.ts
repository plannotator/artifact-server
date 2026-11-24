import {AxeBuilder} from "@axe-core/playwright";
import {expect, test} from "@playwright/test";

import {
  localLogin,
  startBrowserFixture,
  stopBrowserFixture,
} from "./browser-fixture.js";
import {
  fileUrl,
  openPath,
  publishFixture,
  requestsFor,
} from "./preview-fixture.js";

const encoder = new TextEncoder();
const mebibyte = 1024 * 1024;
const onePixelPngBase64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Z7aEAAAAASUVORK5CYII=";

/** A two-second mono 16-bit PCM WAV with a quiet tone. */
function toneWav(seconds: number): Uint8Array {
  const sampleRate = 8_000;
  const samples = sampleRate * seconds;
  const dataSize = samples * 2;
  const wav = Buffer.alloc(44 + dataSize);
  wav.write("RIFF", 0, "ascii");
  wav.writeUInt32LE(36 + dataSize, 4);
  wav.write("WAVE", 8, "ascii");
  wav.write("fmt ", 12, "ascii");
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(sampleRate, 24);
  wav.writeUInt32LE(sampleRate * 2, 28);
  wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write("data", 36, "ascii");
  wav.writeUInt32LE(dataSize, 40);
  for (let sample = 0; sample < samples; sample += 1) {
    wav.writeInt16LE(Math.round(Math.sin(sample / 8) * 1_000), 44 + sample * 2);
  }
  return wav;
}

const markdownFixture = [
  "# Preview heading",
  "",
  "Some *emphasis* and a [relative link](guide.md) and a [section link](#usage).",
  "",
  "## Usage",
  "",
  "| Name | Value |",
  "| --- | --- |",
  "| alpha | 1 |",
  "| beta | 2 |",
  "",
  "```js",
  "const answer = 42;",
  "```",
  "",
  "![Relative dot](images/dot.png)",
  "",
].join("\n");

const hostileMarkdown = [
  "# Hostile document",
  "",
  "<script>window.parent.parent.__markdownScript = true</script>",
  "",
  '<img src="missing.png" onerror="window.parent.parent.__markdownHandler = true">',
  "",
  "[script link](javascript:window.parent.parent.__markdownJs=true)",
  "[document link](data:text/html,<script>alert(1)</script>)",
  "[spaced link](java\tscript:alert(1))",
  "![data image](data:text/html,<script>alert(1)</script>)",
  "",
  '<div id="markdown-injected">raw html block</div>',
  "",
  '<a href="javascript:alert(1)" id="markdown-anchor">raw anchor</a>',
  "",
].join("\n");

test.describe("More preview types", () => {
  test("PRV-006-B PRV-006-F: Review plays exact-version audio through ranged media delivery", async ({browser}) => {
    const fixture = await startBrowserFixture(browser);
    try {
      const published = await publishFixture(fixture, "Audio preview fixture", [
        {bytes: encoder.encode("<!doctype html><title>Audio</title><p>entry</p>"), mediaType: "text/html; charset=utf-8", path: "index.html"},
        {bytes: toneWav(2), mediaType: "audio/wav", path: "audio/tone.wav"},
        {bytes: encoder.encode("these bytes are not audio"), mediaType: "audio/wav", path: "audio/corrupt.wav"},
        {bytes: encoder.encode("opaque codec bytes"), mediaType: "audio/x-unknown-codec", path: "audio/unknown.bin"},
      ]);
      await localLogin(fixture);
      const toneRequests = requestsFor(fixture.page, "media", "audio/tone.wav");
      const rangedStatuses: number[] = [];
      fixture.page.on("response", (response) => {
        const url = new URL(response.url());
        if (url.pathname.endsWith("/media") && url.searchParams.get("path") === "audio/tone.wav") {
          rangedStatuses.push(response.status());
        }
      });
      await openPath(fixture, published, "audio/tone.wav");

      const audio = fixture.page.locator(
        'audio[aria-label="Audio preview fixture — audio/tone.wav"]',
      );
      await expect(audio).toBeVisible();
      await expect(audio).toHaveAttribute("controls", "");
      await expect(audio).toHaveAttribute("preload", "metadata");
      await expect.poll(() => audio.evaluate((node) =>
        node instanceof HTMLAudioElement ? node.readyState : 0
      )).toBeGreaterThanOrEqual(1);
      expect(await audio.evaluate((node) => node instanceof HTMLAudioElement
        ? {autoplay: node.autoplay, paused: node.paused}
        : {autoplay: true, paused: false}))
        .toEqual({autoplay: false, paused: true});
      expect(await audio.evaluate((node) => node instanceof HTMLAudioElement
        ? Math.round(node.duration)
        : 0)).toBe(2);

      const played = await audio.evaluate(async (node) => {
        if (!(node instanceof HTMLAudioElement)) return false;
        node.muted = true;
        await node.play();
        return !node.paused;
      });
      expect(played).toBe(true);
      await audio.evaluate((node) => {
        if (node instanceof HTMLAudioElement) node.pause();
      });
      await expect.poll(() => audio.evaluate((node) =>
        node instanceof HTMLAudioElement && node.paused
      )).toBe(true);
      const seeked = await audio.evaluate((node) => new Promise<number>((resolve) => {
        if (!(node instanceof HTMLAudioElement)) {
          resolve(-1);
          return;
        }
        node.addEventListener("seeked", () => resolve(node.currentTime), {once: true});
        node.currentTime = 1.5;
      }));
      expect(seeked).toBeCloseTo(1.5, 1);

      const rangeHeaders = await Promise.all(
        toneRequests.map(async (request) => (await request.allHeaders())["range"] ?? null),
      );
      expect(rangeHeaders.some((value) => value?.startsWith("bytes=") === true)).toBe(true);
      expect(rangedStatuses).toContain(206);
      const destinations = await Promise.all(
        toneRequests.map(async (request) => (await request.allHeaders())["sec-fetch-dest"]),
      );
      expect(new Set(destinations)).toEqual(new Set(["audio"]));

      await openPath(fixture, published, "audio/corrupt.wav");
      await expect(fixture.page.getByRole("heading", {name: "Audio preview unavailable"}))
        .toBeVisible();
      const fallback = fixture.page.locator(".as-preview-state--terminal");
      await expect(fallback.getByText("audio/corrupt.wav", {exact: true})).toBeVisible();
      await expect(fallback.getByText("audio/wav", {exact: true})).toBeVisible();
      await expect(fixture.page.getByRole("link", {name: "Download file"})).toBeVisible();

      await openPath(fixture, published, "audio/unknown.bin");
      await expect(fixture.page.getByRole("heading", {name: "Audio preview unavailable"}))
        .toBeVisible();
      await expect(fixture.page.getByText("Loading preview", {exact: true})).toHaveCount(0);

      const navigation = await fixture.page.goto(
        fileUrl(fixture, published, "media", "audio/tone.wav"),
      );
      expect(navigation?.status()).toBe(403);
      expect(navigation?.headers()["content-type"]).toMatch(/^application\/json/u);
      expect(await navigation?.text()).toContain("MEDIA_PREVIEW_CONTEXT_REQUIRED");
      await expect(fixture.page.locator("audio")).toHaveCount(0);
    } finally {
      await stopBrowserFixture(fixture);
    }
  });

  test("PRV-008-B PRV-008-F: Markdown renders sanitized inside the review sandbox with a raw-source toggle", async ({browser}) => {
    const fixture = await startBrowserFixture(browser);
    try {
      const published = await publishFixture(fixture, "Markdown preview fixture", [
        {bytes: encoder.encode(markdownFixture), mediaType: "text/markdown; charset=utf-8", path: "docs/readme.md"},
        {bytes: encoder.encode("# Guide\n"), mediaType: "text/markdown; charset=utf-8", path: "docs/guide.md"},
        {bytes: Buffer.from(onePixelPngBase64, "base64"), mediaType: "image/png", path: "docs/images/dot.png"},
        {bytes: encoder.encode(hostileMarkdown), mediaType: "text/markdown", path: "docs/hostile.md"},
      ]);
      await localLogin(fixture);
      await openPath(fixture, published, "docs/readme.md");

      const reviewFrame = fixture.page.frameLocator(".as-artifact-frame");
      const sandbox = reviewFrame.locator("iframe");
      await expect(sandbox).toHaveAttribute("sandbox", "allow-scripts");
      const rendered = reviewFrame.frameLocator("iframe");
      await expect(rendered.getByRole("heading", {level: 1, name: "Preview heading"}))
        .toBeVisible();
      await expect(rendered.getByRole("heading", {level: 2, name: "Usage"})).toBeVisible();
      await expect(rendered.locator("table td").filter({hasText: "beta"})).toBeVisible();
      await expect(rendered.locator("pre code")).toHaveText("const answer = 42;");
      const image = rendered.getByRole("img", {name: "Relative dot"});
      await expect.poll(() => image.evaluate((node) =>
        node instanceof HTMLImageElement ? node.naturalWidth : 0
      )).toBe(1);
      const imageSource = new URL(await image.getAttribute("src") ?? "");
      const applicationOrigin = new URL(fixture.page.url()).origin;
      expect(imageSource.origin).not.toBe(applicationOrigin);
      expect(imageSource.pathname).toBe("/docs/images/dot.png");
      const link = rendered.getByRole("link", {name: "relative link"});
      const linkTarget = new URL(await link.getAttribute("href") ?? "");
      expect(linkTarget.origin).toBe(imageSource.origin);
      expect(linkTarget.pathname).toBe("/docs/guide.md");
      await expect(rendered.getByRole("link", {name: "section link"}))
        .toHaveAttribute("href", "#usage");

      await fixture.page.getByRole("button", {name: "Source"}).click();
      await expect(fixture.page.getByRole("button", {name: "Source"}))
        .toHaveAttribute("aria-pressed", "true");
      const source = fixture.page.locator(".as-text-preview__code code");
      await expect(source).toContainText("# Preview heading");
      await expect(source).toContainText("| alpha | 1 |");
      await expect(fixture.page.locator(".as-artifact-frame")).toHaveCount(0);
      await fixture.page.getByRole("button", {name: "Rendered"}).click();
      await expect(reviewFrame.frameLocator("iframe")
        .getByRole("heading", {level: 1, name: "Preview heading"})).toBeVisible();
      // Markdown shares the HTML review sandbox, so it can be annotated too.
      await expect(fixture.page.getByRole("button", {name: /^Annotate mode:/u}))
        .toHaveAttribute("aria-pressed", "true");

      await openPath(fixture, published, "docs/hostile.md");
      const hostile = fixture.page.frameLocator(".as-artifact-frame").frameLocator("iframe");
      await expect(hostile.getByRole("heading", {level: 1, name: "Hostile document"}))
        .toBeVisible();
      await expect(hostile.getByText(
        "<script>window.parent.parent.__markdownScript = true</script>",
      )).toBeVisible();
      await expect(hostile.getByText('<div id="markdown-injected">raw html block</div>'))
        .toBeVisible();
      await expect(hostile.locator("#markdown-injected")).toHaveCount(0);
      await expect(hostile.locator("#markdown-anchor")).toHaveCount(0);
      await expect(hostile.locator("[onerror]")).toHaveCount(0);
      await expect(hostile.locator('a[href^="javascript:" i]')).toHaveCount(0);
      await expect(hostile.locator('a[href^="data:" i]')).toHaveCount(0);
      await expect(hostile.locator('img[src^="data:" i]')).toHaveCount(0);
      await expect(hostile.getByText("script link")).toBeVisible();
      expect(await hostile.locator("script").evaluateAll((scripts) =>
        scripts.filter((script) => (script.textContent ?? "").includes("__markdown")).length
      )).toBe(0);
      expect(await fixture.page.evaluate(() => [
        "__markdownScript",
        "__markdownHandler",
        "__markdownJs",
      ].filter((name) => name in window))).toEqual([]);
      await expect(fixture.page.locator("#markdown-injected")).toHaveCount(0);
      await expect(fixture.page.getByText("raw html block")).toHaveCount(0);
    } finally {
      await stopBrowserFixture(fixture);
    }
  });

  test("PRV-009-B PRV-009-F: text and code render as bounded text nodes with line numbers", async ({browser}) => {
    const fixture = await startBrowserFixture(browser);
    try {
      const bigLine = `${"0123456789abcdef".repeat(4)}\n`;
      const big = encoder.encode(bigLine.repeat(Math.ceil((3 * mebibyte) / bigLine.length)));
      const published = await publishFixture(fixture, "Text preview fixture", [
        {bytes: encoder.encode("first\r\nsecond\r\nthird\r\n"), mediaType: "text/plain; charset=utf-8", path: "notes/crlf.txt"},
        {bytes: new Uint8Array([0xef, 0xbb, 0xbf, ...encoder.encode("byte order mark\n")]), mediaType: "text/plain", path: "notes/bom.txt"},
        {bytes: encoder.encode("export const answer = 42;\nconsole.log(answer);\n"), mediaType: "text/javascript; charset=utf-8", path: "src/app.js"},
        {bytes: big, mediaType: "text/plain", path: "logs/big.log"},
        {bytes: new Uint8Array([0x61, 0xff, 0x62, 0x0a]), mediaType: "text/plain", path: "notes/invalid.txt"},
        {bytes: encoder.encode('<img src="x" onerror="window.__textHandler = true"><b id="text-injected">bold</b>\n'), mediaType: "text/plain", path: "notes/markup.txt"},
      ]);
      await localLogin(fixture);
      const code = fixture.page.locator(".as-text-preview__code code");
      const gutter = fixture.page.locator(".as-text-preview__gutter");

      await openPath(fixture, published, "notes/crlf.txt");
      await expect(code).toHaveText("first\nsecond\nthird");
      await expect(gutter).toHaveText("1\n2\n3");
      await expect(fixture.page.getByRole("region", {name: "Contents of notes/crlf.txt"}))
        .toBeVisible();

      await openPath(fixture, published, "notes/bom.txt");
      await expect(code).toHaveText("byte order mark");

      await openPath(fixture, published, "src/app.js");
      await expect(code).toHaveText("export const answer = 42;\nconsole.log(answer);");
      await expect(gutter).toHaveText("1\n2");
      const accessibility = await new AxeBuilder({page: fixture.page})
        .withTags(["wcag2a", "wcag2aa"])
        .analyze();
      expect(accessibility.violations).toEqual([]);

      const bigRequests = requestsFor(fixture.page, "file", "logs/big.log");
      await openPath(fixture, published, "logs/big.log");
      await expect(fixture.page.getByRole("note")).toContainText("Showing the first 1.0 MB of 3.1 MB");
      await expect(fixture.page.getByRole("note").getByRole("link", {name: "Download file"}))
        .toBeVisible();
      const shownLength = await code.evaluate((node) => node.textContent?.length ?? 0);
      expect(shownLength).toBeLessThanOrEqual(mebibyte);
      expect(shownLength).toBeGreaterThan(mebibyte - bigLine.length * 2);
      expect(bigRequests.length).toBeGreaterThan(0);
      const bigRanges = await Promise.all(
        bigRequests.map(async (request) => (await request.allHeaders())["range"]),
      );
      expect(new Set(bigRanges)).toEqual(new Set([`bytes=0-${mebibyte - 1}`]));

      await openPath(fixture, published, "notes/invalid.txt");
      await expect(code).toHaveText("a�b");

      await openPath(fixture, published, "notes/markup.txt");
      await expect(code).toHaveText(
        '<img src="x" onerror="window.__textHandler = true"><b id="text-injected">bold</b>',
      );
      expect(await code.evaluate((node) =>
        node.childNodes.length === 1 && node.firstChild?.nodeType === Node.TEXT_NODE
      )).toBe(true);
      await expect(fixture.page.locator("#text-injected")).toHaveCount(0);
      expect(await fixture.page.evaluate(() => "__textHandler" in window)).toBe(false);
    } finally {
      await stopBrowserFixture(fixture);
    }
  });

  test("PRV-010-B PRV-010-F: data files render as bounded tables and trees parsed off the main thread", async ({browser}) => {
    const fixture = await startBrowserFixture(browser);
    try {
      const csvRows = Array.from({length: 6_000}, (_, index) =>
        `${index + 1},"Name ${index + 1}, quoted","line one\nline two"`
      );
      const nested = {
        project: {name: "artifact", tags: ["a", "b"], version: 3},
        records: Array.from({length: 3}, (_, index) => ({id: index, ok: index % 2 === 0})),
        summary: null,
      };
      const overBound = `[${"0,".repeat(Math.ceil((5 * mebibyte) / 2))}0]`;
      const pathologicalCsv = `name,value\n"${'""'.repeat(1_000_000)}x,1\n`;
      const published = await publishFixture(fixture, "Data preview fixture", [
        {bytes: encoder.encode(`id,name,notes\n${csvRows.join("\n")}\n`), mediaType: "text/csv; charset=utf-8", path: "data/rows.csv"},
        {bytes: encoder.encode("city\tcount\nTaipei\t3\nTainan\t5\n"), mediaType: "text/tab-separated-values", path: "data/cities.tsv"},
        {bytes: encoder.encode(JSON.stringify(nested)), mediaType: "application/json", path: "data/nested.json"},
        {bytes: encoder.encode('{"event":"start"}\n{"event":"tick","n":1}\n\n{"event":"stop"}\n'), mediaType: "application/x-ndjson", path: "data/events.ndjson"},
        {bytes: encoder.encode('a,b\n"unclosed,1\n'), mediaType: "text/csv", path: "data/malformed.csv"},
        {bytes: encoder.encode(pathologicalCsv), mediaType: "text/csv", path: "data/pathological.csv"},
        {bytes: encoder.encode('{"a": }'), mediaType: "application/json", path: "data/malformed.json"},
        {bytes: encoder.encode('{"ok":true}\nnot json\n'), mediaType: "application/x-ndjson", path: "data/malformed.ndjson"},
        {bytes: encoder.encode(overBound), mediaType: "application/json", path: "data/over-bound.json"},
      ]);
      await localLogin(fixture);
      const workers: string[] = [];
      fixture.page.on("worker", (worker) => workers.push(worker.url()));

      await openPath(fixture, published, "data/rows.csv");
      const table = fixture.page.getByRole("table");
      await expect(table).toHaveAttribute("aria-rowcount", "5001");
      await expect(fixture.page.getByRole("note")).toContainText("Showing the first 5,000 rows.");
      await expect(table.getByRole("columnheader", {name: "notes"})).toBeVisible();
      await expect(table.getByRole("cell", {exact: true, name: "Name 1, quoted"})).toBeVisible();
      await expect(table.locator("tbody td").filter({hasText: "line one"}).first())
        .toHaveAttribute("title", "line one\nline two");
      const renderedRows = await table.locator("tbody tr:not(.as-data-table__spacer)").count();
      expect(renderedRows).toBeGreaterThan(10);
      expect(renderedRows).toBeLessThan(200);
      await fixture.page.getByRole("region", {name: "Rows of data/rows.csv"})
        .evaluate((node) => {
          node.scrollTop = node.scrollHeight;
        });
      await expect(table.getByRole("rowheader", {exact: true, name: "5000"})).toBeVisible();
      await expect(table.getByRole("cell", {exact: true, name: "Name 5000, quoted"})).toBeVisible();
      expect(workers.some((url) => url.includes("data-preview-worker"))).toBe(true);
      const accessibility = await new AxeBuilder({page: fixture.page})
        .withTags(["wcag2a", "wcag2aa"])
        .analyze();
      expect(accessibility.violations).toEqual([]);

      await openPath(fixture, published, "data/cities.tsv");
      await expect(fixture.page.getByRole("table").getByRole("cell", {name: "Tainan"}))
        .toBeVisible();
      await expect(fixture.page.getByRole("table")).toHaveAttribute("aria-rowcount", "3");

      await openPath(fixture, published, "data/nested.json");
      const tree = fixture.page.getByRole("region", {name: "Structure of data/nested.json"});
      await expect(tree.getByText("3 keys").first()).toBeVisible();
      await expect(tree.getByText('"artifact"')).toBeVisible();
      const records = tree.locator("summary").filter({hasText: "records"});
      await expect(records).toContainText("3 items");
      await records.click();
      await expect(tree.locator("summary").filter({hasText: /^0/u})).toHaveCount(0);
      await records.click();
      await expect(tree.locator("summary").filter({hasText: "2 keys"}).first()).toBeVisible();

      await openPath(fixture, published, "data/events.ndjson");
      const events = fixture.page.getByRole("region", {name: "Structure of data/events.ndjson"});
      await expect(events.locator("summary").first()).toContainText("3 items");
      await expect(events.getByText('"stop"')).toBeVisible();

      const expectRefusal = async (path: string, message: string): Promise<void> => {
        await openPath(fixture, published, path);
        await expect(fixture.page.getByRole("heading", {name: "Data preview unavailable"}))
          .toBeVisible();
        await expect(fixture.page.getByText(message)).toBeVisible();
        await expect(fixture.page.locator(".as-preview-state--terminal").getByText(path, {exact: true}))
          .toBeVisible();
        // The document stays responsive: parsing never ran on its main thread.
        expect(await fixture.page.evaluate(() => document.readyState)).toBe("complete");
      };
      await expectRefusal("data/malformed.csv", "This file is not valid CSV");
      await expectRefusal("data/pathological.csv", "This file is not valid CSV");
      await expectRefusal("data/malformed.json", "This file is not valid JSON");
      await expectRefusal("data/malformed.ndjson", "This file is not valid NDJSON");

      const overBoundRequests = requestsFor(fixture.page, "file", "data/over-bound.json");
      await openPath(fixture, published, "data/over-bound.json");
      await expect(fixture.page.getByRole("heading", {name: "Data preview unavailable"}))
        .toBeVisible();
      await expect(fixture.page.getByText("larger than the 5.2 MB limit")).toBeVisible();
      await expect(fixture.page.getByRole("link", {name: "Download file"})).toBeVisible();
      expect(overBoundRequests).toEqual([]);
      await expect(fixture.page.getByText("Loading preview", {exact: true})).toHaveCount(0);
    } finally {
      await stopBrowserFixture(fixture);
    }
  });
});
