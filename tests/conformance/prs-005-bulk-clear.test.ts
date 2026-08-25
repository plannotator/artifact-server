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
  failureSchema,
  issueApiKey,
  signInAdministrator,
} from "../support/agent-dispatch.js";
import {
  createTestInstallation,
  removeTestInstallation,
  type RunningTestServer,
  startTestServer,
  type TestInstallation,
} from "../support/runtime-harness.js";
import {publishNew, type PublishResponse} from "../support/publishing.js";

const mcpProtocolVersion = "2026-07-28";
const clearingSchema = z.object({
  deleted: z.number().int().nonnegative(),
  skippedDispatched: z.number().int().nonnegative(),
}).strict();
const actionPageSchema = z.object({
  actions: z.array(z.object({
    action: z.string(),
    artifactId: z.string(),
    versionId: z.string(),
  }).loose()),
  nextCursor: z.string().nullable(),
}).strict();
const mcpToolResultSchema = z.object({
  id: z.union([z.string(), z.number()]),
  jsonrpc: z.literal("2.0"),
  result: z.object({
    isError: z.boolean().optional(),
    structuredContent: z.unknown(),
  }).loose(),
}).loose();

describe("bulk comment clearing", () => {
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
      content: "<!doctype html><title>Bulk clear</title>",
      idempotencyKey: "bulk-clear-publish",
      name: "Bulk clear report",
    })).body;
    projectId = published.artifact.projectId;
  });

  afterEach(async () => {
    await server.stop();
    await removeTestInstallation(installation);
  });

  test("PRS-005-B: clearing resolved deletes exactly the resolved threads with one ledger action each, and a manage-any key clears all", async () => {
    expect.hasAssertions();
    const first = await openThread("Resolved and clearable.", "b-one");
    const second = await openThread("Also resolved.", "b-two");
    const third = await openThread("Still open.", "b-three");
    const fourth = await openThread("Open as well.", "b-four");
    await resolveThread(first);
    await resolveThread(second);

    const resolvedClear = await clear(client, {state: "resolved"});
    expect(resolvedClear.status).toBe(200);
    expect(clearingSchema.parse(await resolvedClear.json()))
      .toEqual({deleted: 2, skippedDispatched: 0});
    expect([...await client.listThreadIds(published)].toSorted())
      .toEqual([third, fourth].toSorted());
    expect(await commentDeleteActions()).toBe(2);

    // Repeating the clear finds nothing left in scope.
    const repeated = await clear(client, {state: "resolved"});
    expect(clearingSchema.parse(await repeated.json()))
      .toEqual({deleted: 0, skippedDispatched: 0});

    // The service exception mirrors dispatch send: artifact:manage:any may
    // clear everything, open threads included.
    const administrator = await signInAdministrator(server, installation);
    const manager = new ApiClient(
      server,
      await issueApiKey(
        server,
        administrator,
        ["artifact:manage:any"],
        "Bulk clear manager",
      ),
    );
    const allClear = await clear(manager, {state: "all"});
    expect(allClear.status).toBe(200);
    expect(clearingSchema.parse(await allClear.json()))
      .toEqual({deleted: 2, skippedDispatched: 0});
    expect(await client.listThreadIds(published)).toEqual([]);
    expect(await commentDeleteActions()).toBe(4);
  });

  test("PRS-005-F: an actively dispatched thread is skipped and counted, a non-member key is refused, and MCP comment_clear answers the same shape", async () => {
    expect.hasAssertions();
    const dispatched = await openThread("Held by an agent.", "f-held");
    const resolved = await openThread("Free to delete.", "f-free");
    await resolveThread(resolved);
    const agent = await client.registerAgent({
      agentSessionId: "pi-session-bulk-clear",
      connectionKey: "bulk-clear-connection",
      displayName: "clearing",
      workingDirectory: "/work/clearing",
    });
    const sent = await client.sendDispatch({
      agentId: agent.id,
      idempotencyKey: "bulk-clear-send-dispatched",
      projectId,
      threadIds: [dispatched],
    });
    expect(sent.status).toBe(201);
    const dispatchId = dispatchCreationSchema.parse(await sent.json())
      .dispatch.id;

    // A key without the manage capability is not a member: refused, and the
    // refusal deleted nothing.
    const administrator = await signInAdministrator(server, installation);
    const bridge = new ApiClient(
      server,
      await issueApiKey(
        server,
        administrator,
        ["artifact:read", "comment:write"],
        "Bulk clear bystander",
      ),
    );
    const refused = await clear(bridge, {state: "all"});
    expect(refused.status).toBe(403);
    expect(failureSchema.parse(await refused.json()).error.code)
      .toBe("AUTHORIZATION_DENIED");
    expect(await client.listThreadIds(published, "&state=resolved"))
      .toEqual([resolved]);

    // The queued bundle keeps its thread: clearing never yanks work out
    // from under an agent.
    const cleared = await clear(client, {state: "all"});
    expect(cleared.status).toBe(200);
    expect(clearingSchema.parse(await cleared.json()))
      .toEqual({deleted: 1, skippedDispatched: 1});
    expect(await commentDeleteActions()).toBe(1);

    // MCP parity (CMT-012): the tool sees the same skip and the same counts.
    const parityResolved = await openThread("Cleared over MCP.", "f-mcp");
    await resolveThread(parityResolved);
    const parity = await callCommentClear({
      artifactId: published.artifact.id,
      projectId,
      state: "all",
    });
    expect(parity.result.isError ?? false).toBe(false);
    expect(clearingSchema.parse(parity.result.structuredContent))
      .toEqual({deleted: 1, skippedDispatched: 1});

    // The skipped thread survived intact: canceling the dispatch releases
    // it back into the listing.
    expect((await client.cancelDispatch(dispatchId, projectId)).status)
      .toBe(200);
    expect(await client.listThreadIds(published)).toEqual([dispatched]);
  });

  function clear(
    caller: ApiClient,
    body: {readonly state: "all" | "resolved"; readonly versionId?: string},
  ): Promise<Response> {
    return caller.fetch(
      `/api/v1/projects/${projectId}/artifacts/${published.artifact.id}` +
        "/comments/clear",
      {body: JSON.stringify(body), method: "POST"},
    );
  }

  async function commentDeleteActions(): Promise<number> {
    const response = await client.fetch(
      `/api/v1/artifacts/${published.artifact.id}/actions` +
        `?projectId=${projectId}&limit=100`,
    );
    expect(response.status).toBe(200);
    const page = actionPageSchema.parse(await response.json());
    const deletions = page.actions.filter((action) =>
      action.action === "comment_delete"
    );
    for (const deletion of deletions) {
      expect(deletion).toMatchObject({
        artifactId: published.artifact.id,
        versionId: published.version.id,
      });
    }
    return deletions.length;
  }

  async function callCommentClear(argumentsValue: {
    readonly artifactId: string;
    readonly projectId: string;
    readonly state: "all" | "resolved";
  }) {
    const response = await fetch(`${server.baseUrl}/mcp`, {
      body: JSON.stringify({
        id: crypto.randomUUID(),
        jsonrpc: "2.0",
        method: "tools/call",
        params: {
          _meta: {
            [CLIENT_CAPABILITIES_META_KEY]: {},
            [CLIENT_INFO_META_KEY]: {
              name: "artifact-server-test",
              version: "1",
            },
            [PROTOCOL_VERSION_META_KEY]: mcpProtocolVersion,
          },
          arguments: argumentsValue,
          name: "comment_clear",
        },
      }),
      headers: new Headers({
        Accept: "application/json, text/event-stream",
        Authorization: `Bearer ${installation.apiToken}`,
        "Content-Type": "application/json",
        "Mcp-Method": "tools/call",
        "Mcp-Name": "comment_clear",
        "MCP-Protocol-Version": mcpProtocolVersion,
      }),
      method: "POST",
    });
    expect(response.status).toBe(200);
    return mcpToolResultSchema.parse(await response.json());
  }

  async function openThread(body: string, key: string): Promise<string> {
    const thread = await client.openThread(
      published,
      body,
      `bulk-clear-thread-${key}`,
    );
    return thread.id;
  }

  async function resolveThread(threadId: string): Promise<void> {
    const response = await client.setThreadState(
      published,
      threadId,
      "resolved",
    );
    expect(response.status).toBe(200);
  }
});
