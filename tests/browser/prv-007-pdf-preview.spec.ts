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

const scriptedPdf = [
  "%PDF-1.4",
  "1 0 obj << /Type /Catalog /Pages 2 0 R /OpenAction 4 0 R >> endobj",
  "2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj",
  "3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] >> endobj",
  "4 0 obj << /S /JavaScript /JS (this.__pdfScript = true; app.alert('pdf script');) >> endobj",
  "trailer << /Root 1 0 R >>",
  "%%EOF",
].join("\n");

/*
 * The PDF preview hands the file to the browser's own PDF viewer, which the
 * minimal headless shell does not ship. This one test runs the full Chromium
 * build in headless mode so the viewer actually loads.
 */
test.use({channel: "chromium"});

test.describe("PDF preview in the browser's viewer", () => {
  test("PRV-007-B PRV-007-F: Review frames a PDF only from the exact version's content origin", async ({browser}) => {
    const fixture = await startBrowserFixture(browser);
    try {
      const published = await publishFixture(fixture, "PDF preview fixture", [
        {bytes: encoder.encode("<!doctype html><title>PDF</title><p>entry</p>"), mediaType: "text/html; charset=utf-8", path: "index.html"},
        {bytes: encoder.encode(scriptedPdf), mediaType: "application/pdf", path: "docs/report.pdf"},
        {bytes: encoder.encode("<html><script>parent.__fakePdf = true</script></html>"), mediaType: "application/pdf", path: "docs/not-a.pdf"},
      ]);
      await localLogin(fixture);
      const applicationOrigin = new URL(fixture.page.url()).origin;
      const contentResponse = fixture.page.waitForResponse((response) => {
        const url = new URL(response.url());
        return url.pathname === "/docs/report.pdf" && url.origin !== applicationOrigin;
      });
      await openPath(fixture, published, "docs/report.pdf");

      const frame = fixture.page.locator(
        'iframe.as-pdf-frame[title="PDF preview fixture — docs/report.pdf"]',
      );
      await expect(frame).toBeVisible();
      const source = await frame.getAttribute("src");
      expect(source).not.toBeNull();
      const frameUrl = new URL(source ?? "");
      expect(frameUrl.origin).not.toBe(applicationOrigin);
      expect(frameUrl.hostname.endsWith(".localhost")).toBe(true);
      expect(frameUrl.pathname).toBe("/docs/report.pdf");
      // The browser's PDF viewer needs plugins, which `sandbox` disables; the
      // separate content origin is the isolation boundary.
      expect(await frame.getAttribute("sandbox")).toBeNull();
      const delivered = await contentResponse;
      expect(delivered.status()).toBe(200);
      expect(delivered.headers()["content-type"]).toBe("application/pdf");
      expect(delivered.headers()["x-content-type-options"]).toBe("nosniff");
      const viewer = fixture.page.frames().find((candidate) => candidate.url() === frameUrl.href);
      expect(viewer).toBeDefined();
      // The frame holds the browser's PDF document on the content origin.
      await expect.poll(async () => viewer?.evaluate(() => ({
        contentType: document.contentType,
        origin: window.location.origin,
      }))).toEqual({contentType: "application/pdf", origin: frameUrl.origin});

      // The application cannot reach into the content-origin document, so the
      // PDF's own script cannot reach back into the application either.
      expect(await frame.evaluate((element) =>
        element instanceof HTMLIFrameElement ? element.contentDocument === null : false
      )).toBe(true);
      expect(await fixture.page.evaluate(() =>
        "__pdfScript" in window || "__fakePdf" in window
      )).toBe(false);

      const typedToApplication = await fetch(
        fileUrl(fixture, published, "media", "docs/report.pdf"),
        {
          headers: {
            Authorization: `Bearer ${fixture.installation.apiToken}`,
            "Sec-Fetch-Dest": "document",
            "Sec-Fetch-Mode": "navigate",
            "Sec-Fetch-Site": "same-origin",
          },
        },
      );
      expect(typedToApplication.status).toBe(415);
      const pdfDocumentNavigation = await fixture.page.goto(
        fileUrl(fixture, published, "media", "docs/report.pdf"),
      );
      expect(pdfDocumentNavigation?.headers()["content-type"]).not.toBe("application/pdf");
      expect(pdfDocumentNavigation?.ok()).toBe(false);
      const download = await fetch(fileUrl(fixture, published, "file", "docs/report.pdf"), {
        headers: {Authorization: `Bearer ${fixture.installation.apiToken}`},
      });
      expect(download.headers.get("content-type")).toBe("application/octet-stream");
      expect(download.headers.get("content-disposition")).toMatch(/^attachment/u);

      const framedRequests = requestsFor(fixture.page, "file", "docs/not-a.pdf");
      await openPath(fixture, published, "docs/not-a.pdf");
      await expect(fixture.page.getByRole("heading", {name: "PDF preview unavailable"}))
        .toBeVisible();
      await expect(fixture.page.locator("iframe.as-pdf-frame")).toHaveCount(0);
      expect(framedRequests.length).toBeGreaterThan(0);
      for (const request of framedRequests) {
        expect(request.frame()).toBe(fixture.page.mainFrame());
        expect(request.resourceType()).toBe("fetch");
      }
      expect(await fixture.page.evaluate(() => "__fakePdf" in window)).toBe(false);
    } finally {
      await stopBrowserFixture(fixture);
    }
  });
});
