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
  });
});
