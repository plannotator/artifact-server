import {Effect, Redacted} from "effect";
import {afterEach, beforeEach, describe, expect, test} from "vitest";
import {z} from "zod";

import type {BearerCredentialVerifier} from
  "../../src/application/authentication.js";
import {AuthenticationRequired} from "../../src/core/errors.js";
import type {Principal} from "../../src/core/identity.js";
import {
  apiHeaders,
  createTestInstallation,
  fetchVersion,
  removeTestInstallation,
  type RunningTestServer,
  startTestServer,
  type TestInstallation,
} from "../support/runtime-harness.js";
import {publishNew, type PublishResponse} from "../support/publishing.js";

const memberCredential = "comment-read-admitted-member";
const unscopedCredential = "comment-read-unscoped-service";
const foreignCredential = "comment-read-foreign-installation";
const threadBody = "The axis label on the revenue chart is wrong.";
const replyBody = "Confirmed; the next publish corrects it.";

const threadPageSchema = z.object({
  items: z.array(z.object({
    artifactId: z.string(),
    author: z.object({displayName: z.string(), principalId: z.string()}),
    body: z.string(),
    id: z.string(),
    projectId: z.string(),
    replyCount: z.number().int().nonnegative(),
    state: z.string(),
    versionId: z.string(),
  })),
  nextCursor: z.string().nullable(),
});
const threadDetailsSchema = z.object({
  replies: z.array(z.object({body: z.string(), id: z.string()})),
  thread: z.object({
    body: z.string(),
    id: z.string(),
    replyCount: z.number().int().nonnegative(),
  }),
});
const createdThreadSchema = z.object({
  replayed: z.boolean(),
  thread: z.object({id: z.string(), versionId: z.string()}),
});

describe("comment read authority", () => {
  let installation: TestInstallation;
  let server: RunningTestServer;
  let published: PublishResponse;
  let threadId: string;

  beforeEach(async () => {
    installation = await createTestInstallation();
    server = await startTestServer(installation, {
      externalApiBearerVerifier: commentReaderVerifier,
    });
    published = (await publishNew(server, installation, {
      accessSetting: "public_link",
      content: "<!doctype html><title>Revenue</title>",
      idempotencyKey: "comment-read-authority-publish",
      name: "Revenue report",
    })).body;
    const created = await fetch(
      `${server.baseUrl}/api/v1/artifacts/${published.artifact.id}` +
        `/versions/${published.version.id}/comments`,
      {
        body: JSON.stringify({body: threadBody, path: "index.html"}),
        headers: apiHeaders(installation, "comment-read-authority-thread"),
        method: "POST",
      },
    );
    if (created.status !== 201) {
      throw new Error(`The comment fixture thread failed with ${created.status}.`);
    }
    threadId = createdThreadSchema.parse(await created.json()).thread.id;
    const reply = await fetch(
      `${server.baseUrl}/api/v1/artifacts/${published.artifact.id}` +
        `/comments/${threadId}/replies`,
      {
        body: JSON.stringify({body: replyBody}),
        headers: apiHeaders(installation, "comment-read-authority-reply-01"),
        method: "POST",
      },
    );
    if (reply.status !== 201) {
      throw new Error(`The comment fixture reply failed with ${reply.status}.`);
    }
  });

  afterEach(async () => {
    await server.stop();
    await removeTestInstallation(installation);
  });

  test("CMT-006-B: an admitted member reads threads and replies on the application origin", async () => {
    expect.hasAssertions();
    const page = await credentialFetch(
      memberCredential,
      `/api/v1/artifacts/${published.artifact.id}/comments`,
    );
    expect(page.status).toBe(200);
    const listed = threadPageSchema.parse(await page.json());
    expect(listed.items).toEqual([expect.objectContaining({
      artifactId: published.artifact.id,
      body: threadBody,
      id: threadId,
      projectId: published.artifact.projectId,
      replyCount: 1,
      state: "open",
      versionId: published.version.id,
    })]);

    const details = await credentialFetch(
      memberCredential,
      `/api/v1/artifacts/${published.artifact.id}/comments/${threadId}`,
    );
    expect(details.status).toBe(200);
    const thread = threadDetailsSchema.parse(await details.json());
    expect(thread.thread.id).toBe(threadId);
    expect(thread.replies.map((reply) => reply.body)).toEqual([replyBody]);
  });

  test("CMT-006-F: public-link viewers, anonymous requests, and the content origin never see comments", async () => {
    expect.hasAssertions();
    const listPath = `/api/v1/artifacts/${published.artifact.id}/comments`;
    const detailPath = `${listPath}/${threadId}`;

    const anonymousList = await fetch(`${server.baseUrl}${listPath}`);
    expect(anonymousList.status).toBe(401);
    await expect(anonymousList.json()).resolves.toMatchObject({
      error: {code: "AUTHENTICATION_REQUIRED"},
    });
    const anonymousDetail = await fetch(`${server.baseUrl}${detailPath}`);
    expect(anonymousDetail.status).toBe(401);

    const unscoped = await credentialFetch(unscopedCredential, listPath);
    expect(unscoped.status).toBe(403);
    await expect(unscoped.json()).resolves.toMatchObject({
      error: {code: "AUTHORIZATION_DENIED"},
    });
    const foreign = await credentialFetch(foreignCredential, detailPath);
    expect(foreign.status).toBe(403);
    await expect(foreign.json()).resolves.toMatchObject({
      error: {code: "AUTHORIZATION_DENIED"},
    });

    const publicPage = await fetchVersion(server, published.links.version);
    expect(publicPage.status).toBe(200);
    await expect(publicPage.text()).resolves.not.toContain(threadBody);

    await expectNoContentOriginComments(listPath);
    await expectNoContentOriginComments(detailPath);
  });

  async function expectNoContentOriginComments(pathname: string): Promise<void> {
    const contentUrl = new URL(published.links.version);
    contentUrl.pathname = pathname;
    const anonymous = await fetchVersion(server, contentUrl.toString());
    expect(anonymous.status).toBe(404);
    await expect(anonymous.text()).resolves.not.toContain(threadId);
    const credentialed = await fetchVersion(
      server,
      contentUrl.toString(),
      "GET",
      {Authorization: `Bearer ${installation.apiToken}`},
    );
    expect(credentialed.status).toBe(404);
    const body = await credentialed.text();
    expect(body).not.toContain(threadId);
    expect(body).not.toContain(threadBody);
    expect(body).not.toContain(replyBody);
  }

  async function credentialFetch(
    credential: string,
    pathname: string,
  ): Promise<Response> {
    return fetch(`${server.baseUrl}${pathname}`, {
      headers: {Authorization: `Bearer ${credential}`},
    });
  }
});

const commentReaderPrincipals: ReadonlyMap<string, Principal> = new Map([
  [memberCredential, {
    authorizedByPrincipalId: null,
    capabilities: [],
    displayName: "Dana Reader",
    id: "member_comment_reader",
    installationId: "local",
    kind: "human",
    membershipRole: "member",
  }],
  [unscopedCredential, {
    authorizedByPrincipalId: null,
    capabilities: [],
    displayName: "Unscoped automation",
    id: "service:comment_reader_unscoped",
    installationId: "local",
    kind: "service",
    membershipRole: "member",
  }],
  [foreignCredential, {
    authorizedByPrincipalId: null,
    capabilities: [],
    displayName: "Foreign administrator",
    id: "member_foreign_installation",
    installationId: "other-installation",
    kind: "human",
    membershipRole: "administrator",
  }],
]);

const commentReaderVerifier: BearerCredentialVerifier = {
  verify: (credential) => {
    const principal = commentReaderPrincipals.get(Redacted.value(credential));
    return principal === undefined
      ? Effect.fail(new AuthenticationRequired({
        message: "The external comment credential is invalid.",
      }))
      : Effect.succeed(principal);
  },
};
