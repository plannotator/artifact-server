import {createHash} from "node:crypto";
import {mkdtemp, readdir, rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {DatabaseSync} from "node:sqlite";

import {z} from "zod";
import {unstable_dev, type Unstable_DevWorker} from "wrangler";
import {afterAll, beforeAll, describe, expect, it} from "vitest";

const apiToken = "cloudflare-comment-test-api-token-00000001";
const origin = "https://artifacts.example.test";
const contentDomain = "content.example.test";

const uploadPlanSchema = z.object({
  commitUrl: z.url(),
  files: z.array(z.object({
    path: z.string(),
    uploadUrl: z.url(),
  })).length(1),
});
const publicationSchema = z.object({
  artifact: z.object({id: z.string()}),
  version: z.object({id: z.string(), number: z.number().int().positive()}),
});
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
  path: z.string().nullable(),
  replyCount: z.number().int().nonnegative(),
  resolvedAt: z.iso.datetime().nullable(),
  resolvedBy: commentAuthorSchema.nullable(),
  state: z.enum(["open", "resolved"]),
  updatedAt: z.iso.datetime(),
  versionId: z.string(),
}).loose();
const commentReplySchema = z.object({
  author: commentAuthorSchema,
  body: z.string(),
  createdAt: z.iso.datetime(),
  id: z.string(),
  threadId: z.string(),
}).loose();
const threadCreationSchema = z.object({
  replayed: z.boolean(),
  thread: commentThreadSchema,
}).strict();
const threadEnvelopeSchema = z.object({thread: commentThreadSchema}).strict();
const replyCreationSchema = z.object({
  replayed: z.boolean(),
  reply: commentReplySchema,
}).strict();
const threadDetailsSchema = z.object({
  replies: z.array(commentReplySchema),
  thread: commentThreadSchema,
}).strict();
const threadPageSchema = z.object({
  items: z.array(commentThreadSchema),
  nextCursor: z.string().nullable(),
}).strict();
const actionListSchema = z.object({
  actions: z.array(z.object({
    action: z.string(),
    id: z.string(),
    idempotencyKey: z.string(),
  }).loose()),
}).loose();
const failureSchema = z.object({
  error: z.object({code: z.string(), message: z.string()}).loose(),
}).loose();
const schemaVersionRowSchema = z.object({version: z.number().int().positive()});
const tableColumnRowSchema = z.object({name: z.string()});
const loginAttemptRowSchema = z.object({
  codeVerifier: z.string(),
  nonce: z.string().nullable(),
});

let persistPath: string;
let worker: Unstable_DevWorker;

beforeAll(async () => {
  persistPath = await mkdtemp(join(tmpdir(), "artifact-server-cloudflare-comments-"));
  worker = await startWorker(persistPath);
}, 60_000);

afterAll(async () => {
  await worker.stop();
  await rm(persistPath, {force: true, recursive: true});
});

describe("Cloudflare D1 comments", () => {
  it("records the whole comment lifecycle and keeps it across a restart", async () => {
    const published = await publishArtifact(worker, "comment-lifecycle-publish");
    const artifactId = published.artifact.id;
    const threadsUrl = `${origin}/api/v1/artifacts/${artifactId}/comments`;
    const createUrl =
      `${origin}/api/v1/artifacts/${artifactId}/versions/${published.version.id}/comments`;

    const unknownPath = await worker.fetch(createUrl, {
      body: JSON.stringify({body: "Not a real file.", path: "missing.html"}),
      headers: mutationHeaders("comment-unknown-path-000001"),
      method: "POST",
    });
    expect(unknownPath.status).toBe(422);
    expect(failureSchema.parse(await unknownPath.json()).error.code)
      .toBe("INVALID_COMMENT");

    const anchor = {kind: "page", point: {x: 0.25, y: 0.5}};
    const createdResponse = await worker.fetch(createUrl, {
      body: JSON.stringify({
        anchor,
        body: "The axis label is wrong.",
        path: "index.html",
      }),
      headers: mutationHeaders("comment-create-thread-00001"),
      method: "POST",
    });
    expect(createdResponse.status).toBe(201);
    const created = threadCreationSchema.parse(await createdResponse.json());
    expect(created.replayed).toBe(false);
    expect(created.thread.versionId).toBe(published.version.id);
    expect(created.thread.anchor).toEqual(anchor);
    expect(created.thread.author.displayName).toBe("Local");
    expect(created.thread.replyCount).toBe(0);
    const threadId = created.thread.id;

    const replayResponse = await worker.fetch(createUrl, {
      body: JSON.stringify({
        anchor,
        body: "The axis label is wrong.",
        path: "index.html",
      }),
      headers: mutationHeaders("comment-create-thread-00001"),
      method: "POST",
    });
    expect(replayResponse.status).toBe(201);
    expect(threadCreationSchema.parse(await replayResponse.json()))
      .toMatchObject({replayed: true, thread: {id: threadId}});

    const conflict = await worker.fetch(createUrl, {
      body: JSON.stringify({body: "Different words entirely."}),
      headers: mutationHeaders("comment-create-thread-00001"),
      method: "POST",
    });
    expect(conflict.status).toBe(409);
    expect(failureSchema.parse(await conflict.json()).error.code)
      .toBe("IDEMPOTENCY_CONFLICT");

    const replyResponse = await worker.fetch(`${threadsUrl}/${threadId}/replies`, {
      body: JSON.stringify({body: "Corrected in the next version."}),
      headers: mutationHeaders("comment-create-reply-000001"),
      method: "POST",
    });
    expect(replyResponse.status).toBe(201);
    const reply = replyCreationSchema.parse(await replyResponse.json());
    expect(reply.replayed).toBe(false);
    const replayedReply = await worker.fetch(`${threadsUrl}/${threadId}/replies`, {
      body: JSON.stringify({body: "Corrected in the next version."}),
      headers: mutationHeaders("comment-create-reply-000001"),
      method: "POST",
    });
    expect(replyCreationSchema.parse(await replayedReply.json())).toMatchObject({
      replayed: true,
      reply: {id: reply.reply.id},
    });

    const detail = await readThread(worker, threadsUrl, threadId);
    expect(detail.replies.map((stored) => stored.id)).toEqual([reply.reply.id]);
    expect(detail.thread.replyCount).toBe(1);

    const resolved = await patchThread(
      worker,
      `${threadsUrl}/${threadId}`,
      {state: "resolved"},
    );
    expect(resolved.status).toBe(200);
    expect(threadEnvelopeSchema.parse(await resolved.json()).thread)
      .toMatchObject({
        body: "The axis label is wrong.",
        resolvedBy: {displayName: "Local", principalKind: "service"},
        state: "resolved",
      });

    const refused = await worker.fetch(`${threadsUrl}/${threadId}/replies`, {
      body: JSON.stringify({body: "Too late to answer."}),
      headers: mutationHeaders("comment-refused-reply-00001"),
      method: "POST",
    });
    expect(refused.status).toBe(409);
    expect(failureSchema.parse(await refused.json()).error.code)
      .toBe("COMMENT_RESOLVED");
    expect((await readThread(worker, threadsUrl, threadId)).replies)
      .toHaveLength(1);

    const reopened = await patchThread(
      worker,
      `${threadsUrl}/${threadId}`,
      {state: "open"},
    );
    expect(reopened.status).toBe(200);
    expect(threadEnvelopeSchema.parse(await reopened.json()).thread)
      .toMatchObject({resolvedAt: null, resolvedBy: null, state: "open"});

    // Back-to-back state changes can share a millisecond. Each one must append
    // its own ledger row, so the derived action key cannot be the timestamp.
    const burst = await patchThread(
      worker,
      `${threadsUrl}/${threadId}`,
      {state: "resolved"},
    );
    expect(burst.status).toBe(200);
    const burstReopen = await patchThread(
      worker,
      `${threadsUrl}/${threadId}`,
      {state: "open"},
    );
    expect(burstReopen.status).toBe(200);

    const edited = await patchThread(
      worker,
      `${threadsUrl}/${threadId}`,
      {body: "The axis label reads 2024."},
    );
    expect(threadEnvelopeSchema.parse(await edited.json()).thread).toMatchObject({
      anchor,
      body: "The axis label reads 2024.",
      state: "open",
    });

    const replyEdit = await patchThread(
      worker,
      `${threadsUrl}/${threadId}/replies/${reply.reply.id}`,
      {body: "Corrected in version two."},
    );
    expect(replyEdit.status).toBe(200);
    expect(z.object({reply: commentReplySchema}).strict()
      .parse(await replyEdit.json()).reply.body)
      .toBe("Corrected in version two.");

    const secondResponse = await worker.fetch(createUrl, {
      body: JSON.stringify({body: "The footnote has no source."}),
      headers: mutationHeaders("comment-create-thread-00002"),
      method: "POST",
    });
    expect(secondResponse.status).toBe(201);
    const secondId = threadCreationSchema.parse(await secondResponse.json())
      .thread.id;
    expect((await patchThread(
      worker,
      `${threadsUrl}/${secondId}`,
      {state: "resolved"},
    )).status).toBe(200);

    const listed = threadPageSchema.parse(
      await (await authenticatedFetch(worker, threadsUrl)).json(),
    );
    expect(listed.items.map(({id}) => id).toSorted())
      .toEqual([secondId, threadId].toSorted());
    const artifactCatalog = z.object({
      artifacts: z.array(z.object({
        artifact: z.object({id: z.string()}),
        commentCount: z.number().int().nonnegative(),
      })),
    }).parse(await (await authenticatedFetch(
      worker,
      `${origin}/api/v1/artifacts`,
    )).json());
    expect(artifactCatalog.artifacts.find(({artifact}) => artifact.id === artifactId))
      .toMatchObject({commentCount: 2});
    const commentedCatalog = z.object({
      artifacts: z.array(z.object({
        artifact: z.object({id: z.string()}),
        commentCount: z.number().int().positive(),
      })),
    }).parse(await (await authenticatedFetch(
      worker,
      `${origin}/api/v1/artifacts?comments=with&sort=comments&limit=1`,
    )).json());
    expect(commentedCatalog.artifacts).toEqual([
      expect.objectContaining({
        artifact: expect.objectContaining({id: artifactId}),
        commentCount: 2,
      }),
    ]);
    const uncommentedCatalog = z.object({artifacts: z.array(z.unknown())})
      .parse(await (await authenticatedFetch(
        worker,
        `${origin}/api/v1/artifacts?comments=without`,
      )).json());
    expect(uncommentedCatalog.artifacts).toEqual([]);

    const openOnly = threadPageSchema.parse(
      await (await authenticatedFetch(worker, `${threadsUrl}?state=open`)).json(),
    );
    expect(openOnly.items.map(({id}) => id)).toEqual([threadId]);

    const firstPage = threadPageSchema.parse(
      await (await authenticatedFetch(worker, `${threadsUrl}?limit=1`)).json(),
    );
    expect(firstPage.items).toHaveLength(1);
    expect(firstPage.nextCursor).not.toBeNull();
    const secondPage = threadPageSchema.parse(await (await authenticatedFetch(
      worker,
      `${threadsUrl}?limit=1&cursor=${encodeURIComponent(firstPage.nextCursor ?? "")}`,
    )).json());
    expect(secondPage.items).toHaveLength(1);
    expect(secondPage.nextCursor).toBeNull();
    expect([...firstPage.items, ...secondPage.items].map(({id}) => id).toSorted())
      .toEqual([secondId, threadId].toSorted());

    const future = threadPageSchema.parse(await (await authenticatedFetch(
      worker,
      `${threadsUrl}?since=${encodeURIComponent("2999-01-01T00:00:00.000Z")}`,
    )).json());
    expect(future.items).toHaveLength(0);

    const ledger = actionListSchema.parse(await (await authenticatedFetch(
      worker,
      `${origin}/api/v1/artifacts/${artifactId}/actions?limit=100`,
    )).json());
    const commentActions = ledger.actions
      .filter(({action}) => action.startsWith("comment_"));
    expect(commentActions.filter(({action}) => action === "comment_resolve"))
      .toHaveLength(3);
    expect(commentActions.filter(({action}) => action === "comment_reopen"))
      .toHaveLength(2);
    expect(new Set(commentActions.map(({idempotencyKey}) => idempotencyKey)).size)
      .toBe(commentActions.length);
    const derived = commentActions.filter(({action}) =>
      action !== "comment_create" && action !== "comment_reply"
    );
    expect(derived.length).toBeGreaterThan(0);
    expect(derived.every((record) =>
      record.idempotencyKey.endsWith(`:${record.id}`)
    )).toBe(true);

    const replyDeleted = await worker.fetch(
      `${threadsUrl}/${threadId}/replies/${reply.reply.id}`,
      {headers: bearerHeaders(), method: "DELETE"},
    );
    expect(replyDeleted.status).toBe(204);
    expect((await readThread(worker, threadsUrl, threadId)).thread.replyCount)
      .toBe(0);
    const replyDeletedAgain = await worker.fetch(
      `${threadsUrl}/${threadId}/replies/${reply.reply.id}`,
      {headers: bearerHeaders(), method: "DELETE"},
    );
    expect(replyDeletedAgain.status).toBe(404);

    const threadDeleted = await worker.fetch(`${threadsUrl}/${threadId}`, {
      headers: bearerHeaders(),
      method: "DELETE",
    });
    expect(threadDeleted.status).toBe(204);
    const gone = await authenticatedFetch(worker, `${threadsUrl}/${threadId}`);
    expect(gone.status).toBe(404);
    expect(failureSchema.parse(await gone.json()).error.code)
      .toBe("COMMENT_NOT_FOUND");

    await worker.stop();
    worker = await startWorker(persistPath);
    const afterRestart = threadPageSchema.parse(
      await (await authenticatedFetch(worker, threadsUrl)).json(),
    );
    expect(afterRestart.items.map(({id}) => id)).toEqual([secondId]);
    expect(afterRestart.items[0]?.state).toBe("resolved");
  }, 120_000);

  it("upgrades a version 2 database in place and then accepts comments", async () => {
    const upgradeDirectory = await mkdtemp(
      join(tmpdir(), "artifact-server-cloudflare-upgrade-"),
    );
    let upgradeWorker = await startWorker(upgradeDirectory);
    try {
      const published = await publishArtifact(
        upgradeWorker,
        "comment-upgrade-publish-01",
      );
      await upgradeWorker.stop();

      const d1File = await findD1DatabaseFile(upgradeDirectory);
      const database = new DatabaseSync(d1File);
      try {
        database.exec(`
          DROP TABLE comment_replies;
          DROP TABLE comment_threads;
          CREATE TABLE actions_v2 (
            id TEXT PRIMARY KEY,
            project_id TEXT NOT NULL REFERENCES projects(id),
            artifact_id TEXT NOT NULL REFERENCES artifacts(id),
            version_id TEXT NOT NULL REFERENCES versions(id),
            action TEXT NOT NULL CHECK (action IN ('publish', 'restore', 'change_access', 'change_tags', 'delete')),
            principal_id TEXT NOT NULL,
            authorized_by_principal_id TEXT,
            idempotency_key TEXT NOT NULL,
            created_at TEXT NOT NULL
          );
          INSERT INTO actions_v2 SELECT id, project_id, artifact_id, version_id,
            action, principal_id, authorized_by_principal_id, idempotency_key,
            created_at FROM actions;
          DROP TABLE actions;
          ALTER TABLE actions_v2 RENAME TO actions;
          UPDATE artifact_server_schema SET version = 2 WHERE component = 'runtime';
        `);
        expect(schemaVersionRowSchema.parse(database.prepare(
          "SELECT version FROM artifact_server_schema WHERE component = 'runtime'",
        ).get()).version).toBe(2);
      } finally {
        database.close();
      }

      upgradeWorker = await startWorker(upgradeDirectory);
      const ready = await upgradeWorker.fetch(`${origin}/ready`);
      expect(ready.status).toBe(200);

      const preserved = actionListSchema.parse(await (await authenticatedFetch(
        upgradeWorker,
        `${origin}/api/v1/artifacts/${published.artifact.id}/actions`,
      )).json());
      expect(preserved.actions.map(({action}) => action)).toEqual(["publish"]);

      const created = await upgradeWorker.fetch(
        `${origin}/api/v1/artifacts/${published.artifact.id}/versions/${published.version.id}/comments`,
        {
          body: JSON.stringify({body: "Written after the schema upgrade."}),
          headers: mutationHeaders("comment-after-upgrade-0001"),
          method: "POST",
        },
      );
      expect(created.status).toBe(201);
      expect(threadCreationSchema.parse(await created.json()).thread.versionId)
        .toBe(published.version.id);

      const afterUpgrade = actionListSchema.parse(await (await authenticatedFetch(
        upgradeWorker,
        `${origin}/api/v1/artifacts/${published.artifact.id}/actions`,
      )).json());
      expect(afterUpgrade.actions.map(({action}) => action).toSorted())
        .toEqual(["comment_create", "publish"]);
    } finally {
      await upgradeWorker.stop();
      await rm(upgradeDirectory, {force: true, recursive: true});
    }
  }, 120_000);

  it("upgrades a version 3 database in place and keeps login attempts", async () => {
    const upgradeDirectory = await mkdtemp(
      join(tmpdir(), "artifact-server-cloudflare-nonce-"),
    );
    let upgradeWorker = await startWorker(upgradeDirectory);
    try {
      expect((await upgradeWorker.fetch(`${origin}/ready`)).status).toBe(200);
      await upgradeWorker.stop();

      const d1File = await findD1DatabaseFile(upgradeDirectory);
      const database = new DatabaseSync(d1File);
      try {
        database.exec(`
          DROP TABLE login_attempts;
          CREATE TABLE login_attempts (
            state_digest TEXT PRIMARY KEY,
            provider TEXT NOT NULL,
            code_verifier TEXT NOT NULL,
            return_to TEXT NOT NULL,
            created_at TEXT NOT NULL,
            expires_at TEXT NOT NULL,
            consumed_at TEXT
          );
          INSERT INTO login_attempts (
            state_digest, provider, code_verifier, return_to, created_at,
            expires_at, consumed_at
          ) VALUES (
            'version-three-state-digest', 'workos', 'version-three-verifier',
            '/', '2026-01-01T00:00:00.000Z', '2026-01-01T00:10:00.000Z', NULL
          );
          UPDATE artifact_server_schema SET version = 3 WHERE component = 'runtime';
        `);
      } finally {
        database.close();
      }

      upgradeWorker = await startWorker(upgradeDirectory);
      expect((await upgradeWorker.fetch(`${origin}/ready`)).status).toBe(200);
      await upgradeWorker.stop();

      const upgraded = new DatabaseSync(d1File);
      try {
        expect(schemaVersionRowSchema.parse(upgraded.prepare(
          "SELECT version FROM artifact_server_schema WHERE component = 'runtime'",
        ).get()).version).toBe(9);
        const columns = z.array(tableColumnRowSchema)
          .parse(upgraded.prepare("PRAGMA table_info(login_attempts)").all())
          .map(({name}) => name);
        expect(columns).toContain("nonce");
        const preserved = loginAttemptRowSchema.parse(upgraded.prepare(`
          SELECT code_verifier AS codeVerifier, nonce FROM login_attempts
          WHERE state_digest = 'version-three-state-digest'
        `).get());
        expect(preserved.codeVerifier).toBe("version-three-verifier");
        expect(preserved.nonce).toBeNull();
      } finally {
        upgraded.close();
      }
    } finally {
      await upgradeWorker.stop();
      await rm(upgradeDirectory, {force: true, recursive: true});
    }
  }, 120_000);
});

function bearerHeaders() {
  return {Authorization: `Bearer ${apiToken}`};
}

function jsonHeaders() {
  return {
    Authorization: `Bearer ${apiToken}`,
    "Content-Type": "application/json",
  };
}

function mutationHeaders(idempotencyKey: string) {
  return {...jsonHeaders(), "Idempotency-Key": idempotencyKey};
}

function authenticatedFetch(target: Unstable_DevWorker, url: string) {
  return target.fetch(url, {headers: bearerHeaders()});
}

function patchThread(
  target: Unstable_DevWorker,
  url: string,
  changes: {readonly body?: string; readonly state?: "open" | "resolved"},
) {
  return target.fetch(url, {
    body: JSON.stringify(changes),
    headers: jsonHeaders(),
    method: "PATCH",
  });
}

async function readThread(
  target: Unstable_DevWorker,
  threadsUrl: string,
  threadId: string,
) {
  const response = await authenticatedFetch(target, `${threadsUrl}/${threadId}`);
  expect(response.status).toBe(200);
  return threadDetailsSchema.parse(await response.json());
}

async function findD1DatabaseFile(directory: string): Promise<string> {
  const entries = await readdir(directory, {
    recursive: true,
    withFileTypes: true,
  });
  const found = entries
    .filter((entry) =>
      entry.isFile() && entry.name.endsWith(".sqlite") &&
      entry.parentPath.includes("D1")
    )
    .map((entry) => join(entry.parentPath, entry.name))
    .find((candidate) => {
      const database = new DatabaseSync(candidate, {readOnly: true});
      try {
        return database.prepare(`
          SELECT name FROM sqlite_master
          WHERE type = 'table' AND name = 'artifact_server_schema'
        `).get() !== undefined;
      } finally {
        database.close();
      }
    });
  if (found === undefined) {
    throw new Error("The Worker did not persist a local D1 database file.");
  }
  return found;
}

async function publishArtifact(
  target: Unstable_DevWorker,
  idempotencyKey: string,
) {
  const bytes = new TextEncoder().encode("<h1>Comment target</h1>");
  const createUpload = await target.fetch(`${origin}/api/v1/uploads`, {
    body: JSON.stringify({
      entryPath: "index.html",
      files: [{
        mediaType: "text/html; charset=utf-8",
        path: "index.html",
        sha256: createHash("sha256").update(bytes).digest("hex"),
        size: bytes.byteLength,
      }],
    }),
    headers: jsonHeaders(),
    method: "POST",
  });
  expect(createUpload.status).toBe(201);
  const uploadPlan = uploadPlanSchema.parse(await createUpload.json());
  const plannedFile = uploadPlan.files[0];
  if (plannedFile === undefined) throw new Error("The upload plan is empty.");
  const uploaded = await target.fetch(plannedFile.uploadUrl, {
    body: bytes,
    headers: bearerHeaders(),
    method: "PUT",
  });
  expect(uploaded.status).toBe(200);
  const committed = await target.fetch(uploadPlan.commitUrl, {
    body: JSON.stringify({target: {
      accessSetting: "account_required",
      kind: "new_artifact",
      name: "Comment target",
      tags: [],
    }}),
    headers: mutationHeaders(idempotencyKey),
    method: "POST",
  });
  const committedText = await committed.text();
  if (committed.status !== 201) {
    throw new Error(
      `Publishing the comment target failed with ${committed.status}: ${committedText}`,
    );
  }
  return publicationSchema.parse(JSON.parse(committedText));
}

function startWorker(persistenceDirectory: string): Promise<Unstable_DevWorker> {
  return unstable_dev("src/worker.ts", {
    bundle: true,
    config: "wrangler.test.jsonc",
    compatibilityDate: "2026-08-15",
    compatibilityFlags: ["nodejs_compat"],
    experimental: {
      d1Databases: [{
        binding: "ARTIFACT_SERVER_D1_DATABASE",
        database_id: "artifact-server-test-d1",
        database_name: "artifact-server-test-d1",
      }],
      disableExperimentalWarning: true,
      disableDevRegistry: true,
      testScheduled: true,
      watch: false,
    },
    inspect: false,
    local: true,
    logLevel: "error",
    persist: true,
    persistTo: persistenceDirectory,
    r2: [{
      binding: "ARTIFACT_SERVER_R2_BUCKET",
      bucket_name: "artifact-server-test-r2",
    }],
    vars: {
      ARTIFACT_SERVER_API_TOKEN: apiToken,
      ARTIFACT_SERVER_BOOTSTRAP_ADMIN_EMAIL: "administrator@example.test",
      ARTIFACT_SERVER_CONTENT_DOMAIN: contentDomain,
      ARTIFACT_SERVER_INSTALLATION_ID: "cloudflare-comment-test",
      ARTIFACT_SERVER_OIDC_CLIENT_ID: "cloudflare-comment-test",
      ARTIFACT_SERVER_OIDC_ISSUER: "https://identity.example.test",
      ARTIFACT_SERVER_ORIGIN: origin,
      ARTIFACT_SERVER_QUALIFICATION_MODE: "enabled",
      ARTIFACT_SERVER_REQUEST_LOG_SAMPLE_RATE: "0",
    },
  });
}
