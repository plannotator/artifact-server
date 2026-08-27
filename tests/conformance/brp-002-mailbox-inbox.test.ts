/**
 * BRP-002 — the mailbox floor. Any MCP-capable agent joins the dispatch
 * loop through the `dispatch_inbox` tool on the real `/mcp` endpoint:
 * listing registers the caller implicitly as a mailbox-tier agent, claiming
 * answers the oldest queued dispatch as one rendered, sanitized bundle
 * message, and delivered/failed close the report loop. The rendered message
 * is pinned byte-for-byte against `renderBundleMessage` from
 * `@plannotator/agent-bridge`, so the server-side mirror of the shared
 * render contract cannot drift without failing here.
 */

import {
  CLIENT_CAPABILITIES_META_KEY,
  CLIENT_INFO_META_KEY,
  PROTOCOL_VERSION_META_KEY,
} from "@modelcontextprotocol/server";
import {afterEach, beforeEach, describe, expect, test} from "vitest";
import {z} from "zod";

import {renderBundleMessage} from "@plannotator/agent-bridge";
import {principalCapabilities} from "../../src/core/identity.js";
import {
  agentListSchema,
  ApiClient,
  dispatchCreationSchema,
  dispatchEnvelopeSchema,
  issueApiKey,
  signInAdministrator,
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

const mailboxAgentSchema = z.object({
  capabilities: z.object({
    beacon: z.boolean(),
    evidence: z.enum(["channel", "mailbox", "native"]),
  }).strict(),
  displayName: z.string(),
  id: z.string().startsWith("agt_"),
  kind: z.string(),
}).strict();
const inboxAnswerSchema = z.object({
  agent: mailboxAgentSchema,
  claimed: z.object({
    dispatchId: z.string(),
    message: z.string(),
    note: z.string().nullable(),
    projectId: z.string(),
    threadIds: z.array(z.string()),
    threads: z.array(z.object({
      artifactId: z.string(),
      path: z.string().nullable(),
      threadId: z.string(),
    }).strict()),
  }).strict().nullable(),
  inbox: z.array(z.object({
    createdAt: z.string(),
    id: z.string(),
    note: z.string().nullable(),
    threadCount: z.number().int().positive(),
  }).strict()).nullable(),
  operation: z.enum(["claim", "delivered", "failed", "list"]),
  report: z.object({
    dispatchId: z.string(),
    state: z.string(),
  }).strict().nullable(),
}).strict();
const commentReplyAnswerSchema = z.object({
  replayed: z.boolean(),
  reply: z.object({id: z.string(), threadId: z.string()}).loose(),
}).loose();
const commentThreadAnswerSchema = z.object({
  thread: z.object({id: z.string(), state: z.string()}).loose(),
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
const toolFailureSchema = z.object({
  error: z.object({code: z.string(), message: z.string()}).strict(),
}).strict();

/** Hostile texts: bidirectional overrides and invisibles the render strips. */
const hostileFirstBody =
  "Fix the \u202Eheader\u202C first.\nThen check the footer.";
const hostileQuotedSelection = "The \u200Bquoted \u2066heading\u2069 text";
const secondBody = "Tighten the introduction paragraph.";
const hostileNote = "Please handle \u202Aall\u202C of these today.";

describe("mailbox-tier dispatch inbox over MCP", () => {
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
      content: "<!doctype html><title>Mailbox inbox</title>",
      idempotencyKey: "brp-mailbox-inbox-publish-artifact",
      name: "Mailbox report",
    })).body;
    projectId = published.artifact.projectId;
  });

  afterEach(async () => {
    await server.stop();
    await removeTestInstallation(installation);
  });

  test("BRP-002-B: an MCP principal lists its inbox with implicit mailbox registration, claims the oldest dispatch as a rendered sanitized bundle, and reports delivered, and the agent listing shows the mailbox tier", async () => {
    expect.hasAssertions();
    const firstThread = await openThread(
      hostileFirstBody,
      "brp-mailbox-thread-first",
      hostileQuotedSelection,
    );
    const secondThread = await openThread(
      secondBody,
      "brp-mailbox-thread-second",
      null,
    );
    const thirdThread = await openThread(
      "Third annotation for the younger dispatch.",
      "brp-mailbox-thread-third",
      null,
    );

    // Listing registers the mailbox agent implicitly: mailbox tier, no
    // beacon, the caller-chosen display name, and an empty inbox so far.
    const registered = await callInboxTool(installation.apiToken, {
      agentName: "Mailbox Claude",
      operation: "list",
    });
    expect(registered.agent).toEqual({
      capabilities: {beacon: false, evidence: "mailbox"},
      displayName: "Mailbox Claude",
      id: registered.agent.id,
      kind: "mcp-mailbox",
    });
    expect(registered.inbox).toEqual([]);

    const olderDispatch = await sendDispatch(
      registered.agent.id,
      [firstThread, secondThread],
      hostileNote,
      "brp-mailbox-dispatch-older",
    );
    // Distinct creation instants keep the oldest-first claim deterministic.
    await new Promise((resolve) => setTimeout(resolve, 25));
    const youngerDispatch = await sendDispatch(
      registered.agent.id,
      [thirdThread],
      null,
      "brp-mailbox-dispatch-younger",
    );

    // A second list re-registers the same agent row and shows both queued
    // dispatches oldest first, with note and thread count.
    const listed = await callInboxTool(installation.apiToken, {
      agentName: "Mailbox Claude",
      operation: "list",
    });
    expect(listed.agent.id).toBe(registered.agent.id);
    expect(listed.inbox).toEqual([
      {
        createdAt: olderDispatch.createdAt,
        id: olderDispatch.id,
        note: olderDispatch.note,
        threadCount: 2,
      },
      {
        createdAt: youngerDispatch.createdAt,
        id: youngerDispatch.id,
        note: null,
        threadCount: 1,
      },
    ]);

    // The single-shot claim takes the oldest dispatch and renders the
    // bundle exactly as the shared bridge render does from the same raw
    // inputs — sanitization included, byte for byte.
    const claimAnswer = await callInboxTool(installation.apiToken, {
      agentName: "Mailbox Claude",
      operation: "claim",
    });
    expect(claimAnswer.claimed).not.toBeNull();
    const claimed = claimAnswer.claimed ?? {
      dispatchId: "",
      message: "",
      note: null,
      projectId: "",
      threadIds: [],
      threads: [],
    };
    expect(claimed.dispatchId).toBe(olderDispatch.id);
    expect(claimed.projectId).toBe(projectId);
    expect(claimed.threadIds).toEqual([firstThread, secondThread]);
    expect(claimed.threads).toEqual([
      {
        artifactId: published.artifact.id,
        path: "index.html",
        threadId: firstThread,
      },
      {
        artifactId: published.artifact.id,
        path: "index.html",
        threadId: secondThread,
      },
    ]);
    const expectedMessage = renderBundleMessage(
      {
        items: [
          {
            artifactName: "Mailbox report",
            body: hostileFirstBody,
            path: "index.html",
            quotedSelection: hostileQuotedSelection,
            threadId: firstThread,
            versionNumber: 1,
          },
          {
            artifactName: "Mailbox report",
            body: secondBody,
            path: "index.html",
            quotedSelection: null,
            threadId: secondThread,
            versionNumber: 1,
          },
        ],
        note: olderDispatch.note,
        senderDisplayName: olderDispatch.sender.displayName,
      },
      "mailbox",
    );
    expect(claimed.message).toBe(expectedMessage);
    expect(claimed.message).toMatch(/^Artifact Server: /u);
    // The hostile directives are gone while the visible words survive.
    expect(claimed.message).not.toMatch(
      /[\u202A-\u202E\u2066-\u2069\u200B-\u200F\u2060\uFEFF]/u,
    );
    expect(claimed.message).toContain("Fix the header first.");
    expect(claimed.message).toContain("Please handle all of these today.");
    expect(claimed.message).toContain('"The quoted heading text"');
    expect(claimed.message).toContain("use comment_reply");
    expect(claimed.message).toContain("use comment_resolve");
    expect(claimed.message).not.toContain("artifact_comments");

    // The agent listing tells the mailbox tier truthfully: registered
    // capabilities, connected through its inbox polls, and working the
    // claimed dispatch.
    const agentsAnswer = await client.listAgents();
    expect(agentsAnswer.status).toBe(200);
    const mailboxAgent = agentListSchema.parse(await agentsAnswer.json())
      .items.find((item) => item.id === registered.agent.id);
    expect(mailboxAgent).toBeDefined();
    expect(mailboxAgent?.kind).toBe("mcp-mailbox");
    expect(mailboxAgent?.capabilities).toEqual({
      beacon: false,
      evidence: "mailbox",
    });
    expect(mailboxAgent?.connected).toBe(true);
    expect(mailboxAgent?.activity).toBe("working");
    expect(mailboxAgent?.activeDispatchId).toBe(olderDispatch.id);

    // The delivered report lands, and the younger dispatch stays queued.
    const deliveredAnswer = await callInboxTool(installation.apiToken, {
      dispatchId: olderDispatch.id,
      operation: "delivered",
    });
    expect(deliveredAnswer.report).toEqual({
      dispatchId: olderDispatch.id,
      state: "delivered",
    });
    expect(await dispatchState(youngerDispatch.id)).toBe("queued");

    // The existing MCP comment tools close the loop: reply to and resolve
    // both threads, and the server infers the dispatch as addressed.
    for (const threadId of [firstThread, secondThread]) {
      // eslint-disable-next-line no-await-in-loop
      const replied = await callTool(installation.apiToken, "comment_reply", {
        artifactId: published.artifact.id,
        body: `Addressed thread ${threadId} from the mailbox.`,
        idempotencyKey: `brp-mailbox-reply-${threadId}`,
        projectId,
        threadId,
      });
      expect(replied.isError).not.toBe(true);
      expect(
        commentReplyAnswerSchema.parse(replied.structuredContent)
          .reply.threadId,
      ).toBe(threadId);
      // eslint-disable-next-line no-await-in-loop
      const resolved = await callTool(installation.apiToken, "comment_resolve", {
        artifactId: published.artifact.id,
        projectId,
        resolved: true,
        threadId,
      });
      expect(resolved.isError).not.toBe(true);
      expect(
        commentThreadAnswerSchema.parse(resolved.structuredContent)
          .thread.state,
      ).toBe("resolved");
    }
    expect(await dispatchState(olderDispatch.id)).toBe("addressed");
  });

  test("BRP-002-F: a second principal never sees the first principal's dispatches, claim with an empty inbox answers cleanly, and a delivered report for a dispatch the caller does not hold is refused", async () => {
    expect.hasAssertions();
    const thread = await openThread(
      "An annotation for the first principal's mailbox.",
      "brp-mailbox-foreign-thread",
      null,
    );
    const first = await callInboxTool(installation.apiToken, {
      agentName: "First mailbox",
      operation: "list",
    });
    const dispatch = await sendDispatch(
      first.agent.id,
      [thread],
      null,
      "brp-mailbox-foreign-dispatch",
    );

    const administratorCookies = await signInAdministrator(
      server,
      installation,
    );
    const secondToken = await issueApiKey(
      server,
      administratorCookies,
      [
        principalCapabilities.connectAgents,
        principalCapabilities.readArtifacts,
        principalCapabilities.writeComments,
      ],
      "Second mailbox principal",
    );

    // Before its first list or claim, the second principal holds nothing,
    // so its delivered report is refused without touching the dispatch.
    const unregistered = await callToolExpectingFailure(secondToken, {
      dispatchId: dispatch.id,
      operation: "delivered",
    });
    expect(unregistered.code).toBe("AGENT_NOT_FOUND");
    expect(await dispatchState(dispatch.id)).toBe("queued");

    // Its own inbox registers a separate agent and never shows the first
    // principal's dispatch.
    const foreign = await callInboxTool(secondToken, {
      agentName: null,
      operation: "list",
    });
    expect(foreign.agent.id).not.toBe(first.agent.id);
    expect(foreign.agent.displayName).toBe("mailbox agent");
    expect(foreign.inbox).toEqual([]);

    // An empty-inbox claim answers cleanly rather than erroring.
    const emptyClaim = await callInboxTool(secondToken, {
      agentName: null,
      operation: "claim",
    });
    expect(emptyClaim.operation).toBe("claim");
    expect(emptyClaim.claimed).toBeNull();

    // Registered but still not the holder: the report is refused and the
    // first principal's dispatch stays queued for its own agent.
    const refused = await callToolExpectingFailure(secondToken, {
      dispatchId: dispatch.id,
      operation: "delivered",
    });
    expect(refused.code).toBe("DISPATCH_STATE_CONFLICT");
    expect(refused.message).toContain("does not hold");
    expect(await dispatchState(dispatch.id)).toBe("queued");
  });

  async function openThread(
    body: string,
    idempotencyKey: string,
    quotedSelection: string | null,
  ): Promise<string> {
    const payload = quotedSelection === null
      ? {body, path: "index.html"}
      : {anchor: {originalText: quotedSelection}, body, path: "index.html"};
    const response = await client.fetch(
      `/api/v1/artifacts/${published.artifact.id}` +
        `/versions/${published.version.id}/comments` +
        `?projectId=${projectId}`,
      {body: JSON.stringify(payload), idempotencyKey, method: "POST"},
    );
    expect(response.status).toBe(201);
    return threadCreationSchema.parse(await response.json()).thread.id;
  }

  async function sendDispatch(
    agentId: string,
    threadIds: readonly string[],
    note: string | null,
    idempotencyKey: string,
  ) {
    const response = await client.sendDispatch(
      note === null
        ? {agentId, idempotencyKey, projectId, threadIds}
        : {agentId, idempotencyKey, note, projectId, threadIds},
    );
    expect(response.status).toBe(201);
    return dispatchCreationSchema.parse(await response.json()).dispatch;
  }

  async function dispatchState(dispatchId: string): Promise<string> {
    const response = await client.getDispatch(dispatchId, projectId);
    expect(response.status).toBe(200);
    return dispatchEnvelopeSchema.parse(await response.json()).dispatch.state;
  }

  async function callInboxTool(
    token: string,
    parameters: McpParameters,
  ): Promise<z.infer<typeof inboxAnswerSchema>> {
    const result = await callTool(token, "dispatch_inbox", parameters);
    expect(result.isError).not.toBe(true);
    return inboxAnswerSchema.parse(result.structuredContent);
  }

  async function callToolExpectingFailure(
    token: string,
    parameters: McpParameters,
  ): Promise<{code: string; message: string}> {
    const result = await callTool(token, "dispatch_inbox", parameters);
    expect(result.isError).toBe(true);
    return toolFailureSchema.parse(result.structuredContent).error;
  }

  async function callTool(
    token: string,
    name: string,
    parameters: McpParameters,
  ) {
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
            [CLIENT_INFO_META_KEY]: {
              name: "brp-002-mailbox-test",
              version: "1",
            },
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
