import {mkdir, mkdtemp, realpath, rename, rm, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import path from "node:path";

import {AxeBuilder} from "@axe-core/playwright";
import {expect, test, type Browser, type Page} from "@playwright/test";

import {
  createTestInstallation, removeTestInstallation, startTestServer,
} from "../support/runtime-harness.js";
import {englishContext, localLogin} from "./browser-fixture.js";

async function startFixture(browser: Browser, linkedFiles: "off" | "on") {
  const installation = await createTestInstallation();
  const linkRoot = await mkdtemp(path.join(await realpath(tmpdir()), "artifact-server-linked-folder-"));
  const server = await startTestServer(installation, {linkedFiles, linkedFolderWatch: "off", linkRoots: [linkRoot]});
  const context = await englishContext(browser);
  const page = await context.newPage();
  return {
    context, installation, linkRoot, page, server,
    stop: async () => {
      await context.close();
      await server.stop();
      await removeTestInstallation(installation);
      await rm(linkRoot, {force: true, recursive: true});
    },
  };
}

async function expectAccessible(page: Page): Promise<void> {
  // Contrast is measured on settled frames, never mid-transition.
  await page.waitForFunction(() => document.getAnimations().every((animation) => animation.playState !== "running"));
  const results = await new AxeBuilder({page}).withTags(["wcag2a", "wcag2aa"]).analyze();
  expect(results.violations).toEqual([]);
}

test.describe("Linked folders", () => {
  test("a member links a folder, previews a new file, captures pending files, and relinks a moved file", async ({browser}) => {
    const fixture = await startFixture(browser, "on");
    try {
      const output = path.join(fixture.linkRoot, "site-output");
      await mkdir(path.join(output, "docs"), {recursive: true});
      await writeFile(path.join(output, "index.html"), "<!doctype html><title>Home</title><h1>Home</h1>");
      await writeFile(path.join(output, "docs", "guide.md"), "# Guide\n");
      await localLogin(fixture);

      await fixture.page.getByRole("link", {name: "Linked folders"}).click();
      await expect(fixture.page).toHaveURL(/\/review\/linked-folders\?project=prj_default/u);
      await expect(fixture.page.getByRole("heading", {name: "No linked folders yet"})).toBeVisible();
      await expectAccessible(fixture.page);

      await fixture.page.getByRole("button", {name: "Link a folder"}).click();
      await fixture.page.getByLabel("Directory path").fill(output);
      await fixture.page.getByLabel("Folder name (optional)").fill("Site output");
      await fixture.page.getByRole("button", {name: "Link", exact: true}).click();
      await expect(fixture.page.locator("[role='dialog'], .inset-0")).toHaveCount(0);
      const card = fixture.page.getByRole("region", {name: "site-output"});
      await expect(card.getByText("2 pending")).toBeVisible();
      await expect(card.getByText(output, {exact: true})).toBeVisible();
      const inventory = fixture.page.getByRole("region", {name: /Files · site-output/u});
      await expect(inventory.getByRole("cell", {exact: true, name: "docs/guide.md"})).toBeVisible();
      await expectAccessible(fixture.page);

      const popup = fixture.page.waitForEvent("popup");
      await inventory.getByRole("button", {name: "Preview docs/guide.md"}).click();
      const preview = await popup;
      await preview.waitForURL(/live-fle-/u);
      await expect(preview.locator("body")).toContainText("# Guide");
      await preview.close();

      await inventory.getByRole("checkbox", {name: "Select docs/guide.md"}).click();
      await inventory.getByRole("button", {name: "Capture 1 selected"}).click();
      await expect(inventory.getByText("Capture results")).toBeVisible();
      await expect(inventory.getByRole("listitem").filter({hasText: "docs/guide.md"})).toContainText("Captured");
      await inventory.getByRole("button", {name: "Capture all pending"}).click();
      await expect(inventory.getByRole("listitem").filter({hasText: "index.html"})).toContainText("Captured");
      await expect(card.getByText("0 pending")).toBeVisible();
      await expect(inventory.getByRole("heading", {name: "Nothing to capture"})).toBeVisible();

      await mkdir(path.join(output, "archive"));
      await rename(path.join(output, "docs", "guide.md"), path.join(output, "archive", "guide.md"));
      await card.getByRole("button", {name: "Scan now"}).click();
      await expect(inventory.getByText("Looks like docs/guide.md moved to archive/guide.md.")).toBeVisible();
      await inventory.getByRole("button", {name: "Relink"}).click();
      await expect(inventory.getByText("Looks like docs/guide.md moved to archive/guide.md.")).toBeHidden();
      await inventory.getByRole("button", {exact: true, name: "All"}).click();
      await expect(inventory.getByRole("row").filter({hasText: "archive/guide.md"})).toContainText("Captured · In sync");

      await card.getByRole("button", {name: "Pause"}).click();
      await expect(card.getByText("Paused")).toBeVisible();
      await card.getByRole("button", {name: "Resume"}).click();
      await expect(card.getByText("Active")).toBeVisible();

      await fixture.page.setViewportSize({height: 800, width: 390});
      const overflow = await fixture.page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      expect(overflow).toBeLessThanOrEqual(0);
      await fixture.page.setViewportSize({height: 900, width: 1280});

      await card.getByRole("button", {name: "Unlink"}).click();
      await expect(fixture.page.getByRole("dialog", {name: "Unlink site-output?"})).toBeVisible();
      await expectAccessible(fixture.page);
      await fixture.page.getByRole("dialog").getByRole("button", {name: "Unlink"}).click();
      await expect(fixture.page.getByRole("heading", {name: "No linked folders yet"})).toBeVisible();
    } finally {
      await fixture.stop();
    }
  });

  test("the Files page counts pending linked-folder entries and filters captured linked files", async ({browser}) => {
    const fixture = await startFixture(browser, "on");
    try {
      const output = path.join(fixture.linkRoot, "notes-output");
      await mkdir(output, {recursive: true});
      await writeFile(path.join(output, "alpha.md"), "# Alpha\n");
      await writeFile(path.join(output, "beta.md"), "# Beta\n");
      await writeFile(path.join(output, "gamma.md"), "# Gamma\n");
      await localLogin(fixture);
      await fixture.page.getByRole("link", {name: "Linked folders"}).click();
      await fixture.page.getByRole("button", {name: "Link a folder"}).click();
      await fixture.page.getByLabel("Directory path").fill(output);
      await fixture.page.getByRole("button", {name: "Link", exact: true}).click();
      const inventory = fixture.page.getByRole("region", {name: /Files · notes-output/u});
      await inventory.getByRole("checkbox", {name: "Select alpha.md"}).click();
      await inventory.getByRole("button", {name: "Capture 1 selected"}).click();
      await expect(inventory.getByRole("listitem").filter({hasText: "alpha.md"})).toContainText("Captured");

      await fixture.page.goto(new URL("/review/files", fixture.server.baseUrl).toString());
      const banner = fixture.page.getByRole("complementary", {name: "Pending in linked folders"});
      await expect(banner).toContainText("2 pending in 1 linked folder");
      await expect(fixture.page.locator("tbody tr")).toHaveCount(1);
      await fixture.page.getByRole("combobox", {name: "Linked files"}).selectOption("not-linked");
      await expect(fixture.page.getByRole("heading", {name: "No files match these filters"})).toBeVisible();
      await fixture.page.getByRole("combobox", {name: "Linked files"}).selectOption("linked");
      await expect(fixture.page).toHaveURL(/linked=linked/u);
      await expect(fixture.page.locator("tbody tr")).toHaveCount(1);
      await expect(fixture.page.locator("tbody tr")).toContainText("In sync");
      await expectAccessible(fixture.page);

      await banner.getByRole("link", {name: "Review pending"}).click();
      await expect(fixture.page).toHaveURL(/\/review\/linked-folders/u);
      await expect(fixture.page.getByRole("region", {name: "notes-output"}).getByText("2 pending")).toBeVisible();
    } finally {
      await fixture.stop();
    }
  });

  test("the Traditional Chinese page labels states, and an absent capability shows no entry", async ({browser}) => {
    const fixture = await startFixture(browser, "off");
    try {
      await localLogin(fixture);
      await expect(fixture.page.getByRole("link", {name: "Linked folders"})).toHaveCount(0);
    } finally {
      await fixture.stop();
    }
    const enabled = await startFixture(browser, "on");
    try {
      const context = await browser.newContext();
      const page = await context.newPage();
      await page.goto(enabled.server.baseUrl);
      await expect(page.getByRole("link", {name: "連結的資料夾"})).toBeVisible();
      await page.getByRole("link", {name: "連結的資料夾"}).click();
      await expect(page.getByRole("heading", {name: "還沒有連結的資料夾"})).toBeVisible();
      await expect(page.getByRole("button", {name: "連結資料夾"})).toBeVisible();
      await context.close();
    } finally {
      await enabled.stop();
    }
  });
});
