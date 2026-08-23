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
import {publishNew, publishVersion} from "../support/publishing.js";

const commentAuthorSchema = z.object({
  authorizedByPrincipalId: z.string().nullable(),
  displayName: z.string(),
  principalId: z.string(),
  principalKind: z.enum(["human", "service"]),
});
const commentThreadSchema = z.object({
  anchor: z.unknown(),
  artifactId: z.string(),
  author: commentAuthorSchema,
  body: z.string(),
  createdAt: z.iso.datetime(),
  id: z.string(),
  links: z.object({self: z.url(), version: z.url()}),
  path: z.string().nullable(),
  projectId: z.string(),
  replyCount: z.number().int().nonnegative(),
  resolvedAt: z.string().nullable(),
  resolvedBy: commentAuthorSchema.nullable(),
  state: z.enum(["open", "resolved"]),
  updatedAt: z.iso.datetime(),
  versionId: z.string(),
});
const createdThreadSchema = z.object({
  replayed: z.boolean(),
  thread: commentThreadSchema,
});
const threadDetailsSchema = z.object({
  replies: z.array(z.object({id: z.string()})),
  thread: commentThreadSchema,
});
const threadPageSchema = z.object({
  items: z.array(commentThreadSchema),
  nextCursor: z.string().nullable(),
});
const failureSchema = z.object({
  error: z.object({code: z.string(), message: z.string()}),
});

describe("comment threads pin one exact saved version", () => {
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

  test("CMT-001-B: a thread keeps naming its original artifact and version across later publishes and a restore", async () => {
    expect.hasAssertions();
    const first = await publishNew(server, installation, {
      accessSetting: "account_required",
      content: "<h1>version one</h1>",
      idempotencyKey: "cmt-001-behavior-publish-one",
      name: "Exact version comment target",
    });
    const artifactId = first.body.artifact.id;
    const firstVersionId = first.body.version.id;

    const created = await createThread(
      server,
      installation,
      artifactId,
      firstVersionId,
      "cmt-001-behavior-thread-first",
      JSON.stringify({body: "The axis label is wrong.", path: "index.html"}),
    );
    expect(created.status).toBe(201);
    const createdBody = createdThreadSchema.parse(await created.json());
    expect(createdBody.replayed).toBe(false);
    expect(createdBody.thread.artifactId).toBe(artifactId);
    expect(createdBody.thread.versionId).toBe(firstVersionId);
    expect(createdBody.thread.links.version.endsWith(
      `/api/v1/artifacts/${artifactId}/versions/${firstVersionId}`,
    )).toBe(true);

    const second = await publishVersion(server, installation, {
      artifactId,
      content: "<h1>version two</h1>",
      expectedCurrentVersionId: firstVersionId,
      idempotencyKey: "cmt-001-behavior-publish-two",
    });
    const secondVersionId = second.body.version.id;
    expect(secondVersionId).not.toBe(firstVersionId);

    const secondThread = await createThread(
      server,
      installation,
      artifactId,
      secondVersionId,
      "cmt-001-behavior-thread-second",
      JSON.stringify({body: "The second version reads well."}),
    );
    expect(secondThread.status).toBe(201);

    const restore = await fetch(
      `${server.baseUrl}/api/v1/artifacts/${artifactId}/restore`,
      {
        body: JSON.stringify({
          expectedCurrentVersionId: secondVersionId,
          versionId: firstVersionId,
        }),
        headers: apiHeaders(installation, "cmt-001-behavior-restore-first"),
        method: "POST",
      },
    );
    expect(restore.status).toBe(200);

    const detail = await fetch(
      `${server.baseUrl}/api/v1/artifacts/${artifactId}/comments/${createdBody.thread.id}`,
      {headers: readHeaders(installation)},
    );
    expect(detail.status).toBe(200);
    const detailBody = threadDetailsSchema.parse(await detail.json());
    expect(detailBody.thread.versionId).toBe(firstVersionId);
    expect(detailBody.thread.artifactId).toBe(artifactId);
    expect(detailBody.thread.path).toBe("index.html");

    const firstVersionThreads = await listThreads(
      server,
      installation,
      artifactId,
      `?versionId=${firstVersionId}`,
    );
    expect(firstVersionThreads.items.map((thread) => thread.id))
      .toEqual([createdBody.thread.id]);
    const secondVersionThreads = await listThreads(
      server,
      installation,
      artifactId,
      `?versionId=${secondVersionId}`,
    );
    expect(secondVersionThreads.items.map((thread) => thread.versionId))
      .toEqual([secondVersionId]);
    const everyThread = await listThreads(server, installation, artifactId, "");
    expect(everyThread.items).toHaveLength(2);
  });

  test("CMT-001-F: publishing and restoring change nothing on an existing thread and a thread on an unknown version is refused", async () => {
    expect.hasAssertions();
    const first = await publishNew(server, installation, {
      accessSetting: "account_required",
      content: "<h1>version one</h1>",
      idempotencyKey: "cmt-001-failure-publish-one",
      name: "Unchanged thread target",
    });
    const artifactId = first.body.artifact.id;
    const firstVersionId = first.body.version.id;
    const otherArtifact = await publishNew(server, installation, {
      accessSetting: "account_required",
      content: "<h1>unrelated</h1>",
      idempotencyKey: "cmt-001-failure-publish-other",
      name: "Unrelated artifact",
    });

    const created = await createThread(
      server,
      installation,
      artifactId,
      firstVersionId,
      "cmt-001-failure-thread-first",
      JSON.stringify({body: "Pinned to the first version."}),
    );
    expect(created.status).toBe(201);
    const pinned = createdThreadSchema.parse(await created.json()).thread;

    const second = await publishVersion(server, installation, {
      artifactId,
      content: "<h1>version two</h1>",
      expectedCurrentVersionId: firstVersionId,
      idempotencyKey: "cmt-001-failure-publish-two",
    });
    const restore = await fetch(
      `${server.baseUrl}/api/v1/artifacts/${artifactId}/restore`,
      {
        body: JSON.stringify({
          expectedCurrentVersionId: second.body.version.id,
          versionId: firstVersionId,
        }),
        headers: apiHeaders(installation, "cmt-001-failure-restore-first"),
        method: "POST",
      },
    );
    expect(restore.status).toBe(200);

    const detail = await fetch(
      `${server.baseUrl}/api/v1/artifacts/${artifactId}/comments/${pinned.id}`,
      {headers: readHeaders(installation)},
    );
    expect(threadDetailsSchema.parse(await detail.json()).thread)
      .toStrictEqual(pinned);

    const unknownVersion = await createThread(
      server,
      installation,
      artifactId,
      "ver_00000000-0000-4000-8000-000000000000",
      "cmt-001-failure-unknown-version",
      JSON.stringify({body: "This version never existed."}),
    );
    expect(unknownVersion.status).toBe(404);
    expect(failureSchema.parse(await unknownVersion.json()).error.code)
      .toBe("VERSION_NOT_FOUND");

    const foreignVersion = await createThread(
      server,
      installation,
      artifactId,
      otherArtifact.body.version.id,
      "cmt-001-failure-foreign-version",
      JSON.stringify({body: "That version belongs to another artifact."}),
    );
    expect(foreignVersion.status).toBe(404);
    expect(failureSchema.parse(await foreignVersion.json()).error.code)
      .toBe("VERSION_NOT_FOUND");

    const remaining = await listThreads(server, installation, artifactId, "");
    expect(remaining.items.map((thread) => thread.id)).toEqual([pinned.id]);
    const foreignArtifactThreads = await listThreads(
      server,
      installation,
      otherArtifact.body.artifact.id,
      "",
    );
    expect(foreignArtifactThreads.items).toEqual([]);
  });
});

function readHeaders(installation: TestInstallation): Headers {
  return new Headers({Authorization: `Bearer ${installation.apiToken}`});
}

async function createThread(
  server: RunningTestServer,
  installation: TestInstallation,
  artifactId: string,
  versionId: string,
  idempotencyKey: string,
  body: string,
): Promise<Response> {
  return fetch(
    `${server.baseUrl}/api/v1/artifacts/${artifactId}/versions/${versionId}/comments`,
    {body, headers: apiHeaders(installation, idempotencyKey), method: "POST"},
  );
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
