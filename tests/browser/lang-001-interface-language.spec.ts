import {expect, test, type Browser, type BrowserContext} from "@playwright/test";

import {
  createTestInstallation,
  removeTestInstallation,
  type RunningTestServer,
  startTestServer,
  type TestInstallation,
} from "../support/runtime-harness.js";

/** One installation and a browser context with no stored language choice. */
interface LanguageFixture {
  readonly context: BrowserContext;
  readonly installation: TestInstallation;
  readonly server: RunningTestServer;
}

async function startLanguageFixture(
  browser: Browser,
  initScript?: () => void,
): Promise<LanguageFixture> {
  const installation = await createTestInstallation();
  const server = await startTestServer(installation);
  const context = await browser.newContext();
  if (initScript !== undefined) await context.addInitScript(initScript);
  return {context, installation, server};
}

async function stopLanguageFixture(fixture: LanguageFixture): Promise<void> {
  await fixture.context.close();
  await fixture.server.stop();
  await removeTestInstallation(fixture.installation);
}

test.describe("LANG-001 interface language", () => {
  test("LANG-001-B: the interface opens in Traditional Chinese and switches to English and back", async ({browser}) => {
    const fixture = await startLanguageFixture(browser);
    try {
      const page = await fixture.context.newPage();
      await page.goto(fixture.server.baseUrl);
      await expect(page).toHaveURL(/\/review\?project=prj_default/u);

      await page.goto(`${fixture.server.baseUrl}/review/dashboard`);
      await expect(page.locator("html")).toHaveAttribute("lang", "zh-Hant-TW");
      await expect(page.getByRole("heading", {level: 1, name: "儀表板"})).toBeVisible();

      await page.getByRole("button", {name: "Switch to English"}).click();
      await expect(page.locator("html")).toHaveAttribute("lang", "en");
      await expect(page.getByRole("heading", {level: 1, name: "Dashboard"})).toBeVisible();

      // The choice holds across screens and reloads.
      await page.goto(`${fixture.server.baseUrl}/review/settings/projects`);
      await expect(page.getByRole("heading", {level: 1, name: "Projects"})).toBeVisible();

      await page.getByRole("button", {name: "切換為繁體中文"}).click();
      await expect(page.locator("html")).toHaveAttribute("lang", "zh-Hant-TW");
      await expect(page.getByRole("heading", {level: 1, name: "專案"})).toBeVisible();
    } finally {
      await stopLanguageFixture(fixture);
    }
  });

  test("LANG-001-F: an unknown stored choice or unreadable storage falls back to Traditional Chinese", async ({browser}) => {
    const unknown = await startLanguageFixture(browser);
    try {
      const page = await unknown.context.newPage();
      await page.goto(unknown.server.baseUrl);
      const opensInChinese = async (stored: string) => {
        await page.evaluate((value) => {
          window.localStorage.setItem("artifact-review-locale", value);
        }, stored);
        await page.goto(`${unknown.server.baseUrl}/review/dashboard`);
        await expect(page.locator("html")).toHaveAttribute("lang", "zh-Hant-TW");
        await expect(page.getByRole("heading", {level: 1, name: "儀表板"})).toBeVisible();
      };
      await opensInChinese("fr");
      await opensInChinese("EN");
      await opensInChinese("");
    } finally {
      await stopLanguageFixture(unknown);
    }

    const blocked = await startLanguageFixture(browser, () => {
      Storage.prototype.getItem = () => {
        throw new DOMException("Blocked by the test", "SecurityError");
      };
    });
    try {
      const page = await blocked.context.newPage();
      await page.goto(`${blocked.server.baseUrl}/review/settings/projects`);
      // Reading the language never throws: unreadable storage means the
      // default. (The rest of the shell reads other keys without a guard; that
      // older behaviour is outside this requirement.)
      await expect(page.locator("html")).toHaveAttribute("lang", "zh-Hant-TW");
    } finally {
      await stopLanguageFixture(blocked);
    }
  });
});
