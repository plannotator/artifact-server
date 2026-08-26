/**
 * The Claude Code channel bridge, driven over real stdio MCP against a real
 * spawned server: the process registers as a channel-tier agent, pushes a
 * claimed bundle as a `notifications/claude/channel` event, and closes the
 * loop through its `artifact_comments` tool.
 */

import {resolve} from "node:path";

import {Client} from "@modelcontextprotocol/sdk/client/index.js";
import {StdioClientTransport} from "@modelcontextprotocol/sdk/client/stdio.js";
import {afterEach, beforeEach, describe, expect, test} from "vitest";
import {z} from "zod";

import {
  agentListSchema,
  ApiClient,
  dispatchCreationSchema,
  dispatchEnvelopeSchema,
} from "../support/agent-dispatch.js";
import {publishNew, type PublishResponse} from "../support/publishing.js";
import {
  createTestInstallation,
  removeTestInstallation,
  type RunningTestServer,
  startTestServer,
  type TestInstallation,
} from "../support/runtime-harness.js";

const repositoryRoot = resolve(import.meta.dirname, "..", "..");

const channelNotificationSchema = z.object({
  method: z.literal("notifications/claude/channel"),
  params: z.object({
    content: z.string(),
    meta: z.record(z.string(), z.string()).optional(),
  }).loose(),
}).loose();

const toolTextSchema = z.object({
  content: z.array(z.object({text: z.string(), type: z.literal("text")})),
}).loose();

async function eventually<Value>(
  probe: () => Promise<Value | null>,
  timeoutMilliseconds = 15_000,
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
    await new Promise((settle) => setTimeout(settle, 100));
  }
}

describe("claude channel bridge", () => {
  let installation: TestInstallation;
  let server: RunningTestServer;
  let client: ApiClient;
  let published: PublishResponse;
  let mcpClient: Client | null;

  beforeEach(async () => {
    installation = await createTestInstallation();
    server = await startTestServer(installation);
    client = new ApiClient(server, installation.apiToken);
    published = (await publishNew(server, installation, {
      accessSetting: "account_required",
      content: "<!doctype html><title>Channel</title>",
      idempotencyKey: "claude-channel-publish-artifact",
      name: "Channel report",
    })).body;
    mcpClient = null;
  });

  afterEach(async () => {
    if (mcpClient !== null) await mcpClient.close();
    await server.stop();
    await removeTestInstallation(installation);
  });

  test("a dispatched bundle arrives as a channel notification and the tool closes the loop", async () => {
    expect.hasAssertions();
    const first = await client.openThread(
      published,
      "Rename the heading to Checkout.",
      "claude-channel-thread-first",
    );
    const second = await client.openThread(
      published,
      "Drop the ‮hidden‬ marker.",
      "claude-channel-thread-second",
    );

    const notifications: z.infer<typeof channelNotificationSchema>[] = [];
    mcpClient = new Client({name: "channel-test", version: "0.0.0"});
    mcpClient.fallbackNotificationHandler = (notification) => {
      const parsed = channelNotificationSchema.safeParse(notification);
      if (parsed.success) notifications.push(parsed.data);
      return Promise.resolve();
    };
    await mcpClient.connect(new StdioClientTransport({
      args: [resolve(repositoryRoot, "integrations/claude-channel/index.ts")],
      command: resolve(repositoryRoot, "node_modules/.bin/tsx"),
      cwd: repositoryRoot,
      env: {
        ...process.env,
        ARTIFACT_SERVER_AGENT_NAME: "channel-under-test",
        ARTIFACT_SERVER_AGENT_TOKEN: installation.apiToken,
        ARTIFACT_SERVER_ORIGIN: server.baseUrl,
      },
      stderr: "pipe",
    }));

    // The channel registers itself at the channel evidence tier.
    const agent = await eventually(async () => {
      const response = await client.listAgents();
      expect(response.status).toBe(200);
      const registered = agentListSchema.parse(await response.json()).items
        .find((item) => item.displayName === "channel-under-test");
      return registered ?? null;
    });
    expect(agent.kind).toBe("claude");
    expect(agent.capabilities).toEqual({beacon: true, evidence: "channel"});

    const sent = await client.sendDispatch({
      agentId: agent.id,
      idempotencyKey: "claude-channel-dispatch-0001",
      note: "From the channel test.",
      projectId: published.artifact.projectId,
      threadIds: [first.id, second.id],
    });
    expect(sent.status).toBe(201);
    const dispatch =
      dispatchCreationSchema.parse(await sent.json()).dispatch;

    // The bundle arrives as one channel notification: rendered, sanitized,
    // and marked delivered once written to the transport.
    const pushed = await eventually(() =>
      Promise.resolve(notifications[0] ?? null),
    );
    expect(pushed.params.content).toContain("Rename the heading to Checkout.");
    expect(pushed.params.content).toContain(first.id);
    expect(pushed.params.content).toContain("hidden");
    expect(pushed.params.content).not.toContain("‮");
    expect(notifications).toHaveLength(1);
    await eventually(async () => {
      const response = await client.getDispatch(
        dispatch.id,
        published.artifact.projectId,
      );
      expect(response.status).toBe(200);
      const current = dispatchEnvelopeSchema.parse(await response.json());
      return current.dispatch.state === "delivered" ? current : null;
    });

    // The channel's own tool closes both threads and the dispatch settles.
    for (const threadId of [first.id, second.id]) {
      // eslint-disable-next-line no-await-in-loop
      const replied = await mcpClient.callTool({
        arguments: {body: `Done: ${threadId}.`, operation: "reply", threadId},
        name: "artifact_comments",
      });
      expect(toolTextSchema.parse(replied).content[0]?.text)
        .toContain("Replied");
      // eslint-disable-next-line no-await-in-loop
      const resolved = await mcpClient.callTool({
        arguments: {operation: "resolve", threadId},
        name: "artifact_comments",
      });
      expect(toolTextSchema.parse(resolved).content[0]?.text)
        .toContain("Resolved");
    }
    await eventually(async () => {
      const response = await client.getDispatch(
        dispatch.id,
        published.artifact.projectId,
      );
      expect(response.status).toBe(200);
      const current = dispatchEnvelopeSchema.parse(await response.json());
      return current.dispatch.state === "addressed" ? current : null;
    });
  }, 60_000);
});
