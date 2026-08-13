import path from "node:path";
import {DatabaseSync} from "node:sqlite";

import {afterEach, beforeEach, describe, expect, test} from "vitest";

import {publishNew} from "../support/publishing.js";
import {
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
  });
});
