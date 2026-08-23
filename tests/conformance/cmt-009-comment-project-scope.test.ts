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

const projectSchema = z.object({project: z.object({id: z.string()})});
const createdThreadSchema = z.object({
  thread: z.object({
    artifactId: z.string(),
    body: z.string(),
    id: z.string(),
    projectId: z.string(),
    versionId: z.string(),
  }),
});
const createdReplySchema = z.object({
  reply: z.object({id: z.string(), projectId: z.string()}),
});
const threadPageSchema = z.object({
  items: z.array(z.object({
    body: z.string(),
    id: z.string(),
    projectId: z.string(),
    state: z.string(),
  })),
  nextCursor: z.string().nullable(),
});
const threadDetailsSchema = z.object({
  replies: z.array(z.object({
    body: z.string(),
    id: z.string(),
    projectId: z.string(),
  })),
  thread: z.object({
    body: z.string(),
    id: z.string(),
    projectId: z.string(),
    state: z.string(),
  }),
});
const failureSchema = z.object({
  error: z.object({code: z.string(), message: z.string()}),
});

function commentPath(published: PublishResponse, suffix: string): string {
  return `/api/v1/artifacts/${published.artifact.id}/comments${suffix}`;
}

describe("comment project scope", () => {
  let installation: TestInstallation;
  let server: RunningTestServer;
  let productProjectId: string;
  let supportProjectId: string;
  let productArtifact: PublishResponse;
  let supportArtifact: PublishResponse;

  beforeEach(async () => {
    installation = await createTestInstallation();
    server = await startTestServer(installation);
    productProjectId = await createProject("Product", "product");
    supportProjectId = await createProject("Support", "support");
    productArtifact = (await publishNew(server, installation, {
      accessSetting: "account_required",
      content: "<!doctype html><title>Product</title>",
      idempotencyKey: "comment-scope-product-publish",
      name: "Product report",
      projectId: productProjectId,
    })).body;
    supportArtifact = (await publishNew(server, installation, {
      accessSetting: "account_required",
      content: "<!doctype html><title>Support</title>",
      idempotencyKey: "comment-scope-support-publish",
      name: "Support report",
      projectId: supportProjectId,
    })).body;
  });

  afterEach(async () => {
    await server.stop();
    await removeTestInstallation(installation);
  });

  test("CMT-009-B: every comment operation runs inside its own project and returns project-scoped records", async () => {
    expect.hasAssertions();
    const productThread = await openThread(
      productArtifact,
      productProjectId,
      "scope-product-thread",
    );
    expect(productThread.projectId).toBe(productProjectId);
    const supportThread = await openThread(
      supportArtifact,
      supportProjectId,
      "scope-support-thread",
    );
    expect(supportThread.projectId).toBe(supportProjectId);

    const productReply = await apiFetch(
      commentPath(productArtifact, `/${productThread.id}/replies`),
      productProjectId,
      {
        body: JSON.stringify({body: "A product-project reply."}),
        headers: apiHeaders(installation, "comment-scope-product-reply"),
        method: "POST",
      },
    );
    expect(productReply.status).toBe(201);
    const reply = createdReplySchema.parse(await productReply.json()).reply;
    expect(reply.projectId).toBe(productProjectId);

    const productList = await apiFetch(
      commentPath(productArtifact, ""),
      productProjectId,
    );
    expect(threadPageSchema.parse(await productList.json()).items)
      .toEqual([expect.objectContaining({
        id: productThread.id,
        projectId: productProjectId,
      })]);
    const supportList = await apiFetch(
      commentPath(supportArtifact, ""),
      supportProjectId,
    );
    expect(threadPageSchema.parse(await supportList.json()).items)
      .toEqual([expect.objectContaining({
        id: supportThread.id,
        projectId: supportProjectId,
      })]);

    const edited = await apiFetch(
      commentPath(productArtifact, `/${productThread.id}`),
      productProjectId,
      {
        body: JSON.stringify({body: "The product chart needs a legend."}),
        headers: apiHeaders(installation, "comment-scope-product-edit"),
        method: "PATCH",
      },
    );
    expect(edited.status).toBe(200);
    const editedReply = await apiFetch(
      commentPath(productArtifact, `/${productThread.id}/replies/${reply.id}`),
      productProjectId,
      {
        body: JSON.stringify({body: "A corrected product-project reply."}),
        headers: apiHeaders(installation, "comment-scope-reply-edit"),
        method: "PATCH",
      },
    );
    expect(editedReply.status).toBe(200);
    const resolved = await apiFetch(
      commentPath(productArtifact, `/${productThread.id}`),
      productProjectId,
      {
        body: JSON.stringify({state: "resolved"}),
        headers: apiHeaders(installation, "comment-scope-resolve-key"),
        method: "PATCH",
      },
    );
    expect(resolved.status).toBe(200);

    const details = await apiFetch(
      commentPath(productArtifact, `/${productThread.id}`),
      productProjectId,
    );
    expect(threadDetailsSchema.parse(await details.json())).toMatchObject({
      replies: [expect.objectContaining({
        body: "A corrected product-project reply.",
        projectId: productProjectId,
      })],
      thread: {
        body: "The product chart needs a legend.",
        projectId: productProjectId,
        state: "resolved",
      },
    });

    const removedReply = await apiFetch(
      commentPath(productArtifact, `/${productThread.id}/replies/${reply.id}`),
      productProjectId,
      {method: "DELETE"},
    );
    expect(removedReply.status).toBe(204);
    const removedThread = await apiFetch(
      commentPath(productArtifact, `/${productThread.id}`),
      productProjectId,
      {method: "DELETE"},
    );
    expect(removedThread.status).toBe(204);

    const remainingSupport = await apiFetch(
      commentPath(supportArtifact, `/${supportThread.id}`),
      supportProjectId,
    );
    expect(remainingSupport.status).toBe(200);
    expect(threadDetailsSchema.parse(await remainingSupport.json()).thread)
      .toMatchObject({projectId: supportProjectId, state: "open"});
  });

  test("CMT-009-F: identifiers presented under another project or installation are not found without disclosure", async () => {
    expect.hasAssertions();
    const thread = await openThread(
      productArtifact,
      productProjectId,
      "scope-denied-thread",
    );
    const replyResponse = await apiFetch(
      commentPath(productArtifact, `/${thread.id}/replies`),
      productProjectId,
      {
        body: JSON.stringify({body: "A reply that stays in its project."}),
        headers: apiHeaders(installation, "comment-scope-denied-reply"),
        method: "POST",
      },
    );
    const reply = createdReplySchema.parse(await replyResponse.json()).reply;
    const threadPath = commentPath(productArtifact, `/${thread.id}`);
    const replyPath = `${threadPath}/replies/${reply.id}`;

    const crossProject = [
      await apiFetch(commentPath(productArtifact, ""), supportProjectId),
      await apiFetch(threadPath, supportProjectId),
      await apiFetch(
        `/api/v1/artifacts/${productArtifact.artifact.id}` +
          `/versions/${productArtifact.version.id}/comments`,
        supportProjectId,
        {
          body: JSON.stringify({body: "A thread opened in the wrong project."}),
          headers: apiHeaders(installation, "comment-scope-cross-create"),
          method: "POST",
        },
      ),
      await apiFetch(threadPath, supportProjectId, {
        body: JSON.stringify({body: "An edit from the wrong project."}),
        headers: apiHeaders(installation, "comment-scope-cross-edit"),
        method: "PATCH",
      }),
      await apiFetch(`${threadPath}/replies`, supportProjectId, {
        body: JSON.stringify({body: "A reply from the wrong project."}),
        headers: apiHeaders(installation, "comment-scope-cross-reply"),
        method: "POST",
      }),
      await apiFetch(replyPath, supportProjectId, {
        body: JSON.stringify({body: "A reply edit from the wrong project."}),
        headers: apiHeaders(installation, "comment-scope-cross-reedit"),
        method: "PATCH",
      }),
      await apiFetch(replyPath, supportProjectId, {method: "DELETE"}),
      await apiFetch(threadPath, supportProjectId, {method: "DELETE"}),
    ];
    const crossProjectFailures = await Promise.all(
      crossProject.map(async (denied) => ({
        failure: failureSchema.parse(await denied.json()),
        status: denied.status,
      })),
    );
    for (const denied of crossProjectFailures) {
      expect(denied).toMatchObject({
        failure: {error: {code: "ARTIFACT_NOT_FOUND"}},
        status: 404,
      });
      expect(denied.failure.error.message).not.toContain(thread.id);
      expect(denied.failure.error.message).not.toContain(reply.id);
      expect(denied.failure.error.message).not.toContain(productProjectId);
    }

    const foreignThreadOnSupportArtifact = await apiFetch(
      commentPath(supportArtifact, `/${thread.id}`),
      supportProjectId,
    );
    expect(foreignThreadOnSupportArtifact.status).toBe(404);
    expect(
      failureSchema.parse(await foreignThreadOnSupportArtifact.json()).error,
    ).toMatchObject({code: "COMMENT_NOT_FOUND"});

    const foreignVersion = await apiFetch(
      `/api/v1/artifacts/${supportArtifact.artifact.id}` +
        `/versions/${productArtifact.version.id}/comments`,
      supportProjectId,
      {
        body: JSON.stringify({body: "A thread on another project's version."}),
        headers: apiHeaders(installation, "comment-scope-cross-version"),
        method: "POST",
      },
    );
    expect(foreignVersion.status).toBe(404);
    expect(failureSchema.parse(await foreignVersion.json()).error)
      .toMatchObject({code: "VERSION_NOT_FOUND"});

    const otherInstallation = await createTestInstallation();
    const otherServer = await startTestServer(otherInstallation);
    try {
      const foreignArtifact = (await publishNew(otherServer, otherInstallation, {
        accessSetting: "account_required",
        content: "<!doctype html><title>Foreign</title>",
        idempotencyKey: "comment-scope-foreign-publish",
        name: "Foreign report",
      })).body;
      const foreignProjectResponse = await fetch(
        `${otherServer.baseUrl}/api/v1/projects`,
        {
          body: JSON.stringify({name: "Foreign project"}),
          headers: apiHeaders(otherInstallation, "comment-scope-foreign-prj"),
          method: "POST",
        },
      );
      const foreignProjectId = projectSchema.parse(
        await foreignProjectResponse.json(),
      ).project.id;
      const foreignProjectRead = await apiFetch(
        commentPath(productArtifact, ""),
        foreignProjectId,
      );
      expect(foreignProjectRead.status).toBe(404);
      const foreignProjectFailure = failureSchema.parse(
        await foreignProjectRead.json(),
      );
      expect(foreignProjectFailure.error.code).toBe("PROJECT_NOT_FOUND");
      expect(foreignProjectFailure.error.message).not.toContain(foreignProjectId);
      const foreignArtifactRead = await apiFetch(
        `/api/v1/artifacts/${foreignArtifact.artifact.id}/comments`,
        productProjectId,
      );
      expect(foreignArtifactRead.status).toBe(404);
      expect(failureSchema.parse(await foreignArtifactRead.json()).error)
        .toMatchObject({code: "ARTIFACT_NOT_FOUND"});
    } finally {
      await otherServer.stop();
      await removeTestInstallation(otherInstallation);
    }

    const preserved = await apiFetch(threadPath, productProjectId);
    expect(preserved.status).toBe(200);
    expect(threadDetailsSchema.parse(await preserved.json())).toMatchObject({
      replies: [expect.objectContaining({id: reply.id})],
      thread: {
        body: "The revenue chart needs a second look.",
        id: thread.id,
        projectId: productProjectId,
        state: "open",
      },
    });
  });

  async function openThread(
    published: PublishResponse,
    projectId: string,
    idempotencySuffix: string,
  ): Promise<{readonly id: string; readonly projectId: string}> {
    const response = await apiFetch(
      `/api/v1/artifacts/${published.artifact.id}` +
        `/versions/${published.version.id}/comments`,
      projectId,
      {
        body: JSON.stringify({
          body: "The revenue chart needs a second look.",
          path: "index.html",
        }),
        headers: apiHeaders(installation, `comment-${idempotencySuffix}`),
        method: "POST",
      },
    );
    expect(response.status).toBe(201);
    return createdThreadSchema.parse(await response.json()).thread;
  }

  async function createProject(name: string, key: string): Promise<string> {
    const response = await fetch(`${server.baseUrl}/api/v1/projects`, {
      body: JSON.stringify({name}),
      headers: apiHeaders(installation, `comment-scope-project-${key}`),
      method: "POST",
    });
    expect(response.status).toBe(201);
    return projectSchema.parse(await response.json()).project.id;
  }

  async function apiFetch(
    pathname: string,
    projectId: string,
    init: RequestInit = {},
  ): Promise<Response> {
    const headers = new Headers(init.headers);
    headers.set("Authorization", `Bearer ${installation.apiToken}`);
    headers.set("Content-Type", "application/json");
    return fetch(
      `${server.baseUrl}${pathname}?projectId=${projectId}`,
      {...init, headers},
    );
  }
});
