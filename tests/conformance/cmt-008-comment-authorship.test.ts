import {Effect, Redacted} from "effect";
import {afterEach, beforeEach, describe, expect, test} from "vitest";
import {z} from "zod";

import type {BearerCredentialVerifier} from
  "../../src/application/authentication.js";
import {AuthenticationRequired} from "../../src/core/errors.js";
import type {Principal} from "../../src/core/identity.js";
import {
  createTestInstallation,
  removeTestInstallation,
  type RunningTestServer,
  startTestServer,
  type TestInstallation,
} from "../support/runtime-harness.js";
import {publishNew, type PublishResponse} from "../support/publishing.js";

const authorCredential = "comment-author-credential";
const otherCredential = "comment-other-member-credential";
const administratorCredential = "comment-administrator-credential";
const managerCredential = "comment-artifact-manager-credential";

const createdThreadSchema = z.object({
  thread: z.object({
    author: z.object({principalId: z.string()}),
    body: z.string(),
    id: z.string(),
  }),
});
const createdReplySchema = z.object({
  reply: z.object({
    author: z.object({principalId: z.string()}),
    body: z.string(),
    id: z.string(),
  }),
});
const threadSchema = z.object({thread: z.object({body: z.string()})});
const replySchema = z.object({reply: z.object({body: z.string()})});
const threadDetailsSchema = z.object({
  replies: z.array(z.object({body: z.string(), id: z.string()})),
  thread: z.object({body: z.string(), id: z.string()}),
});
const failureSchema = z.object({
  error: z.object({code: z.string(), message: z.string()}),
});
const actionPageSchema = z.object({
  actions: z.array(z.object({
    action: z.string(),
    artifactId: z.string(),
    principalId: z.string(),
    versionId: z.string(),
  })),
  nextCursor: z.string().nullable(),
});

describe("comment authorship", () => {
  let installation: TestInstallation;
  let server: RunningTestServer;
  let published: PublishResponse;

  beforeEach(async () => {
    installation = await createTestInstallation();
    server = await startTestServer(installation, {
      externalApiBearerVerifier: commentAuthorshipVerifier,
    });
    published = (await publishNew(server, installation, {
      accessSetting: "account_required",
      content: "<!doctype html><title>Authorship</title>",
      idempotencyKey: "comment-authorship-publish",
      name: "Authorship report",
    })).body;
  });

  afterEach(async () => {
    await server.stop();
    await removeTestInstallation(installation);
  });

  test("CMT-008-B: authors edit and delete their own comments while an administrator deletes another member's thread", async () => {
    expect.hasAssertions();
    const thread = await openThread(authorCredential, "authorship-own-01");
    const reply = await addReply(
      authorCredential,
      thread.id,
      "authorship-own-reply-01",
    );
    const threadPath = `/api/v1/artifacts/${published.artifact.id}/comments/${thread.id}`;

    const editedThread = await credentialFetch(authorCredential, threadPath, {
      body: JSON.stringify({body: "The axis label is wrong on the second chart."}),
      method: "PATCH",
    });
    expect(editedThread.status).toBe(200);
    expect(threadSchema.parse(await editedThread.json()).thread.body)
      .toBe("The axis label is wrong on the second chart.");

    const editedReply = await credentialFetch(
      authorCredential,
      `${threadPath}/replies/${reply.id}`,
      {body: JSON.stringify({body: "Corrected in the next publish."}), method: "PATCH"},
    );
    expect(editedReply.status).toBe(200);
    expect(replySchema.parse(await editedReply.json()).reply.body)
      .toBe("Corrected in the next publish.");

    const removedReply = await credentialFetch(
      authorCredential,
      `${threadPath}/replies/${reply.id}`,
      {method: "DELETE"},
    );
    expect(removedReply.status).toBe(204);
    const afterReplyRemoval = await credentialFetch(authorCredential, threadPath);
    expect(threadDetailsSchema.parse(await afterReplyRemoval.json()).replies)
      .toEqual([]);

    const removedThread = await credentialFetch(authorCredential, threadPath, {
      method: "DELETE",
    });
    expect(removedThread.status).toBe(204);
    const missingThread = await credentialFetch(authorCredential, threadPath);
    expect(missingThread.status).toBe(404);
    await expect(missingThread.json()).resolves.toMatchObject({
      error: {code: "COMMENT_NOT_FOUND"},
    });

    const administratorTarget = await openThread(
      authorCredential,
      "authorship-admin-target",
    );
    const administratorDeletion = await credentialFetch(
      administratorCredential,
      `/api/v1/artifacts/${published.artifact.id}/comments/${administratorTarget.id}`,
      {method: "DELETE"},
    );
    expect(administratorDeletion.status).toBe(204);

    const managerTarget = await openThread(
      authorCredential,
      "authorship-manager-target",
    );
    const managerDeletion = await credentialFetch(
      managerCredential,
      `/api/v1/artifacts/${published.artifact.id}/comments/${managerTarget.id}`,
      {method: "DELETE"},
    );
    expect(managerDeletion.status).toBe(204);
  });

  test("CMT-008-F: another member and an administrator cannot rewrite an author's comment while the administrator's delete is recorded", async () => {
    expect.hasAssertions();
    const thread = await openThread(authorCredential, "authorship-denied-01");
    const reply = await addReply(
      authorCredential,
      thread.id,
      "authorship-denied-reply",
    );
    const threadPath = `/api/v1/artifacts/${published.artifact.id}/comments/${thread.id}`;
    const replyPath = `${threadPath}/replies/${reply.id}`;

    const denials = [
      await credentialFetch(otherCredential, threadPath, {
        body: JSON.stringify({body: "Rewritten by another member."}),
        method: "PATCH",
      }),
      await credentialFetch(otherCredential, threadPath, {
        body: JSON.stringify({anchor: {kind: "page"}}),
        method: "PATCH",
      }),
      await credentialFetch(otherCredential, replyPath, {
        body: JSON.stringify({body: "Rewritten reply."}),
        method: "PATCH",
      }),
      await credentialFetch(otherCredential, threadPath, {method: "DELETE"}),
      await credentialFetch(otherCredential, replyPath, {method: "DELETE"}),
      await credentialFetch(administratorCredential, threadPath, {
        body: JSON.stringify({body: "Rewritten by the administrator."}),
        method: "PATCH",
      }),
      await credentialFetch(administratorCredential, replyPath, {
        body: JSON.stringify({body: "Rewritten reply by the administrator."}),
        method: "PATCH",
      }),
    ];
    const denialFailures = await Promise.all(
      denials.map(async (denial) => ({
        failure: failureSchema.parse(await denial.json()),
        status: denial.status,
      })),
    );
    for (const denial of denialFailures) {
      expect(denial).toMatchObject({
        failure: {error: {code: "AUTHORIZATION_DENIED"}},
        status: 403,
      });
    }

    const preserved = await credentialFetch(authorCredential, threadPath);
    const details = threadDetailsSchema.parse(await preserved.json());
    expect(details.thread.body).toBe("The revenue chart needs a second look.");
    expect(details.replies).toEqual([expect.objectContaining({
      body: "The author answers their own thread.",
    })]);

    const administratorDeletion = await credentialFetch(
      administratorCredential,
      threadPath,
      {method: "DELETE"},
    );
    expect(administratorDeletion.status).toBe(204);
    expect((await credentialFetch(authorCredential, threadPath)).status).toBe(404);

    const actions = await credentialFetch(
      administratorCredential,
      `/api/v1/artifacts/${published.artifact.id}/actions` +
        `?projectId=${published.artifact.projectId}`,
    );
    expect(actions.status).toBe(200);
    expect(actionPageSchema.parse(await actions.json()).actions)
      .toContainEqual(expect.objectContaining({
        action: "comment_delete",
        artifactId: published.artifact.id,
        principalId: "member_comment_administrator",
        versionId: published.version.id,
      }));
  });

  async function openThread(
    credential: string,
    idempotencySuffix: string,
  ): Promise<{readonly id: string}> {
    const response = await credentialFetch(
      credential,
      `/api/v1/artifacts/${published.artifact.id}` +
        `/versions/${published.version.id}/comments`,
      {
        body: JSON.stringify({body: "The revenue chart needs a second look."}),
        headers: {"Idempotency-Key": `comment-${idempotencySuffix}`},
        method: "POST",
      },
    );
    expect(response.status).toBe(201);
    return createdThreadSchema.parse(await response.json()).thread;
  }

  async function addReply(
    credential: string,
    threadId: string,
    idempotencySuffix: string,
  ): Promise<{readonly id: string}> {
    const response = await credentialFetch(
      credential,
      `/api/v1/artifacts/${published.artifact.id}/comments/${threadId}/replies`,
      {
        body: JSON.stringify({body: "The author answers their own thread."}),
        headers: {"Idempotency-Key": `comment-${idempotencySuffix}`},
        method: "POST",
      },
    );
    expect(response.status).toBe(201);
    return createdReplySchema.parse(await response.json()).reply;
  }

  async function credentialFetch(
    credential: string,
    pathname: string,
    init: RequestInit = {},
  ): Promise<Response> {
    const headers = new Headers(init.headers);
    headers.set("Authorization", `Bearer ${credential}`);
    headers.set("Content-Type", "application/json");
    return fetch(`${server.baseUrl}${pathname}`, {...init, headers});
  }
});

const commentAuthorshipPrincipals: ReadonlyMap<string, Principal> = new Map([
  [authorCredential, {
    authorizedByPrincipalId: null,
    capabilities: [],
    displayName: "Ada Author",
    id: "member_comment_author",
    installationId: "local",
    kind: "human",
    membershipRole: "member",
  }],
  [otherCredential, {
    authorizedByPrincipalId: null,
    capabilities: [],
    displayName: "Omar Other",
    id: "member_comment_other",
    installationId: "local",
    kind: "human",
    membershipRole: "member",
  }],
  [administratorCredential, {
    authorizedByPrincipalId: null,
    capabilities: [],
    displayName: "Ines Administrator",
    id: "member_comment_administrator",
    installationId: "local",
    kind: "human",
    membershipRole: "administrator",
  }],
  [managerCredential, {
    authorizedByPrincipalId: null,
    capabilities: ["artifact:manage:any"],
    displayName: "Artifact manager automation",
    id: "service:comment_artifact_manager",
    installationId: "local",
    kind: "service",
    membershipRole: "member",
  }],
]);

const commentAuthorshipVerifier: BearerCredentialVerifier = {
  verify: (credential) => {
    const principal = commentAuthorshipPrincipals.get(
      Redacted.value(credential),
    );
    return principal === undefined
      ? Effect.fail(new AuthenticationRequired({
        message: "The external comment credential is invalid.",
      }))
      : Effect.succeed(principal);
  },
};
