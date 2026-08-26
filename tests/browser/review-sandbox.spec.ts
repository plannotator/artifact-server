import {expect, test} from "@playwright/test";

import {publishNew} from "../support/publishing.js";
import {
  localLogin,
  startBrowserFixture,
  stopBrowserFixture,
} from "./browser-fixture.js";

const hostileArtifact = `<!doctype html>
<html lang="en">
  <head><meta charset="utf-8"><title>Sandbox probe</title></head>
  <body>
    <p id="probe-parent">parent:pending</p>
    <p id="probe-cookie">cookie:pending</p>
    <p id="probe-fetch">fetch:pending</p>
    <script>
      (function () {
        var report = function (id, value) {
          document.getElementById(id).textContent = value;
        };
        try {
          var title = window.parent.document.title;
          report("probe-parent", "parent:reached:" + title);
        } catch (error) {
          report("probe-parent", "parent:blocked");
        }
        try {
          report("probe-cookie", "cookie:readable:[" + document.cookie + "]");
        } catch (error) {
          report("probe-cookie", "cookie:blocked");
        }
        try {
          fetch("/api/v1/session", {credentials: "include"}).then(
            function (response) {
              report("probe-fetch", "fetch:reached:" + response.status);
            },
            function () {
              report("probe-fetch", "fetch:blocked");
            }
          );
        } catch (error) {
          report("probe-fetch", "fetch:blocked");
        }
      })();
    </script>
  </body>
</html>`;

test.describe("Review sandbox isolation", () => {
  test("CMT-014-B CMT-014-F: hostile artifact HTML stays inside an opaque-origin sandbox", async ({browser}) => {
    const fixture = await startBrowserFixture(browser);
    try {
      const published = await publishNew(fixture.server, fixture.installation, {
        accessSetting: "account_required",
        content: hostileArtifact,
        idempotencyKey: "review-sandbox-isolation",
        mediaType: "text/html; charset=utf-8",
        name: "Sandbox probe",
        path: "index.html",
      });
      await localLogin(fixture);
      await fixture.page.goto(
        `${fixture.server.baseUrl}/review?project=prj_default&artifact=${published.body.artifact.id}&version=${published.body.version.id}`,
      );

      const reviewFrame = fixture.page.frameLocator(".as-artifact-frame");
      const sandboxElement = reviewFrame.locator("iframe");
      await expect(sandboxElement).toHaveAttribute("sandbox", "allow-scripts");
      await expect(sandboxElement).not.toHaveAttribute("sandbox", /allow-same-origin/u);
      await expect(sandboxElement).not.toHaveAttribute("sandbox", /allow-forms/u);
      await expect(sandboxElement).not.toHaveAttribute("sandbox", /allow-top-navigation/u);

      const artifactFrame = reviewFrame.frameLocator("iframe");
      await expect(artifactFrame.locator("#probe-parent")).toHaveText("parent:blocked");
      await expect(artifactFrame.locator("#probe-cookie")).toHaveText("cookie:blocked");
      await expect(artifactFrame.locator("#probe-fetch")).toHaveText("fetch:blocked");
    } finally {
      await stopBrowserFixture(fixture);
    }
  });
});
