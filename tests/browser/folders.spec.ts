import {expect, test} from "@playwright/test";

import {browserLoginKinds, privateTeamBrowserAccess} from "../../src/core/browser-access.js";
import {OidcIdentityProvider} from "../../src/identity/oidc-identity-provider.js";
import {publishNew} from "../support/publishing.js";
import {
  apiHeaders, createTestInstallation, removeTestInstallation, reserveLoopbackPort,
  startTestServer,
} from "../support/runtime-harness.js";
import {startStubOidcProvider} from "../support/stub-oidc-provider.js";
import {englishContext, localLogin, startBrowserFixture, stopBrowserFixture} from "./browser-fixture.js";

test("Review drills into folders, moves an artifact, and renames both records", async ({browser}) => {
  const fixture = await startBrowserFixture(browser);
  try {
    await publishNew(fixture.server, fixture.installation, {
      accessSetting: "account_required",
      content: "<main>Saved artifact</main>",
      idempotencyKey: "folder-review-browser-fixture",
      name: "Draft report",
    });
    await localLogin(fixture);
    const {page} = fixture;
    const catalog = page.getByRole("complementary", {name: "Artifact catalog"});
    const inspector = page.locator(".as-inspector");
    await expect(page.getByRole("heading", {name: "Draft report", exact: true})).toBeVisible();
    await catalog.getByRole("button", {name: "New folder"}).click();
    let dialog = page.getByRole("dialog", {name: "New folder"});
    await dialog.getByRole("textbox", {name: "Name"}).fill("Reports");
    await dialog.getByRole("button", {name: "New folder"}).click();
    await expect(dialog).toBeHidden();
    await catalog.getByRole("button", {name: "Reports", exact: true}).press("Enter");
    await expect(page).toHaveURL(/folder=fld_/u);
    await expect(catalog.getByText("This folder is empty", {exact: true})).toBeVisible();
    await catalog.getByRole("button", {name: "Actions for Reports"}).click();
    await page.getByRole("button", {name: "Rename", exact: true}).click();
    dialog = page.getByRole("dialog", {name: "Rename Reports"});
    await dialog.getByRole("textbox", {name: "Name"}).fill("Final");
    await dialog.getByRole("button", {name: "Save", exact: true}).click();
    await expect(catalog.getByRole("navigation", {name: "Location"})).toContainText("Final");
    await catalog.getByRole("button", {name: "Project root"}).click();
    await expect(inspector.getByRole("button", {name: "Move…", exact: true})).toBeVisible();
    await inspector.getByRole("button", {name: "Move…", exact: true}).click();
    dialog = page.getByRole("dialog", {name: "Move Draft report"});
    await dialog.getByRole("textbox", {name: "Search this folder"}).fill("Final");
    await dialog.getByRole("button", {name: /Final/u}).click();
    await expect(dialog.getByRole("navigation", {name: "Location"})).toContainText("Final");
    await dialog.getByRole("button", {name: "Move here"}).click();
    await expect(dialog).toBeHidden();
    await expect(catalog.getByRole("button", {name: /Draft report/u})).toHaveCount(0);
    await catalog.getByRole("button", {name: "Final", exact: true}).click();
    await inspector.getByRole("button", {name: "Rename", exact: true}).click();
    dialog = page.getByRole("dialog", {name: "Rename Draft report"});
    await dialog.getByRole("textbox", {name: "Name"}).fill("Final report");
    await dialog.getByRole("button", {name: "Save", exact: true}).click();
    await expect(catalog.getByRole("button", {name: /Final report/u})).toBeVisible();
    await page.reload();
    await expect(page).toHaveURL(/folder=fld_/u);
    await expect(catalog.getByRole("button", {name: /Final report/u})).toBeVisible();
    await expect(inspector.getByRole("navigation", {name: "Location"})).toContainText("Final");
    await expect(page.frameLocator(".as-artifact-frame").frameLocator("iframe").getByText("Saved artifact"))
      .toBeVisible();

    const zhContext = await browser.newContext();
    try {
      const zh = await zhContext.newPage();
      await zh.goto(fixture.server.baseUrl);
      await expect(zh.getByRole("button", {name: "新增資料夾"})).toBeVisible();
      await expect(zh.getByRole("navigation", {name: "位置"}).getByText("專案根目錄")).toBeVisible();
    } finally {
      await zhContext.close();
    }
  } finally {
    await stopBrowserFixture(fixture);
  }
});

test("Review hides placement actions when the live deployment reports folders unavailable", async ({browser}) => {
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
      await publishNew(server, installation, {
        accessSetting: "account_required",
        content: "<main>Remote fixture</main>",
        idempotencyKey: "folder-review-disabled-fixture",
        name: "Remote fixture",
      });
      const session = await fetch(`${applicationOrigin}/api/v1/session`, {
        headers: apiHeaders(installation, "folder-review-disabled-session"),
      });
      await expect(session.json()).resolves.toMatchObject({capabilities: {folders: false}});
      const page = await context.newPage();
      await page.goto(`${applicationOrigin}/auth/login?returnTo=%2Freview`);
      await expect(page.getByRole("heading", {name: "Remote fixture", exact: true})).toBeVisible();
      await expect(page.getByRole("button", {name: "New folder", exact: true})).toHaveCount(0);
      await expect(page.getByRole("navigation", {name: "Location"})).toHaveCount(0);
      await expect(page.getByRole("button", {name: "Move…", exact: true})).toHaveCount(0);
      await expect(page.locator(".as-inspector").getByRole("button", {name: "Rename", exact: true})).toHaveCount(0);
      await expect(page.getByRole("link", {name: "Open trash"})).toHaveCount(0);
      await expect(page.getByRole("button", {name: "Move to Trash", exact: true})).toHaveCount(0);
    } finally {
      await server.stop();
    }
  } finally {
    await context.close();
    await provider.stop();
    await removeTestInstallation(installation);
  }
});
