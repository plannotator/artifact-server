import path from "node:path";
import {DatabaseSync} from "node:sqlite";

import {afterEach, beforeEach, describe, expect, test} from "vitest";

import {publishNew} from "../support/publishing.js";
import {
  apiHeaders,
  createTestInstallation,
  removeTestInstallation,
  startTestServer,
  type RunningTestServer,
  type TestInstallation,
} from "../support/runtime-harness.js";

describe("local storage migration", () => {
  let installation: TestInstallation;
  let server: RunningTestServer | null;

  beforeEach(async () => {
    installation = await createTestInstallation();
    server = null;
  });

  afterEach(async () => {
    if (server !== null) await server.stop();
    await removeTestInstallation(installation);
  });

  test("foundation: a pre-ownership local database upgrades without losing publication", async () => {
    const database = new DatabaseSync(
      path.join(installation.dataDirectory, "artifact-server.db"),
    );
    database.exec(`
      CREATE TABLE artifacts (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        access_setting TEXT NOT NULL CHECK (access_setting IN ('account_required', 'public_link')),
        current_version_id TEXT,
        created_at TEXT NOT NULL,
        deleted_at TEXT
      ) STRICT;

      CREATE TABLE versions (
        id TEXT PRIMARY KEY,
        artifact_id TEXT NOT NULL REFERENCES artifacts(id),
        number INTEGER NOT NULL CHECK (number > 0),
        manifest_digest TEXT NOT NULL,
        entry_path TEXT NOT NULL,
        routing_mode TEXT NOT NULL CHECK (routing_mode = 'static'),
        content_token TEXT NOT NULL UNIQUE,
        created_at TEXT NOT NULL,
        UNIQUE (artifact_id, number)
      ) STRICT;

      CREATE TABLE idempotency_records (
        idempotency_key TEXT PRIMARY KEY,
        input_digest TEXT NOT NULL,
        artifact_id TEXT NOT NULL REFERENCES artifacts(id),
        version_id TEXT NOT NULL REFERENCES versions(id),
        created_at TEXT NOT NULL
      ) STRICT;

      CREATE TABLE actions (
        id TEXT PRIMARY KEY,
        artifact_id TEXT NOT NULL REFERENCES artifacts(id),
        version_id TEXT NOT NULL REFERENCES versions(id),
        action TEXT NOT NULL,
        principal_id TEXT NOT NULL,
        idempotency_key TEXT NOT NULL,
        created_at TEXT NOT NULL
      ) STRICT;
    `);
    database.close();

    server = await startTestServer(installation);
    const published = await publishNew(server, installation, {
      accessSetting: "public_link",
      content: "<!doctype html><title>Migrated</title>",
      idempotencyKey: "legacy-database-owner-migration",
    });
    expect(published.response.status).toBe(201);
    expect(published.body.artifact.ownerPrincipalId).toBe("local-api-token");
    expect(published.body.version.publisherPrincipalId).toBe("local-api-token");

    const deleted = await fetch(
      `${server.baseUrl}/api/v1/artifacts/${published.body.artifact.id}`,
      {
        body: JSON.stringify({
          expectedCurrentVersionId: published.body.version.id,
        }),
        headers: apiHeaders(installation, "legacy-database-delete-migration"),
        method: "DELETE",
      },
    );
    expect(deleted.status).toBe(200);
    await expect(deleted.json()).resolves.toMatchObject({
      artifact: {deletedAt: expect.any(String)},
      retainedVersionCount: 1,
    });
  });

  test("foundation: the previous management schema upgrades to durable tag and deletion idempotency", async () => {
    server = await startTestServer(installation);
    const published = await publishNew(server, installation, {
      accessSetting: "account_required",
      content: "previous management schema",
      idempotencyKey: "previous-management-schema-publish",
    });
    await server.stop();
    server = null;

    const database = new DatabaseSync(
      path.join(installation.dataDirectory, "artifact-server.db"),
    );
    try {
      database.exec(`
        BEGIN IMMEDIATE;
        CREATE TABLE idempotency_records_previous (
          idempotency_key TEXT PRIMARY KEY,
          input_digest TEXT NOT NULL,
          artifact_id TEXT NOT NULL REFERENCES artifacts(id),
          version_id TEXT NOT NULL REFERENCES versions(id),
          operation TEXT NOT NULL DEFAULT 'publish' CHECK (operation IN ('publish', 'restore', 'change_access')),
          access_setting TEXT CHECK (access_setting IS NULL OR access_setting IN ('account_required', 'public_link')),
          created_at TEXT NOT NULL
        ) STRICT;
        INSERT INTO idempotency_records_previous (
          idempotency_key, input_digest, artifact_id, version_id,
          operation, access_setting, created_at
        )
          SELECT
            idempotency_key, input_digest, artifact_id, version_id,
            operation, access_setting, created_at
          FROM idempotency_records;
        DROP TABLE idempotency_records;
        ALTER TABLE idempotency_records_previous RENAME TO idempotency_records;
        COMMIT;
      `);
    } finally {
      database.close();
    }

    server = await startTestServer(installation);
    const tagged = await fetch(
      `${server.baseUrl}/api/v1/artifacts/${published.body.artifact.id}/tags`,
      {
        body: JSON.stringify({
          expectedCurrentVersionId: published.body.version.id,
          tags: ["migrated"],
        }),
        headers: apiHeaders(installation, "previous-management-schema-tags"),
        method: "PATCH",
      },
    );
    expect(tagged.status).toBe(200);
    await expect(tagged.json()).resolves.toMatchObject({
      artifact: {tags: ["migrated"]},
    });
    const deleted = await fetch(
      `${server.baseUrl}/api/v1/artifacts/${published.body.artifact.id}`,
      {
        body: JSON.stringify({
          expectedCurrentVersionId: published.body.version.id,
        }),
        headers: apiHeaders(installation, "previous-management-schema-delete"),
        method: "DELETE",
      },
    );
    expect(deleted.status).toBe(200);
    await expect(deleted.json()).resolves.toMatchObject({
      artifact: {tags: ["migrated"]},
      replayed: false,
      retainedVersionCount: 1,
    });
  });
});
