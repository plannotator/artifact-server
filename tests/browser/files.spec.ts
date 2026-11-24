import {AxeBuilder} from "@axe-core/playwright";
import {expect, type Page, test} from "@playwright/test";
import {z} from "zod";

import {browserLoginKinds, privateTeamBrowserAccess} from "../../src/core/browser-access.js";
import {OidcIdentityProvider} from "../../src/identity/oidc-identity-provider.js";
import {publishNew, publishVersion} from "../support/publishing.js";
import {
  apiHeaders, createTestInstallation, removeTestInstallation, reserveLoopbackPort, startTestServer,
  type RunningTestServer, type TestInstallation,
} from "../support/runtime-harness.js";
import {startStubOidcProvider} from "../support/stub-oidc-provider.js";
import {englishContext, localLogin, startBrowserFixture, stopBrowserFixture} from "./browser-fixture.js";

const folderResult = z.object({folder: z.object({id: z.string()})});
const fileList = z.object({items: z.array(z.object({id: z.string(), name: z.string(), folderId: z.string().nullable()}).loose())});

test.describe("Files page", () => {
  test("FOV-004-B: filter, reload, select a range, move, trash with Undo, purge, and drill into a folder in Review", async ({browser}) => {
    const fixture = await startBrowserFixture(browser);
    try {
      const {server, installation} = fixture;
      const reports = await createFolder(server, installation, "Reports");
      await publish(server, installation, "Alpha notes", "text/markdown", "alpha.md");
      await publish(server, installation, "Beta notes", "text/markdown", "beta.md");
      await publish(server, installation, "Gamma notes", "text/markdown", "gamma.md");
      await publish(server, installation, "Website draft", "text/html; charset=utf-8", "index.html");
      await localLogin(fixture);
      const {page} = fixture;

      await page.getByRole("link", {name: "Open files"}).click();
      await expect(page).toHaveURL(/\/review\/files/u);
      await expect(page.getByRole("heading", {name: "Files", exact: true, level: 1})).toBeVisible();
      await expect(rows(page)).toHaveCount(4);
      await page.getByRole("combobox", {name: "Kind"}).selectOption("markdown");
      await page.getByRole("searchbox", {name: "Search names and tags"}).fill("notes");
      await expect(page).toHaveURL(/kind=markdown.*search=notes|search=notes.*kind=markdown/u);
      await expect(rows(page)).toHaveCount(3);
      await page.reload();
      await expect(page.getByRole("combobox", {name: "Kind"})).toHaveValue("markdown");
      await expect(page.getByRole("searchbox", {name: "Search names and tags"})).toHaveValue("notes");
      await expect(rows(page)).toHaveCount(3);
      const accessibility = await new AxeBuilder({page}).withTags(["wcag2a", "wcag2aa"]).analyze();
      expect(accessibility.violations).toEqual([]);

      await page.getByRole("checkbox", {name: "Select Alpha notes"}).click();
      await page.getByRole("checkbox", {name: "Select Gamma notes"}).click({modifiers: ["Shift"]});
      const selection = page.getByRole("toolbar", {name: "Selection actions"});
      await expect(selection).toContainText("3 selected");
      await selection.getByRole("button", {name: "Move…"}).click();
      const dialog = page.getByRole("dialog", {name: "Move 3 files"});
      await dialog.getByRole("button", {name: /Reports/u}).click();
      await expect(dialog.getByRole("navigation", {name: "Location"})).toContainText("Reports");
      const dialogAccessibility = await new AxeBuilder({page}).include("[role=dialog]").withTags(["wcag2a", "wcag2aa"]).analyze();
      expect(dialogAccessibility.violations).toEqual([]);
      await dialog.getByRole("button", {name: "Move here"}).click();
      await expect(dialog).toBeHidden();
      await expect(page.getByText("Updated 3 files.")).toBeVisible();
      expect((await listFiles(server, installation, `folderId=${reports}`)).map(({name}) => name).toSorted())
        .toEqual(["Alpha notes", "Beta notes", "Gamma notes"]);

      await expect(page.getByRole("combobox", {name: "Project"})).toHaveValue("prj_default");
      await page.getByRole("navigation", {name: "Folders"}).getByRole("button", {name: "Reports", exact: true}).click();
      await expect(page).toHaveURL(new RegExp(`folder=${reports}`, "u"));
      await expect(rows(page)).toHaveCount(3);
      await page.getByRole("checkbox", {name: "Select all loaded files"}).check();
      await page.getByRole("toolbar", {name: "Selection actions"}).getByRole("button", {name: "Move to Trash"}).click();
      await expect(page.getByText("Moved 3 files to the trash.")).toBeVisible();
      await expect(page.getByRole("heading", {name: "No files match these filters"})).toBeVisible();
      await page.getByRole("button", {name: "Undo"}).click();
      await expect(page.getByText("Recovered 3 files.")).toBeVisible();
      await expect(rows(page)).toHaveCount(3);

      await page.getByRole("checkbox", {name: "Select Beta notes"}).click();
      await page.getByRole("toolbar", {name: "Selection actions"}).getByRole("button", {name: "Move to Trash"}).click();
      await expect(rows(page)).toHaveCount(2);
      await page.getByRole("link", {name: "Trash"}).click();
      await expect(page).toHaveURL(/\/review\/files\/trash$/u);
      const trashed = page.getByRole("row").filter({hasText: "Beta notes"});
      await trashed.getByRole("button", {name: "Purge Beta notes"}).click();
      const purge = page.getByRole("dialog", {name: "Purge Beta notes?"});
      await purge.getByRole("textbox", {name: "Type the exact name to confirm"}).fill("Beta notes");
      await purge.getByRole("button", {name: "Purge", exact: true}).click();
      await expect(page.getByText("Purged Beta notes.")).toBeVisible();

      await page.goto(`${server.baseUrl}/review`);
      const catalog = page.getByRole("complementary", {name: "Artifact catalog"});
      await expect(page.getByRole("navigation", {name: "Folders"})).toHaveCount(0);
      await catalog.getByRole("button", {name: "Reports", exact: true}).press("Enter");
      await expect(page).toHaveURL(new RegExp(`folder=${reports}`, "u"));
      await expect(catalog.getByRole("button", {name: /Alpha notes/u})).toBeVisible();
      await expect(catalog.getByRole("button", {name: /Website draft/u})).toHaveCount(0);
      await catalog.getByRole("navigation", {name: "Location"}).getByRole("button", {name: "Project root"}).click();
      await expect(catalog.getByRole("button", {name: /Website draft/u})).toBeVisible();

      const zhContext = await browser.newContext();
      try {
        const zh = await zhContext.newPage();
        await zh.goto(`${server.baseUrl}/review/files`);
        await expect(zh.getByRole("heading", {name: "檔案", exact: true, level: 1})).toBeVisible();
        await expect(zh.getByRole("combobox", {name: "類型"})).toBeVisible();
      } finally {
        await zhContext.close();
      }
    } finally {
      await stopBrowserFixture(fixture);
    }
  });

  test("FOV-004-F: per-item failures show reasons with retry, narrow screens keep the page width, and Review stays sidebar-free", async ({browser}) => {
    const fixture = await startBrowserFixture(browser);
    try {
      const {server, installation} = fixture;
      const archive = await createFolder(server, installation, "Archive");
      await publish(server, installation, "Steady report", "text/html; charset=utf-8", "index.html");
      const racing = await publish(server, installation, "Racing report", "text/html; charset=utf-8", "index.html");
      await localLogin(fixture);
      const {page} = fixture;
      await page.goto(`${server.baseUrl}/review/files`);
      await expect(rows(page)).toHaveCount(2);
      await page.getByRole("checkbox", {name: "Select all loaded files"}).check();
      const changed = await publishVersion(server, installation, {
        artifactId: racing.artifactId, expectedCurrentVersionId: racing.versionId, content: "<main>Changed elsewhere</main>",
        idempotencyKey: "files-browser-race",
      });
      expect(changed.response.status).toBe(201);
      await page.getByRole("toolbar", {name: "Selection actions"}).getByRole("button", {name: "Move…"}).click();
      const move = page.getByRole("dialog", {name: "Move 2 files"});
      await move.getByRole("button", {name: /Archive/u}).click();
      await move.getByRole("button", {name: "Move here"}).click();
      const result = page.getByRole("dialog", {name: "1 item did not change"});
      await expect(result).toContainText("Racing report");
      await expect(result).toContainText("Changed elsewhere");
      expect((await listFiles(server, installation, `folderId=${archive}`)).map(({name}) => name)).toEqual(["Steady report"]);
      await result.getByRole("button", {name: "Retry Racing report"}).click();
      await expect(result.getByText("Racing report")).toHaveCount(0);
      expect((await listFiles(server, installation, `folderId=${archive}`)).map(({name}) => name).toSorted())
        .toEqual(["Racing report", "Steady report"]);
      await result.getByRole("button", {name: "Close"}).last().click();

      await page.setViewportSize({width: 375, height: 800});
      await page.reload();
      await expect(rows(page)).toHaveCount(2);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
      await expect(page.getByRole("navigation", {name: "Folders"})).toBeHidden();
      await page.getByText("Folder", {exact: true}).click();
      await expect(page.getByRole("navigation", {name: "Folders"})).toBeVisible();

      await page.setViewportSize({width: 1280, height: 800});
      await page.goto(`${server.baseUrl}/review`);
      await expect(page.getByRole("link", {name: "Open files"})).toBeVisible();
      await expect(page.getByRole("navigation", {name: "Folders"})).toHaveCount(0);
    } finally {
      await stopBrowserFixture(fixture);
    }

    const installation = await createTestInstallation();
    const provider = await startStubOidcProvider();
    const context = await englishContext(browser);
    provider.claims.email = "administrator@example.test";
    try {
      const port = await reserveLoopbackPort();
      const applicationOrigin = `http://127.0.0.1:${port}`;
      const server = await startTestServer(installation, {
        applicationOrigin,
        port,
        browserAccess: privateTeamBrowserAccess(browserLoginKinds.oidc),
        interactiveIdentityProvider: new OidcIdentityProvider({
          clientId: provider.clientId, clientSecret: null, issuer: provider.issuer,
          redirectUri: `${applicationOrigin}/auth/callback`, scopes: "openid email profile",
        }),
      });
      try {
        await publish(server, installation, "Remote fixture", "text/html; charset=utf-8", "index.html");
        const session = await fetch(`${applicationOrigin}/api/v1/session`, {headers: apiHeaders(installation, "files-disabled-session")});
        await expect(session.json()).resolves.toMatchObject({capabilities: {fileOverview: false, batch: false}});
        const page = await context.newPage();
        await page.goto(`${applicationOrigin}/auth/login?returnTo=%2Freview`);
        await expect(page.getByRole("heading", {name: "Remote fixture", exact: true})).toBeVisible();
        await expect(page.getByRole("link", {name: "Open files"})).toHaveCount(0);
        await page.goto(`${applicationOrigin}/review/files`);
        await expect(page.getByRole("heading", {name: "Remote fixture", exact: true})).toBeVisible();
        await expect(page.getByRole("heading", {name: "Files", exact: true})).toHaveCount(0);
        await expect(page.getByRole("checkbox", {name: /^Select /u})).toHaveCount(0);
      } finally {
        await server.stop();
      }
    } finally {
      await context.close();
      await provider.stop();
      await removeTestInstallation(installation);
    }
  });
});

function rows(page: Page) {
  return page.getByRole("table").getByRole("row").filter({has: page.getByRole("cell")});
}

async function publish(
  server: RunningTestServer, installation: TestInstallation, name: string, mediaType: string, path: string,
): Promise<{readonly artifactId: string; readonly versionId: string}> {
  const published = await publishNew(server, installation, {
    accessSetting: "account_required", content: `<main>${name}</main>`, idempotencyKey: `files-browser-${name}`,
    mediaType, name, path,
  });
  expect(published.response.status).toBe(201);
  return {artifactId: published.body.artifact.id, versionId: published.body.version.id};
}

async function createFolder(server: RunningTestServer, installation: TestInstallation, name: string): Promise<string> {
  const response = await fetch(`${server.baseUrl}/api/v1/projects/prj_default/folders`, {
    method: "POST",
    headers: apiHeaders(installation, `files-browser-folder-${name}`),
    body: JSON.stringify({name, parentFolderId: null}),
  });
  expect(response.status).toBe(201);
  return folderResult.parse(await response.json()).folder.id;
}

async function listFiles(server: RunningTestServer, installation: TestInstallation, query: string) {
  const response = await fetch(`${server.baseUrl}/api/v1/files?${query}`, {headers: apiHeaders(installation, "files-browser-read")});
  expect(response.status).toBe(200);
  return fileList.parse(await response.json()).items;
}
