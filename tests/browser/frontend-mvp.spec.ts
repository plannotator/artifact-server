import {AxeBuilder} from "@axe-core/playwright";
import {expect, test, type Browser, type BrowserContext, type Page} from "@playwright/test";
import {z} from "zod";

import {
  apiHeaders,
  createTestInstallation,
  issueLocalBrowserLogin,
  removeTestInstallation,
  startTestServer,
  type RunningTestServer,
  type TestInstallation,
} from "../support/runtime-harness.js";
import {
  publishNew,
  publishVersion,
} from "../support/publishing.js";

interface BrowserFixture {
  readonly context: BrowserContext;
  readonly installation: TestInstallation;
  readonly page: Page;
  readonly server: RunningTestServer;
}

test.describe("Artifact Server frontend MVP", () => {
  test("local login, projects, artifact opening, session expiry, deep links, and logout work", async ({browser}) => {
    const fixture = await startBrowserFixture(browser);
    try {
      const privateArtifact = await publishNew(fixture.server, fixture.installation, {
        accessSetting: "account_required",
        content: "<!doctype html><title>Private fixture</title><p>private browser content</p>",
        idempotencyKey: "frontend-browser-private",
        name: "Private fixture",
        tags: ["private"],
      });
      const publicArtifact = await publishNew(fixture.server, fixture.installation, {
        accessSetting: "public_link",
        content: "<!doctype html><title>Public fixture</title><p>public browser content</p>",
        idempotencyKey: "frontend-browser-public",
        name: "Public fixture",
        tags: ["ready"],
      });

      await localLogin(fixture);
      await expect(fixture.page.getByRole("heading", {name: "Default"})).toBeVisible();
      await expect(fixture.page.getByText("Private fixture")).toBeVisible();
      await expect(fixture.page.getByText("Public fixture")).toBeVisible();

      await fixture.page.getByLabel("Exact tag").fill("READY");
      await fixture.page.getByRole("button", {name: "Filter"}).click();
      await expect(fixture.page.getByText("Public fixture")).toBeVisible();
      await expect(fixture.page.getByText("Private fixture")).toHaveCount(0);
      await fixture.page.getByRole("button", {name: "Clear"}).click();

      const publicRow = fixture.page.getByRole("row").filter({hasText: "Public fixture"});
      const [publicPage] = await Promise.all([
        fixture.context.waitForEvent("page"),
        publicRow.getByRole("link", {name: "Open artifact"}).click(),
      ]);
      await expect(publicPage.locator("body")).toContainText("public browser content");
      await publicPage.close();

      const privateRow = fixture.page.getByRole("row").filter({hasText: "Private fixture"});
      const [privatePage] = await Promise.all([
        fixture.context.waitForEvent("page"),
        privateRow.getByRole("button", {name: "Open artifact"}).click(),
      ]);
      await expect(privatePage.locator("body")).toContainText("private browser content");
      await privatePage.close();

      await fixture.page.getByRole("link", {name: "Private fixture"}).click();
      await expect(fixture.page).toHaveURL(
        new RegExp(`/projects/prj_default/artifacts/${privateArtifact.body.artifact.id}$`, "u"),
      );
      await fixture.page.reload();
      await expect(fixture.page.getByRole("heading", {name: "Private fixture"})).toBeVisible();

      const cookies = await fixture.context.cookies();
      expect(cookies.some((cookie) => cookie.name === "artifact_session")).toBe(true);
      expect(await fixture.page.evaluate(() => document.cookie)).not.toContain("artifact_session");
      expect(await browserStorage(fixture.page)).toEqual({
        indexedDatabaseNames: [],
        localStorageKeys: [],
        sessionStorageKeys: [],
      });

      await fixture.context.clearCookies();
      await fixture.page.getByRole("button", {name: "Reload"}).click();
      await expect(fixture.page.getByRole("heading", {name: "Sign in required"})).toBeVisible();

      await localLogin(fixture);
      await fixture.page.getByRole("button", {name: "Log out"}).click();
      await expect(fixture.page.getByRole("heading", {name: "Sign in required"})).toBeVisible();

      expect(publicArtifact.body.artifact.projectId).toBe("prj_default");
    } finally {
      await stopBrowserFixture(fixture);
    }
  });

  test("history, comparisons, artifact mutations, members, and one-time API keys work", async ({browser}) => {
    const fixture = await startBrowserFixture(browser);
    try {
      const first = await publishNew(fixture.server, fixture.installation, {
        accessSetting: "account_required",
        content: `before\n${"x".repeat(270_000)}`,
        idempotencyKey: "frontend-workflow-first",
        mediaType: "text/plain; charset=utf-8",
        name: "Workflow fixture",
        path: "payload.txt",
        tags: ["draft"],
      });
      const second = await publishVersion(fixture.server, fixture.installation, {
        artifactId: first.body.artifact.id,
        content: `after\n${"y".repeat(270_000)}`,
        expectedCurrentVersionId: first.body.version.id,
        idempotencyKey: "frontend-workflow-second",
        mediaType: "text/plain; charset=utf-8",
        path: "payload.txt",
      });
      await createActionHistory(fixture, first.body.artifact.id, second.body.version.id);

      await localLogin(fixture);
      await fixture.page.getByRole("link", {name: "Workflow fixture"}).click();

      await fixture.page.getByRole("button", {name: "Edit tags"}).click();
      await fixture.page
        .getByRole("textbox", {name: "Tags"})
        .fill("approved, release");
      await fixture.page.getByRole("button", {name: "Replace tags"}).click();
      await closeTopDialog(fixture.page);
      await expect(fixture.page.getByText("approved", {exact: true})).toBeVisible();

      await fixture.page.getByRole("button", {name: "Make public"}).click();
      await fixture.page.getByRole("button", {name: "Make public", exact: true}).last().click();
      await closeTopDialog(fixture.page);
      await expect(fixture.page.getByText("Public link", {exact: true})).toBeVisible();

      await fixture.page.getByRole("tab", {name: "Versions"}).click();
      await expect(fixture.page.getByRole("heading", {name: "Version 2"})).toBeVisible();
      await fixture.page.getByRole("button", {name: "Inspect manifest"}).first().click();
      await expect(fixture.page.getByText(second.body.version.manifestDigest)).toBeVisible();

      await fixture.page.getByRole("tab", {name: "Compare"}).click();
      await fixture.page.getByRole("button", {name: "Compare"}).click();
      await expect(fixture.page.getByRole("heading", {name: "Changed"})).toBeVisible();
      await expect(fixture.page.getByText(/Binary metadata only/u)).toBeVisible();
      await expect(fixture.page.getByRole("link", {name: "Open before"})).toHaveCount(0);
      const [beforePage, beforeSessionRequest] = await Promise.all([
        fixture.context.waitForEvent("page"),
        fixture.page.waitForRequest((request) =>
          request.method() === "POST"
          && request.url().includes(
            `/versions/${first.body.version.id}/content-sessions`,
          )
        ),
        fixture.page.getByRole("button", {name: "Open before"}).click(),
      ]);
      expect(new URL(beforeSessionRequest.url()).searchParams.get("path")).toBe(
        "payload.txt",
      );
      await expect(beforePage.locator("body")).toContainText("before");
      await beforePage.close();
      const [afterPage] = await Promise.all([
        fixture.context.waitForEvent("page"),
        fixture.page.getByRole("button", {name: "Open after"}).click(),
      ]);
      await expect(afterPage.locator("body")).toContainText("after");
      await afterPage.close();

      await fixture.page.getByRole("tab", {name: "Versions"}).click();
      const earlierVersion = fixture.page.getByRole("article").filter({hasText: "Version 1"});
      await earlierVersion.getByRole("button", {name: "Restore version"}).click();
      await fixture.page.getByRole("button", {name: "Restore version 1"}).click();
      await closeTopDialog(fixture.page);
      await expect(fixture.page.getByText("Current", {exact: true})).toBeVisible();

      await fixture.page.getByRole("tab", {name: "Action history"}).click();
      await expect(fixture.page.getByText("Restored version")).toBeVisible();
      await expect(fixture.page.getByText("Replaced tags").first()).toBeVisible();
      await expect(fixture.page.getByRole("button", {name: "Load more"})).toBeVisible();
      expect(await fixture.page.locator("ol > li").count()).toBe(50);
      await fixture.page.getByRole("button", {name: "Load more"}).click();
      await expect(fixture.page.locator("ol > li")).toHaveCount(57);

      await fixture.page.getByRole("link", {name: "Members"}).click();
      await fixture.page.getByRole("button", {name: "Admit member"}).click();
      await fixture.page.getByLabel("Display name").fill("Frontend member");
      await fixture.page.getByLabel("Email").fill("frontend-member@example.test");
      await fixture.page.getByRole("button", {name: "Admit member", exact: true}).last().click();
      await closeTopDialog(fixture.page);
      const memberRow = fixture.page.getByRole("row").filter({hasText: "Frontend member"});
      await expect(memberRow).toBeVisible();
      await memberRow.getByRole("button", {name: "Deactivate"}).click();
      await fixture.page.getByRole("button", {name: "Deactivate member"}).click();
      await closeTopDialog(fixture.page);
      await expect(memberRow.getByText("inactive", {exact: true})).toBeVisible();

      await fixture.page.getByRole("link", {name: "API keys"}).click();
      await fixture.page.getByRole("button", {name: "Issue API key"}).click();
      await fixture.page
        .getByRole("textbox", {name: "Name", exact: true})
        .fill("Browser workflow key");
      await fixture.page
        .getByLabel("Expires at", {exact: true})
        .fill("2099-01-01T00:00");
      await fixture.page
        .getByRole("checkbox", {name: /Read artifacts/u})
        .click();
      await fixture.page.getByRole("button", {name: "Issue API key", exact: true}).last().click();
      const secret = fixture.page.locator("code").filter({hasText: "as_key_"});
      await expect(secret).toBeVisible();
      const secretValue = await secret.textContent();
      expect(secretValue).toMatch(/^as_key_/u);
      await fixture.page.getByRole("button", {name: "I stored it"}).click();
      await expect(fixture.page.getByText(secretValue ?? "missing-secret")).toHaveCount(0);
      expect(await browserStorage(fixture.page)).toEqual({
        indexedDatabaseNames: [],
        localStorageKeys: [],
        sessionStorageKeys: [],
      });

      const keyCard = fixture.page.getByRole("article").filter({hasText: "Browser workflow key"});
      await keyCard.getByRole("button", {name: "Rotate"}).click();
      await expect(fixture.page.locator("code").filter({hasText: "as_key_"})).toBeVisible();
      await fixture.page.getByRole("button", {name: "I stored it"}).click();
      await expect(keyCard.getByText("Revoked", {exact: true})).toBeVisible();

      await fixture.page.goto(
        `${fixture.server.baseUrl}/projects/prj_default/artifacts/${first.body.artifact.id}`,
      );
      await fixture.page.getByRole("button", {name: "Tombstone artifact"}).click();
      await fixture.page.getByLabel(/Type Workflow fixture/u).fill("Workflow fixture");
      await fixture.page.getByRole("button", {name: "Tombstone artifact", exact: true}).last().click();
      await expect(fixture.page.getByRole("heading", {name: "Default"})).toBeVisible();
      await expect(fixture.page.getByText("Workflow fixture")).toHaveCount(0);
    } finally {
      await stopBrowserFixture(fixture);
    }
  });

  test("hostile boundaries, packaged routing, and accessibility fail closed", async ({browser}) => {
    const fixture = await startBrowserFixture(browser);
    try {
      const first = await publishNew(fixture.server, fixture.installation, {
        accessSetting: "public_link",
        content: "<!doctype html><title>Isolation fixture</title><p>content only</p>",
        idempotencyKey: "frontend-hostile-first",
        name: "Isolation fixture",
      });
      const otherProject = await createProject(fixture, "Other project");

      await localLogin(fixture);
      const shell = await fixture.page.request.get(`${fixture.server.baseUrl}/projects`);
      expect(shell.status()).toBe(200);
      expect(shell.headers()["content-security-policy"]).toContain("frame-ancestors 'none'");
      expect(shell.headers()["referrer-policy"]).toBe("no-referrer");
      expect(shell.headers()["x-content-type-options"]).toBe("nosniff");
      expect(shell.headers()["cache-control"]).toBe("no-cache, must-revalidate");

      const apiFallback = await fixture.page.request.get(
        `${fixture.server.baseUrl}/api/v1/route-that-does-not-exist`,
      );
      expect(apiFallback.status()).toBe(404);
      expect(apiFallback.headers()["content-type"]).toContain("application/json");

      const noCsrf = await fixture.page.request.post(
        `${fixture.server.baseUrl}/api/v1/projects`,
        {data: {name: "Must not exist"}},
      );
      expect(noCsrf.status()).toBe(403);

      const crossedProject = await fixture.page.request.get(
        `${fixture.server.baseUrl}/api/v1/artifacts/${first.body.artifact.id}?projectId=${otherProject.id}`,
      );
      expect(crossedProject.status()).toBe(404);

      const contentUi = new URL("/projects", first.body.links.version);
      const isolated = await fixture.page.request.get(contentUi.toString());
      expect(isolated.status()).toBe(404);
      expect(isolated.headers()["content-type"]).toContain("application/json");

      await fixture.page.goto(`${fixture.server.baseUrl}/projects`);
      await fixture.page.reload();
      await expect(fixture.page.getByRole("heading", {name: "Projects"})).toBeVisible();
      const accessibility = await new AxeBuilder({page: fixture.page})
        .withTags(["wcag2a", "wcag2aa"])
        .analyze();
      expect(accessibility.violations).toEqual([]);
    } finally {
      await stopBrowserFixture(fixture);
    }
  });

  test("project bootstrap failures remain visible and local expiration bounds use wall-clock time", async ({browser}) => {
    const fixture = await startBrowserFixture(browser, {
      timezoneId: "America/Los_Angeles",
    });
    try {
      await fixture.page.clock.install({
        time: new Date("2026-08-16T12:34:00.000Z"),
      });
      await fixture.page.route("**/api/v1/projects", async (route) => {
        await route.fulfill({
          body: JSON.stringify({
            error: {
              code: "INTERNAL_ERROR",
              message: "Project storage is temporarily unavailable.",
            },
          }),
          contentType: "application/json",
          status: 500,
        });
      });
      await localLogin(fixture, false);
      await expect(fixture.page.getByRole("heading", {name: "Request failed"})).toBeVisible();
      await expect(fixture.page.getByRole("heading", {name: "No projects"})).toHaveCount(0);

      await fixture.page.unroute("**/api/v1/projects");
      await fixture.page.getByRole("button", {name: "Try again"}).click();
      await expect(fixture.page.getByRole("heading", {name: "Default"})).toBeVisible();

      await fixture.page.getByRole("link", {name: "API keys"}).click();
      await fixture.page.getByRole("button", {name: "Issue API key"}).click();
      await expect(fixture.page.getByLabel("Expires at", {exact: true})).toHaveAttribute(
        "min",
        "2026-08-16T05:34",
      );
    } finally {
      await stopBrowserFixture(fixture);
    }
  });
});

async function startBrowserFixture(
  browser: Browser,
  options: {readonly timezoneId?: string} = {},
): Promise<BrowserFixture> {
  const installation = await createTestInstallation();
  const server = await startTestServer(installation);
  const context = await browser.newContext(options);
  const page = await context.newPage();
  return {context, installation, page, server};
}

async function stopBrowserFixture(fixture: BrowserFixture): Promise<void> {
  await fixture.context.close();
  await fixture.server.stop();
  await removeTestInstallation(fixture.installation);
}

async function localLogin(
  fixture: BrowserFixture,
  waitForApplication = true,
): Promise<void> {
  const token = await issueLocalBrowserLogin(
    fixture.server,
    fixture.installation,
  );
  const login = new URL("/auth/local", fixture.server.baseUrl);
  login.searchParams.set("token", token);
  await fixture.page.goto(login.toString());
  if (waitForApplication) {
    await expect(fixture.page.getByRole("link", {name: "Artifact Server"})).toBeVisible();
  }
}

async function closeTopDialog(page: Page): Promise<void> {
  await page.keyboard.press("Escape");
}

async function browserStorage(page: Page): Promise<{
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

async function createProject(
  fixture: BrowserFixture,
  name: string,
): Promise<{readonly id: string}> {
  const response = await fetch(`${fixture.server.baseUrl}/api/v1/projects`, {
    body: JSON.stringify({name}),
    headers: apiHeaders(fixture.installation, "frontend-browser-project"),
    method: "POST",
  });
  expect(response.status).toBe(201);
  return z.object({
    project: z.object({id: z.string()}),
  }).parse(await response.json()).project;
}

async function createActionHistory(
  fixture: BrowserFixture,
  artifactId: string,
  expectedCurrentVersionId: string,
): Promise<void> {
  const responses = await Promise.all(Array.from({length: 52}, (_, index) =>
    fetch(
      `${fixture.server.baseUrl}/api/v1/artifacts/${artifactId}/tags?projectId=prj_default`,
      {
        body: JSON.stringify({
          expectedCurrentVersionId,
          tags: [`history-${index}`],
        }),
        headers: apiHeaders(
          fixture.installation,
          `frontend-history-${String(index).padStart(3, "0")}`,
        ),
        method: "PATCH",
      },
    )
  ));
  expect(responses.every((response) => response.status === 200)).toBe(true);
}
