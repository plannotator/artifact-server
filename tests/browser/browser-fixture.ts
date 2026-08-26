import {expect, type Browser, type BrowserContext, type Page} from "@playwright/test";

import {
  createTestInstallation,
  removeTestInstallation,
  startTestServer,
  type RunningTestServer,
  type TestInstallation,
} from "../support/runtime-harness.js";

/** One browser test's own installation, server, and signed-in page. */
export interface BrowserFixture {
  readonly context: BrowserContext;
  readonly installation: TestInstallation;
  readonly page: Page;
  readonly server: RunningTestServer;
}

export async function startBrowserFixture(
  browser: Browser,
  options: {readonly timezoneId?: string} = {},
): Promise<BrowserFixture> {
  const installation = await createTestInstallation();
  const server = await startTestServer(installation);
  const context = await browser.newContext(options);
  const page = await context.newPage();
  return {context, installation, page, server};
}

export async function stopBrowserFixture(fixture: BrowserFixture): Promise<void> {
  await fixture.context.close();
  await fixture.server.stop();
  await removeTestInstallation(fixture.installation);
}

export async function localLogin(
  fixture: BrowserFixture,
  waitForApplication = true,
): Promise<void> {
  await fixture.page.goto(fixture.server.baseUrl);
  if (waitForApplication) {
    await expect(fixture.page.getByRole("link", {name: "Artifact Server"})).toBeVisible();
    await expect(fixture.page).toHaveURL(/\/review\?project=prj_default/u);
  }
}

export async function closeTopDialog(page: Page): Promise<void> {
  await page.keyboard.press("Escape");
}

/** Everything this application is forbidden to keep in the browser. */
export async function browserStorage(page: Page): Promise<{
  readonly indexedDatabaseNames: readonly string[];
  readonly localStorageKeys: readonly string[];
  readonly sessionStorageKeys: readonly string[];
}> {
  return page.evaluate(async () => ({
    indexedDatabaseNames: (await indexedDB.databases())
      .map((database) => database.name)
      .filter((name): name is string => name !== undefined),
    localStorageKeys: Object.keys(localStorage),
    sessionStorageKeys: Object.keys(sessionStorage),
  }));
}
