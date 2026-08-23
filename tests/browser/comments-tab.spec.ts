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

const fixtureHtml = "<!doctype html><html lang=\"en\"><head><title>Comment fixture</title></head>"
  + "<body><h1>Comment fixture</h1><p id=\"comment-target\">One reviewable paragraph.</p></body></html>";

test.describe("Artifact comments tab", () => {
  test("an agent's thread is read, replied to, resolved, and reopened in the browser", async ({browser}) => {
    const fixture = await startBrowserFixture(browser);
    try {
      const artifact = await publishNew(fixture.server, fixture.installation, {
        accessSetting: "account_required",
        content: fixtureHtml,
        idempotencyKey: "comments-tab-fixture",
        mediaType: "text/html; charset=utf-8",
        name: "Comment fixture",
        path: "index.html",
      });
      const seeded = await createThreadOverApi(fixture, {
        artifactId: artifact.body.artifact.id,
        body: "The heading claims more than the page shows.",
        idempotencyKey: "comments-tab-seed-thread",
        path: "index.html",
        versionId: artifact.body.version.id,
      });
      expect(seeded.author.displayName).toBe("Local");
      expect(seeded.state).toBe("open");

      await localLogin(fixture);
      await fixture.page.goto(
        `${fixture.server.baseUrl}/projects/prj_default/artifacts/${artifact.body.artifact.id}`,
      );
      await expect(
        fixture.page.getByRole("heading", {name: "Comment fixture"}),
      ).toBeVisible();
      await fixture.page.getByRole("tab", {name: "Versions"}).click();
      await expect(fixture.page.getByText("1 open comment")).toBeVisible();

      await fixture.page.getByRole("tab", {name: "Comments"}).click();
      const thread = fixture.page.getByRole("article").filter({
        hasText: "The heading claims more than the page shows.",
      });
      await expect(thread).toBeVisible();
      await expect(thread.getByRole("heading", {name: "Local"})).toBeVisible();
      await expect(thread.getByText("Open", {exact: true})).toBeVisible();
      await expect(thread.getByText("Version 1", {exact: true})).toBeVisible();
      await expect(thread.getByText("index.html", {exact: true})).toBeVisible();

      const accessibility = await new AxeBuilder({page: fixture.page})
        .withTags(["wcag2a", "wcag2aa"])
        .analyze();
      expect(accessibility.violations).toEqual([]);

      await thread.getByRole("button", {name: "Show replies (0)"}).click();
      await thread
        .getByRole("textbox", {name: "Reply", exact: true})
        .fill("The heading is the published title; the body is the summary.");
      await thread.getByRole("button", {name: "Post reply"}).click();
      const reply = thread.getByRole("listitem").filter({
        hasText: "The heading is the published title; the body is the summary.",
      });
      await expect(reply).toBeVisible();
      await expect(reply.getByText("Local administrator")).toBeVisible();
      await expect(thread.getByRole("button", {name: "Hide replies (1)"})).toBeVisible();

      await thread.getByRole("button", {name: "Resolve"}).click();
      await expect(thread.getByText("Resolved", {exact: true})).toBeVisible();
      await expect(thread.getByRole("button", {name: "Hide replies (1)"})).toBeVisible();
      await expect(
        thread.getByRole("textbox", {name: "Reply", exact: true}),
      ).toHaveCount(0);
      await expect(thread.getByRole("button", {name: "Post reply"})).toHaveCount(0);
      await expect(thread.getByText("Reopen this comment to reply.")).toBeVisible();

      await thread.getByRole("button", {name: "Reopen"}).click();
      await expect(thread.getByText("Open", {exact: true})).toBeVisible();
      await expect(
        thread.getByRole("textbox", {name: "Reply", exact: true}),
      ).toBeVisible();

      const stored = await listThreadsOverApi(fixture, artifact.body.artifact.id);
      expect(stored).toHaveLength(1);
      expect(stored[0]?.replyCount).toBe(1);
      expect(stored[0]?.state).toBe("open");

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
