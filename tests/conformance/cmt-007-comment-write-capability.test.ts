import {Effect, Redacted} from "effect";
import {afterEach, beforeEach, describe, expect, test} from "vitest";
import {z} from "zod";

import type {BearerCredentialVerifier} from
  "../../src/application/authentication.js";
import {AuthenticationRequired} from "../../src/core/errors.js";
import type {Principal} from "../../src/core/identity.js";
import {
  createTestInstallation,
  issueLocalBrowserLogin,
  removeTestInstallation,
  type RunningTestServer,
  startTestServer,
  type TestInstallation,
} from "../support/runtime-harness.js";
import {publishNew, type PublishResponse} from "../support/publishing.js";

const memberCredential = "comment-write-admitted-member";

const createdThreadSchema = z.object({
  replayed: z.boolean(),
  thread: z.object({
    author: z.object({
      displayName: z.string(),
      principalId: z.string(),
      principalKind: z.string(),
    }),
    id: z.string(),
    state: z.string(),
  }),
});
const createdReplySchema = z.object({
  replayed: z.boolean(),
  reply: z.object({
    author: z.object({principalId: z.string()}),
    id: z.string(),
  }),
});
const threadSchema = z.object({
  thread: z.object({
    id: z.string(),
    resolvedBy: z.object({principalId: z.string()}).nullable(),
    state: z.string(),
  }),
});
const threadPageSchema = z.object({
  items: z.array(z.object({body: z.string(), id: z.string()})),
  nextCursor: z.string().nullable(),
});
const failureSchema = z.object({
  error: z.object({code: z.string(), message: z.string()}),
});
const issuedKeySchema = z.object({
  apiKey: z.object({id: z.string()}),
  token: z.string().startsWith("as_key_"),
});

/** One principal expected to hold comment-write authority. */
interface CommentWriter {
  readonly credential: string;
  readonly displayName: string;
  readonly kind: string;
  readonly label: string;
}

describe("comment write capability", () => {
  let installation: TestInstallation;
  let server: RunningTestServer;
  let published: PublishResponse;
  let administratorCookies: ApplicationCookies;

  beforeEach(async () => {
    installation = await createTestInstallation();
    server = await startTestServer(installation, {
      externalApiBearerVerifier: commentWriterVerifier,
    });
    published = (await publishNew(server, installation, {
      accessSetting: "account_required",
      content: "<!doctype html><title>Capability</title>",
      idempotencyKey: "comment-write-capability-publish",
      name: "Capability report",
    })).body;
    const localBrowserToken = await issueLocalBrowserLogin(server, installation);
    const login = await fetch(
      `${server.baseUrl}/auth/local?token=${localBrowserToken}`,
      {redirect: "manual"},
    );
    if (login.status !== 303) {
      throw new Error(`The administrator login failed with ${login.status}.`);
    }
    administratorCookies = applicationCookies(login.headers.getSetCookie());
  });

  afterEach(async () => {
    await server.stop();
    await removeTestInstallation(installation);
  });

  test("CMT-007-B: a direct human member and a comment-write key open, answer, resolve, and reopen threads", async () => {
    expect.hasAssertions();
    const writerToken = await issueKey(
      ["artifact:read", "comment:write"],
      "Comment writing automation",
    );

    await exerciseCommentWriter({
      credential: memberCredential,
      displayName: "Priya Member",
      kind: "human",
      label: "member",
    });
    await exerciseCommentWriter({
      credential: writerToken,
      displayName: "Comment writing automation",
      kind: "service",
      label: "key",
    });
  });

  test("CMT-007-F: a key holding only artifact read authority is denied every comment mutation", async () => {
    expect.hasAssertions();
    const readOnlyToken = await issueKey(
      ["artifact:read"],
      "Read-only automation",
    );
    const seeded = await credentialFetch(
      memberCredential,
      `/api/v1/artifacts/${published.artifact.id}` +
        `/versions/${published.version.id}/comments`,
      {
        body: JSON.stringify({body: "Only the member may write this."}),
        headers: {"Idempotency-Key": "comment-write-denied-seed-thread"},
        method: "POST",
      },
    );
    const thread = createdThreadSchema.parse(await seeded.json()).thread;
    const seededReply = await credentialFetch(
      memberCredential,
      `/api/v1/artifacts/${published.artifact.id}/comments/${thread.id}/replies`,
      {
        body: JSON.stringify({body: "A reply the read-only key cannot touch."}),
        headers: {"Idempotency-Key": "comment-write-denied-seed-reply0"},
        method: "POST",
      },
    );
    const reply = createdReplySchema.parse(await seededReply.json()).reply;

    const threadPath = `/api/v1/artifacts/${published.artifact.id}/comments/${thread.id}`;
    const denials = [
      await credentialFetch(
        readOnlyToken,
        `/api/v1/artifacts/${published.artifact.id}` +
          `/versions/${published.version.id}/comments`,
        {
          body: JSON.stringify({body: "The read-only key must not open this."}),
          headers: {"Idempotency-Key": "comment-write-denied-create-01"},
          method: "POST",
        },
      ),
      await credentialFetch(readOnlyToken, `${threadPath}/replies`, {
        body: JSON.stringify({body: "The read-only key must not answer."}),
        headers: {"Idempotency-Key": "comment-write-denied-reply-01"},
        method: "POST",
      }),
      await credentialFetch(readOnlyToken, threadPath, {
        body: JSON.stringify({state: "resolved"}),
        method: "PATCH",
      }),
      await credentialFetch(readOnlyToken, threadPath, {
        body: JSON.stringify({body: "Rewritten by a read-only key."}),
        method: "PATCH",
      }),
      await credentialFetch(readOnlyToken, `${threadPath}/replies/${reply.id}`, {
        body: JSON.stringify({body: "Rewritten reply."}),
        method: "PATCH",
      }),
      await credentialFetch(
        readOnlyToken,
        `${threadPath}/replies/${reply.id}`,
        {method: "DELETE"},
      ),
      await credentialFetch(readOnlyToken, threadPath, {method: "DELETE"}),
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

    const readable = await credentialFetch(
      readOnlyToken,
      `/api/v1/artifacts/${published.artifact.id}/comments`,
      {method: "GET"},
    );
    expect(readable.status).toBe(200);
    const listed = threadPageSchema.parse(await readable.json());
    expect(listed.items).toEqual([expect.objectContaining({
      body: "Only the member may write this.",
      id: thread.id,
    })]);
    const unchanged = await credentialFetch(readOnlyToken, threadPath);
    expect(unchanged.status).toBe(200);
    expect(threadSchema.parse(await unchanged.json()).thread.state).toBe("open");
  });

  async function exerciseCommentWriter(
    writer: CommentWriter,
  ): Promise<void> {
    const created = await credentialFetch(
      writer.credential,
      `/api/v1/artifacts/${published.artifact.id}` +
        `/versions/${published.version.id}/comments`,
      {
        body: JSON.stringify({body: `Opened by the ${writer.label}.`}),
        headers: {"Idempotency-Key": `comment-write-open-${writer.label}-01`},
        method: "POST",
      },
    );
    expect(created.status).toBe(201);
    const thread = createdThreadSchema.parse(await created.json()).thread;
    expect(thread.author).toMatchObject({
      displayName: writer.displayName,
      principalKind: writer.kind,
    });

    const reply = await credentialFetch(
      writer.credential,
      `/api/v1/artifacts/${published.artifact.id}/comments/${thread.id}/replies`,
      {
        body: JSON.stringify({body: `Answered by the ${writer.label}.`}),
        headers: {"Idempotency-Key": `comment-write-reply-${writer.label}-01`},
        method: "POST",
      },
    );
    expect(reply.status).toBe(201);
    expect(createdReplySchema.parse(await reply.json()).replayed).toBe(false);

    const resolved = await credentialFetch(
      writer.credential,
      `/api/v1/artifacts/${published.artifact.id}/comments/${thread.id}`,
      {body: JSON.stringify({state: "resolved"}), method: "PATCH"},
    );
    expect(resolved.status).toBe(200);
    const resolvedThread = threadSchema.parse(await resolved.json()).thread;
    expect(resolvedThread.state).toBe("resolved");
    expect(resolvedThread.resolvedBy).not.toBeNull();

    const reopened = await credentialFetch(
      writer.credential,
      `/api/v1/artifacts/${published.artifact.id}/comments/${thread.id}`,
      {body: JSON.stringify({state: "open"}), method: "PATCH"},
    );
    expect(reopened.status).toBe(200);
    expect(threadSchema.parse(await reopened.json()).thread).toMatchObject({
      resolvedBy: null,
      state: "open",
    });
  }

  async function issueKey(
    capabilities: readonly string[],
    name: string,
  ): Promise<string> {
    const response = await fetch(`${server.baseUrl}/api/v1/api-keys`, {
      body: JSON.stringify({
        capabilities,
        expiresAt: "2099-01-01T00:00:00.000Z",
        name,
      }),
      headers: browserMutationHeaders(server.baseUrl, administratorCookies),
      method: "POST",
    });
    expect(response.status).toBe(201);
    return issuedKeySchema.parse(await response.json()).token;
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

interface ApplicationCookies {
  readonly csrf: string;
  readonly header: string;
}

function applicationCookies(
  setCookieHeaders: readonly string[],
): ApplicationCookies {
  const session = setCookieHeaders.find((value) =>
    value.startsWith("artifact_session=")
  );
  const csrf = setCookieHeaders.find((value) =>
    value.startsWith("artifact_csrf=")
  );
  if (session === undefined || csrf === undefined) {
    throw new Error("The login response did not issue both application cookies.");
  }
  const sessionPair = session.split(";", 1)[0];
  const csrfPair = csrf.split(";", 1)[0];
  if (sessionPair === undefined || csrfPair === undefined) {
    throw new Error("The login response issued a malformed application cookie.");
  }
  return {
    csrf: csrfPair.slice(csrfPair.indexOf("=") + 1),
    header: `${sessionPair}; ${csrfPair}`,
  };
}

function browserMutationHeaders(
  origin: string,
  cookies: ApplicationCookies,
): Headers {
  return new Headers({
    "Content-Type": "application/json",
    Cookie: cookies.header,
    Origin: origin,
    "Sec-Fetch-Mode": "cors",
    "Sec-Fetch-Site": "same-origin",
    "X-CSRF-Token": cookies.csrf,
  });
}

const commentWriterPrincipal: Principal = {
  authorizedByPrincipalId: null,
  capabilities: [],
  displayName: "Priya Member",
  id: "member_comment_writer",
  installationId: "local",
  kind: "human",
  membershipRole: "member",
};

const commentWriterVerifier: BearerCredentialVerifier = {
  verify: (credential) =>
    Redacted.value(credential) === memberCredential
      ? Effect.succeed(commentWriterPrincipal)
      : Effect.fail(new AuthenticationRequired({
        message: "The external comment credential is invalid.",
      })),
};
