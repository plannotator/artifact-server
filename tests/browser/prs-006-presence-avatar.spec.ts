import {expect, test, type Browser} from "@playwright/test";

import {
  ApiClient,
  issueApiKey,
  MutableClock,
  signInAdministrator,
} from "../support/agent-dispatch.js";
import {publishNew} from "../support/publishing.js";
import {
  createTestInstallation,
  removeTestInstallation,
  startTestServer,
} from "../support/runtime-harness.js";
import {browserStorage, localLogin, type BrowserFixture} from "./browser-fixture.js";
import {createThreadOverApi} from "./comment-api.js";

const fixtureHtml =
  "<!doctype html><html lang=\"en\"><head><title>Presence fixture</title></head>"
  + "<body><h1>Presence fixture</h1><p id=\"first\">The first claim.</p>"
  + "<p id=\"second\">The second claim.</p></body></html>";

/** The shared fixture plus the server clock this test moves deliberately. */
type PresenceFixture = BrowserFixture & {readonly clock: MutableClock};

/**
 * The shared fixture starts a server on the real clock, but a disconnected
 * agent is one whose heartbeat is more than 90 seconds old — so this test
 * owns the server's clock and ages the heartbeat instead of sleeping.
 */
async function startPresenceFixture(browser: Browser): Promise<PresenceFixture> {
  const installation = await createTestInstallation();
  const clock = new MutableClock();
  const server = await startTestServer(installation, {clock});
  const context = await browser.newContext();
  const page = await context.newPage();
  return {clock, context, installation, page, server};
}

async function stopPresenceFixture(fixture: PresenceFixture): Promise<void> {
  await fixture.context.close();
  await fixture.server.stop();
  await removeTestInstallation(fixture.installation);
}

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
    agentSessionId: `session-${input.name}`,
    connectionKey: input.connectionKey,
    displayName: input.name,
    workingDirectory: `/work/${input.name}`,
  });
  return {agentId: agent.id, client};
}

test.describe("PRS-006 presence avatar", () => {
  test("PRS-006-B PRS-006-F: the ring renders idle, working, replying, and disconnected from real server state, the popover says it in words, and reduced motion keeps the states apart without animation", async ({browser}) => {
    const fixture = await startPresenceFixture(browser);
    try {
      const published = (await publishNew(fixture.server, fixture.installation, {
        accessSetting: "account_required",
        content: fixtureHtml,
        idempotencyKey: "prs-006-fixture-page",
        mediaType: "text/html; charset=utf-8",
        name: "Presence fixture",
        path: "index.html",
      })).body;
      const artifactId = published.artifact.id;
      const bodies = {
        first: "The first claim needs a source.",
        second: "The second claim needs a source.",
      };
      for (const [key, body] of Object.entries(bodies)) {
        // Deliberately sequential: the seeding order is the listing order.
        // eslint-disable-next-line no-await-in-loop
        await createThreadOverApi(fixture, {
          artifactId,
          body,
          idempotencyKey: `prs-006-seed-${key}`,
          path: "index.html",
          versionId: published.version.id,
        });
      }
      const agent = await connectFakeAgent(fixture, {
        connectionKey: "prs-006-connection-key",
        name: "pres",
      });

      await localLogin(fixture);
      const page = fixture.page;
      await page.waitForURL(/\/projects\/[^/]+\/artifacts$/);
      await page.goto(
        `${fixture.server.baseUrl}/projects/prj_default/artifacts/${artifactId}`,
      );
      await page.getByRole("tab", {name: "Comments"}).click();
      const cards = page.getByRole("article");
      await expect(cards).toHaveCount(2);

      // Idle: the send button carries the agent's avatar — the Pi brand mark
      // in a circle whose solid ring is the state, not a bare dot.
      const firstCard = cards.filter({hasText: bodies.first});
      const sendButton = firstCard.getByRole("button", {name: "Send to pres"});
      await expect(sendButton).toBeVisible();
      const idleRing = sendButton.locator("[data-presence-ring=\"idle\"]");
      await expect(idleRing).toHaveCount(1);
      await expect(idleRing.locator("img")).toHaveCount(1);

      // Send the annotation and let the agent claim it: the dispatch alone
      // derives "working" — the agent never wrote an activity state.
      await sendButton.click();
      await expect(page.getByText("Sent 1 thread to pres")).toBeVisible();
      expect((await agent.client.claim(agent.agentId, 2)).status).toBe(200);

      // The Sent view shows the live line under the state pill.
      await page.getByLabel("State", {exact: true})
        .selectOption({label: "Sent to an agent"});
      await expect(page.getByText("pres is working…")).toBeVisible();
      const workingRing = page.getByRole("article")
        .locator("[data-presence-ring=\"working\"]");
      await expect(workingRing).toHaveCount(1);
      await expect(
        workingRing.locator(".presence-ring"),
      ).toHaveCSS("animation-name", "presence-pulse");

      // Hovering the avatar explains the state in words; so does focusing it.
      const avatarButton = page.getByRole("article")
        .getByRole("button", {name: "pres — Working"});
      await avatarButton.hover();
      await expect(page.getByText(/Working — took a bundle/)).toBeVisible();
      await expect(page.getByText("/work/pres")).toBeVisible();
      await expect(page.getByText("Last seen")).toBeVisible();
      await page.mouse.move(0, 0);
      await expect(page.getByText(/Working — took a bundle/)).toHaveCount(0);
      await avatarButton.focus();
      await expect(page.getByText(/Working — took a bundle/)).toBeVisible();
      await page.keyboard.press("Tab");

      // The agent's replying beacon turns the ring into the spinning arc.
      expect(
        (await agent.client.fetch(
          `/api/v1/agents/${agent.agentId}/activity`,
          {body: JSON.stringify({state: "replying"}), method: "POST"},
        )).status,
      ).toBe(204);
      await expect(page.getByText("pres is replying…")).toBeVisible();
      const replyingRing = page.getByRole("article")
        .locator("[data-presence-ring=\"replying\"]");
      await expect(
        replyingRing.locator(".presence-ring"),
      ).toHaveCSS("animation-name", "presence-spin");

      // Reduced motion: nothing animates — every ring on the page falls back
      // to the static treatment...
      await page.emulateMedia({reducedMotion: "reduce"});
      await expect(
        replyingRing.locator(".presence-ring"),
      ).toHaveCSS("animation-name", "none");
      const ringAnimationNames = await page.evaluate(() =>
        Array.from(document.querySelectorAll(".presence-ring"))
          .map((ring) => getComputedStyle(ring).animationName)
      );
      expect(ringAnimationNames.length).toBeGreaterThan(0);
      expect(ringAnimationNames.every((name) => name === "none")).toBe(true);
      // ...and the live state stays distinguishable without motion: the
      // replying ring is two-tone where an idle ring is one solid colour.
      const replyingTone = await replyingRing.locator(".presence-ring")
        .evaluate((ring) => {
          const style = getComputedStyle(ring);
          return {side: style.borderLeftColor, top: style.borderTopColor};
        });
      expect(replyingTone.top).not.toBe(replyingTone.side);

      // Age the heartbeat past the 90-second window: the server now derives
      // disconnected, and the live line honestly disappears.
      fixture.clock.advance(100_000);
      await expect(page.getByText("pres is replying…")).toHaveCount(0);

      // With no connected agent left, send is disabled with the reason.
      await page.getByLabel("State", {exact: true})
        .selectOption({label: "All comments"});
      const dimmedSend = page.getByRole("button", {name: "Send to agent"});
      await expect(dimmedSend).toBeVisible();
      await expect(dimmedSend).toHaveAttribute("title", "Connect an agent");

      // A second agent connects; the disconnected one keeps its hollow ring
      // and its row refuses selection, stating when it was last seen.
      await connectFakeAgent(fixture, {
        connectionKey: "prs-006-backup-connection-key",
        name: "backup",
      });
      await page.getByRole("button", {name: "Send with a note"}).click();
      const dialog = page.getByRole("dialog");
      const presRow = dialog.locator("label").filter({hasText: "pres"});
      await expect(presRow.locator("[data-presence-ring=\"disconnected\"]"))
        .toHaveCount(1);
      await expect(presRow.getByRole("radio")).toBeDisabled();
      await expect(presRow.getByText(/Not connected, last seen/)).toBeVisible();
      const disconnectedRing = await presRow.locator(".presence-ring")
        .evaluate((ring) => {
          const style = getComputedStyle(ring);
          return {animationName: style.animationName, opacity: style.opacity};
        });
      expect(disconnectedRing.animationName).toBe("none");
      expect(Number(disconnectedRing.opacity)).toBeLessThan(1);
      const backupRow = dialog.locator("label").filter({hasText: "backup"});
      await expect(backupRow.locator("[data-presence-ring=\"idle\"]"))
        .toHaveCount(1);
      await expect(backupRow.getByText("Connected", {exact: true}))
        .toBeVisible();
      await dialog.getByRole("button", {name: "Cancel"}).click();
      await expect(dialog).toHaveCount(0);

      expect(await browserStorage(page)).toEqual({
        indexedDatabaseNames: [],
        localStorageKeys: [],
        sessionStorageKeys: [],
      });
    } finally {
      await stopPresenceFixture(fixture);
    }
  });
});
