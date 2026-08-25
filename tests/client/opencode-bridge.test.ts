/**
 * The OpenCode adapter over the shared bridge core, driven through a fake
 * plugin context against a real spawned server: registration as kind
 * `opencode` with native-evidence capabilities, bundle delivery through the
 * `promptAsync` seam only once a top-level session is known, the beacon's
 * state transitions at the natural work boundaries, and fail-open behavior
 * when the plugin context lacks the expected surface.
 */

import {afterEach, beforeEach, describe, expect, test} from "vitest";

import {
  agentListSchema,
  ApiClient,
  dispatchCreationSchema,
  dispatchEnvelopeSchema,
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
  ArtifactServerBridge,
  type OpencodeBridgeHooks,
  type OpencodePluginInput,
} from "../../integrations/opencode/index.js";

const environmentKeys = [
  "ARTIFACT_SERVER_AGENT_NAME",
  "ARTIFACT_SERVER_AGENT_TOKEN",
  "ARTIFACT_SERVER_ORIGIN",
] as const;

interface RecordedPrompt {
  readonly body: {
    readonly parts: readonly {readonly text: string; readonly type: "text"}[];
  };
  readonly path: {readonly id: string};
}

interface RecordedToast {
  readonly message: string;
  readonly variant: string;
}

interface FakePluginContext {
  readonly input: OpencodePluginInput;
  readonly prompts: RecordedPrompt[];
  readonly toasts: RecordedToast[];
}

/** A fake OpenCode plugin context recording every SDK call the bridge makes. */
function fakePluginContext(directory: string): FakePluginContext {
  const prompts: RecordedPrompt[] = [];
  const toasts: RecordedToast[] = [];
  return {
    input: {
      client: {
        session: {
          promptAsync: (options) => {
            prompts.push(options);
            return Promise.resolve({});
          },
        },
        tui: {
          showToast: (options) => {
            toasts.push({
              message: options.body.message,
              variant: options.body.variant,
            });
            return Promise.resolve(true);
          },
        },
      },
      directory,
    },
    prompts,
    toasts,
  };
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

function settle(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

describe("opencode bridge adapter", () => {
  let installation: TestInstallation;
  let server: RunningTestServer;
  let client: ApiClient;
  let published: PublishResponse;
  let projectId: string;
  let hooksToDispose: OpencodeBridgeHooks[];
  let savedEnvironment: Partial<
    Record<(typeof environmentKeys)[number], string>
  >;

  beforeEach(async () => {
    installation = await createTestInstallation();
    server = await startTestServer(installation);
    client = new ApiClient(server, installation.apiToken);
    published = (await publishNew(server, installation, {
      accessSetting: "account_required",
      content: "<!doctype html><title>OpenCode bridge</title>",
      idempotencyKey: "opencode-bridge-publish-artifact",
      name: "OpenCode report",
    })).body;
    projectId = published.artifact.projectId;
    hooksToDispose = [];
    savedEnvironment = {};
    for (const key of environmentKeys) {
      const value = process.env[key];
      if (value !== undefined) savedEnvironment[key] = value;
    }
    process.env["ARTIFACT_SERVER_AGENT_NAME"] = "opencode-under-test";
    process.env["ARTIFACT_SERVER_AGENT_TOKEN"] = installation.apiToken;
    process.env["ARTIFACT_SERVER_ORIGIN"] = server.baseUrl;
  });

  afterEach(async () => {
    for (const key of environmentKeys) {
      const saved = savedEnvironment[key];
      if (saved === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = saved;
      }
    }
    for (const hooks of hooksToDispose) {
      // eslint-disable-next-line no-await-in-loop
      await hooks.dispose();
    }
    await server.stop();
    await removeTestInstallation(installation);
  });

  async function connectedAgent(
    agentId: string,
  ): Promise<{activity: string; beacon: string | null}> {
    const response = await client.listAgents();
    expect(response.status).toBe(200);
    const listed = agentListSchema.parse(await response.json()).items
      .find((item) => item.id === agentId);
    if (listed === undefined) {
      throw new Error(`Agent ${agentId} disappeared from the listing.`);
    }
    return {activity: listed.activity, beacon: listed.beacon};
  }

  test("registers as kind opencode, holds delivery until a top-level session exists, injects through promptAsync, and beacons each work boundary", async () => {
    expect.hasAssertions();
    const first = await client.openThread(
      published,
      "Rename the heading.",
      "opencode-bridge-thread-first",
    );
    const second = await client.openThread(
      published,
      "Tighten the intro.",
      "opencode-bridge-thread-second",
    );

    const context = fakePluginContext("/work/opencode-under-test");
    const hooks = await ArtifactServerBridge(context.input);
    hooksToDispose.push(hooks);

    // Registration: the agent appears with the opencode kind and the
    // native-evidence, beacon-capable capability set the core advertises.
    const agent = await eventually(async () => {
      const response = await client.listAgents();
      expect(response.status).toBe(200);
      return agentListSchema.parse(await response.json()).items
        .find((item) => item.displayName === "opencode-under-test") ?? null;
    });
    expect(agent.kind).toBe("opencode");
    expect(agent.capabilities).toEqual({beacon: true, evidence: "native"});
    expect(agent.workingDirectory).toBe("/work/opencode-under-test");

    // A dispatch sent before any top-level session is known is claimed but
    // held: a child (subagent) session never becomes the injection target.
    await hooks.event({
      event: {
        properties: {
          info: {id: "ses_child", parentID: "ses_parent"},
        },
        type: "session.created",
      },
    });
    await hooks["chat.message"]({sessionID: "ses_child"});
    const sent = await client.sendDispatch({
      agentId: agent.id,
      idempotencyKey: "opencode-bridge-dispatch",
      note: "Both today, please.",
      projectId,
      threadIds: [first.id, second.id],
    });
    expect(sent.status).toBe(201);
    const dispatchId = dispatchCreationSchema.parse(await sent.json())
      .dispatch.id;
    await eventually(async () => {
      const answer = await client.getDispatch(dispatchId, projectId);
      const state = dispatchEnvelopeSchema.parse(await answer.json())
        .dispatch.state;
      return state === "claimed" ? true : null;
    });
    await settle(700);
    expect(context.prompts).toHaveLength(0);
    const held = await client.getDispatch(dispatchId, projectId);
    expect(dispatchEnvelopeSchema.parse(await held.json()).dispatch.state)
      .toBe("claimed");

    // A top-level session announcement releases the hold: the bundle lands
    // through promptAsync as one text part, and the dispatch is delivered.
    await hooks["chat.message"]({sessionID: "ses_main"});
    await eventually(async () => {
      const answer = await client.getDispatch(dispatchId, projectId);
      const state = dispatchEnvelopeSchema.parse(await answer.json())
        .dispatch.state;
      return state === "delivered" ? true : null;
    });
    expect(context.prompts).toHaveLength(1);
    const prompt = context.prompts[0];
    expect(prompt?.path.id).toBe("ses_main");
    const message = prompt?.body.parts[0];
    expect(message?.type).toBe("text");
    expect(message?.text.startsWith("Artifact Server: ")).toBe(true);
    expect(message?.text).toContain("Both today, please.");
    expect(message?.text).toContain(first.id);
    expect(message?.text).toContain(second.id);
    expect(message?.text).toContain("artifact_comments");
    expect(
      context.toasts.some((toast) =>
        toast.message.includes("delivering 2 annotation(s)")
      ),
    ).toBe(true);

    // Beacon: the accepted bundle reports thinking.
    await eventually(async () => {
      const state = await connectedAgent(agent.id);
      return state.beacon === "thinking" ? true : null;
    });

    // The first reply through the registered tool reports replying.
    const replied = await hooks.tool.artifact_comments.execute({
      body: "Renamed the heading.",
      operation: "reply",
      threadId: first.id,
    });
    expect(replied).toBe(`Replied to ${first.id}.`);
    await eventually(async () => {
      const state = await connectedAgent(agent.id);
      return state.beacon === "replying" ? true : null;
    });

    // Resolving the bundle's last thread reports idle, and the server
    // infers the dispatch as addressed.
    await hooks.tool.artifact_comments.execute({
      operation: "resolve",
      threadId: first.id,
    });
    await hooks.tool.artifact_comments.execute({
      body: "Tightened the intro.",
      operation: "reply",
      threadId: second.id,
    });
    const resolved = await hooks.tool.artifact_comments.execute({
      operation: "resolve",
      threadId: second.id,
    });
    expect(resolved).toBe(`Resolved ${second.id}.`);
    await eventually(async () => {
      const state = await connectedAgent(agent.id);
      return state.beacon === null && state.activity === "idle" ? true : null;
    });
    await eventually(async () => {
      const answer = await client.getDispatch(dispatchId, projectId);
      const state = dispatchEnvelopeSchema.parse(await answer.json())
        .dispatch.state;
      return state === "addressed" ? true : null;
    });

    // Dispose is a real departure: the courtesy disconnect removes the row.
    await hooks.dispose();
    await eventually(async () => {
      const response = await client.listAgents();
      const listed = agentListSchema.parse(await response.json()).items
        .find((item) => item.id === agent.id);
      return listed === undefined ? true : null;
    });
  });

  test("fails open when the plugin context lacks the expected surface: no registration, no crash, an honest tool error", async () => {
    expect.hasAssertions();
    // A context without the client surface: the boundary guard must leave
    // the bridge dormant rather than crash or register.
    const hooks = await ArtifactServerBridge({directory: "/work/surface-less"});
    hooksToDispose.push(hooks);

    // Every hook stays callable and inert.
    await hooks["chat.message"]({sessionID: "ses_any"});
    await hooks.event({event: {type: "session.created"}});
    await hooks["experimental.session.compacting"]({sessionID: "ses_any"});
    await expect(
      hooks.tool.artifact_comments.execute({operation: "get_bundle"}),
    ).rejects.toThrow("dormant");

    // No agent was ever registered despite resolvable credentials.
    await settle(800);
    const response = await client.listAgents();
    expect(response.status).toBe(200);
    expect(agentListSchema.parse(await response.json()).items)
      .toHaveLength(0);
  });
});
