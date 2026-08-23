import {
  CLIENT_CAPABILITIES_META_KEY,
  CLIENT_INFO_META_KEY,
  PROTOCOL_VERSION_META_KEY,
} from "@modelcontextprotocol/server";
import {afterEach, beforeEach, describe, expect, test} from "vitest";
import {z} from "zod";

import {
  ApiClient,
  browserThreadIds,
  commentThreadSchema,
  dispatchCreationSchema,
  failureSchema,
  type RegisteredAgent,
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

const protocolVersion = "2026-07-28";

const toolCallResultSchema = z.object({
  id: z.union([z.string(), z.number()]),
  jsonrpc: z.literal("2.0"),
  result: z.object({
    isError: z.boolean().optional(),
    structuredContent: z.unknown(),
  }).loose(),
}).loose();
const mcpThreadPageSchema = z.object({
  items: z.array(commentThreadSchema),
  nextCursor: z.string().nullable(),
}).loose();
const mcpThreadDetailsSchema = z.object({
  replies: z.array(z.object({id: z.string()}).loose()),
  thread: commentThreadSchema,
}).loose();
const httpThreadDetailsSchema = z.object({
  replies: z.array(z.object({id: z.string()}).loose()),
  thread: commentThreadSchema,
}).loose();

type McpValue = boolean | number | string | null | McpParameters;
interface McpParameters {
  readonly [key: string]: McpValue;
}

describe("dispatched thread visibility", () => {
  let installation: TestInstallation;
  let server: RunningTestServer;
  let client: ApiClient;
  let published: PublishResponse;
  let projectId: string;
  let agent: RegisteredAgent;

  beforeEach(async () => {
    installation = await createTestInstallation();
    server = await startTestServer(installation);
    client = new ApiClient(server, installation.apiToken);
    published = (await publishNew(server, installation, {
      accessSetting: "account_required",
      content: "<!doctype html><title>Consumptive</title>",
      idempotencyKey: "dispatch-visibility-publish-artifact",
      name: "Consumptive report",
    })).body;
    projectId = published.artifact.projectId;
    agent = await client.registerAgent({
      agentSessionId: "pi-session-visibility",
      connectionKey: "dispatch-visibility-connection-key",
      displayName: "site",
      workingDirectory: "/work/site",
    });
  });

  afterEach(async () => {
    await server.stop();
    await removeTestInstallation(installation);
  });

  test("DSP-004-B: HTTP, MCP, and the web application hide a sent bundle by default and answer the same for every dispatched filter", async () => {
    expect.hasAssertions();
    const sent = await client.openThread(
      published,
      "The heading contradicts the summary.",
      "dispatch-visibility-thread-sent-one",
    );
    const alsoSent = await client.openThread(
      published,
      "The footer link returns a 404.",
      "dispatch-visibility-thread-sent-two",
    );
    const kept = await client.openThread(
      published,
      "An annotation nobody sent anywhere.",
      "dispatch-visibility-thread-kept",
    );
    const browser = await signInAdministrator(server, installation);

    const beforeSending = await client.listThreadIds(published);
    expect(beforeSending.toSorted())
      .toEqual([sent.id, alsoSent.id, kept.id].toSorted());

    const created = dispatchCreationSchema.parse(
      await (await client.sendDispatch({
        agentId: agent.id,
        idempotencyKey: "dispatch-visibility-send-bundle-key",
        projectId,
        threadIds: [sent.id, alsoSent.id],
      })).json(),
    );
    expect(created.dispatch.state).toBe("queued");

    // The send is consumptive: the default listing loses the bundle on every
    // surface without any client passing a new parameter.
    expect(await client.listThreadIds(published)).toEqual([kept.id]);
    expect(await mcpThreadIds()).toEqual([kept.id]);
    expect(await browserThreadIds(server, browser, published))
      .toEqual([kept.id]);

    // include restores the whole set, only isolates the sent bundle, and the
    // two surfaces answer identically for the same principal.
    const httpIncluded = await client.listThreadIds(
      published,
      "&dispatched=include",
    );
    expect(httpIncluded.toSorted())
      .toEqual([sent.id, alsoSent.id, kept.id].toSorted());
    expect(await mcpThreadIds("include")).toEqual(httpIncluded);

    const httpOnly = await client.listThreadIds(published, "&dispatched=only");
    expect(httpOnly.toSorted()).toEqual([sent.id, alsoSent.id].toSorted());
    expect(await mcpThreadIds("only")).toEqual(httpOnly);
    expect(await browserThreadIds(server, browser, published, "&dispatched=only"))
      .toEqual(httpOnly);

    // A deep link into a dispatched thread keeps working: the agent reads it.
    const httpDetails = httpThreadDetailsSchema.parse(
      await (await client.fetch(
        `/api/v1/artifacts/${published.artifact.id}/comments/${sent.id}` +
          `?projectId=${projectId}`,
      )).json(),
    );
    expect(httpDetails.thread).toMatchObject({
      id: sent.id,
      state: "open",
    });
    const mcpDetails = await callTool(
      mcpThreadDetailsSchema,
      "comment_get",
      {artifactId: published.artifact.id, projectId, threadId: sent.id},
    );
    expect(mcpDetails.thread.id).toBe(sent.id);
    expect(mcpDetails.thread.body).toBe(httpDetails.thread.body);
  });

  test("DSP-004-F: no default listing on any surface can show a dispatched thread, and the filter never reaches another project or installation", async () => {
    expect.hasAssertions();
    const sent = await client.openThread(
      published,
      "A sent annotation that must vanish everywhere.",
      "dispatch-visibility-hidden-thread",
    );
    const kept = await client.openThread(
      published,
      "The annotation that stays on screen.",
      "dispatch-visibility-visible-thread",
    );
    const browser = await signInAdministrator(server, installation);
    const beforeSending = new Date(Date.now() - 60_000).toISOString();
    await client.sendDispatch({
      agentId: agent.id,
      idempotencyKey: "dispatch-visibility-hidden-send-key",
      projectId,
      threadIds: [sent.id],
    });

    // Every default-shaped read, including the filtered and polling reads a
    // client already makes, must miss the dispatched thread.
    const defaultReads = [
      await client.listThreadIds(published),
      await client.listThreadIds(published, "&state=open"),
      await client.listThreadIds(published, `&since=${beforeSending}`),
      await client.listThreadIds(
        published,
        `&versionId=${published.version.id}`,
      ),
      await mcpThreadIds(),
      await mcpThreadIds(null, {state: "open"}),
      await mcpThreadIds(null, {since: beforeSending}),
      await browserThreadIds(server, browser, published),
      await browserThreadIds(server, browser, published, "&state=open"),
    ];
    for (const listed of defaultReads) {
      expect(listed).toEqual([kept.id]);
    }

    // A second project holds its own sent bundle; neither filter crosses.
    const otherProjectId = await client.createProject(
      "Other project",
      "dispatch-visibility-other-project",
    );
    const otherPublished = (await publishNew(server, installation, {
      accessSetting: "account_required",
      content: "<!doctype html><title>Other</title>",
      idempotencyKey: "dispatch-visibility-other-publish",
      name: "Other report",
      projectId: otherProjectId,
    })).body;
    const otherAgent = await client.registerAgent({
      connectionKey: "dispatch-visibility-other-connection",
      displayName: "other",
      workingDirectory: "/work/other",
    });
    const otherThread = await client.openThread(
      otherPublished,
      "Another project's sent annotation.",
      "dispatch-visibility-other-thread",
    );
    await client.sendDispatch({
      agentId: otherAgent.id,
      idempotencyKey: "dispatch-visibility-other-send-key",
      projectId: otherProjectId,
      threadIds: [otherThread.id],
    });
    expect(await client.listThreadIds(published, "&dispatched=only"))
      .toEqual([sent.id]);
    expect(await client.listThreadIds(otherPublished, "&dispatched=only"))
      .toEqual([otherThread.id]);
    const crossProject = await client.fetch(
      `/api/v1/artifacts/${published.artifact.id}/comments` +
        `?projectId=${otherProjectId}&dispatched=only`,
    );
    expect(crossProject.status).toBe(404);
    expect(failureSchema.parse(await crossProject.json()).error.code)
      .toBe("ARTIFACT_NOT_FOUND");

    const foreignInstallation = await createTestInstallation();
    const foreignServer = await startTestServer(foreignInstallation);
    try {
      const foreignClient = new ApiClient(
        foreignServer,
        foreignInstallation.apiToken,
      );
      const foreignPublished = (await publishNew(
        foreignServer,
        foreignInstallation,
        {
          accessSetting: "account_required",
          content: "<!doctype html><title>Foreign</title>",
          idempotencyKey: "dispatch-visibility-foreign-publish",
          name: "Foreign report",
        },
      )).body;
      const foreignAgent = await foreignClient.registerAgent({
        connectionKey: "dispatch-visibility-foreign-connection",
        displayName: "foreign",
        workingDirectory: "/work/foreign",
      });
      const foreignThread = await foreignClient.openThread(
        foreignPublished,
        "A foreign installation's sent annotation.",
        "dispatch-visibility-foreign-thread",
      );
      await foreignClient.sendDispatch({
        agentId: foreignAgent.id,
        idempotencyKey: "dispatch-visibility-foreign-send-key",
        projectId: foreignPublished.artifact.projectId,
        threadIds: [foreignThread.id],
      });
      expect(await foreignClient.listThreadIds(foreignPublished, "&dispatched=only"))
        .toEqual([foreignThread.id]);
      const foreignRead = await client.fetch(
        `/api/v1/artifacts/${foreignPublished.artifact.id}/comments` +
          `?projectId=${projectId}&dispatched=only`,
      );
      expect(foreignRead.status).toBe(404);
      expect(failureSchema.parse(await foreignRead.json()).error.code)
        .toBe("ARTIFACT_NOT_FOUND");
    } finally {
      await foreignServer.stop();
      await removeTestInstallation(foreignInstallation);
    }
  });

  /** List thread ids through the MCP comment tool, as an agent client does. */
  async function mcpThreadIds(
    dispatched: "exclude" | "include" | "only" | null = null,
    extra: McpParameters = {},
  ): Promise<readonly string[]> {
    const page = await callTool(mcpThreadPageSchema, "comment_list", {
      artifactId: published.artifact.id,
      dispatched,
      projectId,
      ...extra,
    });
    return page.items.map((thread) => thread.id);
  }

  async function callTool<Output>(
    schema: z.ZodType<Output>,
    name: string,
    parameters: McpParameters,
  ): Promise<Output> {
    const response = await fetch(`${server.baseUrl}/mcp`, {
      body: JSON.stringify({
        id: crypto.randomUUID(),
        jsonrpc: "2.0",
        method: "tools/call",
        params: {
          _meta: {
            [CLIENT_CAPABILITIES_META_KEY]: {},
            [CLIENT_INFO_META_KEY]: {name: "artifact-server-test", version: "1"},
            [PROTOCOL_VERSION_META_KEY]: protocolVersion,
          },
          arguments: parameters,
          name,
        },
      }),
      headers: {
        Accept: "application/json, text/event-stream",
        Authorization: `Bearer ${installation.apiToken}`,
        "Content-Type": "application/json",
        "MCP-Protocol-Version": protocolVersion,
        "Mcp-Method": "tools/call",
        "Mcp-Name": name,
      },
      method: "POST",
    });
    expect(response.status).toBe(200);
    const result = toolCallResultSchema.parse(await response.json()).result;
    expect(result.isError).not.toBe(true);
    return schema.parse(result.structuredContent);
  }
});
