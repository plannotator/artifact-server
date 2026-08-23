import path from "node:path";
import {DatabaseSync} from "node:sqlite";

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
import {
  createTestInstallation,
  removeTestInstallation,
  type RunningTestServer,
  startTestServer,
  type TestInstallation,
} from "../support/runtime-harness.js";
import {publishNew, type PublishResponse} from "../support/publishing.js";

const humanToken = "comment-ledger-human-credential";
const humanPrincipalId = "member_reviewer";
const agentToken = "comment-ledger-agent-credential";
const agentPrincipalId = "service:key_publisher";

const actionRecordSchema = z.object({
  action: z.string(),
  artifactId: z.string(),
  authorizedByPrincipalId: z.string().nullable(),
  createdAt: z.iso.datetime(),
  id: z.string(),
  idempotencyKey: z.string(),
  principalId: z.string(),
  projectId: z.string(),
  versionId: z.string(),
}).strict();
const actionPageSchema = z.object({
  actions: z.array(actionRecordSchema),
  nextCursor: z.string().nullable(),
}).strict();
const threadCreationSchema = z.object({
  replayed: z.boolean(),
  thread: z.object({
    id: z.string(),
    replyCount: z.number().int().nonnegative(),
    state: z.enum(["open", "resolved"]),
    updatedAt: z.iso.datetime(),
    versionId: z.string(),
  }).loose(),
}).strict();
const replyCreationSchema = z.object({
  replayed: z.boolean(),
  reply: z.object({id: z.string(), threadId: z.string()}).loose(),
}).strict();
const threadDetailsSchema = z.object({
  replies: z.array(z.object({id: z.string()}).loose()),
  thread: z.object({
    id: z.string(),
    replyCount: z.number().int().nonnegative(),
    state: z.enum(["open", "resolved"]),
    updatedAt: z.iso.datetime(),
  }).loose(),
}).strict();
const threadPageSchema = z.object({
  items: z.array(z.object({id: z.string()}).loose()),
  nextCursor: z.string().nullable(),
}).strict();
const failureSchema = z.object({
  error: z.object({code: z.string(), message: z.string()}).strict(),
}).strict();

describe("comment mutations and the action ledger", () => {
  let installation: TestInstallation;
  let server: RunningTestServer;

  beforeEach(async () => {
    installation = await createTestInstallation();
    server = await startTestServer(installation, {
      externalApiBearerVerifier: commentPrincipalVerifier,
    });
  });

  afterEach(async () => {
    await server.stop();
    await removeTestInstallation(installation);
  });

  test("CMT-011-B: every comment mutation appends an attributed action naming the artifact and version", async () => {
    expect.hasAssertions();
    const published = await publishArtifact("comment-ledger-behavior");

    const agentThread = threadCreationSchema.parse(
      await expectStatus(
        await commentFetch(agentToken, "POST", versionComments(published), {
          body: JSON.stringify({body: "The axis label is wrong."}),
          key: "comment-ledger-agent-thread",
        }),
        201,
      ).json(),
    );
    const humanThread = threadCreationSchema.parse(
      await expectStatus(
        await commentFetch(humanToken, "POST", versionComments(published), {
          body: JSON.stringify({body: "The summary paragraph reads well."}),
          key: "comment-ledger-human-thread",
        }),
        201,
      ).json(),
    );
    const reply = replyCreationSchema.parse(
      await expectStatus(
        await commentFetch(
          humanToken,
          "POST",
          repliesPath(published, agentThread.thread.id),
          {
            body: JSON.stringify({body: "Fixed in the next publish."}),
            key: "comment-ledger-human-reply",
          },
        ),
        201,
      ).json(),
    );
    // A comment write reuses keys that already name a publish and a thread; the
    // ledger owns its own key namespace, so neither collides.
    expectStatus(
      await commentFetch(humanToken, "POST", versionComments(published), {
        body: JSON.stringify({body: "This note reuses the publish key."}),
        key: "comment-ledger-behavior",
      }),
      201,
    );
    expectStatus(
      await commentFetch(
        humanToken,
        "POST",
        repliesPath(published, agentThread.thread.id),
        {
          body: JSON.stringify({body: "This reply reuses the thread key."}),
          key: "comment-ledger-agent-thread",
        },
      ),
      201,
    );
    expectStatus(
      await commentFetch(
        agentToken,
        "PATCH",
        threadPath(published, agentThread.thread.id),
        {body: JSON.stringify({body: "The axis label is wrong on the chart."})},
      ),
      200,
    );
    expectStatus(
      await commentFetch(
        humanToken,
        "PATCH",
        threadPath(published, agentThread.thread.id),
        {body: JSON.stringify({state: "resolved"})},
      ),
      200,
    );
    expectStatus(
      await commentFetch(
        humanToken,
        "PATCH",
        threadPath(published, agentThread.thread.id),
        {body: JSON.stringify({state: "open"})},
      ),
      200,
    );
    expectStatus(
      await commentFetch(
        humanToken,
        "PATCH",
        replyPath(published, agentThread.thread.id, reply.reply.id),
        {body: JSON.stringify({body: "Fixed in version two."})},
      ),
      200,
    );
    expectStatus(
      await commentFetch(
        humanToken,
        "DELETE",
        replyPath(published, agentThread.thread.id, reply.reply.id),
      ),
      204,
    );
    expectStatus(
      await commentFetch(
        humanToken,
        "DELETE",
        threadPath(published, agentThread.thread.id),
      ),
      204,
    );
    expectStatus(
      await commentFetch(
        humanToken,
        "DELETE",
        threadPath(published, humanThread.thread.id),
      ),
      204,
    );

    const ledger = await readActions(published);
    const commentActions = ledger.filter((record) =>
      record.action.startsWith("comment_")
    );
    expect(commentActions.every((record) =>
      record.artifactId === published.artifact.id &&
      record.versionId === published.version.id &&
      record.projectId === published.artifact.projectId
    )).toBe(true);
    expect(new Set(commentActions.map((record) => record.action))).toEqual(
      new Set([
        "comment_create",
        "comment_delete",
        "comment_reopen",
        "comment_reply",
        "comment_resolve",
        "comment_update",
      ]),
    );
    expect(commentActions).toContainEqual(expect.objectContaining({
      action: "comment_create",
      authorizedByPrincipalId: humanPrincipalId,
      principalId: agentPrincipalId,
    }));
    expect(commentActions).toContainEqual(expect.objectContaining({
      action: "comment_create",
      authorizedByPrincipalId: null,
      principalId: humanPrincipalId,
    }));
    expect(commentActions).toContainEqual(expect.objectContaining({
      action: "comment_reply",
      principalId: humanPrincipalId,
    }));
    expect(commentActions).toContainEqual(expect.objectContaining({
      action: "comment_update",
      authorizedByPrincipalId: humanPrincipalId,
      principalId: agentPrincipalId,
    }));
    expect(commentActions).toContainEqual(expect.objectContaining({
      action: "comment_resolve",
      principalId: humanPrincipalId,
    }));
    expect(commentActions).toContainEqual(expect.objectContaining({
      action: "comment_reopen",
      principalId: humanPrincipalId,
    }));
    expect(
      commentActions.filter((record) => record.action === "comment_delete"),
    ).toHaveLength(3);
    expect(commentActions.every((record) => record.idempotencyKey.length > 0))
      .toBe(true);
    expect(new Set(ledger.map((record) => record.idempotencyKey)).size)
      .toBe(ledger.length);
  });

  test("CMT-011-F: a comment mutation cannot commit when its action record is refused", async () => {
    expect.hasAssertions();
    const published = await publishArtifact("comment-ledger-failure");
    const survivor = threadCreationSchema.parse(
      await expectStatus(
        await commentFetch(humanToken, "POST", versionComments(published), {
          body: JSON.stringify({body: "The first note survives."}),
          key: "comment-ledger-survivor-thread",
        }),
        201,
      ).json(),
    );

    refuseCommentActions();

    const refusedCreate = await commentFetch(
      humanToken,
      "POST",
      versionComments(published),
      {
        body: JSON.stringify({body: "This note must never exist."}),
        key: "comment-ledger-refused-thread",
      },
    );
    expect(refusedCreate.status).toBe(500);
    expect(failureSchema.parse(await refusedCreate.json()).error.code)
      .toBe("INTERNAL_ERROR");

    const refusedReply = await commentFetch(
      humanToken,
      "POST",
      repliesPath(published, survivor.thread.id),
      {
        body: JSON.stringify({body: "This reply must never exist."}),
        key: "comment-ledger-refused-reply",
      },
    );
    expect(refusedReply.status).toBe(500);

    const refusedResolve = await commentFetch(
      humanToken,
      "PATCH",
      threadPath(published, survivor.thread.id),
      {body: JSON.stringify({state: "resolved"})},
    );
    expect(refusedResolve.status).toBe(500);

    const refusedDelete = await commentFetch(
      humanToken,
      "DELETE",
      threadPath(published, survivor.thread.id),
    );
    expect(refusedDelete.status).toBe(500);

    const afterRefusals = threadPageSchema.parse(
      await expectStatus(
        await commentFetch(humanToken, "GET", artifactComments(published)),
        200,
      ).json(),
    );
    expect(afterRefusals.items.map((thread) => thread.id))
      .toEqual([survivor.thread.id]);
    const unchanged = threadDetailsSchema.parse(
      await expectStatus(
        await commentFetch(
          humanToken,
          "GET",
          threadPath(published, survivor.thread.id),
        ),
        200,
      ).json(),
    );
    expect(unchanged.thread.state).toBe("open");
    expect(unchanged.thread.replyCount).toBe(0);
    expect(unchanged.thread.updatedAt).toBe(survivor.thread.updatedAt);
    expect(unchanged.replies).toEqual([]);
    const refusedLedger = await readActions(published);
    expect(refusedLedger.filter((record) =>
      record.action.startsWith("comment_")
    )).toHaveLength(1);

    acceptCommentActions();

    const accepted = await commentFetch(
      humanToken,
      "POST",
      repliesPath(published, survivor.thread.id),
      {
        body: JSON.stringify({body: "This reply is recorded with its action."}),
        key: "comment-ledger-accepted-reply",
      },
    );
    expect(accepted.status).toBe(201);
    const acceptedLedger = await readActions(published);
    expect(acceptedLedger.filter((record) =>
      record.action.startsWith("comment_")
    ).map((record) => record.action)).toEqual(
      expect.arrayContaining(["comment_create", "comment_reply"]),
    );
  });

  function refuseCommentActions(): void {
    withInstallationDatabase((database) => {
      database.exec(
        `CREATE TRIGGER comment_action_outage
         BEFORE INSERT ON actions
         WHEN NEW.action LIKE 'comment\\_%' ESCAPE '\\'
         BEGIN
           SELECT RAISE(ABORT, 'the action ledger refused the write');
         END;`,
      );
    });
  }

  function acceptCommentActions(): void {
    withInstallationDatabase((database) => {
      database.exec("DROP TRIGGER comment_action_outage;");
    });
  }

  function withInstallationDatabase(
    operation: (database: DatabaseSync) => void,
  ): void {
    const database = new DatabaseSync(
      path.join(installation.dataDirectory, "artifact-server.db"),
      {timeout: 5_000},
    );
    try {
      operation(database);
    } finally {
      database.close();
    }
  }

  async function publishArtifact(idempotencyKey: string): Promise<PublishResponse> {
    return (await publishNew(server, installation, {
      accessSetting: "account_required",
      content: "<p>quarterly revenue</p>",
      idempotencyKey,
      name: "Quarterly revenue",
    })).body;
  }

  async function readActions(
    published: PublishResponse,
  ): Promise<readonly z.infer<typeof actionRecordSchema>[]> {
    const response = await commentFetch(
      humanToken,
      "GET",
      `/api/v1/artifacts/${published.artifact.id}/actions?projectId=${published.artifact.projectId}&limit=100`,
    );
    expect(response.status).toBe(200);
    return actionPageSchema.parse(await response.json()).actions;
  }

  async function commentFetch(
    token: string,
    method: string,
    routePath: string,
    options: {readonly body?: string; readonly key?: string} = {},
  ): Promise<Response> {
    const headers = new Headers({
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    });
    if (options.key !== undefined) headers.set("Idempotency-Key", options.key);
    const init: RequestInit = options.body === undefined
      ? {headers, method}
      : {body: options.body, headers, method};
    return fetch(`${server.baseUrl}${routePath}`, init);
  }
});

function versionComments(published: PublishResponse): string {
  return scoped(
    published,
    `/versions/${published.version.id}/comments`,
  );
}

function artifactComments(published: PublishResponse): string {
  return scoped(published, "/comments");
}

function threadPath(published: PublishResponse, threadId: string): string {
  return scoped(published, `/comments/${threadId}`);
}

function repliesPath(published: PublishResponse, threadId: string): string {
  return scoped(published, `/comments/${threadId}/replies`);
}

function replyPath(
  published: PublishResponse,
  threadId: string,
  replyId: string,
): string {
  return scoped(published, `/comments/${threadId}/replies/${replyId}`);
}

function scoped(published: PublishResponse, suffix: string): string {
  return `/api/v1/artifacts/${published.artifact.id}${suffix}?projectId=${published.artifact.projectId}`;
}

function expectStatus(response: Response, status: number): Response {
  expect(response.status).toBe(status);
  return response;
}

const commentPrincipalVerifier: BearerCredentialVerifier = {
  verify: (credential) => {
    const token = Redacted.value(credential);
    if (token === humanToken) {
      return Effect.succeed({
        authorizedByPrincipalId: null,
        capabilities: [],
        displayName: "Dana Reviewer",
        id: humanPrincipalId,
        installationId: "local",
        kind: principalKinds.human,
        membershipRole: membershipRoles.administrator,
      });
    }
    if (token === agentToken) {
      return Effect.succeed({
        authorizedByPrincipalId: humanPrincipalId,
        capabilities: [
          principalCapabilities.readArtifacts,
          principalCapabilities.writeComments,
        ],
        displayName: "Publishing agent",
        id: agentPrincipalId,
        installationId: "local",
        kind: principalKinds.service,
        membershipRole: membershipRoles.member,
      });
    }
    return Effect.fail(new AuthenticationRequired({
      message: "The comment credential is invalid.",
    }));
  },
};
