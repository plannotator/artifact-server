import {mkdtemp, rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import path from "node:path";
import {DatabaseSync} from "node:sqlite";

import {afterEach, beforeEach, describe, expect, test} from "vitest";

import type {CreateStagedUpload} from "../../src/core/ports.js";
import {createManifest} from "../../src/manifest/create-manifest.js";
import {SqliteArtifactRepository} from "../../src/storage/sqlite-artifact-repository.js";
import {requiredSqliteSchemaVersion} from "../../src/storage/sqlite-schema.js";

describe("staged upload grant storage on SQLite", () => {
  let directory: string;
  let databasePath: string;

  beforeEach(async () => {
    directory = await mkdtemp(path.join(tmpdir(), "artifact-upload-grant-"));
    databasePath = path.join(directory, "artifact-server.db");
  });

  afterEach(async () => {
    await rm(directory, {force: true, recursive: true});
  });

  test("stores the grant digest and finds it by upload id alone", async () => {
    const repository = new SqliteArtifactRepository(databasePath);
    try {
      const projectId = await defaultProjectId(repository);
      await repository.createStagedUpload(
        stagedUpload(projectId, "upl_with_grant", "a".repeat(64)),
      );
      await repository.createStagedUpload(
        stagedUpload(projectId, "upl_without_grant", null),
      );

      expect(await repository.findStagedUploadGrant("upl_with_grant")).toEqual({
        grantDigest: "a".repeat(64),
        principalId: "member_owner",
        projectId,
      });
      expect(await repository.findStagedUploadGrant("upl_without_grant")).toEqual({
        grantDigest: null,
        principalId: "member_owner",
        projectId,
      });
      expect(await repository.findStagedUploadGrant("upl_missing")).toBeNull();
    } finally {
      repository.close();
    }
  });

  test("a schema 12 database gains the column with existing uploads left without a grant", async () => {
    const first = new SqliteArtifactRepository(databasePath);
    const projectId = await defaultProjectId(first);
    await first.createStagedUpload(stagedUpload(projectId, "upl_before_upgrade", null));
    first.close();

    const database = new DatabaseSync(databasePath);
    database.exec(`
      ALTER TABLE staged_uploads DROP COLUMN grant_digest;
      PRAGMA user_version = 12;
    `);
    database.close();

    const upgraded = new SqliteArtifactRepository(databasePath);
    try {
      expect(await upgraded.findStagedUploadGrant("upl_before_upgrade")).toMatchObject({
        grantDigest: null,
      });
      const check = new DatabaseSync(databasePath, {readOnly: true});
      try {
        expect(check.prepare("PRAGMA user_version").get()).toEqual({
          user_version: requiredSqliteSchemaVersion,
        });
      } finally {
        check.close();
      }
    } finally {
      upgraded.close();
    }
  });
});

async function defaultProjectId(repository: SqliteArtifactRepository): Promise<string> {
  const project = (await repository.listProjects())[0];
  if (project === undefined) throw new Error("The default project is missing.");
  return project.id;
}

function stagedUpload(
  projectId: string,
  id: string,
  grantDigest: string | null,
): CreateStagedUpload {
  const manifest = createManifest({
    entryPath: "index.html",
    files: [{
      mediaType: "text/html",
      path: "index.html",
      sha256: "b".repeat(64),
      size: 4,
    }],
    routingMode: "static",
  });
  return {
    createdAt: "2026-10-12T08:00:00.000Z",
    expiresAt: "2026-10-12T09:00:00.000Z",
    files: manifest.entries.map((entry) => ({entry, storageToken: `${id}_file`})),
    grantDigest,
    id,
    manifest,
    principalId: "member_owner",
    projectId,
  };
}
