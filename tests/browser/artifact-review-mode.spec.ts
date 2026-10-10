import {expect, test} from "@playwright/test";

import {publishNew, publishVersion, type PublishNewInput} from "../support/publishing.js";
import {
  localLogin,
  startBrowserFixture,
  stopBrowserFixture,
} from "./browser-fixture.js";

const interactiveArtifact = `<!doctype html><html lang="en"><body>
  <button onclick="document.getElementById('count').textContent='clicked'">Run action</button>
  <p id="count">waiting</p>
  <details><summary>Show details</summary><p>Expanded detail</p></details>
  <a href="#destination" onclick="event.preventDefault();document.getElementById('link-result').textContent='followed'">Follow link</a>
  <p id="link-result">waiting</p><p id="destination">Destination</p>
</body></html>`;

test.describe("Artifact review mode", () => {
  for (const scenario of [
    {defaultMode: "annotate", linkMode: "interact", expected: "interact"},
    {defaultMode: "interact", linkMode: "annotate", expected: "annotate"},
    {defaultMode: "interact", linkMode: null, expected: "interact"},
    {defaultMode: "interact", linkMode: "ANNOTATE", expected: "interact"},
    {defaultMode: undefined, linkMode: "invalid", expected: "annotate"},
    {defaultMode: undefined, linkMode: null, expected: "annotate"},
  ] as const) {
    const primary = scenario.defaultMode === "annotate" && scenario.linkMode === "interact";
    test(`${primary ? "PRV-006-B PRV-006-F: " : ""}artifact review mode: ${scenario.defaultMode ?? "legacy"} default with ${scenario.linkMode ?? "no"} override starts ${scenario.expected}`, async ({browser}) => {
      const fixture = await startBrowserFixture(browser);
      try {
        const input: PublishNewInput = {
          accessSetting: "account_required",
          content: interactiveArtifact,
          idempotencyKey: "initial-review-mode",
          name: "Interactive fixture",
        };
        const published = await publishNew(
          fixture.server,
          fixture.installation,
          scenario.defaultMode === undefined ? input : {...input, reviewMode: scenario.defaultMode},
        );
        await localLogin(fixture);
        const url = normalReviewUrl(published.body.links.review);
        if (scenario.linkMode !== null) url.searchParams.set("mode", scenario.linkMode);
        await fixture.page.goto(url.href);
        const review = fixture.page.frameLocator(".as-artifact-frame");
        const preview = review.frameLocator("iframe");
        await expect(fixture.page.getByRole("button", {
          name: scenario.expected === "interact" ? /^Interact mode/u : /^Annotate mode/u,
        })).toBeVisible();
        await preview.getByRole("button", {name: "Run action"}).click();
        if (scenario.expected === "interact") {
          await expect(preview.locator("#count")).toHaveText("clicked");
          await preview.getByText("Show details", {exact: true}).click();
          await expect(preview.getByText("Expanded detail")).toBeVisible();
          await preview.getByRole("link", {name: "Follow link"}).click();
          await expect(preview.locator("#link-result")).toHaveText("followed");
          await expect(review.locator('[data-comment-popover="true"]')).toBeHidden();
          if (primary) {
            url.searchParams.set("mode", "invalid");
            await fixture.page.goto(url.href);
            await expect(fixture.page.getByRole("button", {name: /^Annotate mode/u})).toBeVisible();
          }
        } else {
          await expect(preview.locator("#count")).toHaveText("waiting");
          await expect(review.locator('[data-comment-popover="true"]')).toBeVisible();
        }
      } finally {
        await stopBrowserFixture(fixture);
      }
    });
  }

  test("artifact review mode: a link override survives focus navigation and browser history", async ({browser}) => {
    const fixture = await startBrowserFixture(browser);
    try {
      const published = await publishNew(fixture.server, fixture.installation, {
        accessSetting: "account_required",
        content: interactiveArtifact,
        idempotencyKey: "review-mode-navigation",
      });
      await localLogin(fixture);
      const url = normalReviewUrl(published.body.links.review);
      url.searchParams.set("mode", "interact");
      await fixture.page.goto(url.href);
      await expect(fixture.page.getByRole("button", {name: /^Interact mode/u})).toBeVisible();
      await fixture.page.getByRole("button", {name: "Full screen", exact: true}).click();
      await expect(fixture.page).toHaveURL(/mode=interact/u);
      await expect.poll(() => fixture.page.evaluate(() => sessionStorage.getItem("artifact-review-return-url")))
        .toContain("mode=interact");
      await fixture.page.getByRole("button", {name: "Exit full screen", exact: true}).click();
      await fixture.page.goBack();
      await expect(fixture.page.getByRole("button", {name: "Interact mode", exact: true})).toBeVisible();
      await fixture.page.goForward();
      await expect(fixture.page.getByRole("button", {name: /^Interact mode/u})).toBeVisible();
      await expect(fixture.page).toHaveURL(/mode=interact/u);
    } finally {
      await stopBrowserFixture(fixture);
    }
  });

  test("artifact review mode: Escape and toggles survive version selection and refreshed artifact details", async ({browser}) => {
    const fixture = await startBrowserFixture(browser);
    try {
      const first = await publishNew(fixture.server, fixture.installation, {
        accessSetting: "account_required",
        content: interactiveArtifact,
        idempotencyKey: "review-mode-refresh-first",
      });
      await publishVersion(fixture.server, fixture.installation, {
        artifactId: first.body.artifact.id,
        content: interactiveArtifact,
        expectedCurrentVersionId: first.body.version.id,
        idempotencyKey: "review-mode-refresh-second",
      });
      await localLogin(fixture);
      await fixture.page.goto(normalReviewUrl(first.body.links.review).href);
      await expect(fixture.page.getByRole("button", {name: /^Annotate mode/u})).toBeVisible();
      await fixture.page.keyboard.press("Escape");
      await expect(fixture.page.getByRole("button", {name: /^Interact mode/u})).toBeVisible();
      await fixture.page.getByRole("tab", {name: /Versions/u}).click();
      const firstRow = fixture.page.locator(".as-version-list li").filter({hasText: "Version 1"});
      await firstRow.getByRole("button", {name: "Make current"}).click();
      await fixture.page.getByRole("dialog", {name: "Make Version 1 current?"})
        .getByRole("button", {name: "Make current"}).click();
      await expect(firstRow.getByText("current", {exact: true})).toBeVisible();
      await expect(fixture.page.getByRole("button", {name: /^Interact mode/u})).toBeVisible();
      await fixture.page.getByRole("button", {name: /^Interact mode/u}).click();
      await fixture.page.locator(".as-version-list li").filter({hasText: "Version 2"})
        .getByRole("button", {name: /Version 2/u}).first().click();
      await expect(fixture.page.getByRole("button", {name: /^Annotate mode/u})).toBeVisible();
    } finally {
      await stopBrowserFixture(fixture);
    }
  });

  test("artifact review mode: browser history restores a link override after a manual toggle", async ({browser}) => {
    const fixture = await startBrowserFixture(browser);
    try {
      const published = await publishNew(fixture.server, fixture.installation, {
        accessSetting: "account_required",
        content: interactiveArtifact,
        idempotencyKey: "review-mode-history-toggle",
      });
      await localLogin(fixture);
      const url = normalReviewUrl(published.body.links.review);
      url.searchParams.set("mode", "interact");
      await fixture.page.goto(url.href);
      await fixture.page.getByRole("button", {name: "Full screen", exact: true}).click();
      await fixture.page.getByRole("button", {name: "Interact mode", exact: true}).click();
      await expect(fixture.page.getByRole("button", {name: "Annotate mode", exact: true})).toBeVisible();
      await fixture.page.goBack();
      await expect(fixture.page.getByRole("button", {name: /^Interact mode/u})).toBeVisible();
      await fixture.page.goForward();
      await expect(fixture.page.getByRole("button", {name: "Interact mode", exact: true})).toBeVisible();
    } finally {
      await stopBrowserFixture(fixture);
    }
  });

  test("artifact review mode: mode-only history entries and removal use the restored URL", async ({browser}) => {
    const fixture = await startBrowserFixture(browser);
    try {
      const published = await publishNew(fixture.server, fixture.installation, {
        accessSetting: "account_required",
        content: interactiveArtifact,
        idempotencyKey: "review-mode-history-override-removal",
        reviewMode: "interact",
      });
      await localLogin(fixture);
      const url = normalReviewUrl(published.body.links.review);
      await fixture.page.goto(url.href);
      await expect(fixture.page.getByRole("button", {name: /^Interact mode/u})).toBeVisible();
      const annotate = new URL(url);
      annotate.searchParams.set("mode", "annotate");
      const interact = new URL(url);
      interact.searchParams.set("mode", "interact");
      await fixture.page.evaluate((locations) => {
        for (const location of locations) window.history.pushState(null, "", location);
      }, [annotate.href, interact.href]);
      await fixture.page.goBack();
      await expect(fixture.page.getByRole("button", {name: /^Annotate mode/u})).toBeVisible();
      await fixture.page.goBack();
      await expect(fixture.page.getByRole("button", {name: /^Interact mode/u})).toBeVisible();
      await expect.poll(() => new URL(fixture.page.url()).searchParams.has("mode")).toBe(false);
    } finally {
      await stopBrowserFixture(fixture);
    }
  });

  test("artifact review mode: selecting another artifact applies its default", async ({browser}) => {
    const fixture = await startBrowserFixture(browser);
    try {
      const first = await publishNew(fixture.server, fixture.installation, {
        accessSetting: "account_required",
        content: interactiveArtifact,
        idempotencyKey: "review-mode-artifact-first",
        name: "Annotate fixture",
      });
      await publishNew(fixture.server, fixture.installation, {
        accessSetting: "account_required",
        content: interactiveArtifact,
        idempotencyKey: "review-mode-artifact-second",
        name: "Interact fixture",
        reviewMode: "interact",
      });
      await localLogin(fixture);
      await fixture.page.goto(normalReviewUrl(first.body.links.review).href);
      await expect(fixture.page.getByRole("button", {name: /^Annotate mode/u})).toBeVisible();
      await fixture.page.getByRole("button", {name: /Interact fixture/u}).click();
      await expect(fixture.page.getByRole("button", {name: /^Interact mode/u})).toBeVisible();
      await fixture.page.getByRole("button", {name: /^Interact mode/u}).click();
      await fixture.page.getByRole("button", {name: /Annotate fixture/u}).click();
      await expect(fixture.page.getByRole("button", {name: /^Annotate mode/u})).toBeVisible();
    } finally {
      await stopBrowserFixture(fixture);
    }
  });

  test("artifact review mode: a manual Escape before initial details arrives remains selected", async ({browser}) => {
    const fixture = await startBrowserFixture(browser);
    const requested = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    try {
      const published = await publishNew(fixture.server, fixture.installation, {
        accessSetting: "account_required",
        content: interactiveArtifact,
        idempotencyKey: "review-mode-delayed-details",
      });
      await localLogin(fixture);
      await fixture.page.route(`**/api/v1/artifacts/${published.body.artifact.id}?*`, async (route) => {
        requested.resolve();
        await release.promise;
        await route.continue();
      });
      await fixture.page.goto(normalReviewUrl(published.body.links.review).href);
      await requested.promise;
      await fixture.page.keyboard.press("Escape");
      release.resolve();
      await expect(fixture.page.getByRole("button", {name: /^Interact mode/u})).toBeVisible();
      await fixture.page.frameLocator(".as-artifact-frame").frameLocator("iframe")
        .getByRole("button", {name: "Run action"}).click();
      await expect(fixture.page.frameLocator(".as-artifact-frame").frameLocator("iframe").locator("#count"))
        .toHaveText("clicked");
    } finally {
      release.resolve();
      await stopBrowserFixture(fixture);
    }
  });
});

function normalReviewUrl(href: string): URL {
  const url = new URL(href);
  url.searchParams.delete("view");
  return url;
}
