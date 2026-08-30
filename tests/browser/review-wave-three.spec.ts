import {expect, test} from "@playwright/test";
import {z} from "zod";

import {publishNew, publishVersion} from "../support/publishing.js";
import {
  localLogin,
  startBrowserFixture,
  stopBrowserFixture,
} from "./browser-fixture.js";
import {createReplyOverApi, createThreadOverApi} from "./comment-api.js";

test.describe("Artifact Server Review wave three", () => {
  test("ART-010-B ART-010-F: Make current confirms, handles pointer conflicts, and preserves the exact review", async ({browser}) => {
    const fixture = await startBrowserFixture(browser);
    try {
      const first = await publishNew(fixture.server, fixture.installation, {
        accessSetting: "account_required",
        content: "<!doctype html><html lang=\"en\"><h1>Historical review stays open</h1></html>",
        idempotencyKey: "review-make-current-v1",
        name: "Make current fixture",
      });
      const second = await publishVersion(fixture.server, fixture.installation, {
        artifactId: first.body.artifact.id,
        content: "<!doctype html><html lang=\"en\"><h1>Second saved version</h1></html>",
        expectedCurrentVersionId: first.body.version.id,
        idempotencyKey: "review-make-current-v2",
      });
      await localLogin(fixture);
      await fixture.page.goto(reviewUrl(
        fixture.server.baseUrl,
        first.body.artifact.id,
        first.body.version.id,
      ));
      const preview = fixture.page.frameLocator(".as-artifact-frame").frameLocator("iframe");
      await expect(preview.getByRole("heading", {name: "Historical review stays open"}))
        .toBeVisible();

      await fixture.page.getByRole("tab", {name: /Versions/u}).click();
      const firstRow = fixture.page.locator(".as-version-list li").filter({hasText: "Version 1"});
      await firstRow.getByRole("button", {name: "Make current"}).click();
      const confirmation = fixture.page.getByRole("dialog", {
        name: "Make Version 1 current?",
      });
      await expect(confirmation).toContainText("No saved version is changed or duplicated.");
      await confirmation.getByRole("button", {name: "Make current"}).click();
      await expect(firstRow.getByText("current", {exact: true})).toBeVisible();
      await expect(preview.getByRole("heading", {name: "Historical review stays open"}))
        .toBeVisible();
      expect(new URL(fixture.page.url()).searchParams.get("version"))
        .toBe(first.body.version.id);

      const secondRow = fixture.page.locator(".as-version-list li").filter({hasText: "Version 2"});
      await secondRow.getByRole("button", {name: "Make current"}).click();
      const third = await publishVersion(fixture.server, fixture.installation, {
        artifactId: first.body.artifact.id,
        content: "<!doctype html><html lang=\"en\"><h1>Concurrent version</h1></html>",
        expectedCurrentVersionId: first.body.version.id,
        idempotencyKey: "review-make-current-v3",
      });
      await fixture.page.getByRole("dialog", {name: "Make Version 2 current?"})
        .getByRole("button", {name: "Make current"}).click();
      await expect(fixture.page.getByRole("dialog", {name: "Make Version 2 current?"}))
        .toHaveCount(0);
      await expect(fixture.page.getByText(/current version changed/u)).toBeVisible();
      await expect(preview.getByRole("heading", {name: "Historical review stays open"}))
        .toBeVisible();
      expect(new URL(fixture.page.url()).searchParams.get("version"))
        .toBe(first.body.version.id);

      const detailsResponse = await fetch(
        `${fixture.server.baseUrl}/api/v1/artifacts/${first.body.artifact.id}?projectId=prj_default`,
        {headers: {Authorization: `Bearer ${fixture.installation.apiToken}`}},
      );
      const details = z.object({
        artifact: z.object({currentVersionId: z.string()}),
      }).parse(await detailsResponse.json());
      expect(details.artifact.currentVersionId).toBe(third.body.version.id);
      expect(details.artifact.currentVersionId).not.toBe(second.body.version.id);
    } finally {
      await stopBrowserFixture(fixture);
    }
  });

  test("CMT-019-B CMT-019-F: Review displays full conversations and creates, edits, and deletes replies", async ({browser}) => {
    const fixture = await startBrowserFixture(browser);
    try {
      const published = await publishNew(fixture.server, fixture.installation, {
        accessSetting: "account_required",
        content: "<!doctype html><html lang=\"en\"><h1>Reply fixture</h1></html>",
        idempotencyKey: "review-reply-fixture",
        name: "Reply fixture",
      });
      const thread = await createThreadOverApi(fixture, {
        artifactId: published.body.artifact.id,
        body: "Root feedback",
        idempotencyKey: "review-reply-thread",
        versionId: published.body.version.id,
      });
      await createReplyOverApi(fixture, {
        artifactId: published.body.artifact.id,
        body: "Agent reply already in this conversation",
        idempotencyKey: "review-reply-seeded",
        threadId: thread.id,
      });

      await localLogin(fixture);
      await fixture.page.goto(reviewUrl(
        fixture.server.baseUrl,
        published.body.artifact.id,
        published.body.version.id,
      ));
      await fixture.page.getByRole("tab", {name: /Comments/u}).click();
      const conversation = fixture.page.getByRole("article").filter({hasText: "Root feedback"});
      await expect(conversation.getByText("Agent reply already in this conversation"))
        .toBeVisible();
      await expect(conversation.getByText("1 reply", {exact: true})).toBeVisible();
      await expect(conversation.locator(".as-comment-card__meta")).toContainText("Updated");
      await expect(conversation.locator(".as-comment-card__meta")).toContainText("Whole version");
      await expect(conversation.getByRole("textbox", {exact: true, name: "Reply"}))
        .toHaveCount(0);
      const agentReply = conversation.locator(".as-comment-replies li")
        .filter({hasText: "Agent reply already in this conversation"});
      await expect(agentReply.getByRole("button", {name: "Edit"})).toHaveCount(0);

      await conversation.getByRole("button", {exact: true, name: "Reply"}).click();
      await conversation.getByRole("textbox", {exact: true, name: "Reply"})
        .fill("Human follow-up");
      const postReply = conversation.getByRole("button", {name: "Post reply"});
      await expect(postReply).toHaveCSS("text-transform", "none");
      expect(await postReply.evaluate((element) => element.getBoundingClientRect().height))
        .toBeLessThanOrEqual(32);
      await postReply.click();
      await expect(conversation.getByText("Human follow-up", {exact: true})).toBeVisible();
      await expect(conversation.getByText("2 replies", {exact: true})).toBeVisible();
      const humanReply = conversation.locator(".as-comment-replies li")
        .filter({hasText: "Human follow-up"});
      await humanReply.getByRole("button", {name: "Edit"}).click();
      await humanReply.getByLabel("Edit reply").fill("Human follow-up, revised");
      await humanReply.getByRole("button", {name: "Save reply"}).click();
      await expect(conversation.getByText("Human follow-up, revised", {exact: true}))
        .toBeVisible();
      await humanReply.getByRole("button", {name: "Delete"}).click();
      await expect(conversation.getByText("Human follow-up, revised", {exact: true}))
        .toHaveCount(0);
      await expect(conversation.getByText("Agent reply already in this conversation"))
        .toBeVisible();
      await conversation.getByRole("button", {name: "Resolve"}).click();
      await expect(conversation.getByRole("textbox", {exact: true, name: "Reply"}))
        .toHaveCount(0);
    } finally {
      await stopBrowserFixture(fixture);
    }
  });

  test("ART-009-B ART-009-F: Review searches the whole project and preserves a nonmatching preview", async ({browser}) => {
    const fixture = await startBrowserFixture(browser);
    try {
      const selected = await publishNew(fixture.server, fixture.installation, {
        accessSetting: "account_required",
        content: "<!doctype html><html lang=\"en\"><h1>Selected preview remains</h1></html>",
        idempotencyKey: "review-search-selected",
        name: "Selected historical plan",
        tags: ["hidden-target"],
      });
      const result = await publishNew(fixture.server, fixture.installation, {
        accessSetting: "account_required",
        content: "<!doctype html><html lang=\"en\"><h1>Search result preview</h1></html>",
        idempotencyKey: "review-search-result",
        name: "Decision Board Result",
      });
      await localLogin(fixture);
      await fixture.page.route(/\/api\/v1\/artifacts\?.*/u, async (route) => {
        const requestUrl = new URL(route.request().url());
        const response = await route.fetch();
        if (requestUrl.searchParams.has("search")) {
          await route.fulfill({response});
          return;
        }
        const body = z.object({
          artifacts: z.array(z.unknown()),
          nextCursor: z.string().nullable(),
        }).passthrough().parse(await response.json());
        const artifacts = body.artifacts.filter((item) => z.object({
          artifact: z.object({id: z.string()}),
        }).parse(item).artifact.id !== selected.body.artifact.id);
        await route.fulfill({
          body: JSON.stringify({...body, artifacts}),
          contentType: "application/json",
          response,
        });
      });
      await fixture.page.goto(reviewUrl(
        fixture.server.baseUrl,
        selected.body.artifact.id,
        selected.body.version.id,
      ));
      const preview = fixture.page.frameLocator(".as-artifact-frame").frameLocator("iframe");
      await expect(preview.getByRole("heading", {name: "Selected preview remains"}))
        .toBeVisible();

      const search = fixture.page.getByRole("searchbox", {name: "Search artifacts"});
      await search.fill("  DECISION   BOARD ");
      await expect(fixture.page.getByRole("button", {name: /Decision Board Result/u}))
        .toBeVisible();
      await expect(fixture.page.getByRole("button", {name: /Selected historical plan/u}))
        .toHaveCount(0);
      await expect(preview.getByRole("heading", {name: "Selected preview remains"}))
        .toBeVisible();

      await search.fill("HIDDEN-TARGET");
      await expect(fixture.page.getByRole("button", {name: /Selected historical plan/u}))
        .toBeVisible();
      await search.fill("hidden");
      await expect(fixture.page.getByText("No matching artifacts", {exact: true})).toBeVisible();
      await expect(preview.getByRole("heading", {name: "Selected preview remains"}))
        .toBeVisible();
      expect(result.body.artifact.id).not.toBe(selected.body.artifact.id);
    } finally {
      await stopBrowserFixture(fixture);
    }
  });
});

function reviewUrl(
  baseUrl: string,
  artifactId: string,
  versionId: string,
): string {
  return `${baseUrl}/review?${new URLSearchParams({
    artifact: artifactId,
    project: "prj_default",
    version: versionId,
  })}`;
}
