import {
  CLIENT_CAPABILITIES_META_KEY,
  CLIENT_INFO_META_KEY,
  PROTOCOL_VERSION_META_KEY,
} from "@modelcontextprotocol/server";
import {Effect, Redacted} from "effect";
import {afterEach, beforeEach, describe, expect, test} from "vitest";
import {z} from "zod";

import type {BearerCredentialVerifier} from
  "../../src/application/authentication.js";
import {AuthenticationRequired} from "../../src/core/errors.js";
import {
  membershipRoles,
  principalCapabilities,
  principalKinds,
} from "../../src/core/identity.js";
import type {Clock} from "../../src/core/ports.js";
import {
  createTestInstallation,
  removeTestInstallation,
  type RunningTestServer,
  startTestServer,
  type TestInstallation,
} from "../support/runtime-harness.js";
import {publishNew, type PublishResponse} from "../support/publishing.js";

const protocolVersion = "2026-07-28";
const writeOnlyToken = "comment-parity-write-only-credential";

const commentThreadSchema = z.object({
  anchor: z.unknown(),
  artifactId: z.string(),
  author: z.object({
    authorizedByPrincipalId: z.string().nullable(),
    displayName: z.string(),
    principalId: z.string(),
    principalKind: z.enum(["human", "service"]),
  }).strict(),
  body: z.string(),
  createdAt: z.iso.datetime(),
  id: z.string(),
  path: z.string().nullable(),
  projectId: z.string(),
  replyCount: z.number().int().nonnegative(),
  resolvedAt: z.iso.datetime().nullable(),
  resolvedBy: z.unknown(),
  state: z.enum(["open", "resolved"]),
  updatedAt: z.iso.datetime(),
  versionId: z.string(),
}).strict();
const httpThreadSchema = commentThreadSchema.extend({
  links: z.object({self: z.url(), version: z.url()}).strict(),
});
const httpThreadPageSchema = z.object({
  items: z.array(httpThreadSchema),
  nextCursor: z.string().nullable(),
}).strict();
const httpThreadDetailsSchema = z.object({
  replies: z.array(z.object({id: z.string()}).loose()),
  thread: httpThreadSchema,
}).strict();
const httpThreadCreationSchema = z.object({
  replayed: z.boolean(),
  thread: httpThreadSchema,
}).strict();
const mcpThreadPageSchema = z.object({
  items: z.array(commentThreadSchema),
  nextCursor: z.string().nullable(),
}).strict();
const mcpThreadDetailsSchema = z.object({
  replies: z.array(z.object({id: z.string()}).loose()),
  thread: commentThreadSchema,
}).strict();
const mcpThreadCreationSchema = z.object({
  replayed: z.boolean(),
  thread: commentThreadSchema,
}).strict();
const mcpReplyCreationSchema = z.object({
  replayed: z.boolean(),
  reply: z.object({id: z.string(), threadId: z.string()}).loose(),
}).strict();
const toolCallResultSchema = z.object({
  id: z.union([z.string(), z.number()]),
  jsonrpc: z.literal("2.0"),
  result: z.object({
    content: z.array(z.object({text: z.string(), type: z.literal("text")})),
    isError: z.boolean().optional(),
    resultType: z.literal("complete"),
    structuredContent: z.unknown(),
  }).loose(),
}).loose();
const failureSchema = z.object({
  error: z.object({code: z.string(), message: z.string()}).strict(),
}).strict();

describe("comment surface parity and change polling", () => {
  let clock: MutableClock;
  let installation: TestInstallation;
  let server: RunningTestServer;

  beforeEach(async () => {
    // MCP bearer authentication expires one minute after the application
    // clock, so the pinned clock starts at the next whole second of real time
    // instead of a fixed instant that eventually falls into the past.
    clock = new MutableClock(
      new Date(Math.ceil(Date.now() / 1_000) * 1_000).toISOString(),
    );
    installation = await createTestInstallation();
    server = await startTestServer(installation, {
      clock,
      externalApiBearerVerifier: writeOnlyVerifier,
      externalMcpBearerVerifier: writeOnlyVerifier,
    });
  });

  afterEach(async () => {
    await server.stop();
    await removeTestInstallation(installation);
  });

  test("CMT-012-B: HTTP and MCP drive the same comment operations and page changes with a since time and a cursor", async () => {
    expect.hasAssertions();
    const published = await publishArtifact("comment-parity-behavior");

    const overMcp = await callCommentTool(
      mcpThreadCreationSchema,
      "comment_create",
      {
        artifactId: published.artifact.id,
        body: "Opened by the agent over MCP.",
        idempotencyKey: "comment-parity-mcp-create-one",
        path: "index.html",
        projectId: published.artifact.projectId,
        versionId: published.version.id,
      },
    );
    expect(overMcp.replayed).toBe(false);
    const readOverHttp = httpThreadDetailsSchema.parse(
      await (await apiFetch(
        "GET",
        threadRoute(published, overMcp.thread.id),
      )).json(),
    );
    expect(withoutLinks(readOverHttp.thread)).toEqual(overMcp.thread);
    expect(readOverHttp.thread.links.self).toContain(overMcp.thread.id);
    expect(readOverHttp.thread.links.version).toContain(published.version.id);

    clock.advance(1_000);
    const overHttp = httpThreadCreationSchema.parse(
      await (await apiFetch(
        "POST",
        versionCommentsRoute(published),
        {body: {body: "Opened by the same principal over HTTP."}, key: "comment-parity-http-create-one"},
      )).json(),
    );
    const readOverMcp = await callCommentTool(
      mcpThreadDetailsSchema,
      "comment_get",
      {
        artifactId: published.artifact.id,
        projectId: published.artifact.projectId,
        threadId: overHttp.thread.id,
      },
    );
    expect(readOverMcp.thread).toEqual(withoutLinks(overHttp.thread));
    expect(readOverMcp.thread.author.principalId)
      .toBe(overMcp.thread.author.principalId);

    clock.advance(1_000);
    const answered = await callCommentTool(
      mcpReplyCreationSchema,
      "comment_reply",
      {
        artifactId: published.artifact.id,
        body: "Answered over MCP.",
        idempotencyKey: "comment-parity-mcp-reply-one",
        projectId: published.artifact.projectId,
        threadId: overHttp.thread.id,
      },
    );
    expect(answered.reply.threadId).toBe(overHttp.thread.id);
    clock.advance(1_000);
    expect((await apiFetch(
      "PATCH",
      threadRoute(published, overMcp.thread.id),
      {body: {state: "resolved"}},
    )).status).toBe(200);

    const httpAfterMutations = httpThreadPageSchema.parse(
      await (await apiFetch("GET", commentsRoute(published))).json(),
    );
    const mcpAfterMutations = await callCommentTool(
      mcpThreadPageSchema,
      "comment_list",
      {
        artifactId: published.artifact.id,
        projectId: published.artifact.projectId,
      },
    );
    expect(mcpAfterMutations.items)
      .toEqual(httpAfterMutations.items.map(withoutLinks));
    expect(mcpAfterMutations.nextCursor).toBe(httpAfterMutations.nextCursor);
    expect(new Map(mcpAfterMutations.items.map((thread) =>
      [thread.id, thread.state]
    ))).toEqual(new Map([
      [overMcp.thread.id, "resolved"],
      [overHttp.thread.id, "open"],
    ]));

    const opened = [
      overMcp.thread.id,
      overHttp.thread.id,
      ...await openThreadsInOrder(published, "comment-parity-page-thread", 3),
    ];

    const since = overMcp.thread.createdAt;
    const httpPolled = await pageEveryHttpThread(published, since, 2);
    expect(httpPolled.pages).toBe(3);
    expect(new Set(httpPolled.ids).size).toBe(httpPolled.ids.length);
    expect(new Set(httpPolled.ids)).toEqual(new Set(opened));
    const mcpPolled = await pageEveryMcpThread(published, since, 2);
    expect(mcpPolled.ids).toEqual(httpPolled.ids);
    expect(mcpPolled.pages).toBe(httpPolled.pages);
  });

  test("CMT-012-F: MCP and HTTP agree for one principal and a since poll resuming from the previous pass start misses no change", async () => {
    expect.hasAssertions();
    const published = await publishArtifact("comment-parity-failure");
    const threads = await openThreadsInOrder(
      published,
      "comment-parity-poll-thread",
      5,
    );
    const oldest = threads[0];
    const middle = threads[2];
    const newest = threads[4];
    if (oldest === undefined || middle === undefined || newest === undefined) {
      throw new Error("The polling fixture did not create five threads.");
    }

    const firstPage = httpThreadPageSchema.parse(
      await (await apiFetch(
        "GET",
        `${commentsRoute(published)}&limit=2`,
      )).json(),
    );
    expect(firstPage.items).toHaveLength(2);
    expect(firstPage.nextCursor).not.toBeNull();
    clock.advance(1_000);
    expect((await apiFetch(
      "PATCH",
      threadRoute(published, newest),
      {body: {body: "Edited while the poll was still running."}},
    )).status).toBe(200);
    const remaining = await continueHttpPaging(
      published,
      null,
      firstPage.nextCursor,
      2,
    );
    const walked = [
      ...firstPage.items.map((thread) => thread.id),
      ...remaining.ids,
    ];
    expect(new Set(walked).size).toBe(walked.length);
    expect(new Set(walked)).toEqual(new Set(threads));

    clock.advance(1_000);
    const resolvedAt = isoNow();
    expect((await apiFetch(
      "PATCH",
      threadRoute(published, oldest),
      {body: {state: "resolved"}},
    )).status).toBe(200);
    clock.advance(1_000);
    expect((await apiFetch(
      "POST",
      repliesRoute(published, middle),
      {body: {body: "A late reply bumps its thread."}, key: "comment-parity-late-reply"},
    )).status).toBe(201);

    const polled = await pageEveryHttpThread(published, resolvedAt, 1);
    expect(new Set(polled.ids).size).toBe(polled.ids.length);
    expect(new Set(polled.ids)).toEqual(new Set([middle, oldest]));
    const polledOverMcp = await pageEveryMcpThread(published, resolvedAt, 1);
    expect(polledOverMcp.ids).toEqual(polled.ids);

    // A second-precision instant names the same moment, so it must not sort
    // after the millisecond stamps recorded inside that second.
    const secondPrecision = resolvedAt.replace(".000Z", "Z");
    expect(secondPrecision).not.toBe(resolvedAt);
    const polledAtSecondPrecision = await pageEveryHttpThread(
      published,
      secondPrecision,
      1,
    );
    expect(polledAtSecondPrecision.ids).toEqual(polled.ids);
    const polledAtSecondPrecisionOverMcp = await pageEveryMcpThread(
      published,
      secondPrecision,
      1,
    );
    expect(polledAtSecondPrecisionOverMcp.ids).toEqual(polled.ids);

    const httpDenied = await fetch(
      `${server.baseUrl}${commentsRoute(published)}`,
      {headers: {Authorization: `Bearer ${writeOnlyToken}`}},
    );
    expect(httpDenied.status).toBe(403);
    expect(failureSchema.parse(await httpDenied.json()).error.code)
      .toBe("AUTHORIZATION_DENIED");
    const mcpDenied = await callTool(writeOnlyToken, "comment_list", {
      artifactId: published.artifact.id,
      projectId: published.artifact.projectId,
    });
    expect(mcpDenied.isError).toBe(true);
    expect(mcpDenied.content[0]?.text).toContain("AUTHORIZATION_DENIED");

    const httpDeniedRead = await fetch(
      `${server.baseUrl}${threadRoute(published, oldest)}`,
      {headers: {Authorization: `Bearer ${writeOnlyToken}`}},
    );
    expect(httpDeniedRead.status).toBe(403);
    const mcpDeniedRead = await callTool(writeOnlyToken, "comment_get", {
      artifactId: published.artifact.id,
      projectId: published.artifact.projectId,
      threadId: oldest,
    });
    expect(mcpDeniedRead.isError).toBe(true);
    expect(mcpDeniedRead.content[0]?.text).toContain("AUTHORIZATION_DENIED");
  });

  async function publishArtifact(idempotencyKey: string): Promise<PublishResponse> {
    return (await publishNew(server, installation, {
      accessSetting: "account_required",
      content: "<p>parity report</p>",
      idempotencyKey,
      name: "Parity report",
    })).body;
  }

  async function openThreadsInOrder(
    published: PublishResponse,
    keyPrefix: string,
    remaining: number,
    opened: readonly string[] = [],
  ): Promise<readonly string[]> {
    if (remaining === 0) return opened;
    clock.advance(1_000);
    const created = httpThreadCreationSchema.parse(
      await (await apiFetch("POST", versionCommentsRoute(published), {
        body: {body: `Sequenced note ${opened.length}.`},
        key: `${keyPrefix}-${opened.length}`,
      })).json(),
    );
    return openThreadsInOrder(
      published,
      keyPrefix,
      remaining - 1,
      [...opened, created.thread.id],
    );
  }

  function isoNow(): string {
    return clock.now().toISOString();
  }

  async function pageEveryHttpThread(
    published: PublishResponse,
    since: string,
    limit: number,
  ): Promise<WalkedThreads> {
    return continueHttpPaging(published, since, null, limit);
  }

  async function continueHttpPaging(
    published: PublishResponse,
    since: string | null,
    cursor: string | null,
    limit: number,
    walked: WalkedThreads = {ids: [], pages: 0},
  ): Promise<WalkedThreads> {
    const query = new URLSearchParams({limit: String(limit)});
    if (since !== null) query.set("since", since);
    if (cursor !== null) query.set("cursor", cursor);
    const page = httpThreadPageSchema.parse(
      await (await apiFetch(
        "GET",
        `${commentsRoute(published)}&${query.toString()}`,
      )).json(),
    );
    const next: WalkedThreads = {
      ids: [...walked.ids, ...page.items.map((thread) => thread.id)],
      pages: walked.pages + 1,
    };
    return page.nextCursor === null
      ? next
      : continueHttpPaging(published, since, page.nextCursor, limit, next);
  }

  async function pageEveryMcpThread(
    published: PublishResponse,
    since: string,
    limit: number,
    cursor: string | null = null,
    walked: WalkedThreads = {ids: [], pages: 0},
  ): Promise<WalkedThreads> {
    const page = await callCommentTool(mcpThreadPageSchema, "comment_list", {
      artifactId: published.artifact.id,
      cursor,
      limit,
      projectId: published.artifact.projectId,
      since,
    });
    const next: WalkedThreads = {
      ids: [...walked.ids, ...page.items.map((thread) => thread.id)],
      pages: walked.pages + 1,
    };
    return page.nextCursor === null
      ? next
      : pageEveryMcpThread(published, since, limit, page.nextCursor, next);
  }

  async function callCommentTool<Output>(
    schema: z.ZodType<Output>,
    name: string,
    parameters: McpParameters,
  ): Promise<Output> {
    const result = await callTool(installation.apiToken, name, parameters);
    expect(result.isError).not.toBe(true);
    return schema.parse(result.structuredContent);
  }

  async function callTool(
    token: string,
    name: string,
    parameters: McpParameters,
  ) {
    const response = await mcpRequest(
      token,
      "tools/call",
      name,
      {arguments: parameters, name},
    );
    expect(response.status).toBe(200);
    return toolCallResultSchema.parse(await response.json()).result;
  }

  async function mcpRequest(
    token: string,
    method: string,
    toolName: string,
    parameters: McpParameters,
  ): Promise<Response> {
    return fetch(`${server.baseUrl}/mcp`, {
      body: JSON.stringify({
        id: crypto.randomUUID(),
        jsonrpc: "2.0",
        method,
        params: {
          ...parameters,
          _meta: {
            [CLIENT_CAPABILITIES_META_KEY]: {},
            [CLIENT_INFO_META_KEY]: {name: "artifact-server-test", version: "1"},
            [PROTOCOL_VERSION_META_KEY]: protocolVersion,
          },
        },
      }),
      headers: {
        Accept: "application/json, text/event-stream",
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        "MCP-Protocol-Version": protocolVersion,
        "Mcp-Method": method,
        "Mcp-Name": toolName,
      },
      method: "POST",
    });
  }

  async function apiFetch(
    method: string,
    route: string,
    options: {
      readonly body?: McpParameters;
      readonly key?: string;
    } = {},
  ): Promise<Response> {
    const headers = new Headers({
      Authorization: `Bearer ${installation.apiToken}`,
      "Content-Type": "application/json",
    });
    if (options.key !== undefined) headers.set("Idempotency-Key", options.key);
    const init: RequestInit = options.body === undefined
      ? {headers, method}
      : {body: JSON.stringify(options.body), headers, method};
    return fetch(`${server.baseUrl}${route}`, init);
  }
});

function withoutLinks(
  thread: z.infer<typeof httpThreadSchema>,
): z.infer<typeof commentThreadSchema> {
  return {
    anchor: thread.anchor,
    artifactId: thread.artifactId,
    author: thread.author,
    body: thread.body,
    createdAt: thread.createdAt,
    id: thread.id,
    path: thread.path,
    projectId: thread.projectId,
    replyCount: thread.replyCount,
    resolvedAt: thread.resolvedAt,
    resolvedBy: thread.resolvedBy,
    state: thread.state,
    updatedAt: thread.updatedAt,
    versionId: thread.versionId,
  };
}

function commentsRoute(published: PublishResponse): string {
  return `/api/v1/artifacts/${published.artifact.id}/comments?projectId=${published.artifact.projectId}`;
}

function versionCommentsRoute(published: PublishResponse): string {
  return `/api/v1/artifacts/${published.artifact.id}/versions/${published.version.id}/comments?projectId=${published.artifact.projectId}`;
}

function threadRoute(published: PublishResponse, threadId: string): string {
  return `/api/v1/artifacts/${published.artifact.id}/comments/${threadId}?projectId=${published.artifact.projectId}`;
}

function repliesRoute(published: PublishResponse, threadId: string): string {
  return `/api/v1/artifacts/${published.artifact.id}/comments/${threadId}/replies?projectId=${published.artifact.projectId}`;
}

interface WalkedThreads {
  readonly ids: readonly string[];
  readonly pages: number;
}

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

class MutableClock implements Clock {
  #milliseconds: number;

  constructor(instant: string) {
    this.#milliseconds = new Date(instant).getTime();
  }

  advance(milliseconds: number): void {
    this.#milliseconds += milliseconds;
  }

  now(): Date {
    return new Date(this.#milliseconds);
  }
}

const writeOnlyVerifier: BearerCredentialVerifier = {
  verify: (credential) =>
    Redacted.value(credential) === writeOnlyToken
      ? Effect.succeed({
        authorizedByPrincipalId: null,
        capabilities: [principalCapabilities.writeComments],
        displayName: "Write-only agent",
        id: "service:key_write_only",
        installationId: "local",
        kind: principalKinds.service,
        membershipRole: membershipRoles.member,
      })
      : Effect.fail(new AuthenticationRequired({
        message: "The parity credential is invalid.",
      })),
};
