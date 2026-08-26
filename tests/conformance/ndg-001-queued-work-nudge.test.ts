/**
 * NDG-001 — the queued-work nudge. A mailbox-tier principal with dispatches
 * queued sees exactly one nudge block appended to an unrelated MCP tool
 * result, naming the real count; the nudge steps down the spec's priority
 * order as the queue drains (queued work, then the unfinished claim, then
 * the progress echo on the settling call) and never appears on error
 * results or on `dispatch_inbox` results.
 */

import {
  CLIENT_CAPABILITIES_META_KEY,
  CLIENT_INFO_META_KEY,
  PROTOCOL_VERSION_META_KEY,
} from "@modelcontextprotocol/server";
import {afterEach, beforeEach, describe, expect, test} from "vitest";
import {z} from "zod";

import {
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

const protocolVersion = "2026-07-28";
const nudgeHeading = "— artifact server —";
const maximumNudgeCharacters = 400;

const inboxAnswerSchema = z.object({
  agent: z.object({id: z.string().startsWith("agt_")}).loose(),
  claimed: z.object({dispatchId: z.string()}).loose().nullable(),
  operation: z.string(),
}).loose();
const threadCreationSchema = z.object({
  thread: z.object({id: z.string()}).loose(),
}).loose();
const toolCallResultSchema = z.object({
  id: z.union([z.string(), z.number()]),
  jsonrpc: z.literal("2.0"),
  result: z.object({
    content: z.array(z.object({text: z.string(), type: z.literal("text")})),
    isError: z.boolean().optional(),
    structuredContent: z.unknown(),
  }).loose(),
}).loose();

describe("queued-work nudges on MCP tool results", () => {
  let installation: TestInstallation;
  let server: RunningTestServer;
  let client: ApiClient;
  let published: PublishResponse;
  let projectId: string;

  beforeEach(async () => {
    installation = await createTestInstallation();
    server = await startTestServer(installation);
    client = new ApiClient(server, installation.apiToken);
    published = (await publishNew(server, installation, {
      accessSetting: "account_required",
      content: "<!doctype html><title>Nudged</title>",
      idempotencyKey: "ndg-001-publish-artifact",
      name: "Nudged report",
    })).body;
    projectId = published.artifact.projectId;
  });

  afterEach(async () => {
    await server.stop();
    await removeTestInstallation(installation);
  });

  test("NDG-001-B: a principal with queued mailbox dispatches sees exactly one queued-work nudge on an unrelated tool result, the nudge names the real count and steps down to the unfinished claim and the settling echo as the queue drains, and it disappears once nothing is pending", async () => {
    expect.hasAssertions();
    const firstThread = await openThread("Rename the heading.", "ndg-001-thread-first");
    const secondThread = await openThread("Tighten the intro.", "ndg-001-thread-second");

    // No mailbox agent yet: an unrelated call carries no nudge at all.
    const before = await callTool(installation.apiToken, "project_list", {});
    expect(before.isError).not.toBe(true);
    expect(before.content).toHaveLength(1);

    const registered = inboxAnswerSchema.parse(
      (await callTool(installation.apiToken, "dispatch_inbox", {
        agentName: "Nudged Claude",
        operation: "list",
      })).structuredContent,
    );
    const olderDispatch = await sendDispatch(registered.agent.id, [firstThread], "ndg-001-dispatch-older");
    await new Promise((resolve) => setTimeout(resolve, 25));
    const youngerDispatch = await sendDispatch(registered.agent.id, [secondThread], "ndg-001-dispatch-younger");

    // Two queued bundles: exactly one trailing nudge naming the real count.
    const queued = await callTool(installation.apiToken, "project_list", {});
    expect(queued.isError).not.toBe(true);
    expect(queued.content).toHaveLength(2);
    const queuedNudge = queued.content[1]?.text ?? "";
    expect(queuedNudge.startsWith(nudgeHeading)).toBe(true);
    expect(queuedNudge).toContain("2 review bundles are queued for your inbox");
    expect(queuedNudge).toContain('dispatch_inbox {"operation": "claim"}');
    expect(queuedNudge.length).toBeLessThanOrEqual(maximumNudgeCharacters);
    expect(queued.content.filter((item) => item.text.includes(nudgeHeading)))
      .toHaveLength(1);

    // Claiming drains one bundle: the count drops, and queued work still
    // outranks the claim that is now being worked.
    const claim = await callTool(installation.apiToken, "dispatch_inbox", {
      agentName: "Nudged Claude",
      operation: "claim",
    });
    expect(claim.isError).not.toBe(true);
    expect(inboxAnswerSchema.parse(claim.structuredContent).claimed?.dispatchId)
      .toBe(olderDispatch.id);
    const oneQueued = await callTool(installation.apiToken, "project_list", {});
    expect(oneQueued.content).toHaveLength(2);
    expect(oneQueued.content[1]?.text).toContain("1 review bundle is queued");
    expect(oneQueued.content[1]?.text).not.toContain("not fully resolved");

    // Settle the first bundle, then claim the second: with nothing queued,
    // the unfinished claim is what the nudge names.
    await reportDelivered(olderDispatch.id);
    await replyAndResolve(firstThread, "ndg-001-first");
    expect(await dispatchState(olderDispatch.id)).toBe("addressed");
    const secondClaim = await callTool(installation.apiToken, "dispatch_inbox", {
      agentName: "Nudged Claude",
      operation: "claim",
    });
    expect(inboxAnswerSchema.parse(secondClaim.structuredContent).claimed?.dispatchId)
      .toBe(youngerDispatch.id);
    await reportDelivered(youngerDispatch.id);
    const working = await callTool(installation.apiToken, "project_list", {});
    expect(working.content).toHaveLength(2);
    const workingNudge = working.content[1]?.text ?? "";
    expect(workingNudge.startsWith(nudgeHeading)).toBe(true);
    expect(workingNudge).toContain(`Your claimed bundle ${youngerDispatch.id} is not fully resolved`);
    expect(workingNudge).not.toContain("queued for your inbox");

    // The call that settles the last thread carries the progress echo.
    const replied = await callTool(installation.apiToken, "comment_reply", {
      artifactId: published.artifact.id,
      body: "Tightened the intro.",
      idempotencyKey: "ndg-001-reply-second",
      projectId,
      threadId: secondThread,
    });
    expect(replied.content[1]?.text).toContain("not fully resolved");
    const settling = await callTool(installation.apiToken, "comment_resolve", {
      artifactId: published.artifact.id,
      projectId,
      resolved: true,
      threadId: secondThread,
    });
    expect(settling.isError).not.toBe(true);
    expect(settling.content).toHaveLength(2);
    expect(settling.content[1]?.text).toContain(
      `All 1 thread in bundle ${youngerDispatch.id} are resolved; the dispatch is addressed.`,
    );
    expect(await dispatchState(youngerDispatch.id)).toBe("addressed");

    // Nothing pending: the nudge is gone.
    const after = await callTool(installation.apiToken, "project_list", {});
    expect(after.isError).not.toBe(true);
    expect(after.content).toHaveLength(1);
    expect(after.content[0]?.text).not.toContain(nudgeHeading);
  });

  test("NDG-001-F: with work queued, an error result and a dispatch_inbox result each carry no nudge", async () => {
    expect.hasAssertions();
    const thread = await openThread("Fix the footer.", "ndg-001-failure-thread");
    const registered = inboxAnswerSchema.parse(
      (await callTool(installation.apiToken, "dispatch_inbox", {
        agentName: "Nudged Claude",
        operation: "list",
      })).structuredContent,
    );
    await sendDispatch(registered.agent.id, [thread], "ndg-001-failure-dispatch");

    // The queue is live: an unrelated success carries the nudge...
    const success = await callTool(installation.apiToken, "project_list", {});
    expect(success.content).toHaveLength(2);
    expect(success.content[1]?.text).toContain("1 review bundle is queued");

    // ...an error result carries only its own message...
    const failed = await callTool(installation.apiToken, "comment_resolve", {
      artifactId: published.artifact.id,
      projectId,
      resolved: true,
      threadId: "th_does_not_exist",
    });
    expect(failed.isError).toBe(true);
    expect(failed.content).toHaveLength(1);
    expect(failed.content[0]?.text).not.toContain(nudgeHeading);

    // ...and the inbox itself, which already says everything, is nudge-free.
    const inbox = await callTool(installation.apiToken, "dispatch_inbox", {
      agentName: "Nudged Claude",
      operation: "list",
    });
    expect(inbox.isError).not.toBe(true);
    expect(inbox.content.some((item) => item.text.includes(nudgeHeading))).toBe(false);
  });

  async function openThread(body: string, idempotencyKey: string): Promise<string> {
    const response = await client.fetch(
      `/api/v1/artifacts/${published.artifact.id}` +
        `/versions/${published.version.id}/comments` +
        `?projectId=${projectId}`,
      {
        body: JSON.stringify({body, path: "index.html"}),
        idempotencyKey,
        method: "POST",
      },
    );
    expect(response.status).toBe(201);
    return threadCreationSchema.parse(await response.json()).thread.id;
  }

  async function sendDispatch(
    agentId: string,
    threadIds: readonly string[],
    idempotencyKey: string,
  ) {
    const response = await client.sendDispatch({agentId, idempotencyKey, projectId, threadIds});
    expect(response.status).toBe(201);
    return dispatchCreationSchema.parse(await response.json()).dispatch;
  }

  async function reportDelivered(dispatchId: string): Promise<void> {
    const delivered = await callTool(installation.apiToken, "dispatch_inbox", {
      dispatchId,
      operation: "delivered",
    });
    expect(delivered.isError).not.toBe(true);
  }

  async function replyAndResolve(threadId: string, keyPrefix: string): Promise<void> {
    const replied = await callTool(installation.apiToken, "comment_reply", {
      artifactId: published.artifact.id,
      body: `Addressed ${threadId}.`,
      idempotencyKey: `${keyPrefix}-reply-${threadId}`,
      projectId,
      threadId,
    });
    expect(replied.isError).not.toBe(true);
    const resolved = await callTool(installation.apiToken, "comment_resolve", {
      artifactId: published.artifact.id,
      projectId,
      resolved: true,
      threadId,
    });
    expect(resolved.isError).not.toBe(true);
  }

  async function dispatchState(dispatchId: string): Promise<string> {
    const response = await client.getDispatch(dispatchId, projectId);
    expect(response.status).toBe(200);
    return dispatchEnvelopeSchema.parse(await response.json()).dispatch.state;
  }

  async function callTool(token: string, name: string, parameters: McpParameters) {
    const response = await fetch(`${server.baseUrl}/mcp`, {
      body: JSON.stringify({
        id: crypto.randomUUID(),
        jsonrpc: "2.0",
        method: "tools/call",
        params: {
          arguments: parameters,
          name,
          _meta: {
            [CLIENT_CAPABILITIES_META_KEY]: {},
            [CLIENT_INFO_META_KEY]: {name: "ndg-001-nudge-test", version: "1"},
            [PROTOCOL_VERSION_META_KEY]: protocolVersion,
          },
        },
      }),
      headers: {
        Accept: "application/json, text/event-stream",
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        "MCP-Protocol-Version": protocolVersion,
        "Mcp-Method": "tools/call",
        "Mcp-Name": name,
      },
      method: "POST",
    });
    expect(response.status).toBe(200);
    return toolCallResultSchema.parse(await response.json()).result;
  }
});

interface McpParameters {
  readonly [key: string]: McpParameterValue;
}

type McpParameterValue =
  | boolean
  | number
  | string
  | null
  | readonly McpParameterValue[]
  | McpParameters;
