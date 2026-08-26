import {expect, test} from "@playwright/test";

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

const fixtureHtml =
  "<!doctype html><html lang=\"en\"><head><title>One-click fixture</title></head>"
  + "<body><h1>One-click fixture</h1><p id=\"first\">The first claim.</p>"
  + "<p id=\"second\">The second claim.</p></body></html>";

/**
 * One connected agent, registered over the API by an `agent:connect` key —
 * the same credential a bridge holds, never the browser session.
 */
async function connectFakeAgent(
  fixture: BrowserFixture,
  input: {
    readonly capabilities?: object;
    readonly connectionKey: string;
    readonly name: string;
  },
): Promise<{readonly agentId: string; readonly client: ApiClient}> {
  const cookies = await signInAdministrator(fixture.server, fixture.installation);
  const token = await issueApiKey(
    fixture.server,
    cookies,
    ["agent:connect"],
    `${input.name} bridge key`,
  );
  const client = new ApiClient(fixture.server, token);
  const registration = {
    agentSessionId: `session-${input.name}`,
    connectionKey: input.connectionKey,
    displayName: input.name,
    workingDirectory: `/work/${input.name}`,
  };
  const agent = await client.registerAgent(input.capabilities === undefined
    ? registration
    : {...registration, capabilities: input.capabilities});
  return {agentId: agent.id, client};
}

test.describe("PRS-004 one-click send and undo", () => {
  test("PRS-004-B PRS-004-F: a single connected agent sends without a dialog, undo cancels a queued send, and a delivered send reports the undo conflict", async ({browser}) => {
    const fixture = await startBrowserFixture(browser);
    try {
      const published = (await publishNew(fixture.server, fixture.installation, {
        accessSetting: "account_required",
        content: fixtureHtml,
        idempotencyKey: "prs-004-fixture-page",
        mediaType: "text/html; charset=utf-8",
        name: "One-click fixture",
        path: "index.html",
      })).body;
      const artifactId = published.artifact.id;
      const versionId = published.version.id;
      const bodies = {
        first: "The first claim overstates the measurement.",
        second: "The second claim needs a source.",
      };
      for (const [key, body] of Object.entries(bodies)) {
        // Deliberately sequential: the seeding order is the listing order.
        // eslint-disable-next-line no-await-in-loop
        await createThreadOverApi(fixture, {
          artifactId,
          body,
          idempotencyKey: `prs-004-seed-${key}`,
          path: "index.html",
          versionId,
        });
      }
      const agent = await connectFakeAgent(fixture, {
        connectionKey: "prs-004-connection-key",
        name: "solo",
      });

      await localLogin(fixture);
      const page = fixture.page;
      await page.goto(
        `${fixture.server.baseUrl}/review?project=prj_default&artifact=${artifactId}&version=${versionId}`,
      );
      await page.getByRole("tab", {name: "Comments"}).click();
      const cards = page.getByRole("article");
      await expect(cards).toHaveCount(2);

      // One click, no dialog: the primary button names its destination and
      // sends every open comment on the exact version.
      await page.getByRole("button", {name: "Send all open (2) to solo"}).click();
      await expect(page.getByText("Sent 2 threads to solo")).toBeVisible();
      await expect(page.getByRole("dialog")).toHaveCount(0);
      await expect(cards).toHaveCount(0);

      // The server holds exactly one dispatch for it, still queued.
      const owner = new ApiClient(fixture.server, fixture.installation.apiToken);
      const queuedPage = dispatchPageSchema.parse(
        await (await owner.listDispatches("prj_default")).json(),
      );
      expect(queuedPage.items).toHaveLength(1);
      const queued = queuedPage.items[0];
      expect(queued?.state).toBe("queued");

      // Undo while the send is still queued: the annotation comes back.
      await page.getByRole("button", {name: "Undo"}).click();
      await expect(
        page.getByText("Send canceled — the annotations are back."),
      ).toBeVisible();
      await expect(cards).toHaveCount(2);
      // The undo really canceled the dispatch on the server.
      const canceled = dispatchEnvelopeSchema.parse(
        await (await owner.getDispatch(queued?.id ?? "", "prj_default")).json(),
      ).dispatch;
      expect(canceled.state).toBe("canceled");
      expect(canceled.canceledAt).not.toBeNull();
      // Nothing is left in the mailbox for the agent to take.
      expect((await agent.client.claim(agent.agentId, 1)).status).toBe(204);

      // Selecting comments is the secondary path. A send the agent already
      // delivered refuses the undo, and says so.
      await cards.filter({hasText: bodies.second})
        .getByRole("checkbox", {name: `Select comment: ${bodies.second}`})
        .check();
      await page.getByLabel("Selected annotations")
        .getByRole("button", {name: "Send 1 to solo"}).click();
      await expect(page.getByText("Sent 1 thread to solo")).toBeVisible();
      const claimed = await agent.client.claim(agent.agentId, 2);
      expect(claimed.status).toBe(200);
      const delivered =
        dispatchEnvelopeSchema.parse(await claimed.json()).dispatch;
      expect(
        (await agent.client.reportDelivered(delivered.id, agent.agentId)).status,
      ).toBe(200);
      await page.getByRole("button", {name: "Undo"}).click();
      await expect(page.getByText(/Too late to undo/)).toBeVisible();
      // The conflict is honest: the delivered dispatch was not re-canceled.
      const conflicted = dispatchEnvelopeSchema.parse(
        await (await owner.getDispatch(delivered.id, "prj_default")).json(),
      ).dispatch;
      expect(conflicted.state).toBe("delivered");
      expect(conflicted.canceledAt).toBeNull();

      // The note stays reachable behind the split-button caret, as a dialog.
      await page.getByRole("button", {
        name: "Choose agent or send with a note",
      }).first().click();
      await page.getByRole("button", {name: "Send with a note…"}).click();
      const noteDialog = page.getByRole("dialog");
      await expect(noteDialog.getByRole("heading", {name: "Send with a note"}))
        .toBeVisible();
      await expect(noteDialog.getByText("/work/solo")).toBeVisible();
      await expect(noteDialog.getByText("Connected", {exact: true}))
        .toBeVisible();
      await expect(noteDialog.getByLabel("Note for the agent")).toBeVisible();
      await noteDialog.getByRole("button", {name: "Cancel"}).click();
      await expect(noteDialog).toHaveCount(0);

      // A second connected agent appears in the inline destination menu.
      await connectFakeAgent(fixture, {
        connectionKey: "prs-004-second-connection-key",
        name: "duo",
      });
      await expect(page.getByRole("button", {name: "Send all open (1) to solo"}))
        .toBeVisible();
      await page.getByRole("button", {
        name: "Choose agent or send with a note",
      }).first().click();
      await expect(page.getByRole("button", {name: "duo /work/duo"})).toBeVisible();

      expect(await browserStorage(page)).toEqual({
        indexedDatabaseNames: [],
        localStorageKeys: [
          expect.stringMatching(/^dispatch-default:/u),
          "artifact-review-theme",
        ],
        sessionStorageKeys: ["artifact-review-return-url"],
      });
    } finally {
      await stopBrowserFixture(fixture);
    }
  });
});
