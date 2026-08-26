import {expect, test} from "@playwright/test";
import {z} from "zod";

import {ApiClient, issueApiKey, signInAdministrator} from "../support/agent-dispatch.js";
import {publishNew} from "../support/publishing.js";
import {localLogin, startBrowserFixture, stopBrowserFixture} from "./browser-fixture.js";
import {createThreadOverApi, listThreadsOverApi} from "./comment-api.js";
import {
  callTool,
  expectedToolNames,
  installFakeModelContext,
  registeredToolNames,
} from "./webmcp-fake.js";

const fixtureHtml =
  "<!doctype html><html lang=\"en\"><head><title>WebMCP fixture</title></head>"
  + "<body><h1>WebMCP fixture</h1><p id=\"first\">The first claim.</p></body></html>";

const viewSchema = z.object({
  agents: z.array(z.object({
    activity: z.string(),
    connected: z.boolean(),
    evidence: z.string(),
    kind: z.string(),
    name: z.string(),
  })),
  artifact: z.object({currentVersionId: z.string(), id: z.string(), name: z.string()}),
  counts: z.object({open: z.number(), resolved: z.number()}),
  project: z.object({id: z.string(), name: z.string().nullable()}),
  threads: z.object({
    items: z.array(z.object({
      body: z.string(),
      id: z.string(),
      replies: z.array(z.object({body: z.string(), id: z.string()})),
      state: z.enum(["open", "resolved"]),
    })),
    nextCursor: z.string().nullable(),
  }),
  version: z.object({id: z.string()}),
});

const echoSchema = z.object({
  counts: z.object({open: z.number(), resolved: z.number()}),
  thread: z.object({
    id: z.string(),
    replies: z.array(z.object({body: z.string()})),
    state: z.enum(["open", "resolved"]),
  }),
});

const listSchema = z.object({
  artifacts: z.array(z.object({currentVersionId: z.string(), id: z.string(), name: z.string()})),
  nextCursor: z.string().nullable(),
});

test.describe("WMC-001 WebMCP review tools", () => {
  test("WMC-001-B: the seven tools register with provenance names, one get_view orients, and reply then resolve through the tools update the server and the UI with each result carrying the updated thread and counts", async ({browser}) => {
    const fixture = await startBrowserFixture(browser);
    try {
      await installFakeModelContext(fixture.context);
      const published = (await publishNew(fixture.server, fixture.installation, {
        accessSetting: "account_required",
        content: fixtureHtml,
        idempotencyKey: "wmc-001-fixture-page",
        mediaType: "text/html; charset=utf-8",
        name: "WebMCP fixture",
        path: "index.html",
      })).body;
      const artifactId = published.artifact.id;
      const first = await createThreadOverApi(fixture, {
        artifactId,
        body: "The first claim needs a source.",
        idempotencyKey: "wmc-001-seed-first",
        path: "index.html",
        versionId: published.version.id,
      });
      const second = await createThreadOverApi(fixture, {
        artifactId,
        body: "The heading should name the product.",
        idempotencyKey: "wmc-001-seed-second",
        path: "index.html",
        versionId: published.version.id,
      });
      const cookies = await signInAdministrator(fixture.server, fixture.installation);
      const token = await issueApiKey(fixture.server, cookies, ["agent:connect"], "wmc bridge key");
      await new ApiClient(fixture.server, token).registerAgent({
        agentSessionId: "session-wmc",
        connectionKey: "wmc-001-connection-key",
        displayName: "wmc-pi",
        workingDirectory: "/work/wmc",
      });

      await localLogin(fixture);
      const page = fixture.page;
      await page.goto(
        `${fixture.server.baseUrl}/review?project=prj_default&artifact=${artifactId}&version=${published.version.id}`,
      );
      await page.getByRole("tab", {name: "Comments"}).click();
      await expect(page.getByRole("article")).toHaveCount(2);

      // Registration: exactly the seven provenance-prefixed tools.
      await expect.poll(() => registeredToolNames(page)).toEqual([...expectedToolNames]);

      // One situational call answers where, what, and who.
      const view = viewSchema.parse(await callTool(page, "artifact_server_get_view"));
      expect(view.artifact.id).toBe(artifactId);
      expect(view.version.id).toBe(published.version.id);
      expect(view.project.id).toBe("prj_default");
      expect(view.counts).toEqual({open: 2, resolved: 0});
      expect(view.threads.items.map((thread) => thread.id).toSorted())
        .toEqual([first.id, second.id].toSorted());
      expect(view.threads.items.map((thread) => thread.body))
        .toContain("The first claim needs a source.");
      expect(view.threads.nextCursor).toBeNull();
      expect(view.agents.map((agent) => [agent.name, agent.kind, agent.connected, agent.evidence]))
        .toContainEqual(["wmc-pi", "pi", true, "native"]);

      // A reply echoes the updated thread with its replies and the counts.
      const replied = echoSchema.parse(await callTool(page, "artifact_server_reply", {
        body: "Cited the 2024 survey.",
        threadId: first.id,
      }));
      expect(replied.thread.id).toBe(first.id);
      expect(replied.thread.replies.map((reply) => reply.body)).toEqual(["Cited the 2024 survey."]);
      expect(replied.counts).toEqual({open: 2, resolved: 0});
      const firstCard = page.getByRole("article").filter({hasText: "The first claim needs a source."});
      await expect(firstCard.getByText("Cited the 2024 survey.")).toBeVisible();

      // Resolve echoes the new state and the decremented open count; the
      // card follows without any read-back call.
      const resolved = echoSchema.parse(await callTool(page, "artifact_server_resolve", {
        threadId: first.id,
      }));
      expect(resolved.thread.state).toBe("resolved");
      expect(resolved.counts).toEqual({open: 1, resolved: 1});
      await expect(firstCard.locator("[data-state=\"resolved\"]")).toBeVisible();
      await expect(firstCard.getByRole("button", {name: "Reopen"})).toBeVisible();
      const stored = await listThreadsOverApi(fixture, artifactId);
      expect(stored.find((thread) => thread.id === first.id)?.state).toBe("resolved");
      expect(stored.find((thread) => thread.id === first.id)?.replyCount).toBe(1);

      // The state filter and paging bound the view; reopen restores the loop.
      const openOnly = viewSchema.parse(
        await callTool(page, "artifact_server_get_view", {limit: 1, state: "open"}),
      );
      expect(openOnly.threads.items.map((thread) => thread.id)).toEqual([second.id]);
      expect(openOnly.threads.nextCursor).toBeNull();
      const reopened = echoSchema.parse(await callTool(page, "artifact_server_reopen", {
        threadId: first.id,
      }));
      expect(reopened.thread.state).toBe("open");
      expect(reopened.counts).toEqual({open: 2, resolved: 0});

      // A new comment through the tool lands in the UI list like any other.
      const commented = echoSchema.parse(await callTool(page, "artifact_server_comment", {
        body: "Add a summary paragraph.",
        path: "index.html",
      }));
      expect(commented.counts).toEqual({open: 3, resolved: 0});
      await expect(page.getByRole("article")).toHaveCount(3);
      await expect(page.getByText("Add a summary paragraph.")).toBeVisible();

      // list_artifacts is project-scoped, and open returns the new view.
      const listed = listSchema.parse(await callTool(page, "artifact_server_list_artifacts"));
      expect(listed.artifacts.map((artifact) => artifact.id)).toContain(artifactId);
      const opened = viewSchema.parse(await callTool(page, "artifact_server_open", {
        artifactId,
        versionId: published.version.id,
      }));
      expect(opened.artifact.id).toBe(artifactId);
      expect(opened.counts.open).toBe(3);
    } finally {
      await stopBrowserFixture(fixture);
    }
  });

  test("WMC-001-F: without a model context the application behaves identically and logs nothing, and the per-user toggle unregisters and re-registers the tools live", async ({browser}) => {
    const fixture = await startBrowserFixture(browser);
    try {
      const published = (await publishNew(fixture.server, fixture.installation, {
        accessSetting: "account_required",
        content: fixtureHtml,
        idempotencyKey: "wmc-001-plain-page",
        mediaType: "text/html; charset=utf-8",
        name: "Plain fixture",
        path: "index.html",
      })).body;
      const reviewUrl =
        `${fixture.server.baseUrl}/review?project=prj_default&artifact=${published.artifact.id}&version=${published.version.id}`;

      // No model context: the same page, the same UI, and a silent console.
      // Resource-load lines are the browser's own network log (the session
      // probe answers 401 before the local owner signs in); application
      // logging is what must stay silent.
      const consoleMessages: string[] = [];
      fixture.page.on("console", (message) => {
        if (
          (message.type() === "error" || message.type() === "warning")
          && !message.text().startsWith("Failed to load resource")
        ) {
          consoleMessages.push(`${message.type()}: ${message.text()}`);
        }
      });
      fixture.page.on("pageerror", (error) => consoleMessages.push(`pageerror: ${error.message}`));
      await localLogin(fixture);
      await fixture.page.goto(reviewUrl);
      await fixture.page.getByRole("tab", {name: "Comments"}).click();
      await expect(fixture.page.getByText("No comments on this version yet.")).toBeVisible();
      expect(await fixture.page.evaluate(() => "modelContext" in document)).toBe(false);
      expect(consoleMessages).toEqual([]);

      // With a model context the tools register by default; switching the
      // preference off unregisters them live (the abort-signal path), the
      // settings page shows the stored choice, and switching it back on
      // registers again on the next review load.
      const toggled = await browser.newContext();
      try {
        await installFakeModelContext(toggled);
        const page = await toggled.newPage();
        await page.goto(reviewUrl);
        await expect(page.getByRole("tab", {name: "Comments"})).toBeVisible();
        await expect.poll(() => registeredToolNames(page)).toEqual([...expectedToolNames]);

        await page.evaluate(() => {
          window.localStorage.setItem("artifact-review-webmcp", "off");
          window.dispatchEvent(new Event("artifact-webmcp-changed"));
        });
        await expect.poll(() => registeredToolNames(page)).toEqual([]);

        await page.goto(reviewUrl);
        await expect(page.getByRole("tab", {name: "Comments"})).toBeVisible();
        expect(await registeredToolNames(page)).toEqual([]);

        await page.goto(`${fixture.server.baseUrl}/review/settings/projects`);
        const toggle = page.getByRole("checkbox", {name: /Browser agent tools/});
        await expect(toggle).not.toBeChecked();
        await toggle.check();
        await page.goto(reviewUrl);
        await expect(page.getByRole("tab", {name: "Comments"})).toBeVisible();
        await expect.poll(() => registeredToolNames(page)).toEqual([...expectedToolNames]);
      } finally {
        await toggled.close();
      }
    } finally {
      await stopBrowserFixture(fixture);
    }
  });
});
