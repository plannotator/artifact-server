import {afterEach, beforeEach, describe, expect, test} from "vitest";
import {z} from "zod";

import {
  apiHeaders,
  createTestInstallation,
  removeTestInstallation,
  type RunningTestServer,
  startTestServer,
  type TestInstallation,
} from "../support/runtime-harness.js";
import {publishNew, type PublishResponse} from "../support/publishing.js";

const commentAuthorSchema = z.object({
  authorizedByPrincipalId: z.string().nullable(),
  displayName: z.string(),
  principalId: z.string(),
  principalKind: z.enum(["human", "service"]),
});
const commentThreadSchema = z.object({
  author: commentAuthorSchema,
  body: z.string(),
  createdAt: z.iso.datetime(),
  id: z.string(),
  resolvedAt: z.iso.datetime().nullable(),
  resolvedBy: commentAuthorSchema.nullable(),
  state: z.enum(["open", "resolved"]),
  updatedAt: z.iso.datetime(),
  versionId: z.string(),
});
const createdThreadSchema = z.object({
  replayed: z.boolean(),
  thread: commentThreadSchema,
});
const updatedThreadSchema = z.object({thread: commentThreadSchema});
const threadDetailsSchema = z.object({
  replies: z.array(z.object({id: z.string()})),
  thread: commentThreadSchema,
});
const threadPageSchema = z.object({
  items: z.array(commentThreadSchema),
  nextCursor: z.string().nullable(),
});
const actionPageSchema = z.object({
  actions: z.array(z.object({
    action: z.string(),
    createdAt: z.iso.datetime(),
    principalId: z.string(),
    versionId: z.string(),
  })),
});
const failureSchema = z.object({
  error: z.object({code: z.string(), message: z.string()}),
});

describe("resolving and reopening one comment thread", () => {
  let installation: TestInstallation;
  let server: RunningTestServer;

  beforeEach(async () => {
    installation = await createTestInstallation();
    server = await startTestServer(installation);
  });

  afterEach(async () => {
    await server.stop();
    await removeTestInstallation(installation);
  });

  test("CMT-005-B: one state change resolves and reopens a thread and records who changed it and when", async () => {
    expect.hasAssertions();
    const published = await publishNew(server, installation, {
      accessSetting: "account_required",
      content: "<h1>state</h1>",
      idempotencyKey: "cmt-005-behavior-publish",
      name: "Thread state target",
    });
    const artifactId = published.body.artifact.id;
    const opened = await createThread(
      server,
      installation,
      published.body,
      "cmt-005-behavior-thread-open",
      "The footnote is missing a source.",
    );
    expect(opened.state).toBe("open");
    expect(opened.resolvedAt).toBeNull();
    expect(opened.resolvedBy).toBeNull();

    const resolve = await patchThread(
      server,
      installation,
      artifactId,
      opened.id,
      JSON.stringify({state: "resolved"}),
    );
    expect(resolve.status).toBe(200);
    const resolved = updatedThreadSchema.parse(await resolve.json()).thread;
    expect(resolved.state).toBe("resolved");
    expect(resolved.resolvedAt).not.toBeNull();
    expect(resolved.resolvedBy).toStrictEqual({
      authorizedByPrincipalId: null,
      displayName: "Local",
      principalId: "local-api-token",
      principalKind: "service",
    });
    expect(resolved.resolvedAt === null || resolved.resolvedAt >= opened.createdAt)
      .toBe(true);
    expect(resolved.updatedAt >= opened.updatedAt).toBe(true);
    expect(resolved.body).toBe(opened.body);
    expect(resolved.author).toStrictEqual(opened.author);

    const reopen = await patchThread(
      server,
      installation,
      artifactId,
      opened.id,
      JSON.stringify({state: "open"}),
    );
    expect(reopen.status).toBe(200);
    const reopened = updatedThreadSchema.parse(await reopen.json()).thread;
    expect(reopened.state).toBe("open");
    expect(reopened.resolvedAt).toBeNull();
    expect(reopened.resolvedBy).toBeNull();
    expect(reopened.updatedAt >= resolved.updatedAt).toBe(true);

    const detail = await readThread(server, installation, artifactId, opened.id);
    expect(detail.thread.state).toBe("open");
    expect(detail.thread.resolvedBy).toBeNull();

    const actions = await fetch(
      `${server.baseUrl}/api/v1/artifacts/${artifactId}/actions`,
      {headers: readHeaders(installation)},
    );
    expect(actions.status).toBe(200);
    const actionBody = actionPageSchema.parse(await actions.json());
    const stateActions = actionBody.actions.filter((action) =>
      action.action === "comment_resolve" || action.action === "comment_reopen"
    );
    expect(stateActions.map((action) => action.action))
      .toEqual(["comment_reopen", "comment_resolve"]);
    for (const action of stateActions) {
      expect(action.principalId).toBe("local-api-token");
      expect(action.versionId).toBe(opened.versionId);
      expect(action.createdAt >= opened.createdAt).toBe(true);
    }
  });

  test("CMT-005-F: an unknown state value is refused and a resolved thread stays resolved on every read path", async () => {
    expect.hasAssertions();
    const published = await publishNew(server, installation, {
      accessSetting: "account_required",
      content: "<h1>state</h1>",
      idempotencyKey: "cmt-005-failure-publish",
      name: "Thread state refusal target",
    });
    const artifactId = published.body.artifact.id;
    const opened = await createThread(
      server,
      installation,
      published.body,
      "cmt-005-failure-thread-open",
      "This thread never accepts an unknown state.",
    );

    const refusedCases: readonly {
      readonly body: string;
      readonly code: string;
      readonly status: number;
    }[] = [
      {body: JSON.stringify({state: "closed"}), code: "INVALID_INPUT", status: 422},
      {body: JSON.stringify({state: "Resolved"}), code: "INVALID_INPUT", status: 422},
      {body: JSON.stringify({state: null}), code: "INVALID_INPUT", status: 422},
      {body: JSON.stringify({resolved: true}), code: "INVALID_INPUT", status: 422},
      {body: JSON.stringify({}), code: "INVALID_COMMENT", status: 422},
    ];
    const refused = await Promise.all(refusedCases.map(async (refusedCase) => {
      const response = await patchThread(
        server,
        installation,
        artifactId,
        opened.id,
        refusedCase.body,
      );
      return {
        code: failureSchema.parse(await response.json()).error.code,
        status: response.status,
      };
    }));
    expect(refused.map((outcome) => outcome.status))
      .toEqual(refusedCases.map((refusedCase) => refusedCase.status));
    expect(refused.map((outcome) => outcome.code))
      .toEqual(refusedCases.map((refusedCase) => refusedCase.code));
    expect((await readThread(server, installation, artifactId, opened.id)).thread)
      .toStrictEqual(opened);

    const resolve = await patchThread(
      server,
      installation,
      artifactId,
      opened.id,
      JSON.stringify({state: "resolved"}),
    );
    expect(resolve.status).toBe(200);
    const resolved = updatedThreadSchema.parse(await resolve.json()).thread;

    expect((await listThreads(server, installation, artifactId, "?state=resolved"))
      .items.map((thread) => thread.id)).toEqual([opened.id]);
    expect((await listThreads(server, installation, artifactId, "?state=open"))
      .items).toEqual([]);

    await server.stop();
    server = await startTestServer(installation);
    const afterRestart = await readThread(
      server,
      installation,
      artifactId,
      opened.id,
    );
    expect(afterRestart.thread).toStrictEqual(resolved);
    expect((await listThreads(server, installation, artifactId, "")).items)
      .toEqual([resolved]);
  });
});

function readHeaders(installation: TestInstallation): Headers {
  return new Headers({Authorization: `Bearer ${installation.apiToken}`});
}

async function createThread(
  server: RunningTestServer,
  installation: TestInstallation,
  published: PublishResponse,
  idempotencyKey: string,
  body: string,
): Promise<z.infer<typeof commentThreadSchema>> {
  const response = await fetch(
    `${server.baseUrl}/api/v1/artifacts/${published.artifact.id}/versions/${published.version.id}/comments`,
    {
      body: JSON.stringify({body}),
      headers: apiHeaders(installation, idempotencyKey),
      method: "POST",
    },
  );
  if (response.status !== 201) {
    throw new Error(`Creating a comment thread failed with ${response.status}.`);
  }
  return createdThreadSchema.parse(await response.json()).thread;
}

async function patchThread(
  server: RunningTestServer,
  installation: TestInstallation,
  artifactId: string,
  threadId: string,
  body: string,
): Promise<Response> {
  return fetch(
    `${server.baseUrl}/api/v1/artifacts/${artifactId}/comments/${threadId}`,
    {
      body,
      headers: new Headers({
        Authorization: `Bearer ${installation.apiToken}`,
        "Content-Type": "application/json",
      }),
      method: "PATCH",
    },
  );
}

async function readThread(
  server: RunningTestServer,
  installation: TestInstallation,
  artifactId: string,
  threadId: string,
): Promise<z.infer<typeof threadDetailsSchema>> {
  const response = await fetch(
    `${server.baseUrl}/api/v1/artifacts/${artifactId}/comments/${threadId}`,
    {headers: readHeaders(installation)},
  );
  if (response.status !== 200) {
    throw new Error(`Reading a comment thread failed with ${response.status}.`);
  }
  return threadDetailsSchema.parse(await response.json());
}

async function listThreads(
  server: RunningTestServer,
  installation: TestInstallation,
  artifactId: string,
  query: string,
): Promise<z.infer<typeof threadPageSchema>> {
  const response = await fetch(
    `${server.baseUrl}/api/v1/artifacts/${artifactId}/comments${query}`,
    {headers: readHeaders(installation)},
  );
  if (response.status !== 200) {
    throw new Error(`Listing comment threads failed with ${response.status}.`);
  }
  return threadPageSchema.parse(await response.json());
}
