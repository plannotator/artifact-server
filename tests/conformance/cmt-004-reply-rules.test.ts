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
const commentReplySchema = z.object({
  author: commentAuthorSchema,
  body: z.string(),
  createdAt: z.iso.datetime(),
  id: z.string(),
  projectId: z.string(),
  threadId: z.string(),
  updatedAt: z.iso.datetime(),
});
const commentThreadSchema = z.object({
  body: z.string(),
  id: z.string(),
  replyCount: z.number().int().nonnegative(),
  state: z.enum(["open", "resolved"]),
  updatedAt: z.iso.datetime(),
});
const createdThreadSchema = z.object({
  replayed: z.boolean(),
  thread: commentThreadSchema,
});
const createdReplySchema = z.object({
  replayed: z.boolean(),
  reply: commentReplySchema,
});
const threadDetailsSchema = z.object({
  replies: z.array(commentReplySchema),
  thread: commentThreadSchema,
});
const failureSchema = z.object({
  error: z.object({code: z.string(), message: z.string()}),
});

describe("comment replies are one level deep and open-thread only", () => {
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

  test("CMT-004-B: an open thread collects replies that carry no replies of their own", async () => {
    expect.hasAssertions();
    const published = await publishNew(server, installation, {
      accessSetting: "account_required",
      content: "<h1>reviewed</h1>",
      idempotencyKey: "cmt-004-behavior-publish",
      name: "Reply target",
    });
    const artifactId = published.body.artifact.id;
    const thread = await createThread(
      server,
      installation,
      published.body,
      "cmt-004-behavior-thread-open",
      "The summary contradicts the chart.",
    );

    const firstReply = await createReply(
      server,
      installation,
      artifactId,
      thread.id,
      "cmt-004-behavior-reply-first",
      "Good catch; the chart is stale.",
    );
    expect(firstReply.status).toBe(201);
    const firstReplyPayload = await firstReply.json();
    const firstReplyBody = createdReplySchema.parse(firstReplyPayload);
    const firstReplyFields = z.object({
      reply: z.record(z.string(), z.unknown()),
    }).parse(firstReplyPayload).reply;
    expect(Object.keys(firstReplyFields).filter((field) =>
      field === "anchor" || field === "replies" || field === "replyCount" ||
      field === "state"
    )).toEqual([]);
    expect(firstReplyBody.replayed).toBe(false);
    expect(firstReplyBody.reply.threadId).toBe(thread.id);
    expect(firstReplyBody.reply.body).toBe("Good catch; the chart is stale.");

    const secondReply = await createReply(
      server,
      installation,
      artifactId,
      thread.id,
      "cmt-004-behavior-reply-second",
      "Republished with the corrected chart.",
    );
    expect(secondReply.status).toBe(201);
    const secondReplyBody = createdReplySchema.parse(await secondReply.json());

    const detail = await readThread(server, installation, artifactId, thread.id);
    expect(detail.replies.map((reply) => reply.id))
      .toEqual([firstReplyBody.reply.id, secondReplyBody.reply.id]);
    expect(detail.thread.replyCount).toBe(2);
    expect(detail.thread.state).toBe("open");
    expect(detail.thread.updatedAt >= thread.updatedAt).toBe(true);

    const nestedReply = await fetch(
      `${server.baseUrl}/api/v1/artifacts/${artifactId}/comments/${thread.id}/replies/${firstReplyBody.reply.id}/replies`,
      {
        body: JSON.stringify({body: "A reply to a reply."}),
        headers: apiHeaders(installation, "cmt-004-behavior-nested-reply"),
        method: "POST",
      },
    );
    expect(nestedReply.status).toBe(404);
    expect((await readThread(server, installation, artifactId, thread.id))
      .replies).toHaveLength(2);
  });

  test("CMT-004-F: a resolved thread refuses replies and a concurrent resolve never leaves a reply on a resolved thread", async () => {
    expect.hasAssertions();
    const published = await publishNew(server, installation, {
      accessSetting: "account_required",
      content: "<h1>reviewed</h1>",
      idempotencyKey: "cmt-004-failure-publish",
      name: "Reply refusal target",
    });
    const artifactId = published.body.artifact.id;
    const resolvedThread = await createThread(
      server,
      installation,
      published.body,
      "cmt-004-failure-thread-resolved",
      "This thread closes before the reply.",
    );
    const resolve = await patchThread(
      server,
      installation,
      artifactId,
      resolvedThread.id,
      JSON.stringify({state: "resolved"}),
    );
    expect(resolve.status).toBe(200);

    const refused = await createReply(
      server,
      installation,
      artifactId,
      resolvedThread.id,
      "cmt-004-failure-reply-refused",
      "Too late to answer.",
    );
    expect(refused.status).toBe(409);
    expect(failureSchema.parse(await refused.json()).error.code)
      .toBe("COMMENT_RESOLVED");
    const refusedDetail = await readThread(
      server,
      installation,
      artifactId,
      resolvedThread.id,
    );
    expect(refusedDetail.replies).toEqual([]);
    expect(refusedDetail.thread.replyCount).toBe(0);

    const racedThreads = await Promise.all(
      Array.from({length: 12}, (_, index) =>
        createThread(
          server,
          installation,
          published.body,
          `cmt-004-failure-thread-race-${index.toString().padStart(2, "0")}`,
          `Raced thread ${index}.`,
        )),
    );
    const raced = await Promise.all(racedThreads.map(async (racedThread, index) => {
      const suffix = index.toString().padStart(2, "0");
      const replying = () =>
        createReply(
          server,
          installation,
          artifactId,
          racedThread.id,
          `cmt-004-failure-reply-race-${suffix}`,
          `Raced reply ${index}.`,
        );
      const resolving = () =>
        patchThread(
          server,
          installation,
          artifactId,
          racedThread.id,
          JSON.stringify({state: "resolved"}),
        );
      if (index % 2 === 0) {
        const [replyResponse, resolveResponse] = await Promise.all([
          replying(),
          resolving(),
        ]);
        return {replyResponse, resolveResponse, threadId: racedThread.id};
      }
      const [resolveResponse, replyResponse] = await Promise.all([
        resolving(),
        replying(),
      ]);
      return {replyResponse, resolveResponse, threadId: racedThread.id};
    }));

    const settled = await Promise.all(raced.map(async (outcome) => {
      const racedReplyBody: unknown = await outcome.replyResponse.json();
      const detail = await readThread(
        server,
        installation,
        artifactId,
        outcome.threadId,
      );
      const afterRace = await createReply(
        server,
        installation,
        artifactId,
        outcome.threadId,
        `cmt-004-failure-reply-after-${outcome.threadId.slice(-12)}`,
        "The thread is closed now.",
      );
      const afterRaceBody = failureSchema.parse(await afterRace.json());
      const settledDetail = await readThread(
        server,
        installation,
        artifactId,
        outcome.threadId,
      );
      return {
        afterRaceCode: afterRaceBody.error.code,
        afterRaceStatus: afterRace.status,
        racedRefusalCode: outcome.replyResponse.status === 409
          ? failureSchema.parse(racedReplyBody).error.code
          : null,
        replyCount: detail.replies.length,
        replyCountField: detail.thread.replyCount,
        replyStatus: outcome.replyResponse.status,
        resolveStatus: outcome.resolveResponse.status,
        settledReplyCount: settledDetail.replies.length,
        state: detail.thread.state,
      };
    }));
    const expectedReplyCounts = settled.map((outcome) =>
      outcome.replyStatus === 201 ? 1 : 0
    );
    expect(settled.map((outcome) => outcome.resolveStatus))
      .toEqual(settled.map(() => 200));
    expect(settled.every((outcome) =>
      outcome.replyStatus === 201 || outcome.replyStatus === 409
    )).toBe(true);
    expect(settled.map((outcome) => outcome.state))
      .toEqual(settled.map(() => "resolved"));
    expect(settled.map((outcome) => outcome.replyCount))
      .toEqual(expectedReplyCounts);
    expect(settled.map((outcome) => outcome.replyCountField))
      .toEqual(expectedReplyCounts);
    expect(settled.map((outcome) => outcome.racedRefusalCode))
      .toEqual(settled.map((outcome) =>
        outcome.replyStatus === 409 ? "COMMENT_RESOLVED" : null
      ));
    expect(settled.map((outcome) => outcome.afterRaceStatus))
      .toEqual(settled.map(() => 409));
    expect(settled.map((outcome) => outcome.afterRaceCode))
      .toEqual(settled.map(() => "COMMENT_RESOLVED"));
    expect(settled.map((outcome) => outcome.settledReplyCount))
      .toEqual(expectedReplyCounts);
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

async function createReply(
  server: RunningTestServer,
  installation: TestInstallation,
  artifactId: string,
  threadId: string,
  idempotencyKey: string,
  body: string,
): Promise<Response> {
  return fetch(
    `${server.baseUrl}/api/v1/artifacts/${artifactId}/comments/${threadId}/replies`,
    {
      body: JSON.stringify({body}),
      headers: apiHeaders(installation, idempotencyKey),
      method: "POST",
    },
  );
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
