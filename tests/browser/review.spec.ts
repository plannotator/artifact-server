import {AxeBuilder} from "@axe-core/playwright";
import {expect, test} from "@playwright/test";

import {publishNew} from "../support/publishing.js";
import {
  browserStorage,
  localLogin,
  startBrowserFixture,
  stopBrowserFixture,
} from "./browser-fixture.js";
import {createThreadOverApi, listThreadsOverApi} from "./comment-api.js";

/**
 * A self-contained artifact that also probes its own containment: it tries the
 * comment API of the application origin, the embedding document, and the
 * cookie jar, and writes what happened into the page for the test to read.
 */
const fixtureHtml = `<!doctype html>
<html lang="en">
  <head><meta charset="utf-8"><title>Review fixture</title></head>
  <body>
    <h1 id="review-heading">Review fixture</h1>
    <p id="review-target">The axis label on this chart is wrong.</p>
    <p id="probe-fetch">fetch:pending</p>
    <p id="probe-parent">parent:pending</p>
    <p id="probe-cookie">cookie:pending</p>
    <script>
      (function () {
        var report = function (id, value) {
          document.getElementById(id).textContent = value;
        };
        try {
          var reached = window.parent.document.title;
          report('probe-parent', 'parent:reached:' + reached);
        } catch (error) {
          report('probe-parent', 'parent:blocked');
        }
        try {
          report('probe-cookie', 'cookie:readable:[' + document.cookie + ']');
        } catch (error) {
          report('probe-cookie', 'cookie:blocked');
        }
        try {
          fetch('/api/v1/session', {credentials: 'include'}).then(
            function (response) { report('probe-fetch', 'fetch:reached:' + response.status); },
            function () { report('probe-fetch', 'fetch:blocked'); }
          );
        } catch (error) {
          report('probe-fetch', 'fetch:blocked');
        }
      })();
    </script>
  </body>
</html>`;

test.describe("Artifact review viewer", () => {
  test("CMT-014-B CMT-014-F CMT-015-B CMT-015-F: the artifact-first viewer stays contained and reveals context on demand", async ({browser}) => {
    const fixture = await startBrowserFixture(browser);
    try {
      const artifact = await publishNew(fixture.server, fixture.installation, {
        accessSetting: "account_required",
        content: fixtureHtml,
        idempotencyKey: "review-viewer-fixture",
        mediaType: "text/html; charset=utf-8",
        name: "Review fixture",
        path: "index.html",
      });
      const artifactId = artifact.body.artifact.id;
      const versionId = artifact.body.version.id;
      const reviewUrl =
        `${fixture.server.baseUrl}/projects/prj_default/artifacts/${artifactId}/versions/${versionId}/review`;

      await localLogin(fixture);

      const frameResponse = await fixture.page.request.get(
        `${fixture.server.baseUrl}/review-frame`,
      );
      expect(frameResponse.status()).toBe(200);
      const framePolicy = frameResponse.headers()["content-security-policy"] ?? "";
      expect(framePolicy).toContain(
        "connect-src http://*.localhost:* https://*.localhost",
      );
      expect(framePolicy).not.toContain("connect-src 'self'");
      expect(framePolicy).toContain("frame-ancestors 'self'");

      await fixture.page.goto(reviewUrl);
      await expect(
        fixture.page.getByRole("heading", {name: "Review fixture"}),
      ).toBeVisible();
      await expect(
        fixture.page.getByRole("navigation", {name: "Primary navigation"}),
      ).toHaveCount(0);
      await expect(fixture.page.getByLabel("Selected project")).toHaveCount(0);
      await expect(
        fixture.page.getByRole("complementary", {
          name: "Comment threads on this version",
        }),
      ).toHaveCount(0);

      const frameElement = fixture.page.locator(
        "iframe[title$=\"annotated page\"]",
      );
      const fullViewerBox = await frameElement.boundingBox();
      expect(fullViewerBox).not.toBeNull();
      if (fullViewerBox !== null) {
        expect(fullViewerBox.y).toBeLessThanOrEqual(45);
        expect(fullViewerBox.width).toBeGreaterThan(1_000);
      }
      const accessibility = await new AxeBuilder({page: fixture.page})
        .withTags(["wcag2a", "wcag2aa"])
        .analyze();
      expect(accessibility.violations).toEqual([]);

      await fixture.page.getByRole("button", {
        name: "Browse artifacts and versions",
      }).click();
      await expect(
        fixture.page.getByRole("complementary", {
          name: "Browse artifacts and versions",
        }),
      ).toBeVisible();
      await expect(
        fixture.page.getByRole("link", {name: /Review fixture/u}),
      ).toHaveAttribute("aria-current", "page");
      await fixture.page.getByRole("button", {name: "Close artifact browser"}).click();

      await fixture.page.setViewportSize({height: 844, width: 390});
      const narrowViewerBox = await frameElement.boundingBox();
      await fixture.page.getByRole("button", {
        name: "Browse artifacts and versions",
      }).click();
      const overlaidViewerBox = await frameElement.boundingBox();
      expect(narrowViewerBox).not.toBeNull();
      expect(overlaidViewerBox).not.toBeNull();
      if (narrowViewerBox !== null && overlaidViewerBox !== null) {
        expect(Math.abs(narrowViewerBox.width - overlaidViewerBox.width)).toBeLessThan(2);
      }
      await fixture.page.getByRole("button", {name: "Close artifact browser"}).click();
      await fixture.page.setViewportSize({height: 720, width: 1280});

      await fixture.page.getByRole("button", {name: "Enter focus mode"}).click();
      await expect(
        fixture.page.getByRole("button", {name: "Exit focus mode"}),
      ).toBeVisible();
      await expect(
        fixture.page.getByRole("button", {name: "Comments — 0 threads"}),
      ).toHaveCount(0);
      await fixture.page.getByRole("button", {name: "Exit focus mode"}).click();

      await fixture.context.grantPermissions(
        ["clipboard-read", "clipboard-write"],
        {origin: fixture.server.baseUrl},
      );
      await fixture.page.getByRole("button", {name: "Copy review link"}).click();
      await expect(
        fixture.page.getByRole("button", {name: "Review link copied"}),
      ).toBeVisible();

      // Two frames: the same-origin review frame the shell embeds, and the
      // opaque-origin sandbox inside it that runs the artifact.
      const reviewFrame = fixture.page.frameLocator(
        "iframe[title$=\"annotated page\"]",
      );
      const sandboxElement = reviewFrame.locator("iframe");
      await expect(sandboxElement).toHaveAttribute("sandbox", "allow-scripts");
      const sandbox = reviewFrame.frameLocator("iframe");
      await expect(sandbox.locator("#review-target")).toContainText(
        "The axis label on this chart is wrong.",
      );

      // Hostile containment: the artifact's own script reports what it reached.
      await expect(sandbox.locator("#probe-parent")).toHaveText("parent:blocked");
      await expect(sandbox.locator("#probe-cookie")).toHaveText("cookie:blocked");
      await expect(sandbox.locator("#probe-fetch")).toHaveText("fetch:blocked");

      // The viewer is always in pinpoint mode here: the review frame passes
      // `inputMethod="pinpoint"` to `HtmlViewer`, so hovering draws the
      // element outline box straight away with no mode control to enter.
      await sandbox.locator("#review-target").hover();
      await expect(
        sandbox.locator("[data-plannotator-pinpoint-box]"),
      ).toBeVisible();

      await sandbox.locator("#review-target").click();
      const composer = reviewFrame.getByPlaceholder("Add a comment...");
      await expect(composer).toBeVisible();
      await composer.fill("This axis label reads as a percentage but holds a count.");
      await reviewFrame.getByRole("button", {name: "Save"}).click();

      await fixture.page.getByRole("button", {
        name: "Comments — 1 thread",
      }).click();

      const panelThread = fixture.page.getByRole("article").filter({
        hasText: "This axis label reads as a percentage but holds a count.",
      });
      await expect(panelThread).toBeVisible();
      await expect(panelThread.getByText("Open", {exact: true})).toBeVisible();
      await expect(fixture.page.getByText("1 thread")).toBeVisible();

      await expect(async () => {
        const stored = await listThreadsOverApi(fixture, artifactId);
        expect(stored).toHaveLength(1);
        expect(stored[0]?.body).toBe(
          "This axis label reads as a percentage but holds a count.",
        );
        expect(stored[0]?.path).toBe("index.html");
        expect(stored[0]?.versionId).toBe(versionId);
        expect(stored[0]?.author.principalKind).toBe("human");
      }).toPass();

      // The stored anchor survives a reload: the marker comes back numbered on
      // the element the reviewer pinned.
      await fixture.page.reload();
      const reloaded = fixture.page.frameLocator("iframe[title$=\"annotated page\"]")
        .frameLocator("iframe");
      await expect(reloaded.locator("#review-target")).toBeVisible();
      const marker = reloaded.locator("button[data-plannotator-marker]");
      await expect(marker).toHaveCount(1);
      await expect(marker).toHaveAttribute("aria-label", "Comment 1");
      await expect(marker.locator(".pn-marker-num")).toHaveText("1");
      const markerBox = await marker.boundingBox();
      const targetBox = await reloaded.locator("#review-target").boundingBox();
      expect(markerBox).not.toBeNull();
      expect(targetBox).not.toBeNull();
      if (markerBox !== null && targetBox !== null) {
        expect(markerBox.y + markerBox.height).toBeGreaterThan(targetBox.y - 30);
        expect(markerBox.y).toBeLessThan(targetBox.y + targetBox.height + 30);
      }
      // A second reviewer comments while this screen stays open: the
      // incremental `since` poll folds the new thread in with no reload and no
      // click of Reload.
      await createThreadOverApi(fixture, {
        artifactId,
        body: "A second reviewer wants the units spelled out.",
        idempotencyKey: "review-viewer-polled-thread",
        path: "index.html",
        versionId,
      });
      await expect(
        fixture.page.getByRole("button", {name: "Comments — 2 threads"}),
      ).toBeVisible({timeout: 20_000});
      await fixture.page.getByRole("button", {name: "Comments — 2 threads"}).click();
      await expect(
        fixture.page.getByRole("article").filter({
          hasText: "A second reviewer wants the units spelled out.",
        }),
      ).toBeVisible();
      await expect(fixture.page.getByText("2 threads")).toBeVisible();

      // The review frame is same-origin with the shell, so this reads the
      // storage both documents share: the viewer's own settings store is
      // replaced before its first render and writes nothing here.
      expect(await browserStorage(fixture.page)).toEqual({
        indexedDatabaseNames: [],
        localStorageKeys: [],
        sessionStorageKeys: [],
      });
    } finally {
      await stopBrowserFixture(fixture);
    }
  });
});
