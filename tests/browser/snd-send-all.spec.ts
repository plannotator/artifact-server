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
  localLogin,
  startBrowserFixture,
  stopBrowserFixture,
  type BrowserFixture,
} from "./browser-fixture.js";
import {createThreadOverApi} from "./comment-api.js";

const fixtureHtml = "<!doctype html><html lang=\"en\"><head><title>Send all fixture</title></head>"
  + "<body><main><p id=\"target\">Review target</p></main></body></html>";

async function connectAgent(
  fixture: BrowserFixture,
  input: {
    readonly evidence?: "channel" | "mailbox" | "native";
    readonly key: string;
    readonly name: string;
  },
): Promise<{readonly agentId: string; readonly client: ApiClient}> {
  const cookies = await signInAdministrator(fixture.server, fixture.installation);
  const token = await issueApiKey(
    fixture.server,
    cookies,
    ["agent:connect"],
    `${input.name} key`,
  );
  const client = new ApiClient(fixture.server, token);
  const registration = {
    agentSessionId: `session-${input.name}`,
    connectionKey: input.key,
    displayName: input.name,
    workingDirectory: `/work/${input.name}`,
  };
  const agent = await client.registerAgent(input.evidence === undefined
    ? registration
    : {
      ...registration,
      capabilities: {beacon: false, evidence: input.evidence},
    });
  return {agentId: agent.id, client};
}

test.describe("Review send-all", () => {
  test("SND-001-B SND-001-F: every comment page feeds one exact send-all action and sent-state recovery", async ({browser}) => {
    const fixture = await startBrowserFixture(browser);
    try {
      const published = (await publishNew(fixture.server, fixture.installation, {
        accessSetting: "account_required",
        content: fixtureHtml,
        idempotencyKey: "snd-001-page-publish",
        mediaType: "text/html; charset=utf-8",
        name: "Send all fixture",
        path: "index.html",
      })).body;
      const seeded = await Promise.all(Array.from({length: 101}, async (_, index) => {
        const thread = {
          artifactId: published.artifact.id,
          body: `Send-all comment ${String(index + 1).padStart(3, "0")}`,
          idempotencyKey: `snd-001-thread-${index}`,
          path: "index.html",
          versionId: published.version.id,
        };
        return createThreadOverApi(fixture, index === 0
          ? {
            ...thread,
            anchor: {
              htmlAnchor: {
                point: {x: 0.5, y: 0.5},
                selector: "#target",
                tagName: "P",
                text: "Review target",
              },
              originalText: "Review target",
            },
          }
          : thread);
      }));
      const agent = await connectAgent(fixture, {
        key: "snd-001-agent",
        name: "builder",
      });

      await localLogin(fixture);
      const page = fixture.page;
      await page.goto(
        `${fixture.server.baseUrl}/review?project=prj_default&artifact=${published.artifact.id}&version=${published.version.id}`,
      );
      await page.getByRole("tab", {name: "Comments"}).click();
      await expect(page.getByRole("button", {
        name: "Send all open (101) to builder",
      })).toBeVisible();
      await expect(page.locator(".as-comment-card")).toHaveCount(101);
      const preview = page.frameLocator(".as-artifact-frame")
        .frameLocator("iframe");
      await expect(preview.locator("button[data-plannotator-marker]")).toHaveCount(1);

      await page.getByRole("button", {name: "Send all open (101) to builder"}).click();
      await expect(page.getByText("Sent 101 threads to builder")).toBeVisible();
      await expect(page.locator(".as-comment-card")).toHaveCount(0);
      await expect(preview.locator("button[data-plannotator-marker]")).toHaveCount(0);

      const owner = new ApiClient(fixture.server, fixture.installation.apiToken);
      const dispatches = dispatchPageSchema.parse(
        await (await owner.listDispatches("prj_default")).json(),
      ).items;
      expect(dispatches).toHaveLength(2);
      expect(dispatches.flatMap((dispatch) => dispatch.threadIds)).toHaveLength(101);

      await page.getByRole("button", {name: "Sent (101)"}).click();
      await expect(page.locator(".as-comment-card")).toHaveCount(101);
      await expect(page.getByText("Queued", {exact: true})).toHaveCount(101);

      const claimedResponse = await agent.client.claim(agent.agentId, 1);
      expect(claimedResponse.status).toBe(200);
      const claimed = dispatchEnvelopeSchema.parse(await claimedResponse.json()).dispatch;
      expect((await agent.client.reportDelivered(claimed.id, agent.agentId)).status)
        .toBe(200);
      await Promise.all(claimed.threadIds.map((threadId) =>
        owner.setThreadState(published, threadId, "resolved")
      ));
      await page.getByRole("button", {name: "Reload"}).click();
      await expect(page.getByText("Addressed", {exact: true})).toHaveCount(
        claimed.threadIds.length,
      );

      const queued = dispatches.find((dispatch) => dispatch.id !== claimed.id);
      if (queued === undefined) throw new Error("The second dispatch is missing.");
      const queuedThreadId = queued.threadIds[0];
      const queuedThread = seeded.find((thread) => thread.id === queuedThreadId);
      if (queuedThread === undefined) throw new Error("The queued thread is missing.");
      const queuedCard = page.locator(".as-comment-card").filter({
        hasText: queuedThread.body,
      });
      await queuedCard.getByRole("button", {name: "Cancel send"}).click();
      await page.getByRole("button", {exact: true, name: "Open"}).click();
      await expect(page.locator(".as-comment-card")).toHaveCount(1);
      await expect(page.getByText(queuedThread.body)).toBeVisible();
      await expect(page.getByRole("button", {
        name: "Send all open (1) to builder",
      })).toBeVisible();
    } finally {
      await stopBrowserFixture(fixture);
    }
  });

  test("SND-002-B SND-002-F: destination defaults and mailbox copy follow real presence without fallback", async ({browser}) => {
    const fixture = await startBrowserFixture(browser);
    try {
      const published = (await publishNew(fixture.server, fixture.installation, {
        accessSetting: "account_required",
        content: fixtureHtml,
        idempotencyKey: "snd-002-page-publish",
        mediaType: "text/html; charset=utf-8",
        name: "Tier-aware send fixture",
        path: "index.html",
      })).body;
      const first = await createThreadOverApi(fixture, {
        artifactId: published.artifact.id,
        body: "First tier-aware comment",
        idempotencyKey: "snd-002-first-thread",
        path: "index.html",
        versionId: published.version.id,
      });
      await localLogin(fixture);
      const page = fixture.page;
      await page.goto(
        `${fixture.server.baseUrl}/review?project=prj_default&artifact=${published.artifact.id}&version=${published.version.id}`,
      );
      await page.getByRole("tab", {name: "Comments"}).click();
      await expect(page.getByText("No agent connected — connect one to send."))
        .toBeVisible();

      const live = await connectAgent(fixture, {
        evidence: "native",
        key: "snd-002-live",
        name: "live",
      });
      const mailbox = await connectAgent(fixture, {
        evidence: "mailbox",
        key: "snd-002-mailbox",
        name: "mailbox",
      });
      await expect(page.getByRole("button", {name: "Send all open (1)…"}))
        .toBeDisabled();
      await page.getByRole("button", {
        name: "Choose agent or send with a note",
      }).click();
      await page.getByRole("button", {name: "mailbox /work/mailbox"}).click();
      await expect(page.getByText(
        "Queued for mailbox — it picks this up when it next checks in.",
      )).toBeVisible();

      await createThreadOverApi(fixture, {
        artifactId: published.artifact.id,
        body: "Second tier-aware comment",
        idempotencyKey: "snd-002-second-thread",
        path: "index.html",
        versionId: published.version.id,
      });
      await page.getByRole("button", {name: "Reload"}).click();
      await expect(page.getByRole("button", {
        name: "Send all open (1) to mailbox",
      })).toBeVisible();
      const rememberedDestination = () => page.evaluate(() =>
        Object.entries(window.localStorage).find(([key]) =>
          key.startsWith("dispatch-default:")
        )?.[1] ?? null
      );
      await expect.poll(rememberedDestination).toContain('"displayName":"mailbox"');

      expect((await mailbox.client.fetch(
        `/api/v1/agents/${mailbox.agentId}/disconnect`,
        {method: "POST"},
      )).status).toBe(204);
      await expect.poll(rememberedDestination).toContain('"displayName":"mailbox"');
      await expect(page.getByText("mailbox disconnected — pick another"))
        .toBeVisible({timeout: 20_000});
      const owner = new ApiClient(fixture.server, fixture.installation.apiToken);
      const before = dispatchPageSchema.parse(
        await (await owner.listDispatches("prj_default")).json(),
      ).items.length;
      await expect(page.getByRole("button", {
        name: "Send all open (1) to mailbox",
      })).toBeDisabled();
      expect(dispatchPageSchema.parse(
        await (await owner.listDispatches("prj_default")).json(),
      ).items).toHaveLength(before);

      await page.getByRole("button", {
        name: "Choose agent or send with a note",
      }).click();
      await page.getByRole("button", {name: "live /work/live"}).click();
      await expect(page.getByText("Sent 1 thread to live")).toBeVisible();
      await page.getByRole("button", {name: "Send all open (1) to live"}).click();
      await expect(page.getByText("Nothing open to send.")).toBeVisible();
      expect(first.id).toMatch(/^cmt_/u);
      expect(live.agentId).toMatch(/^agt_/u);
    } finally {
      await stopBrowserFixture(fixture);
    }
  });
});
