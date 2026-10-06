import {expect, test, type FrameLocator} from "@playwright/test";

import {publishNew} from "../support/publishing.js";
import {
  localLogin,
  startBrowserFixture,
  stopBrowserFixture,
} from "./browser-fixture.js";
import {listThreadsOverApi} from "./comment-api.js";

const anchorArtifact = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8"><title>Fragment links</title>
    <style>
      body { margin: 0; }
      nav { position: fixed; top: 0; background: white; z-index: 1; }
      section { height: 1200px; padding-top: 80px; }
    </style>
  </head>
  <body>
    <nav>
      <a id="nested-link" href="#section"><span>Nested section link</span></a>
      <a id="encoded-link" href="#caf%C3%A9%20%5Bsection%5D">Encoded section</a>
      <a id="named-link" href="#legacy">Named section</a>
      <a id="keyboard-link" href="#keyboard">Keyboard section</a>
      <a id="missing-link" href="#missing">Missing section</a>
      <a id="malformed-link" href="#bad%escape">Malformed fragment</a>
      <a id="empty-link" href="#">Document start</a>
      <a id="top-link" href="#top">Top</a>
      <a id="owned-link" href="#section">Authored action</a>
    </nav>
    <section><h1>Fragment links remain in the preview</h1></section>
    <section id="section"><h2>Nested target</h2></section>
    <section id="café [section]"><h2>Encoded target</h2></section>
    <section><a name="legacy">Legacy target</a></section>
    <section id="keyboard"><h2>Keyboard target</h2></section>
    <script>
      document.addEventListener("click", function (event) {
        if (event.target.id === "owned-link") {
          event.preventDefault();
          event.target.textContent = "Authored action handled";
        }
      });
      var dynamicLink = document.createElement("a");
      dynamicLink.id = "dynamic-link";
      dynamicLink.href = "#section";
      dynamicLink.textContent = "Dynamic section link";
      document.querySelector("nav").append(dynamicLink);
    </script>
  </body>
</html>`;

test.describe("Review fragment links", () => {
  test("CMT-022-B CMT-022-F: fragment links scroll within the sandbox and tolerate invalid targets without navigation", async ({browser}) => {
    const fixture = await startBrowserFixture(browser);
    try {
      const published = await publishNew(fixture.server, fixture.installation, {
        accessSetting: "account_required",
        content: anchorArtifact,
        idempotencyKey: "review-fragment-links",
        mediaType: "text/html; charset=utf-8",
        name: "Fragment links",
        path: "index.html",
      });
      await localLogin(fixture);
      await fixture.page.goto(
        `${fixture.server.baseUrl}/review?project=prj_default&artifact=${published.body.artifact.id}&version=${published.body.version.id}`,
      );
      const review = fixture.page.frameLocator(".as-artifact-frame");
      const preview = review.frameLocator("iframe");
      await expect(preview.locator("h1")).toHaveText("Fragment links remain in the preview");
      await expect(review.locator("iframe")).toHaveAttribute("sandbox", "allow-scripts");
      const contentBase = await preview.locator("base").getAttribute("href");
      expect(contentBase).toMatch(/^http:\/\/review-[a-f0-9]+\.localhost:\d+\/$/u);
      await preview.locator("#nested-link").focus();
      await fixture.page.keyboard.press("Escape");
      await expect(fixture.page.getByRole("button", {name: /^Interact mode:/u}))
        .toHaveAttribute("aria-pressed", "false");
      const reviewUrl = fixture.page.url();
      const previewUrl = await preview.locator("body").evaluate(() => window.location.href);
      expect(previewUrl).toBe("about:srcdoc");

      const navigations: string[] = [];
      const documentRequests: string[] = [];
      const browserErrors: string[] = [];
      fixture.page.on("framenavigated", (frame) => navigations.push(frame.url()));
      fixture.page.on("request", (request) => {
        if (request.isNavigationRequest()) documentRequests.push(request.url());
      });
      fixture.page.on("pageerror", (error) => browserErrors.push(error.message));

      await preview.locator("#nested-link span").click();
      await expectTargetAtTop(preview, "#section");
      await preview.locator("#encoded-link").click();
      await expectTargetAtTop(preview, '[id="café [section]"]');
      await preview.locator("#named-link").click();
      await expectTargetAtTop(preview, 'a[name="legacy"]');
      await preview.locator("#keyboard-link").focus();
      await fixture.page.keyboard.press("Enter");
      await expectTargetAtTop(preview, "#keyboard");

      const beforeMissing = await preview.locator("body").evaluate(() => window.scrollY);
      await preview.locator("#missing-link").click();
      expect(await preview.locator("body").evaluate(() => window.scrollY)).toBe(beforeMissing);
      await preview.locator("#malformed-link").click();
      expect(await preview.locator("body").evaluate(() => window.scrollY)).toBe(beforeMissing);
      await preview.locator("#empty-link").click();
      await expect.poll(() => preview.locator("body").evaluate(() => window.scrollY)).toBe(0);
      await preview.locator("#nested-link").click();
      await expectTargetAtTop(preview, "#section");
      await preview.locator("#top-link").click();
      await expect.poll(() => preview.locator("body").evaluate(() => window.scrollY)).toBe(0);
      await preview.locator("#owned-link").click();
      await expect(preview.locator("#owned-link")).toHaveText("Authored action handled");
      expect(await preview.locator("body").evaluate(() => window.scrollY)).toBe(0);
      await preview.locator("#dynamic-link").click();
      await expectTargetAtTop(preview, "#section");

      await expect(preview.locator("h1")).toHaveText("Fragment links remain in the preview");
      expect(navigations).toEqual([]);
      expect(documentRequests).toEqual([]);
      expect(browserErrors).toEqual([]);
      expect(fixture.page.url()).toBe(reviewUrl);
      expect(await preview.locator("body").evaluate(() => window.location.href)).toBe(previewUrl);
    } finally {
      await stopBrowserFixture(fixture);
    }
  });

  test("CMT-022-F CMT-014-B: fragment links remain selectable for comments in annotation mode", async ({browser}) => {
    const fixture = await startBrowserFixture(browser);
    try {
      const published = await publishNew(fixture.server, fixture.installation, {
        accessSetting: "account_required",
        content: anchorArtifact,
        idempotencyKey: "review-fragment-annotation",
        name: "Fragment annotation",
      });
      await localLogin(fixture);
      await fixture.page.goto(
        `${fixture.server.baseUrl}/review?project=prj_default&artifact=${published.body.artifact.id}&version=${published.body.version.id}`,
      );
      const review = fixture.page.frameLocator(".as-artifact-frame");
      const preview = review.frameLocator("iframe");
      await expect(review.locator("iframe")).toHaveAttribute("sandbox", "allow-scripts");
      await expect(fixture.page.getByRole("button", {name: /^Annotate mode:/u}))
        .toHaveAttribute("aria-pressed", "true");
      await preview.locator("#nested-link span").click();
      const composer = review.getByPlaceholder("Add a comment...");
      await expect(composer).toBeVisible();
      expect(await preview.locator("body").evaluate(() => window.scrollY)).toBe(0);
      await composer.fill("Clarify the section link.");
      await review.getByRole("button", {name: "Save"}).click();
      await expect(fixture.page.getByRole("article").filter({hasText: "Clarify the section link."}))
        .toBeVisible();
      const threads = await listThreadsOverApi(fixture, published.body.artifact.id);
      expect(threads).toHaveLength(1);
      expect(threads[0]?.body).toBe("Clarify the section link.");
      expect(threads[0]?.versionId).toBe(published.body.version.id);
      expect(threads[0]?.path).toBe("index.html");
    } finally {
      await stopBrowserFixture(fixture);
    }
  });
});

async function expectTargetAtTop(preview: FrameLocator, selector: string): Promise<void> {
  await expect.poll(() => preview.locator(selector).evaluate((element) =>
    Math.abs(element.getBoundingClientRect().top)
  )).toBeLessThan(2);
}
