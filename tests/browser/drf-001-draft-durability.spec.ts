import {expect, test} from "@playwright/test";

import {publishNew, publishVersion} from "../support/publishing.js";
import {
  localLogin,
  startBrowserFixture,
  stopBrowserFixture,
} from "./browser-fixture.js";
import {createThreadOverApi} from "./comment-api.js";

const pageHtml = (title: string): string =>
  `<!doctype html><html lang="en"><head><title>${title}</title></head>`
  + `<body><h1>${title}</h1><p id="claim">A claim worth reviewing.</p></body></html>`;

/** The mirror write is debounced; settle it before anything that reloads. */
const mirrorSettle = 600;

test.describe("DRF-001 draft durability", () => {
  test("DRF-001-B DRF-001-F: draft text survives a version switch, artifact navigation, and a page reload, restores into the same composer with the draft marker, and is gone after the comment posts and after explicit discard", async ({browser}) => {
    const fixture = await startBrowserFixture(browser);
    try {
      const first = await publishNew(fixture.server, fixture.installation, {
        accessSetting: "account_required",
        content: pageHtml("Draft fixture"),
        idempotencyKey: "drf-001-fixture-v1",
        mediaType: "text/html; charset=utf-8",
        name: "Draft fixture",
        path: "index.html",
      });
      const second = await publishVersion(fixture.server, fixture.installation, {
        artifactId: first.body.artifact.id,
        content: pageHtml("Draft fixture v2"),
        expectedCurrentVersionId: first.body.version.id,
        idempotencyKey: "drf-001-fixture-v2",
        mediaType: "text/html; charset=utf-8",
        path: "index.html",
      });
      await publishNew(fixture.server, fixture.installation, {
        accessSetting: "account_required",
        content: pageHtml("Other fixture"),
        idempotencyKey: "drf-001-other-fixture",
        mediaType: "text/html; charset=utf-8",
        name: "Other fixture",
        path: "index.html",
      });
      const artifactId = first.body.artifact.id;
      const versionId = second.body.version.id;
      await createThreadOverApi(fixture, {
        artifactId,
        body: "Seeded thread for the reply draft.",
        idempotencyKey: "drf-001-seed-thread",
        versionId,
      });

      await localLogin(fixture);
      const page = fixture.page;
      page.on("dialog", (dialog) => void dialog.accept());
      const reviewUrl =
        `${fixture.server.baseUrl}/review?project=prj_default&artifact=${artifactId}&version=${versionId}`;
      await page.goto(reviewUrl);
      await page.getByRole("tab", {name: "Comments"}).click();

      const newThread = page.getByLabel("Comment on this version");
      const reply = page.getByLabel("Reply", {exact: true});
      const newText = "A careful multi-paragraph thought about the heading.";
      const replyText = "Reply in progress, do not lose me.";
      await newThread.fill(newText);
      await reply.fill(replyText);
      await page.waitForTimeout(mirrorSettle);

      // In-app version switch and back: the drafts never left.
      await page.getByRole("tab", {name: /Versions/u}).click();
      await page.getByRole("button", {name: /Version 1/u}).click();
      await page.getByRole("tab", {name: /Versions/u}).click();
      await page.getByRole("button", {name: /Version 2/u}).click();
      await page.getByRole("tab", {name: "Comments"}).click();
      await expect(page.getByLabel("Comment on this version")).toHaveValue(newText);
      await expect(page.getByLabel("Reply", {exact: true})).toHaveValue(replyText);
      await expect(page.locator("[data-draft-marker]")).toHaveCount(2);

      // Artifact navigation and back (the newer "Other fixture" sorts first,
      // so the drafted artifact is the last catalog entry).
      await page.getByRole("button", {name: "Previous artifact"}).click();
      await expect(page).not.toHaveURL(new RegExp(`artifact=${artifactId}`, "u"));
      await page.getByRole("button", {name: "Next artifact"}).click();
      await page.getByRole("tab", {name: "Comments"}).click();
      await expect(page.getByLabel("Comment on this version")).toHaveValue(newText);
      await expect(page.getByLabel("Reply", {exact: true})).toHaveValue(replyText);

      // A full reload restores both from the mirror, marker included.
      await page.reload();
      await page.getByRole("tab", {name: "Comments"}).click();
      await expect(page.getByLabel("Comment on this version")).toHaveValue(newText);
      await expect(page.getByLabel("Reply", {exact: true})).toHaveValue(replyText);
      await expect(page.locator("[data-draft-marker]")).toHaveCount(2);

      // Posting the reply consumes its draft.
      await page.getByRole("button", {name: "Post reply"}).click();
      await expect(page.getByText(replyText)).toBeVisible();
      await expect(page.getByLabel("Reply", {exact: true})).toHaveValue("");

      // Discarding the new-thread draft empties it; neither survives a reload.
      await page.getByRole("button", {name: "Discard"}).click();
      await expect(page.getByLabel("Comment on this version")).toHaveValue("");
      await page.reload();
      await page.getByRole("tab", {name: "Comments"}).click();
      await expect(page.getByLabel("Comment on this version")).toHaveValue("");
      await expect(page.getByLabel("Reply", {exact: true})).toHaveValue("");
      await expect(page.locator("[data-draft-marker]")).toHaveCount(0);
    } finally {
      await stopBrowserFixture(fixture);
    }
  });
});
