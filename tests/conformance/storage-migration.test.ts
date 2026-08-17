import {createHash} from "node:crypto";
import {mkdir, writeFile} from "node:fs/promises";
import path from "node:path";
import {DatabaseSync} from "node:sqlite";

import {afterEach, beforeEach, describe, expect, test} from "vitest";
import {z} from "zod";

import {publishNew} from "../support/publishing.js";
import {createManifest} from "../../src/manifest/create-manifest.js";
import {defaultProjectId} from "../../src/core/model.js";
import {
  apiHeaders,
  createTestInstallation,
  fetchVersion,
  removeTestInstallation,
  startTestServer,
  type RunningTestServer,
  type TestInstallation,
} from "../support/runtime-harness.js";

const migratedArtifactDetailsSchema = z.object({
  artifact: z.object({
    id: z.string(),
    projectId: z.string(),
    tags: z.array(z.string()),
  }),
  current: z.object({
    links: z.object({version: z.url()}),
    manifest: z.object({digest: z.string()}),
    version: z.object({id: z.string(), projectId: z.string()}),
  }),
});

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

  test("foundation: an early local database upgrades without losing publication", async () => {
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
      idempotencyKey: "legacy-database-migration",
    });
    expect(published.response.status).toBe(201);
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

  test("a populated pre-project database migrates once without changing identity or bytes", async () => {
    const artifactId = "art_legacy_project_migration";
    const versionId = "ver_legacy_project_migration";
    const actionId = "act_legacy_project_migration";
    const contentToken = "legacy-project-content-token";
    const createdAt = "2026-01-02T03:04:05.000Z";
    const content = new TextEncoder().encode(
      "<!doctype html><title>Preserved project migration</title>",
    );
    const contentDigest = createHash("sha256").update(content).digest("hex");
    const manifest = createManifest({
      entryPath: "index.html",
      files: [{
        mediaType: "text/html",
        path: "index.html",
        sha256: contentDigest,
        size: content.byteLength,
      }],
      routingMode: "static",
    });
    const database = new DatabaseSync(
      path.join(installation.dataDirectory, "artifact-server.db"),
    );
    try {
      database.exec(`
        PRAGMA foreign_keys = ON;
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
          publisher_principal_id TEXT NOT NULL,
          created_at TEXT NOT NULL,
          UNIQUE (artifact_id, number)
        ) STRICT;
        CREATE TABLE manifest_entries (
          version_id TEXT NOT NULL REFERENCES versions(id),
          path TEXT NOT NULL,
          size INTEGER NOT NULL CHECK (size >= 0),
          media_type TEXT NOT NULL,
          sha256 TEXT NOT NULL,
          disposition TEXT NOT NULL CHECK (disposition IN ('inline', 'attachment')),
          PRIMARY KEY (version_id, path)
        ) STRICT;
        CREATE TABLE artifact_tags (
          artifact_id TEXT NOT NULL REFERENCES artifacts(id),
          tag TEXT NOT NULL,
          PRIMARY KEY (artifact_id, tag)
        ) STRICT;
        CREATE TABLE idempotency_records (
          idempotency_key TEXT PRIMARY KEY,
          input_digest TEXT NOT NULL,
          artifact_id TEXT NOT NULL REFERENCES artifacts(id),
          version_id TEXT NOT NULL REFERENCES versions(id),
          operation TEXT NOT NULL DEFAULT 'publish'
            CHECK (operation IN ('publish', 'restore', 'change_access', 'change_tags', 'delete')),
          access_setting TEXT
            CHECK (access_setting IS NULL OR access_setting IN ('account_required', 'public_link')),
          tags_json TEXT,
          created_at TEXT NOT NULL
        ) STRICT;
        CREATE TABLE actions (
          id TEXT PRIMARY KEY,
          artifact_id TEXT NOT NULL REFERENCES artifacts(id),
          version_id TEXT NOT NULL REFERENCES versions(id),
          action TEXT NOT NULL,
          principal_id TEXT NOT NULL,
          authorized_by_principal_id TEXT,
          idempotency_key TEXT NOT NULL,
          created_at TEXT NOT NULL
        ) STRICT;
        PRAGMA user_version = 1;
      `);
      database.prepare(`
        INSERT INTO artifacts (
          id, name, access_setting, current_version_id,
          created_at, deleted_at
        ) VALUES (?, ?, ?, ?, ?, NULL)
      `).run(
        artifactId,
        "Preserved artifact",
        "public_link",
        versionId,
        createdAt,
      );
      database.prepare(`
        INSERT INTO versions (
          id, artifact_id, number, manifest_digest, entry_path, routing_mode,
          content_token, publisher_principal_id, created_at
        ) VALUES (?, ?, 1, ?, 'index.html', 'static', ?, ?, ?)
      `).run(
        versionId,
        artifactId,
        manifest.digest,
        contentToken,
        "local-api-token",
        createdAt,
      );
      database.prepare(`
        INSERT INTO manifest_entries (
          version_id, path, size, media_type, sha256, disposition
        ) VALUES (?, 'index.html', ?, 'text/html', ?, 'inline')
      `).run(versionId, content.byteLength, contentDigest);
      database.prepare(
        "INSERT INTO artifact_tags (artifact_id, tag) VALUES (?, 'migrated')",
      ).run(artifactId);
      database.prepare(`
        INSERT INTO idempotency_records (
          idempotency_key, input_digest, artifact_id, version_id, operation,
          access_setting, tags_json, created_at
        ) VALUES ('legacy-publish', 'legacy-input', ?, ?, 'publish', NULL, NULL, ?)
      `).run(artifactId, versionId, createdAt);
      database.prepare(`
        INSERT INTO actions (
          id, artifact_id, version_id, action, principal_id,
          authorized_by_principal_id, idempotency_key, created_at
        ) VALUES (?, ?, ?, 'publish', 'local-api-token', NULL, 'legacy-publish', ?)
      `).run(actionId, artifactId, versionId, createdAt);
    } finally {
      database.close();
    }
    const blobDirectory = path.join(
      installation.dataDirectory,
      "blobs",
      contentDigest.slice(0, 2),
    );
    await mkdir(blobDirectory, {recursive: true});
    await writeFile(path.join(blobDirectory, contentDigest), content);

    server = await startTestServer(installation);
    const detailsResponse = await fetch(
      `${server.baseUrl}/api/v1/artifacts/${artifactId}`,
      {headers: {Authorization: `Bearer ${installation.apiToken}`}},
    );
    expect(detailsResponse.status).toBe(200);
    const details = migratedArtifactDetailsSchema.parse(
      await detailsResponse.json(),
    );
    expect(details).toMatchObject({
      artifact: {
        id: artifactId,
        projectId: defaultProjectId,
        tags: ["migrated"],
      },
      current: {
        manifest: {digest: manifest.digest},
        version: {id: versionId, projectId: defaultProjectId},
      },
    });
    const rendered = await fetchVersion(server, details.current.links.version);
    expect(rendered.status).toBe(200);
    expect(new Uint8Array(await rendered.arrayBuffer())).toEqual(content);
    const actions = await fetch(
      `${server.baseUrl}/api/v1/artifacts/${artifactId}/actions`,
      {headers: {Authorization: `Bearer ${installation.apiToken}`}},
    );
    await expect(actions.json()).resolves.toMatchObject({
      actions: [{id: actionId, projectId: defaultProjectId, versionId}],
    });

    await server.stop();
    server = await startTestServer(installation);
    const repeated = await fetch(
      `${server.baseUrl}/api/v1/artifacts/${artifactId}`,
      {headers: {Authorization: `Bearer ${installation.apiToken}`}},
    );
    expect(repeated.status).toBe(200);
    await expect(repeated.json()).resolves.toMatchObject({
      artifact: {id: artifactId, projectId: defaultProjectId},
      current: {version: {id: versionId, projectId: defaultProjectId}},
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
