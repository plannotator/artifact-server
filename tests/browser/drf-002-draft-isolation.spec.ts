import {expect, test} from "@playwright/test";
import {z} from "zod";

import {publishNew} from "../support/publishing.js";
import {
  localLogin,
  startBrowserFixture,
  stopBrowserFixture,
} from "./browser-fixture.js";
import {createThreadOverApi} from "./comment-api.js";

const pageHtml =
  "<!doctype html><html lang=\"en\"><head><title>Isolation fixture</title></head>"
  + "<body><h1>Isolation fixture</h1><p id=\"claim\">Reviewed text.</p></body></html>";

const sessionSchema = z.object({principal: z.object({id: z.string()}).loose()}).loose();
const mirrorSettle = 600;

test.describe("DRF-002 draft isolation", () => {
  test("DRF-002-B DRF-002-F: drafts are principal-scoped and bounded — a foreign principal's draft never restores, signing out clears the signed-in principal's drafts and spares the other principal's, a reply draft never restores into the new-thread composer, and closing over a non-empty draft prompts", async ({browser}) => {
    const fixture = await startBrowserFixture(browser);
    try {
      const published = await publishNew(fixture.server, fixture.installation, {
        accessSetting: "account_required",
        content: pageHtml,
        idempotencyKey: "drf-002-fixture-page",
        mediaType: "text/html; charset=utf-8",
        name: "Isolation fixture",
        path: "index.html",
      });
      const artifactId = published.body.artifact.id;
      const versionId = published.body.version.id;
      await createThreadOverApi(fixture, {
        artifactId,
        body: "Seeded thread.",
        idempotencyKey: "drf-002-seed-thread",
        versionId,
      });

      await localLogin(fixture);
      const page = fixture.page;
      const principalId = sessionSchema.parse(
        await (await page.request.get(`${fixture.server.baseUrl}/api/v1/session`)).json(),
      ).principal.id;
      const reviewUrl =
        `${fixture.server.baseUrl}/review?project=prj_default&artifact=${artifactId}&version=${versionId}`;
      await page.goto(reviewUrl);
      await page.getByRole("tab", {name: "Comments"}).click();

      // Only a reply draft exists; the new-thread composer must stay empty.
      await page.getByRole("button", {exact: true, name: "Reply"}).click();
      await page.getByLabel("Reply", {exact: true}).fill("Reply-only draft.");
      await page.waitForTimeout(mirrorSettle);
      const keys = await page.evaluate(() => Object.keys(localStorage).filter((key) => key.startsWith("draft:")));
      expect(keys).toHaveLength(1);
      expect(keys[0]?.startsWith(`draft:${principalId}:${artifactId}:`)).toBe(true);
      expect(keys[0]?.includes(":new:")).toBe(false);

      // A draft mirrored under another principal is invisible to this one.
      const foreignKey = `draft:someone-else:${artifactId}:new:${versionId}`;
      await page.evaluate(([key]) => {
        localStorage.setItem(key ?? "", JSON.stringify({b: "Not yours.", t: Date.now()}));
      }, [foreignKey]);
      page.on("dialog", (dialog) => void dialog.accept());
      await page.reload();
      await page.getByRole("tab", {name: "Comments"}).click();
      await expect(page.getByLabel("Add a comment")).toHaveValue("");
      await expect(page.getByLabel("Reply", {exact: true})).toHaveValue("Reply-only draft.");
      expect(await page.evaluate(([key]) => localStorage.getItem(key ?? ""), [foreignKey]))
        .not.toBeNull();

      // A real sign-out (settings header, through api.logout) purges the
      // departing principal's drafts and nobody else's.
      await page.getByRole("link", {name: "Open settings"}).click();
      await page.getByRole("button", {name: "Sign out"}).click();
      // Sign-out purges the drafts and then navigates to /review. Reading
      // storage while that navigation is in flight destroys the evaluate's
      // execution context, so wait for the landing page first and treat a
      // mid-navigation read as "not yet" rather than a failure.
      await page.waitForURL(/\/review(?:[?#]|$)/u);
      await expect.poll(() => page.evaluate(
        () => Object.keys(localStorage).filter((key) => key.startsWith("draft:")),
      ).catch(() => null)).toEqual([foreignKey]);
      await localLogin(fixture);
      await page.goto(reviewUrl);
      await page.getByRole("tab", {name: "Comments"}).click();
      await expect(page.getByLabel("Reply", {exact: true})).toHaveCount(0);
      await expect(page.getByRole("button", {exact: true, name: "Reply"})).toBeVisible();
      await expect(page.getByLabel("Add a comment")).toHaveValue("");

      // Closing the tab over a non-empty draft asks first.
      await page.getByLabel("Add a comment").fill("Unsaved thought.");
      const dialogTypes: string[] = [];
      page.removeAllListeners("dialog");
      page.on("dialog", (dialog) => {
        dialogTypes.push(dialog.type());
        void dialog.accept();
      });
      await page.close({runBeforeUnload: true});
      await expect.poll(() => dialogTypes).toEqual(["beforeunload"]);
    } finally {
      await stopBrowserFixture(fixture);
    }
  });
});
