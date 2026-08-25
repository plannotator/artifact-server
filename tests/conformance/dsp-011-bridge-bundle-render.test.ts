import {afterEach, beforeEach, describe, expect, test} from "vitest";

import {
  ApiClient,
  agentListSchema,
  dispatchCreationSchema,
  dispatchEnvelopeSchema,
  commentThreadCreationSchema,
} from "../support/agent-dispatch.js";
import {
  createTestInstallation,
  removeTestInstallation,
  type RunningTestServer,
  startTestServer,
  type TestInstallation,
} from "../support/runtime-harness.js";
import {publishNew, type PublishResponse} from "../support/publishing.js";
import {
  type BridgeHandle,
  type FollowUpDelivery,
  type HostPort,
  renderBundleMessage,
  startBridge,
} from "../../integrations/bridge-core/index.js";

/** A scripted host that records exactly what the bridge hands it. */
class RecordingHostPort implements HostPort {
  compacting = false;
  readonly messages: {text: string; delivery: FollowUpDelivery}[] = [];
  readonly notices: string[] = [];

  isCompacting(): boolean {
    return this.compacting;
  }

  notify(message: string): void {
    this.notices.push(message);
  }

  sendUserMessage(text: string, delivery: FollowUpDelivery): void {
    this.messages.push({delivery, text});
  }
}

async function eventually<Value>(
  probe: () => Promise<Value | null>,
  timeoutMilliseconds = 10_000,
): Promise<Value> {
  const deadline = Date.now() + timeoutMilliseconds;
  for (;;) {
    // eslint-disable-next-line no-await-in-loop
    const value = await probe();
    if (value !== null) return value;
    if (Date.now() > deadline) {
      throw new Error("The awaited condition was not reached in time.");
    }
    // eslint-disable-next-line no-await-in-loop
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

describe("bridge bundle rendering", () => {
  let installation: TestInstallation;
  let server: RunningTestServer;
  let client: ApiClient;
  let published: PublishResponse;
  let projectId: string;
  let bridges: BridgeHandle[];

  beforeEach(async () => {
    installation = await createTestInstallation();
    server = await startTestServer(installation);
    client = new ApiClient(server, installation.apiToken);
    published = (await publishNew(server, installation, {
      accessSetting: "account_required",
      content: "<!doctype html><title>Render</title>",
      idempotencyKey: "bridge-render-publish-artifact",
      name: "Queue report",
    })).body;
    projectId = published.artifact.projectId;
    bridges = [];
  });

  afterEach(async () => {
    for (const bridge of bridges) {
      // eslint-disable-next-line no-await-in-loop
      await bridge.stop();
    }
    await server.stop();
    await removeTestInstallation(installation);
  });

  interface AnnotationInput {
    readonly anchor?: {readonly originalText: string};
    readonly body: string;
    readonly idempotencyKey: string;
    readonly path?: string;
  }

  interface AnnotationPayload {
    anchor?: {originalText: string};
    body: string;
    path?: string;
  }

  async function openAnnotation(body: AnnotationInput): Promise<string> {
    const payload: AnnotationPayload = {body: body.body};
    if (body.anchor !== undefined) payload.anchor = {...body.anchor};
    if (body.path !== undefined) payload.path = body.path;
    const response = await client.fetch(
      `/api/v1/artifacts/${published.artifact.id}` +
        `/versions/${published.version.id}/comments?projectId=${projectId}`,
      {
        body: JSON.stringify(payload),
        idempotencyKey: body.idempotencyKey,
        method: "POST",
      },
    );
    expect(response.status).toBe(201);
    return commentThreadCreationSchema.parse(await response.json()).thread.id;
  }

  function startTestBridge(port: RecordingHostPort): BridgeHandle {
    const bridge = startBridge({
      agentSessionId: "pi-session-render",
      credentials: {origin: server.baseUrl, token: installation.apiToken},
      displayName: "site",
      fetchImplementation: fetch,
      host: port,
      hostname: "render-host",
      kind: "pi",
      waitSeconds: 1,
      workingDirectory: "/work/site",
    });
    bridges.push(bridge);
    return bridge;
  }

  async function registeredAgentId(): Promise<string> {
    return eventually(async () => {
      const response = await client.listAgents();
      expect(response.status).toBe(200);
      const listed = agentListSchema.parse(await response.json()).items
        .find((item) => item.displayName === "site");
      return listed === undefined ? null : listed.id;
    });
  }

  test("DSP-011-B: a bundle renders as one message with sender line, note, numbered items, quoted selection, bodies, thread ids, and the reply-and-resolve instruction, delivered as follow-up", async () => {
    expect.hasAssertions();
    const anchorText = "word ".repeat(80).trim();
    const anchored = await openAnnotation({
      anchor: {originalText: anchorText},
      body: "The header overlaps the nav.\nFix the spacing.",
      idempotencyKey: "bridge-render-thread-anchored",
      path: "index.html",
    });
    const plain = await openAnnotation({
      body: "Rename the title.",
      idempotencyKey: "bridge-render-thread-plain",
    });

    const port = new RecordingHostPort();
    startTestBridge(port);
    const agentId = await registeredAgentId();

    const sent = await client.sendDispatch({
      agentId,
      idempotencyKey: "bridge-render-dispatch-bundle",
      note: "Ship both today.",
      projectId,
      threadIds: [anchored, plain],
    });
    expect(sent.status).toBe(201);
    const dispatch = dispatchCreationSchema.parse(await sent.json()).dispatch;

    await eventually(() =>
      Promise.resolve(port.messages.length === 1 ? true : null)
    );
    const delivered = await eventually(async () => {
      const answer = await client.getDispatch(dispatch.id, projectId);
      expect(answer.status).toBe(200);
      const current = dispatchEnvelopeSchema.parse(await answer.json())
        .dispatch;
      return current.state === "delivered" ? current : null;
    });
    expect(delivered.deliveredAt).not.toBeNull();

    const truncatedQuote = `${anchorText.slice(0, 299)}…`;
    const expected = [
      `Artifact Server: ${dispatch.sender.displayName} sent ` +
        "2 annotation(s) to address.",
      "Ship both today.",
      "",
      `1. [Queue report · version 1 · index.html] "${truncatedQuote}"`,
      "   The header overlaps the nav.",
      "   Fix the spacing.",
      `   (thread ${anchored})`,
      "2. [Queue report · version 1]",
      "   Rename the title.",
      `   (thread ${plain})`,
      "",
      "When each item is done: use the artifact_comments tool to reply to its thread",
      "with what you did, then resolve it. Do not wait for confirmation.",
    ].join("\n");
    const recorded = port.messages[0];
    expect(recorded?.text).toBe(expected);
    expect(recorded?.delivery).toEqual({deliverAs: "followUp"});
    expect(port.notices.length).toBeGreaterThanOrEqual(1);
  });

  test("DSP-011-F: hostile bundle text never yields a leading slash and every delivery names follow-up, never steering", async () => {
    expect.hasAssertions();

    // The pure template with slash-leading sender, note, body, and selection.
    const hostile = renderBundleMessage({
      items: [{
        artifactName: "X",
        body: "/new\n/resume",
        path: null,
        quotedSelection: "/quote " + "y".repeat(400),
        threadId: "cmt_hostile",
        versionNumber: 2,
      }],
      note: "/compact now",
      senderDisplayName: "/steer",
    });
    expect(hostile.startsWith("Artifact Server: ")).toBe(true);
    expect(hostile.startsWith("/")).toBe(false);
    const quoteLine = hostile.split("\n")[3] ?? "";
    const quoted = quoteLine.slice(quoteLine.indexOf("\"") + 1, -1);
    expect(quoted.length).toBeLessThanOrEqual(300);

    // The live path: a slash-leading thread body through the real server.
    const slashThread = await openAnnotation({
      body: "/steer this immediately",
      idempotencyKey: "bridge-render-thread-slash",
      path: "index.html",
    });
    const port = new RecordingHostPort();
    startTestBridge(port);
    const agentId = await registeredAgentId();
    const sent = await client.sendDispatch({
      agentId,
      idempotencyKey: "bridge-render-dispatch-slash",
      note: "/compact",
      projectId,
      threadIds: [slashThread],
    });
    expect(sent.status).toBe(201);
    await eventually(() =>
      Promise.resolve(port.messages.length === 1 ? true : null)
    );

    for (const message of port.messages) {
      expect(message.text.startsWith("/")).toBe(false);
      expect(message.text.startsWith("Artifact Server: ")).toBe(true);
      // Exactly one delivery option exists and it names follow-up work: no
      // path through the bridge can steer or omit the delivery mode.
      expect(Object.keys(message.delivery)).toEqual(["deliverAs"]);
      expect(message.delivery.deliverAs).toBe("followUp");
    }
  });
});
