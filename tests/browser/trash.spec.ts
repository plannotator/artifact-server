import {AxeBuilder} from "@axe-core/playwright";
import {expect, test} from "@playwright/test";
import {z} from "zod";

import {publishNew} from "../support/publishing.js";
import {apiHeaders} from "../support/runtime-harness.js";
import {localLogin, startBrowserFixture, stopBrowserFixture} from "./browser-fixture.js";

test("Review moves an artifact to the trash with Undo, and Trash recovers and purges with typed confirmation", async ({browser}) => {
  const fixture = await startBrowserFixture(browser);
  try {
    const kept = await publishNew(fixture.server, fixture.installation, {
      accessSetting: "public_link",
      content: "<main>Kept artifact</main>",
      idempotencyKey: "trash-browser-kept",
      name: "Kept report",
    });
    await publishNew(fixture.server, fixture.installation, {
      accessSetting: "account_required",
      content: "<main>Doomed artifact</main>",
      idempotencyKey: "trash-browser-doomed",
      name: "Doomed report",
    });
    await localLogin(fixture);
    const {page} = fixture;
    const catalog = page.getByRole("complementary", {name: "Artifact catalog"});
    const inspector = page.locator(".as-inspector");

    await catalog.getByRole("button", {name: /Kept report/u}).click();
    await expect(page.getByRole("heading", {name: "Kept report", exact: true})).toBeVisible();
    await inspector.getByRole("button", {name: "Move to Trash", exact: true}).click();
    const toast = page.getByRole("status").filter({hasText: "Moved Kept report to the trash."});
    await expect(toast).toBeVisible();
    await expect(catalog.getByRole("button", {name: /Kept report/u})).toHaveCount(0);
    await toast.getByRole("button", {name: "Undo"}).click();
    await expect(page.getByRole("status").filter({hasText: "now account-required"})).toBeVisible();
    await expect(catalog.getByRole("button", {name: /Kept report/u})).toBeVisible();
    const recovered = await fetch(
      `${fixture.server.baseUrl}/api/v1/artifacts/${kept.body.artifact.id}`,
      {headers: apiHeaders(fixture.installation, "trash-browser-read")},
    );
    await expect(recovered.json()).resolves.toMatchObject({artifact: {accessSetting: "account_required"}});

    await catalog.getByRole("button", {name: /Doomed report/u}).click();
    await expect(page.getByRole("heading", {name: "Doomed report", exact: true})).toBeVisible();
    await inspector.getByRole("button", {name: "Move to Trash", exact: true}).click();
    await expect(catalog.getByRole("button", {name: /Doomed report/u})).toHaveCount(0);

    await page.getByRole("link", {name: "Open trash"}).click();
    await expect(page).toHaveURL(/\/review\/files\/trash$/u);
    await expect(page.getByRole("heading", {name: "Trash", exact: true})).toBeVisible();
    const row = page.getByRole("row").filter({hasText: "Doomed report"});
    await expect(row).toContainText("Default");
    const accessibility = await new AxeBuilder({page}).withTags(["wcag2a", "wcag2aa"]).analyze();
    expect(accessibility.violations).toEqual([]);

    await page.emulateMedia({reducedMotion: "reduce"});
    await row.getByRole("button", {name: "Purge Doomed report"}).click();
    const dialog = page.getByRole("dialog", {name: "Purge Doomed report?"});
    await expect(dialog).toContainText("It does not free disk space yet.");
    const confirm = dialog.getByRole("button", {name: "Purge", exact: true});
    await expect(confirm).toBeDisabled();
    await dialog.getByRole("textbox", {name: "Type the exact name to confirm"}).fill("doomed report");
    await expect(confirm).toBeDisabled();
    await dialog.getByRole("textbox", {name: "Type the exact name to confirm"}).fill("Doomed report");
    const dialogAccessibility = await new AxeBuilder({page}).include("[role=dialog]").withTags(["wcag2a", "wcag2aa"]).analyze();
    expect(dialogAccessibility.violations).toEqual([]);
    await confirm.click();
    await expect(dialog).toBeHidden();
    await expect(page.getByText("Purged Doomed report.")).toBeVisible();
    await expect(page.getByRole("heading", {name: "The trash is empty"})).toBeVisible();
    await page.reload();
    await expect(page.getByRole("heading", {name: "The trash is empty"})).toBeVisible();

    const zhContext = await browser.newContext();
    try {
      const zh = await zhContext.newPage();
      await zh.goto(`${fixture.server.baseUrl}/review/files/trash`);
      await expect(zh.getByRole("heading", {name: "垃圾桶", exact: true, level: 1})).toBeVisible();
      await expect(zh.getByRole("heading", {name: "垃圾桶是空的"})).toBeVisible();
    } finally {
      await zhContext.close();
    }
  } finally {
    await stopBrowserFixture(fixture);
  }
});

test("Trash recovers a folder group under a new name when its old name was taken", async ({browser}) => {
  const fixture = await startBrowserFixture(browser);
  try {
    const headers = (key: string) => apiHeaders(fixture.installation, key);
    const foldersPath = `${fixture.server.baseUrl}/api/v1/projects/prj_default/folders`;
    const created = await fetch(foldersPath, {method: "POST", headers: headers("trash-browser-folder-one"), body: JSON.stringify({name: "Reports"})});
    const {folder} = z.object({folder: z.object({id: z.string()})}).parse(await created.json());
    await fetch(`${foldersPath}/${folder.id}?expectedRevision=1`, {method: "DELETE", headers: headers("trash-browser-folder-trash")});
    await fetch(foldersPath, {method: "POST", headers: headers("trash-browser-folder-two"), body: JSON.stringify({name: "Reports"})});
    await localLogin(fixture);
    const {page} = fixture;
    await page.goto(`${fixture.server.baseUrl}/review/files/trash`);
    const row = page.getByRole("row").filter({hasText: "Reports"});
    await expect(row).toContainText("Folder · 0 artifacts");
    await row.getByRole("button", {name: "Recover Reports"}).click();
    const dialog = page.getByRole("dialog", {name: "Recover Reports"});
    await expect(dialog).toContainText("A folder with this name already exists there.");
    await dialog.getByRole("textbox", {name: "New folder name"}).fill("Reports (old)");
    await dialog.getByRole("button", {name: "Recover with this name"}).click();
    await expect(dialog).toBeHidden();
    await expect(page.getByText("Recovered Reports (old).")).toBeVisible();
    await expect(page.getByRole("heading", {name: "The trash is empty"})).toBeVisible();
  } finally {
    await stopBrowserFixture(fixture);
  }
});
