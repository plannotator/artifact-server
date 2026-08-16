import {access} from "node:fs/promises";
import {DatabaseSync} from "node:sqlite";
import path from "node:path";

import {z} from "zod";
import {afterEach, beforeEach, describe, expect, test} from "vitest";

import {
  apiHeaders,
  createTestInstallation,
  fetchVersion,
  removeTestInstallation,
  type RunningTestServer,
  startTestServer,
  type TestInstallation,
} from "../support/runtime-harness.js";
import {
  publishNew,
  publishVersion,
} from "../support/publishing.js";

const artifactRecordSchema = z.object({
  accessSetting: z.enum(["account_required", "public_link"]),
  createdAt: z.string(),
  currentVersionId: z.string(),
  deletedAt: z.string().nullable(),
  id: z.string(),
  name: z.string(),
});
const artifactPageSchema = z.object({
  artifacts: z.array(z.object({
    artifact: artifactRecordSchema,
    links: z.object({artifact: z.url(), management: z.url()}),
  })),
  nextCursor: z.string().nullable(),
});
const actionRecordSchema = z.object({
  action: z.enum([
    "change_access",
    "change_tags",
    "delete",
    "publish",
    "restore",
  ]),
  artifactId: z.string(),
  authorizedByPrincipalId: z.string().nullable(),
  createdAt: z.string(),
  id: z.string(),
  idempotencyKey: z.string(),
  principalId: z.string(),
  versionId: z.string(),
});
const actionPageSchema = z.object({
  actions: z.array(actionRecordSchema),
  nextCursor: z.string().nullable(),
});
const deletionSchema = z.object({
  artifact: artifactRecordSchema.extend({deletedAt: z.string()}),
  replayed: z.boolean(),
  retainedVersionCount: z.number().int().positive(),
});

describe("artifact lifecycle", () => {
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

  test("foundation: artifact and action lists use bounded stable cursors", async () => {
    const published = [];
    for (let index = 0; index < 3; index += 1) {
      // Sequential creation gives the keyset cursor a deterministic write order.
      // eslint-disable-next-line no-await-in-loop
      published.push(await publishNew(server, installation, {
        accessSetting: "account_required",
        content: `artifact ${index}`,
        idempotencyKey: `lifecycle-list-${index}`,
        name: `Listed artifact ${index}`,
      }));
    }

    const firstPage = artifactPageSchema.parse(await (await authenticatedFetch(
      `/api/v1/artifacts?limit=2`,
    )).json());
    expect(firstPage.artifacts).toHaveLength(2);
    expect(firstPage.nextCursor).not.toBeNull();
    const secondPage = artifactPageSchema.parse(await (await authenticatedFetch(
      `/api/v1/artifacts?limit=2&cursor=${encodeURIComponent(firstPage.nextCursor ?? "")}`,
    )).json());
    expect(secondPage.artifacts).toHaveLength(1);
    expect(secondPage.nextCursor).toBeNull();
    const listedIds = [...firstPage.artifacts, ...secondPage.artifacts]
      .map(({artifact}) => artifact.id);
    expect(new Set(listedIds).size).toBe(3);
    expect(new Set(listedIds)).toEqual(
      new Set(published.map(({body}) => body.artifact.id)),
    );

    const malformedCursor = await authenticatedFetch(
      "/api/v1/artifacts?cursor=not-a-valid-cursor",
    );
    expect(malformedCursor.status).toBe(422);
    await expect(malformedCursor.json()).resolves.toMatchObject({
      error: {code: "INVALID_INPUT"},
    });
    expect((await authenticatedFetch("/api/v1/artifacts?limit=101")).status)
      .toBe(422);

    const target = published[0];
    if (target === undefined) throw new Error("The list fixture was not created.");
    const updated = await publishVersion(server, installation, {
      artifactId: target.body.artifact.id,
      content: "updated",
      expectedCurrentVersionId: target.body.version.id,
      idempotencyKey: "lifecycle-action-list-version",
    });
    const changed = await fetch(
      `${server.baseUrl}/api/v1/artifacts/${target.body.artifact.id}/access`,
      {
        body: JSON.stringify({
          accessSetting: "public_link",
          expectedCurrentVersionId: updated.body.version.id,
        }),
        headers: apiHeaders(installation, "lifecycle-action-list-access"),
        method: "PATCH",
      },
    );
    expect(changed.status).toBe(200);

    const firstActions = actionPageSchema.parse(await (await authenticatedFetch(
      `/api/v1/artifacts/${target.body.artifact.id}/actions?limit=2`,
    )).json());
    expect(firstActions.actions).toHaveLength(2);
    expect(firstActions.nextCursor).not.toBeNull();
    const secondActions = actionPageSchema.parse(await (await authenticatedFetch(
      `/api/v1/artifacts/${target.body.artifact.id}/actions?limit=2&cursor=${encodeURIComponent(firstActions.nextCursor ?? "")}`,
    )).json());
    expect(secondActions.actions).toHaveLength(1);
    expect(secondActions.nextCursor).toBeNull();
    const actions = [...firstActions.actions, ...secondActions.actions];
    expect(new Set(actions.map(({id}) => id)).size).toBe(3);
    expect(actions.map(({action}) => action).toSorted()).toEqual([
      "change_access",
      "publish",
      "publish",
    ]);
    expect(actions.every(({principalId}) => principalId === "local-api-token"))
      .toBe(true);
  });

  test("ART-006-B ART-006-F ART-007-B ART-007-F: deletion tombstones the artifact, blocks every read path, and retains committed versions", async () => {
    const first = await publishNew(server, installation, {
      accessSetting: "public_link",
      content: "<!doctype html><title>Retained first version</title>",
      idempotencyKey: "lifecycle-delete-first",
      name: "Deleted artifact",
    });
    const second = await publishVersion(server, installation, {
      artifactId: first.body.artifact.id,
      content: "<!doctype html><title>Retained second version</title>",
      expectedCurrentVersionId: first.body.version.id,
      idempotencyKey: "lifecycle-delete-second",
    });
    const details = z.object({
      current: z.object({
        manifest: z.object({
          entries: z.array(z.object({sha256: z.string()})),
        }),
      }),
    }).parse(await (await authenticatedFetch(
      `/api/v1/artifacts/${first.body.artifact.id}`,
    )).json());
    const currentDigest = details.current.manifest.entries[0]?.sha256;
    if (currentDigest === undefined) throw new Error("The version has no blob.");

    const earlierBootstrap = await issueVersionBootstrap(
      first.body.artifact.id,
      first.body.version.id,
    );
    const earlierExchange = await fetchVersion(server, earlierBootstrap);
    const earlierCookie = earlierExchange.headers.get("set-cookie");
    expect(earlierCookie).not.toBeNull();
    expect((await fetchVersion(
      server,
      first.body.links.version,
      "GET",
      {Cookie: earlierCookie ?? ""},
    )).status).toBe(200);
    const unredeemedBootstrap = await issueVersionBootstrap(
      first.body.artifact.id,
      second.body.version.id,
    );

    const deletedResponse = await deleteArtifact(
      first.body.artifact.id,
      second.body.version.id,
      "lifecycle-delete",
    );
    expect(deletedResponse.status).toBe(200);
    const deleted = deletionSchema.parse(await deletedResponse.json());
    expect(deleted).toMatchObject({
      artifact: {
        currentVersionId: second.body.version.id,
        id: first.body.artifact.id,
      },
      replayed: false,
      retainedVersionCount: 2,
    });

    const replay = deletionSchema.parse(await (await deleteArtifact(
      first.body.artifact.id,
      second.body.version.id,
      "lifecycle-delete",
    )).json());
    expect(replay).toEqual({...deleted, replayed: true});
    const conflictingReplay = await deleteArtifact(
      first.body.artifact.id,
      first.body.version.id,
      "lifecycle-delete",
    );
    expect(conflictingReplay.status).toBe(409);
    await expect(conflictingReplay.json()).resolves.toMatchObject({
      error: {code: "IDEMPOTENCY_CONFLICT"},
    });

    const actions = actionPageSchema.parse(await (await authenticatedFetch(
      `/api/v1/artifacts/${first.body.artifact.id}/actions`,
    )).json());
    expect(actions.actions.map(({action}) => action).toSorted()).toEqual([
      "delete",
      "publish",
      "publish",
    ]);
    expect(actions.actions.find(({action}) => action === "delete"))
      .toMatchObject({
        artifactId: first.body.artifact.id,
        authorizedByPrincipalId: null,
        idempotencyKey: "lifecycle-delete",
        principalId: "local-api-token",
        versionId: second.body.version.id,
      });

    expect((await authenticatedFetch(
      `/api/v1/artifacts/${first.body.artifact.id}`,
    )).status).toBe(404);
    expect((await authenticatedFetch(
      `/api/v1/artifacts/${first.body.artifact.id}/versions`,
    )).status).toBe(404);
    expect((await authenticatedFetch(
      `/api/v1/artifacts/${first.body.artifact.id}/versions/${first.body.version.id}`,
    )).status).toBe(404);
    expect((await authenticatedFetch(
      `/api/v1/artifacts/${first.body.artifact.id}/comparisons?fromVersionId=${first.body.version.id}&toVersionId=${second.body.version.id}`,
    )).status).toBe(404);
    expect((await authenticatedFetch(
      `/api/v1/artifacts/${first.body.artifact.id}/versions/${first.body.version.id}`,
      {method: "DELETE"},
    )).status).toBe(404);
    expect((await fetch(first.body.links.artifact, {redirect: "manual"})).status)
      .toBe(404);
    expect((await fetchVersion(server, second.body.links.version)).status).toBe(404);
    expect((await fetchVersion(
      server,
      first.body.links.version,
      "GET",
      {Cookie: earlierCookie ?? ""},
    )).status).toBe(404);
    expect((await fetchVersion(server, unredeemedBootstrap)).status).toBe(401);
    const listed = artifactPageSchema.parse(await (await authenticatedFetch(
      "/api/v1/artifacts",
    )).json());
    expect(listed.artifacts).toHaveLength(0);

    await server.stop();
    const database = openDatabase();
    try {
      expect(z.object({count: z.number()}).parse(database.prepare(
        "SELECT COUNT(*) AS count FROM versions WHERE artifact_id = ?",
      ).get(first.body.artifact.id)).count).toBe(2);
      expect(z.object({deletedAt: z.string()}).parse(database.prepare(
        "SELECT deleted_at AS deletedAt FROM artifacts WHERE id = ?",
      ).get(first.body.artifact.id)).deletedAt).toBe(deleted.artifact.deletedAt);
    } finally {
      database.close();
    }
    await expect(access(
      path.join(
        installation.dataDirectory,
        "blobs",
        currentDigest.slice(0, 2),
        currentDigest,
      ),
    )).resolves.toBeUndefined();
    server = await startTestServer(installation);
    expect((await authenticatedFetch(
      `/api/v1/artifacts/${first.body.artifact.id}`,
    )).status).toBe(404);
    expect((await deleteArtifact(
      first.body.artifact.id,
      second.body.version.id,
      "lifecycle-delete-new-key",
    )).status).toBe(404);
  });

  test("foundation: a tombstone cannot commit without its action record", async () => {
    const published = await publishNew(server, installation, {
      accessSetting: "public_link",
      content: "atomic deletion",
      idempotencyKey: "lifecycle-atomic-publish",
    });
    await server.stop();
    const database = openDatabase();
    try {
      database.exec(`
        CREATE TRIGGER reject_delete_action
        BEFORE INSERT ON actions
        WHEN NEW.action = 'delete'
        BEGIN
          SELECT RAISE(ABORT, 'reject delete action for atomicity test');
        END;
      `);
    } finally {
      database.close();
    }
    server = await startTestServer(installation);

    const rejected = await deleteArtifact(
      published.body.artifact.id,
      published.body.version.id,
      "lifecycle-atomic-delete",
    );
    expect(rejected.status).toBe(500);
    expect((await authenticatedFetch(
      `/api/v1/artifacts/${published.body.artifact.id}`,
    )).status).toBe(200);
    expect((await fetchVersion(server, published.body.links.version)).status)
      .toBe(200);

    await server.stop();
    const inspected = openDatabase();
    try {
      expect(z.object({deletedAt: z.null()}).parse(inspected.prepare(
        "SELECT deleted_at AS deletedAt FROM artifacts WHERE id = ?",
      ).get(published.body.artifact.id))).toEqual({deletedAt: null});
      expect(z.object({count: z.number()}).parse(inspected.prepare(
        "SELECT COUNT(*) AS count FROM actions WHERE action = 'delete'",
      ).get()).count).toBe(0);
      expect(z.object({count: z.number()}).parse(inspected.prepare(
        "SELECT COUNT(*) AS count FROM idempotency_records WHERE operation = 'delete'",
      ).get()).count).toBe(0);
    } finally {
      inspected.close();
    }
    server = await startTestServer(installation);
  });

  function authenticatedFetch(
    pathname: string,
    init?: RequestInit,
  ): Promise<Response> {
    const headers = new Headers(init?.headers);
    headers.set("Authorization", `Bearer ${installation.apiToken}`);
    return fetch(`${server.baseUrl}${pathname}`, {...init, headers});
  }

  function deleteArtifact(
    artifactId: string,
    expectedCurrentVersionId: string,
    idempotencyKey: string,
  ): Promise<Response> {
    return fetch(`${server.baseUrl}/api/v1/artifacts/${artifactId}`, {
      body: JSON.stringify({expectedCurrentVersionId}),
      headers: apiHeaders(installation, idempotencyKey),
      method: "DELETE",
    });
  }

  async function issueVersionBootstrap(
    artifactId: string,
    versionId: string,
  ): Promise<string> {
    const response = await authenticatedFetch(
      `/api/v1/artifacts/${artifactId}/versions/${versionId}/content-sessions`,
      {method: "POST"},
    );
    expect(response.status).toBe(201);
    return z.object({bootstrapUrl: z.url()}).parse(await response.json())
      .bootstrapUrl;
  }

  function openDatabase(): DatabaseSync {
    return new DatabaseSync(
      path.join(installation.dataDirectory, "artifact-server.db"),
    );
  }
});
