import {AxeBuilder} from "@axe-core/playwright";
import {expect, test, type Page, type Route} from "@playwright/test";

import {ApiClient, dispatchCreationSchema, dispatchEnvelopeSchema, issueApiKey, signInAdministrator} from "../support/agent-dispatch.js";
import {publishNew, publishVersion, type PublishResponse} from "../support/publishing.js";
import {localLogin, startBrowserFixture, stopBrowserFixture, type BrowserFixture} from "./browser-fixture.js";
import {createThreadOverApi} from "./comment-api.js";

const projectId = "prj_default";
const artifactHtml = (heading: string) =>
  `<!doctype html><html lang="en"><title>${heading}</title><body><main style="min-height:1800px"><h1>${heading}</h1></main><p id="target">Bottom target</p></body></html>`;

async function publish(fixture: BrowserFixture, name: string, publicLink = false) {
  return (await publishNew(fixture.server, fixture.installation, {
    accessSetting: publicLink ? "public_link" : "account_required",
    content: artifactHtml(name),
    idempotencyKey: `uxr-publish-${name}`,
    name,
  })).body;
}

async function nextVersion(fixture: BrowserFixture, previous: PublishResponse, heading: string) {
  return (await publishVersion(fixture.server, fixture.installation, {
    artifactId: previous.artifact.id,
    content: artifactHtml(heading),
    expectedCurrentVersionId: previous.version.id,
    idempotencyKey: `uxr-version-${heading}`,
  })).body;
}

function comment(fixture: BrowserFixture, published: PublishResponse, body: string) {
  return createThreadOverApi(fixture, {
    anchor: {
      htmlAnchor: {selector: "#target", tagName: "P", text: "Bottom target"},
      originalText: "Bottom target",
    },
    artifactId: published.artifact.id,
    body,
    idempotencyKey: `uxr-comment-${body}`,
    path: "index.html",
    versionId: published.version.id,
  });
}

async function openArtifact(fixture: BrowserFixture, published: PublishResponse) {
  const url = new URL(published.links.review);
  url.searchParams.delete("view");
  await fixture.page.goto(url.href);
  await expect(fixture.page.frameLocator(".as-artifact-frame").frameLocator("iframe")
    .getByRole("heading")).toBeVisible();
}

async function comments(page: Page) {
  await page.getByRole("tab", {name: "Comments"}).click();
}

function card(page: Page, body: string) {
  return page.getByRole("article").filter({hasText: body});
}

async function agent(fixture: BrowserFixture) {
  const cookies = await signInAdministrator(fixture.server, fixture.installation);
  const key = await issueApiKey(fixture.server, cookies, ["agent:connect"], "Reviewer agent");
  const client = new ApiClient(fixture.server, key);
  const registration = await client.registerAgent({
    agentSessionId: "uxr-reviewer",
    connectionKey: "uxr-reviewer",
    displayName: "Review agent with a long display name",
    workingDirectory: "/uxr",
  });
  return {client, id: registration.id};
}

async function dispatches(fixture: BrowserFixture, published: PublishResponse, states: readonly string[]) {
  const worker = await agent(fixture);
  const owner = new ApiClient(fixture.server, fixture.installation.apiToken);
  await states.reduce<Promise<void>>(async (previous, state) => {
    await previous;
    const thread = await comment(fixture, published, `${state} discussion`);
    const sent = await owner.sendDispatch({
      agentId: worker.id,
      idempotencyKey: `uxr-send-dispatch-${state}`,
      projectId,
      threadIds: [thread.id],
    });
    expect(sent.status).toBe(201);
    const {dispatch} = dispatchCreationSchema.parse(await sent.json());
    if (state === "queued") return;
    if (state === "canceled") {
      expect((await owner.cancelDispatch(dispatch.id, projectId)).ok).toBe(true);
      return;
    }
    const claimed = dispatchEnvelopeSchema.parse(await (await worker.client.claim(worker.id)).json());
    expect(claimed.dispatch.id).toBe(dispatch.id);
    if (state === "claimed") return;
    if (state === "failed") {
      expect((await worker.client.reportFailed(dispatch.id, worker.id, "Test failure")).ok).toBe(true);
      return;
    }
    expect((await worker.client.reportDelivered(dispatch.id, worker.id)).ok).toBe(true);
    if (state === "delivered") return;
    expect((await owner.setThreadState(published, thread.id, "resolved")).ok).toBe(true);
    const addressed = dispatchEnvelopeSchema.parse(await (await owner.getDispatch(dispatch.id, projectId)).json());
    expect(addressed.dispatch.state).toBe("addressed");
    if (state === "addressed") {
      expect((await owner.setThreadState(published, thread.id, "open")).ok).toBe(true);
    }
  }, Promise.resolve());
}

async function malformDates(route: Route): Promise<void> {
  const response = await route.fetch();
  const body: {artifacts: {artifact: {createdAt: string}}[]} = await response.json();
  for (const item of body.artifacts) item.artifact.createdAt = "unknown date";
  await route.fulfill({json: body, response});
}

test.describe("Review interface refinements", () => {
  let fixture: BrowserFixture;
  test.beforeEach(async ({browser}) => {
    fixture = await startBrowserFixture(browser);
    await localLogin(fixture);
  });

  test.afterEach(async () => {
    await stopBrowserFixture(fixture);
  });

  test("UXR-001-B: dashboard links each attention item and groups consecutive publishes", async () => {
    const {page} = fixture;
    const review = await publish(fixture, "Feedback artifact");
    await dispatches(fixture, review, ["addressed", "failed"]);
    const release = await publish(fixture, "Release artifact");
    await openArtifact(fixture, release);
    await nextVersion(fixture, release, "New release");
    await publish(fixture, "Third publish");
    await page.goto(`${fixture.server.baseUrl}/review/dashboard`);
    const band = page.getByRole("region", {name: "Needs you"});
    await expect(band.locator("dt + dd")).toHaveText(["1", "1", "1"]);
    const group = page.locator("summary").filter({hasText: /3.*publish/iu});
    await expect(group).toHaveCount(1);
    await group.click();
    await expect(group.locator("..").getByRole("link")).toHaveCount(3);
    expect((await new AxeBuilder({page}).include("section[aria-labelledby='dashboard-attention-title']")
      .withTags(["wcag2a", "wcag2aa"]).analyze()).violations).toEqual([]);
    await page.getByRole("button", {name: "Use light theme"}).click();
    expect((await new AxeBuilder({page}).include("section[aria-labelledby='dashboard-attention-title']")
      .withTags(["wcag2a", "wcag2aa"]).analyze()).violations).toEqual([]);
    const links = await band.getByRole("link").evaluateAll((elements) =>
      elements.map((element) => element.getAttribute("href"))
    );
    expect(links).toHaveLength(3);
    await links.reduce<Promise<void>>(async (previous, link, index) => {
      await previous;
      await page.goto(new URL(link ?? "", fixture.server.baseUrl).href);
      if (index === 1) {
        await expect(page.frameLocator(".as-artifact-frame").frameLocator("iframe")
          .getByRole("heading", {name: "New release"})).toBeVisible();
      } else {
        await expect(card(page, index === 0 ? "addressed discussion" : "failed discussion"))
          .toHaveAttribute("aria-current", "true");
      }
    }, Promise.resolve());
  });

  test("UXR-001-F: blocked storage leaves counts and the dashboard available", async () => {
    const {page} = fixture;
    await page.addInitScript(() => {
      Object.defineProperty(window, "localStorage", {get: () => {throw new Error("Storage blocked");}});
    });
    await page.goto(`${fixture.server.baseUrl}/review/dashboard`);
    await expect(page.getByRole("region", {name: "需要你處理"}).locator("dt + dd"))
      .toHaveText(["0", "未知", "0"]);
  });

  test("UXR-002-B: catalog rows show non-default access, open counts, and exact relative times", async () => {
    const {page} = fixture;
    await publish(fixture, "Quiet artifact");
    const active = await publish(fixture, "Public artifact", true);
    await comment(fixture, active, "First catalog comment");
    await comment(fixture, active, "Second catalog comment");
    await page.reload();
    const quiet = page.getByRole("button", {name: /Quiet artifact/u});
    const publicRow = page.getByRole("button", {name: /Public artifact/u});
    await expect(quiet.locator("[data-access], .as-artifact-card__counts")).toHaveCount(0);
    await expect(publicRow.locator("[data-access=public_link]")).toHaveText("public");
    await expect(publicRow.locator("[data-open-count]")).toHaveText("2");
    const time = publicRow.locator("time");
    await expect(time).toContainText(/now|ago/u);
    await expect(time).toHaveAttribute("aria-label", active.artifact.createdAt);
    await expect(time).toHaveAttribute("title", active.artifact.createdAt);
  });

  test("UXR-002-F: future and malformed dates fall back to the supplied timestamp", async () => {
    const {page} = fixture;
    const future = await publish(fixture, "Future catalog artifact");
    await page.clock.setFixedTime(new Date("2000-01-01T00:00:00Z"));
    await page.reload();
    const time = page.getByRole("button", {name: /Future catalog artifact/u}).locator("time");
    await expect(time).toHaveText(future.artifact.createdAt);
    // The catalog lists through the folder route when folders are available.
    await page.route("**/api/v1/artifacts?*", malformDates);
    await page.route("**/api/v1/projects/*/folders/*?*", malformDates);
    await page.reload();
    await expect(time).toHaveText("unknown date");
  });

  test("UXR-003-B: an addressed open thread carries its chip and leaves Awaiting you when resolved", async () => {
    const {page} = fixture;
    const item = await publish(fixture, "Awaiting fixture");
    await dispatches(fixture, item, ["addressed"]);
    await openArtifact(fixture, item);
    await comments(page);
    await expect(card(page, "addressed discussion").getByText("Addressed", {exact: true})).toBeVisible();
    await page.getByRole("button", {name: "Awaiting you (1)"}).click();
    await expect(card(page, "addressed discussion").getByText("Addressed", {exact: true})).toBeVisible();
    await card(page, "addressed discussion").getByRole("button", {name: "Resolve"}).click();
    await expect(page.getByRole("button", {name: "Awaiting you (0)"})).toBeVisible();
    await expect(card(page, "addressed discussion")).toHaveCount(0);
  });

  test("UXR-003-F: other dispatch states and resolved threads stay out of Awaiting you", async () => {
    const {page} = fixture;
    const item = await publish(fixture, "Other dispatch states");
    await dispatches(fixture, item, ["resolved", "failed", "delivered", "canceled", "claimed", "queued"]);
    await openArtifact(fixture, item);
    await comments(page);
    await page.getByRole("button", {name: "Awaiting you (0)"}).click();
    await expect(page.getByText("No threads are awaiting you.")).toBeVisible();
    await expect(page.getByRole("article")).toHaveCount(0);
  });

  test("UXR-004-B: click and Enter reveal anchors, and disconnected reviewers get a connection link", async () => {
    const {page} = fixture;
    const item = await publish(fixture, "Anchor fixture");
    await comment(fixture, item, "Reveal my anchor");
    await openArtifact(fixture, item);
    await comments(page);
    await expect(page.getByRole("link", {name: "Connect an agent"})).toHaveAttribute("href", "/review/settings/mcp");
    const thread = card(page, "Reveal my anchor");
    await expect(thread.getByRole("button", {name: "Resolve"})).toBeVisible();
    await thread.getByText("Reveal my anchor").click();
    await expect(thread).toHaveAttribute("aria-current", "true");
    const target = page.frameLocator(".as-artifact-frame").frameLocator("iframe").locator("#target");
    await expect(target).toBeInViewport();
    await target.evaluate((node) => node.ownerDocument.defaultView?.scrollTo(0, 0));
    await thread.press("Enter");
    await expect(target).toBeInViewport();
  });

  test("UXR-004-F: focused cards expose the entire split button and a keyboard-reachable reply", async () => {
    const {page} = fixture;
    const item = await publish(fixture, "Focus actions fixture");
    await comment(fixture, item, "Card controls");
    await agent(fixture);
    await openArtifact(fixture, item);
    await comments(page);
    const thread = card(page, "Card controls");
    await thread.focus();
    const send = thread.getByRole("button", {name: "Send to Review agent with a long display name"});
    await expect(send).toBeVisible();
    expect(await send.evaluate((button) => button.scrollWidth <= button.clientWidth)).toBe(true);
    await page.keyboard.press("Tab");
    await expect(send).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(thread.getByRole("button", {name: "Choose agent or send with a note"})).toBeFocused();
    await page.keyboard.press("Tab");
    await page.keyboard.press("Tab");
    await expect(thread.getByRole("button", {name: "Reply"})).toBeFocused();
  });

  test("UXR-005-B: modifier Enter posts a comment and reply once and clears their drafts", async () => {
    const {page} = fixture;
    await openArtifact(fixture, await publish(fixture, "Composer fixture"));
    await comments(page);
    const composer = page.getByRole("textbox", {name: "Add a comment"});
    await composer.fill("Keyboard comment");
    await composer.press("Control+Enter");
    const thread = card(page, "Keyboard comment");
    await expect(thread).toHaveCount(1);
    await expect(composer).toHaveValue("");
    await thread.focus();
    await thread.getByRole("button", {exact: true, name: "Reply"}).click();
    const reply = thread.getByRole("textbox", {name: "Reply"});
    await reply.fill("Keyboard reply");
    await reply.press("Meta+Enter");
    await expect(thread.getByText("Keyboard reply", {exact: true})).toHaveCount(1);
    await thread.getByRole("button", {exact: true, name: "Reply"}).click();
    await expect(reply).toHaveValue("");
  });

  test("UXR-005-F: blank, oversized and composing input cannot submit", async () => {
    const {page} = fixture;
    await openArtifact(fixture, await publish(fixture, "Invalid composer fixture"));
    await comments(page);
    const composer = page.getByRole("textbox", {name: "Add a comment"});
    await composer.press("Control+Enter");
    await composer.fill("x".repeat(100_001));
    await composer.press("Control+Enter");
    await expect(composer).toHaveAttribute("aria-invalid", "true");
    await composer.fill("Composing");
    await composer.dispatchEvent("keydown", {bubbles: true, ctrlKey: true, isComposing: true, key: "Enter"});
    await expect(composer).toHaveValue("Composing");
    await expect(page.getByRole("article")).toHaveCount(0);
  });

  test("UXR-006-B: palette finds artifacts and commands, and the shortcut sheet lists bindings", async () => {
    const {page} = fixture;
    const item = await publish(fixture, "Unique palette artifact");
    await page.keyboard.press("Control+k");
    const palette = page.getByRole("dialog", {name: "Command palette"});
    const search = palette.getByRole("searchbox");
    await search.fill("palette arti");
    await search.press("Enter");
    await expect.poll(() => new URL(page.url()).searchParams.get("artifact")).toBe(item.artifact.id);
    const annotate = page.getByRole("button", {name: /Annotate/u}).first();
    await annotate.click();
    await expect(page.getByRole("button", {name: "Interact mode"})).toHaveAttribute("aria-pressed", "false");
    await page.keyboard.press("Meta+k");
    await search.fill("annotate mode");
    await search.press("Enter");
    await expect(annotate).toHaveAttribute("aria-pressed", "true");
    await page.keyboard.press("?");
    const sheet = page.getByRole("dialog", {name: "Keyboard shortcuts"});
    await expect(sheet).toBeVisible();
    const keys = await sheet.locator("kbd").allTextContents();
    expect(keys).toEqual(expect.arrayContaining(["J", "K", "F", "[", "]", "Esc", "\\", "⌘K / Ctrl+K", "⌘↵ / Ctrl+Enter"]));
  });

  test("UXR-006-F: editable fields keep their keys and dialogs trap and restore focus", async () => {
    const {page} = fixture;
    const catalogSearch = page.getByPlaceholder("Search artifacts…");
    await catalogSearch.focus();
    await page.keyboard.press("Control+k");
    await page.keyboard.press("?");
    await expect(page.getByRole("dialog")).toHaveCount(0);
    const previous = page.locator(".as-preview-panel");
    await previous.focus();
    await page.keyboard.press("Control+k");
    const palette = page.getByRole("dialog", {name: "Command palette"});
    await palette.getByRole("searchbox").fill("no match for this query");
    await expect(palette.getByText("No results.")).toBeVisible();
    await page.keyboard.press("Tab");
    await page.keyboard.press("Tab");
    await expect(palette.locator(":focus")).toHaveCount(1);
    await page.keyboard.press("Escape");
    await expect(previous).toBeFocused();
    await page.keyboard.press("?");
    const sheet = page.getByRole("dialog", {name: "Keyboard shortcuts"});
    await expect(sheet).toBeVisible();
    await page.keyboard.press("Tab");
    await expect.poll(() => sheet.evaluate((node) => node.contains(node.ownerDocument.activeElement))).toBe(true);
    await page.keyboard.press("Escape");
    await expect(previous).toBeFocused();
  });

  test("UXR-007-B: side-by-side comparison renders both versions and synchronizes scrolling", async () => {
    const {page} = fixture;
    const first = await publish(fixture, "Compare first");
    const second = await nextVersion(fixture, first, "Compare second");
    await openArtifact(fixture, second);
    await compare(page);
    const left = comparisonFrame(page, 1);
    const right = comparisonFrame(page, 2);
    await expect(left.getByRole("heading", {name: "Compare first"})).toBeVisible();
    await expect(right.getByRole("heading", {name: "Compare second"})).toBeVisible();
    const sync = page.getByRole("checkbox", {name: "Synchronize scrolling"});
    await expect(sync).not.toBeChecked();
    await sync.check();
    await left.locator("body").evaluate((node) => node.ownerDocument.defaultView?.scrollTo(0, 450));
    await expect.poll(() => right.locator("body").evaluate((node) =>
      node.ownerDocument.defaultView?.scrollY)).toBeGreaterThan(400);
  });

  test("UXR-007-F: mixed entries show unavailable while HTML stays in an opaque sandbox", async () => {
    const {page} = fixture;
    const first = await publish(fixture, "HTML first");
    await publishVersion(fixture.server, fixture.installation, {
      artifactId: first.artifact.id,
      content: "Plain text",
      expectedCurrentVersionId: first.version.id,
      idempotencyKey: "plain-text-entry",
      mediaType: "text/plain",
      path: "index.txt",
    });
    await page.goto(`${fixture.server.baseUrl}/review?project=${projectId}&artifact=${first.artifact.id}`);
    await compare(page);
    await expect(page.getByTitle("Version 1 preview").contentFrame().locator("iframe"))
      .toHaveAttribute("sandbox", "allow-scripts");
    expect(await comparisonFrame(page, 1).locator("body").evaluate((node) =>
      node.ownerDocument.defaultView?.origin)).toBe("null");
    await expect(page.getByText("Version 2 has no HTML preview.")).toBeVisible();
    await expect(page.getByTitle("Version 2 preview")).toHaveCount(0);
  });

  test("UXR-008-B: focus mode starts collapsed, shows the count, and teaches the shortcut once", async () => {
    const {page} = fixture;
    const item = await publish(fixture, "Focus hint fixture");
    await comment(fixture, item, "Open focus comment");
    await openArtifact(fixture, item);
    await page.locator(".as-preview-panel").focus();
    await page.keyboard.press("f");
    const restore = page.getByRole("button", {name: /Show viewer controls/u});
    await expect(restore).toBeVisible();
    await expect(restore).toContainText("1");
    await expect(page.getByText(/Press ⌘\\/u)).toBeVisible();
    await expect(page.getByRole("toolbar")).toHaveCount(0);
    await page.keyboard.press("Meta+Backslash");
    await expect(page.getByRole("toolbar", {name: "Artifact viewer controls"})).toBeVisible();
    await page.keyboard.press("f");
    await page.keyboard.press("f");
    await expect(restore).toBeVisible();
    await expect(page.getByText(/Press ⌘\\/u)).toHaveCount(0);
    await restore.click();
    await expect(page.getByRole("toolbar", {name: "Artifact viewer controls"})).toBeVisible();
    await page.reload();
    await expect(restore).toBeVisible();
    await expect(page.getByText(/Press ⌘\\/u)).toHaveCount(0);
  });

  test("UXR-008-F: blocked storage does not disable the focus hint or controls", async () => {
    const {page} = fixture;
    const item = await publish(fixture, "Blocked hint fixture");
    await page.addInitScript(() => {
      Object.defineProperty(window, "localStorage", {get: () => {throw new Error("Storage blocked");}});
    });
    await openArtifact(fixture, item);
    await page.locator(".as-preview-panel").focus();
    await page.keyboard.press("f");
    await expect(page.getByText(/按 ⌘\\/u)).toBeVisible();
    await page.getByRole("button", {name: /顯示檢視器控制項/u}).click();
    await expect(page.getByRole("toolbar")).toBeVisible();
  });
});

async function compare(page: Page) {
  await page.getByRole("tab", {name: "Versions"}).click();
  await page.getByRole("button", {exact: true, name: "Compare"}).click();
  await expect(page.getByText("Changed files", {exact: true})).toBeVisible();
  await page.getByRole("button", {name: "Side by side"}).click();
}

function comparisonFrame(page: Page, version: number) {
  return page.getByTitle(`Version ${version} preview`).contentFrame().frameLocator("iframe");
}
