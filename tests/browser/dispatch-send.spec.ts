import {AxeBuilder} from "@axe-core/playwright";
import {expect, test, type Page} from "@playwright/test";

import {
  ApiClient,
  dispatchEnvelopeSchema,
  dispatchPageSchema,
  issueApiKey,
  signInAdministrator,
} from "../support/agent-dispatch.js";
import {publishNew} from "../support/publishing.js";
import {
  browserStorage,
  localLogin,
  startBrowserFixture,
  stopBrowserFixture,
  type BrowserFixture,
} from "./browser-fixture.js";
import {createThreadOverApi} from "./comment-api.js";

const commentsFixtureHtml =
  "<!doctype html><html lang=\"en\"><head><title>Dispatch fixture</title></head>"
  + "<body><h1>Dispatch fixture</h1><p id=\"first\">The first claim.</p>"
  + "<p id=\"second\">The second claim.</p><p id=\"third\">The third claim.</p>"
  + "</body></html>";

const reviewFixtureHtml =
  "<!doctype html><html lang=\"en\"><head><meta charset=\"utf-8\">"
  + "<title>Dispatch review fixture</title></head>"
  + "<body><h1>Dispatch review fixture</h1>"
  + "<p id=\"review-target\">The axis label on this chart is wrong.</p></body></html>";

/**
 * One connected agent, registered over the API by an `agent:connect` key —
 * the same credential the Pi bridge holds, never the browser session.
 */
async function connectFakeAgent(
  fixture: BrowserFixture,
  input: {readonly connectionKey: string; readonly name: string},
): Promise<{readonly agentId: string; readonly client: ApiClient}> {
  const cookies = await signInAdministrator(fixture.server, fixture.installation);
  const token = await issueApiKey(
    fixture.server,
    cookies,
    ["agent:connect"],
    `${input.name} bridge key`,
  );
  const client = new ApiClient(fixture.server, token);
  const agent = await client.registerAgent({
    agentSessionId: "pi-session-browser",
    connectionKey: input.connectionKey,
    displayName: input.name,
    workingDirectory: `/work/${input.name}`,
  });
  return {agentId: agent.id, client};
}

/**
 * Let every running transition finish before a colour is measured.
 *
 * The dialog fades in, and a contrast check taken mid-fade reads the blended
 * pixels rather than the palette, which is neither what the reader sees nor
 * what the tokens promise.
 */
async function settleMotion(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const running = document.getAnimations()
      .filter((animation) => animation.playState === "running")
      .map((animation) => animation.finished.catch(() => undefined));
    await Promise.race([
      Promise.all(running),
      new Promise((resolve) => setTimeout(resolve, 2_000)),
    ]);
  });
}

async function expectNoAccessibilityViolations(page: Page): Promise<void> {
  await settleMotion(page);
  const accessibility = await new AxeBuilder({page})
    .withTags(["wcag2a", "wcag2aa"])
    .analyze();
  expect(accessibility.violations).toEqual([]);
}

test.describe("Sending annotations to an agent", () => {
  test("a send takes annotations off the artifact, the Sent filter follows them, and a cancel brings them back", async ({browser}) => {
    const fixture = await startBrowserFixture(browser);
    try {
      const published = (await publishNew(fixture.server, fixture.installation, {
        accessSetting: "account_required",
        content: commentsFixtureHtml,
        idempotencyKey: "dispatch-send-fixture",
        mediaType: "text/html; charset=utf-8",
        name: "Dispatch fixture",
        path: "index.html",
      })).body;
      const artifactId = published.artifact.id;
      const versionId = published.version.id;

      const bodies = {
        first: "The first claim overstates the measurement.",
        second: "The second claim needs a source.",
        third: "The third claim contradicts the chart.",
      };
      // Seeded oldest first, which is the order one bundle carries them in.
      const threadIds = new Map<string, string>();
      for (const [key, body] of Object.entries(bodies)) {
        // Deliberately sequential: the seeding order is the bundle order.
        // eslint-disable-next-line no-await-in-loop
        const thread = await createThreadOverApi(fixture, {
          artifactId,
          body,
          idempotencyKey: `dispatch-send-seed-${key}`,
          path: "index.html",
          versionId,
        });
        threadIds.set(key, thread.id);
      }

      const agent = await connectFakeAgent(fixture, {
        connectionKey: "dispatch-send-connection-key",
        name: "site",
      });
      const owner = new ApiClient(fixture.server, fixture.installation.apiToken);

      await localLogin(fixture);
      const page = fixture.page;
      // The post-login landing redirects home -> project via location.replace;
      // wait for it to settle before navigating, or the goto races the replace.
      await page.waitForURL(/\/projects\/[^/]+\/artifacts$/);
      await page.goto(
        `${fixture.server.baseUrl}/projects/prj_default/artifacts/${artifactId}`,
      );
      await page.getByRole("tab", {name: "Comments"}).click();
      const cards = page.getByRole("article");
      await expect(cards).toHaveCount(3);

      // One annotation, sent from its own card through the agent picker.
      const firstCard = cards.filter({hasText: bodies.first});
      await firstCard.getByRole("button", {name: "Send to agent"}).click();
      const picker = page.getByRole("dialog");
      await expect(picker.getByRole("heading", {name: "Send to agent"}))
        .toBeVisible();
      await expect(picker.getByText("site", {exact: true})).toBeVisible();
      await expect(picker.getByText("/work/site")).toBeVisible();
      await expect(picker.getByText("Connected", {exact: true})).toBeVisible();
      await expectNoAccessibilityViolations(page);
      await picker.getByRole("button", {name: "Send 1 annotation"}).click();

      // Send is consumptive: the annotation leaves the artifact's own views.
      await expect(picker).toHaveCount(0);
      await expect(cards).toHaveCount(2);
      await expect(cards.filter({hasText: bodies.first})).toHaveCount(0);

      // The "Sent" filter is the one view that still shows it, with its state.
      await page.getByLabel("State", {exact: true})
        .selectOption({label: "Sent to an agent"});
      const sentCard = page.getByRole("article").filter({hasText: bodies.first});
      await expect(sentCard).toBeVisible();
      await expect(sentCard.getByText("Queued", {exact: true})).toBeVisible();
      await expectNoAccessibilityViolations(page);

      // The agent takes the bundle, reports it delivered, and resolves it.
      const claimed = await agent.client.claim(agent.agentId, 2);
      expect(claimed.status).toBe(200);
      const singleDispatch =
        dispatchEnvelopeSchema.parse(await claimed.json()).dispatch;
      expect(singleDispatch.threadIds).toHaveLength(1);
      expect(
        (await agent.client.reportDelivered(singleDispatch.id, agent.agentId))
          .status,
      ).toBe(200);
      const firstThreadId = singleDispatch.threadIds[0] ?? "";
      expect(firstThreadId).toBe(threadIds.get("first"));
      expect(
        (await owner.setThreadState(published, firstThreadId, "resolved")).status,
      ).toBe(200);

      await page.getByRole("button", {name: "Reload comments"}).click();
      await expect(sentCard.getByText("Addressed", {exact: true})).toBeVisible();

      // "Send all open on this version": the two survivors become one bundle.
      await page.getByLabel("State", {exact: true})
        .selectOption({label: "All comments"});
      await page.getByLabel("Version", {exact: true})
        .selectOption({label: "Version 1"});
      await expect(page.getByRole("article")).toHaveCount(2);
      await page.getByRole("button", {name: "Send all open on this version"})
        .click();
      const bundlePicker = page.getByRole("dialog");
      await bundlePicker.getByRole("button", {name: "Send 2 annotations"})
        .click();
      await expect(bundlePicker).toHaveCount(0);
      await expect(page.getByRole("heading", {name: "No matching comments"}))
        .toBeVisible();

      // One send, one dispatch, both annotations in it, oldest first.
      const listed = dispatchPageSchema.parse(
        await (await owner.listDispatches(published.artifact.projectId)).json(),
      );
      expect(listed.items).toHaveLength(2);
      const bundle = listed.items.find((dispatch) =>
        dispatch.id !== singleDispatch.id
      );
      expect(bundle?.state).toBe("queued");
      expect(bundle?.agentId).toBe(agent.agentId);
      expect(bundle?.agentDisplayName).toBe("site");
      expect(bundle?.threadIds).toEqual([
        threadIds.get("second"),
        threadIds.get("third"),
      ]);

      // Cancelling that queued send is the one way annotations come back.
      await page.getByLabel("State", {exact: true})
        .selectOption({label: "Sent to an agent"});
      const bundleCard = page.getByRole("article").filter({
        hasText: bodies.second,
      });
      await expect(bundleCard.getByText("Queued", {exact: true})).toBeVisible();
      await bundleCard.getByRole("button", {name: "Cancel send"}).click();
      await expect(page.getByRole("article").filter({hasText: bodies.second}))
        .toHaveCount(0);

      // Back in the open list, on the artifact's own surface, as if unsent.
      await page.getByLabel("State", {exact: true})
        .selectOption({label: "Open"});
      await expect(page.getByRole("article")).toHaveCount(2);
      await expect(page.getByRole("article").filter({hasText: bodies.second}))
        .toBeVisible();
      await expect(page.getByRole("article").filter({hasText: bodies.third}))
        .toBeVisible();
      // Nothing is left in the mailbox for the agent to take.
      expect((await agent.client.claim(agent.agentId, 1)).status).toBe(204);

      expect(await browserStorage(page)).toEqual({
        indexedDatabaseNames: [],
        localStorageKeys: [],
        sessionStorageKeys: [],
      });
    } finally {
      await stopBrowserFixture(fixture);
    }
  });

  test("a sent annotation loses its pin on the review screen", async ({browser}) => {
    const fixture = await startBrowserFixture(browser);
    try {
      const published = (await publishNew(fixture.server, fixture.installation, {
        accessSetting: "account_required",
        content: reviewFixtureHtml,
        idempotencyKey: "dispatch-review-fixture",
        mediaType: "text/html; charset=utf-8",
        name: "Dispatch review fixture",
        path: "index.html",
      })).body;
      await connectFakeAgent(fixture, {
        connectionKey: "dispatch-review-connection-key",
        name: "review",
      });

      await localLogin(fixture);
      const page = fixture.page;
      // The post-login landing redirects home -> project via location.replace;
      // wait for it to settle before navigating, or the goto races the replace.
      await page.waitForURL(/\/projects\/[^/]+\/artifacts$/);
      await page.goto(
        `${fixture.server.baseUrl}/projects/prj_default/artifacts/`
          + `${published.artifact.id}/versions/${published.version.id}/review`,
      );
      const reviewFrame = page.frameLocator("iframe[title$=\"annotated page\"]");
      const sandbox = reviewFrame.frameLocator("iframe");
      await expect(sandbox.locator("#review-target")).toBeVisible();

      // Pin one annotation on the rendered page, the way a reviewer does.
      await sandbox.locator("#review-target").hover();
      await sandbox.locator("#review-target").click();
      const composer = reviewFrame.getByPlaceholder("Add a comment...");
      await expect(composer).toBeVisible();
      await composer.fill("This axis label reads as a percentage but holds a count.");
      await reviewFrame.getByRole("button", {name: "Save"}).click();
      await page.getByRole("button", {name: "Comments — 1 thread"}).click();

      const card = page.getByRole("article").filter({
        hasText: "This axis label reads as a percentage but holds a count.",
      });
      await expect(card).toBeVisible();
      const marker = sandbox.locator("button[data-plannotator-marker]");
      await expect(marker).toHaveCount(1);

      await card.getByRole("button", {name: "Send to agent"}).click();
      const picker = page.getByRole("dialog");
      await expect(picker.getByText("/work/review")).toBeVisible();
      await picker.getByRole("button", {name: "Send 1 annotation"}).click();

      // The pin goes with the card: no send status decorates this surface.
      await expect(picker).toHaveCount(0);
      await expect(card).toHaveCount(0);
      await expect(marker).toHaveCount(0);

      expect(await browserStorage(page)).toEqual({
        indexedDatabaseNames: [],
        localStorageKeys: [],
        sessionStorageKeys: [],
      });
    } finally {
      await stopBrowserFixture(fixture);
    }
  });
});
