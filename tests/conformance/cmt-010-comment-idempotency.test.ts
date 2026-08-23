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
import {
  publishNew,
  publishVersion,
  type PublishResponse,
} from "../support/publishing.js";

const commentThreadSchema = z.object({
  anchor: z.unknown(),
  artifactId: z.string(),
  body: z.string(),
  createdAt: z.iso.datetime(),
  id: z.string(),
  path: z.string().nullable(),
  projectId: z.string(),
  replyCount: z.number().int().nonnegative(),
  state: z.enum(["open", "resolved"]),
  updatedAt: z.iso.datetime(),
  versionId: z.string(),
}).loose();
const commentReplySchema = z.object({
  body: z.string(),
  createdAt: z.iso.datetime(),
  id: z.string(),
  threadId: z.string(),
}).loose();
const threadCreationSchema = z.object({
  replayed: z.boolean(),
  thread: commentThreadSchema,
}).strict();
const replyCreationSchema = z.object({
  replayed: z.boolean(),
  reply: commentReplySchema,
}).strict();
const threadPageSchema = z.object({
  items: z.array(commentThreadSchema),
  nextCursor: z.string().nullable(),
}).strict();
const threadDetailsSchema = z.object({
  replies: z.array(commentReplySchema),
  thread: commentThreadSchema,
}).strict();
const failureSchema = z.object({
  error: z.object({code: z.string(), message: z.string()}).strict(),
}).strict();

const threadKey = "comment-thread-create-key-one";
const replyKey = "comment-reply-create-key-one";

describe("comment create idempotency", () => {
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

  test("CMT-010-B: repeated thread and reply creates with one key replay the original records", async () => {
    expect.hasAssertions();
    const published = await publishArtifact("comment-idempotency-behavior");

    const created = threadCreationSchema.parse(
      await (await createThread(published, threadKey, {
        body: "The axis label on the revenue chart is wrong.",
        path: "index.html",
      })).json(),
    );
    expect(created.replayed).toBe(false);
    expect(created.thread.versionId).toBe(published.version.id);
    expect(created.thread.replyCount).toBe(0);

    const replayedThread = await createThread(published, threadKey, {
      body: "The axis label on the revenue chart is wrong.",
      path: "index.html",
    });
    expect(replayedThread.status).toBe(201);
    const replay = threadCreationSchema.parse(await replayedThread.json());
    expect(replay.replayed).toBe(true);
    expect(replay.thread.id).toBe(created.thread.id);
    expect(replay.thread.createdAt).toBe(created.thread.createdAt);
    expect(replay.thread.body).toBe(created.thread.body);

    const reply = replyCreationSchema.parse(
      await (await createReply(published, created.thread.id, replyKey, {
        body: "Fixed in the next publish.",
      })).json(),
    );
    expect(reply.replayed).toBe(false);
    const replayedReply = await createReply(
      published,
      created.thread.id,
      replyKey,
      {body: "Fixed in the next publish."},
    );
    expect(replayedReply.status).toBe(201);
    const replayedReplyBody = replyCreationSchema.parse(await replayedReply.json());
    expect(replayedReplyBody.replayed).toBe(true);
    expect(replayedReplyBody.reply.id).toBe(reply.reply.id);
    expect(replayedReplyBody.reply.createdAt).toBe(reply.reply.createdAt);

    const page = threadPageSchema.parse(await (await listThreads(published)).json());
    expect(page.items).toHaveLength(1);
    expect(page.items[0]?.id).toBe(created.thread.id);
    expect(page.items[0]?.replyCount).toBe(1);
    const details = threadDetailsSchema.parse(
      await (await readThread(published, created.thread.id)).json(),
    );
    expect(details.replies.map((stored) => stored.id)).toEqual([reply.reply.id]);
  });

  test("CMT-010-F: one key with different input conflicts and writes no duplicate comment", async () => {
    expect.hasAssertions();
    const published = await publishArtifact("comment-idempotency-failure");
    const second = await publishVersion(server, installation, {
      artifactId: published.artifact.id,
      content: "second revision bytes",
      expectedCurrentVersionId: published.artifact.currentVersionId,
      idempotencyKey: "comment-idempotency-second-version",
    });
    const created = threadCreationSchema.parse(
      await (await createThread(published, threadKey, {
        body: "The axis label on the revenue chart is wrong.",
      })).json(),
    );

    const conflictingBody = await createThread(published, threadKey, {
      body: "A different note under the same key.",
    });
    expect(conflictingBody.status).toBe(409);
    expect(failureSchema.parse(await conflictingBody.json()).error.code)
      .toBe("IDEMPOTENCY_CONFLICT");

    const conflictingPath = await createThread(published, threadKey, {
      body: "The axis label on the revenue chart is wrong.",
      path: "index.html",
    });
    expect(conflictingPath.status).toBe(409);

    const conflictingVersion = await fetch(
      `${server.baseUrl}/api/v1/artifacts/${published.artifact.id}/versions/${second.body.version.id}/comments`,
      {
        body: JSON.stringify({
          body: "The axis label on the revenue chart is wrong.",
        }),
        headers: apiHeaders(installation, threadKey),
        method: "POST",
      },
    );
    expect(conflictingVersion.status).toBe(409);

    const missingKey = await fetch(
      `${server.baseUrl}/api/v1/artifacts/${published.artifact.id}/versions/${published.version.id}/comments`,
      {
        body: JSON.stringify({body: "A note posted without a key."}),
        headers: {
          Authorization: `Bearer ${installation.apiToken}`,
          "Content-Type": "application/json",
        },
        method: "POST",
      },
    );
    expect(missingKey.status).toBe(422);
    expect(failureSchema.parse(await missingKey.json()).error.code)
      .toBe("INVALID_INPUT");

    const afterThreadConflicts = threadPageSchema.parse(
      await (await listThreads(published)).json(),
    );
    expect(afterThreadConflicts.items).toHaveLength(1);
    expect(afterThreadConflicts.items[0]?.id).toBe(created.thread.id);
    expect(afterThreadConflicts.items[0]?.body).toBe(created.thread.body);
    expect(afterThreadConflicts.items[0]?.path).toBeNull();

    const reply = replyCreationSchema.parse(
      await (await createReply(published, created.thread.id, replyKey, {
        body: "Fixed in the next publish.",
      })).json(),
    );
    const conflictingReply = await createReply(
      published,
      created.thread.id,
      replyKey,
      {body: "A different reply under the same key."},
    );
    expect(conflictingReply.status).toBe(409);
    expect(failureSchema.parse(await conflictingReply.json()).error.code)
      .toBe("IDEMPOTENCY_CONFLICT");

    const details = threadDetailsSchema.parse(
      await (await readThread(published, created.thread.id)).json(),
    );
    expect(details.replies.map((stored) => stored.id)).toEqual([reply.reply.id]);
    expect(details.thread.replyCount).toBe(1);
  });

  async function publishArtifact(idempotencyKey: string): Promise<PublishResponse> {
    return (await publishNew(server, installation, {
      accessSetting: "account_required",
      content: "<p>revenue report</p>",
      idempotencyKey,
      name: "Revenue report",
    })).body;
  }

  async function createThread(
    published: PublishResponse,
    idempotencyKey: string,
    body: {readonly body: string; readonly path?: string},
  ): Promise<Response> {
    return fetch(
      `${server.baseUrl}/api/v1/artifacts/${published.artifact.id}/versions/${published.version.id}/comments?projectId=${published.artifact.projectId}`,
      {
        body: JSON.stringify(body),
        headers: apiHeaders(installation, idempotencyKey),
        method: "POST",
      },
    );
  }

  async function createReply(
    published: PublishResponse,
    threadId: string,
    idempotencyKey: string,
    body: {readonly body: string},
  ): Promise<Response> {
    return fetch(
      `${server.baseUrl}/api/v1/artifacts/${published.artifact.id}/comments/${threadId}/replies?projectId=${published.artifact.projectId}`,
      {
        body: JSON.stringify(body),
        headers: apiHeaders(installation, idempotencyKey),
        method: "POST",
      },
    );
  }

  async function listThreads(published: PublishResponse): Promise<Response> {
    return fetch(
      `${server.baseUrl}/api/v1/artifacts/${published.artifact.id}/comments?projectId=${published.artifact.projectId}`,
      {headers: {Authorization: `Bearer ${installation.apiToken}`}},
    );
  }

  async function readThread(
    published: PublishResponse,
    threadId: string,
  ): Promise<Response> {
    return fetch(
      `${server.baseUrl}/api/v1/artifacts/${published.artifact.id}/comments/${threadId}?projectId=${published.artifact.projectId}`,
      {headers: {Authorization: `Bearer ${installation.apiToken}`}},
    );
  }
});
