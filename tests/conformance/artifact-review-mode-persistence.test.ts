import {mkdtemp, rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import path from "node:path";
import {DatabaseSync} from "node:sqlite";

import {afterEach, beforeEach, describe, expect, test} from "vitest";

import {defaultProjectId, type ReviewMode} from "../../src/core/model.js";
import type {CommitNewArtifact} from "../../src/core/ports.js";
import {createManifest} from "../../src/manifest/create-manifest.js";
import {SqliteArtifactRepository} from "../../src/storage/sqlite-artifact-repository.js";

describe("artifact review mode persistence", () => {
  let directory: string;
  let databasePath: string;
  let repository: SqliteArtifactRepository;
  const createdAt = "2026-10-11T00:00:00.000Z";
  const projectId = defaultProjectId;
  const manifest = createManifest({
    entryPath: "index.html",
    files: [{mediaType: "text/html", path: "index.html", sha256: "a".repeat(64), size: 1}],
    routingMode: "static",
  });

  beforeEach(async () => {
    directory = await mkdtemp(path.join(tmpdir(), "artifact-review-mode-"));
    databasePath = path.join(directory, "artifact-server.db");
    repository = new SqliteArtifactRepository(databasePath);
  });

  afterEach(async () => {
    repository.close();
    await rm(directory, {force: true, recursive: true});
  });

  async function publish(reviewMode?: ReviewMode) {
    await repository.createStagedUpload({
      createdAt,
      expiresAt: "2026-10-12T00:00:00.000Z",
      files: manifest.entries.map((entry) => ({entry, storageToken: "slot"})),
      id: "upl_review",
      manifest,
      principalId: "publisher",
      projectId,
    });
    await repository.markStagedFileUploaded(projectId, "upl_review", "publisher", "slot", createdAt);
    const defaultCommand: CommitNewArtifact = {
      accessSetting: "public_link", artifactId: "art_review", authorizedByPrincipalId: null,
      contentToken: "content_review", createdAt, idempotencyKey: "publish_review",
      inputDigest: "publish_digest", manifest, name: "Review", principalId: "publisher",
      projectId,
      source: {kind: "staged_upload", principalId: "publisher", projectId, uploadId: "upl_review"},
      tags: [], versionId: "ver_review",
    };
    const command = reviewMode === undefined ? defaultCommand : {...defaultCommand, reviewMode};
    return {command, result: await repository.commitNewArtifact(command)};
  }

  const change = (reviewMode: ReviewMode, idempotencyKey: string) => ({
    artifactId: "art_review", authorizedByPrincipalId: "administrator", createdAt,
    expectedCurrentVersionId: "ver_review", idempotencyKey, inputDigest: idempotencyKey,
    principalId: "publisher", projectId, reviewMode,
  });

  test("publication defaults to annotate and survives a restart", async () => {
    const {result} = await publish();
    expect(result.artifact.reviewMode).toBe("annotate");
    repository.close();
    repository = new SqliteArtifactRepository(databasePath);
    expect(await repository.findArtifact(projectId, "art_review")).toMatchObject({reviewMode: "annotate"});
  });

  test("interact publication, mutation replay, and immutable version identity are durable", async () => {
    const {command, result} = await publish("interact");
    const first = await repository.changeReviewMode(change("annotate", "mode_first"));
    await repository.changeReviewMode(change("interact", "mode_second"));
    repository.close();
    repository = new SqliteArtifactRepository(databasePath);
    const replay = await repository.changeReviewMode(change("annotate", "mode_first"));
    expect(replay).toEqual({...first, replayed: true});
    expect(replay.artifact.reviewMode).toBe("annotate");
    expect(replay.version).toEqual(result.version);
    expect(await repository.findArtifact(projectId, "art_review")).toMatchObject({reviewMode: "interact"});
    expect((await repository.commitNewArtifact(command)).artifact.reviewMode).toBe("interact");
    const actions = await repository.listArtifactActions({artifactId: "art_review", cursor: null, limit: 20, projectId});
    expect(actions.items.filter((action) => action.action === "change_review_mode")).toHaveLength(2);
    expect(actions.items.find((action) => action.idempotencyKey === "mode_first")).toMatchObject({authorizedByPrincipalId: "administrator"});
    await repository.changeReviewMode(change("annotate", "mode_third"));
    expect((await repository.commitNewArtifact(command)).artifact.reviewMode).toBe("interact");
    expect(await repository.findArtifact(projectId, "art_review")).toMatchObject({reviewMode: "annotate"});
  });

  test("versions, restores, tags, access changes, and list projections preserve the saved mode", async () => {
    const {command, result} = await publish("interact");
    await repository.createStagedUpload({
      createdAt, expiresAt: "2026-10-12T00:00:00.000Z", files: manifest.entries.map((entry) => ({entry, storageToken: "second_slot"})),
      id: "upl_second", manifest, principalId: "publisher", projectId,
    });
    await repository.markStagedFileUploaded(projectId, "upl_second", "publisher", "second_slot", createdAt);
    const second = await repository.commitVersion({
      ...command, contentToken: "content_second", expectedCurrentVersionId: result.version.id,
      idempotencyKey: "publish_second", inputDigest: "publish_second",
      source: {...command.source, uploadId: "upl_second"}, versionId: "ver_second",
    });
    expect(second.artifact.reviewMode).toBe("interact");
    const management = {...change("interact", "management"), expectedCurrentVersionId: second.version.id};
    expect((await repository.changeTags({...management, tags: ["saved"]})).artifact.reviewMode).toBe("interact");
    expect((await repository.changeAccessSetting({...management, accessSetting: "account_required", idempotencyKey: "access", inputDigest: "access"})).artifact.reviewMode).toBe("interact");
    const restored = await repository.restoreVersion({...management, idempotencyKey: "restore", inputDigest: "restore", versionId: result.version.id});
    expect(restored.artifact.reviewMode).toBe("interact");
    const listed = await repository.listArtifacts({comments: "all", cursor: null, limit: 10, projectId, sort: "newest", tags: []});
    expect(listed.items).toEqual([expect.objectContaining({reviewMode: "interact", currentVersionId: result.version.id})]);
  });

  test("rejects stale versions, changed idempotent input, and invalid database values", async () => {
    await publish();
    await expect(repository.changeReviewMode({...change("interact", "stale"), expectedCurrentVersionId: "ver_missing"})).rejects.toMatchObject({_tag: "ArtifactMutationConflict"});
    await repository.changeReviewMode(change("interact", "same_key"));
    await expect(repository.changeReviewMode({...change("annotate", "same_key"), inputDigest: "other"})).rejects.toMatchObject({_tag: "IdempotencyConflict"});
    const database = new DatabaseSync(databasePath);
    try {
      expect(() => database.exec("UPDATE artifacts SET review_mode = 'invalid'")).toThrow(/CHECK constraint failed/u);
      expect(() => database.exec("UPDATE idempotency_records SET review_mode = 'invalid'")).toThrow(/CHECK constraint failed/u);
    } finally {database.close();}
  });

  test("pre-feature rows and saved retries migrate to annotate without changing versions", async () => {
    const {command, result} = await publish();
    repository.close();
    const database = new DatabaseSync(databasePath);
    try {
      database.exec("ALTER TABLE artifacts DROP COLUMN review_mode; ALTER TABLE idempotency_records DROP COLUMN review_mode; PRAGMA user_version = 12;");
    } finally {database.close();}
    repository = new SqliteArtifactRepository(databasePath);
    expect(await repository.findArtifact(projectId, "art_review")).toMatchObject({reviewMode: "annotate", currentVersionId: result.version.id});
    expect(await repository.commitNewArtifact(command)).toMatchObject({artifact: {reviewMode: "annotate"}, replayed: true, version: result.version});
    await expect(repository.changeReviewMode(change("interact", "after_migration"))).resolves.toMatchObject({artifact: {reviewMode: "interact"}});
  });
});
