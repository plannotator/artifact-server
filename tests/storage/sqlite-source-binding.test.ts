import {createHash} from "node:crypto";
import {mkdtemp, rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import path from "node:path";
import {DatabaseSync} from "node:sqlite";

import {afterEach, beforeEach, describe, expect, test} from "vitest";

import {
  defaultProjectId,
  type CanonicalManifest,
} from "../../src/core/model.js";
import type {PublicationSource} from "../../src/core/ports.js";
import {createManifest} from "../../src/manifest/create-manifest.js";
import {SqliteArtifactRepository} from "../../src/storage/sqlite-artifact-repository.js";

const principalId = "principal-linking";
const linkedArtifactId = "art_linked";
const plainArtifactId = "art_plain";
const sourcePath = "/workspace/reports/quarterly.html";
const movedSourcePath = "/workspace/archive/quarterly.html";
const firstFingerprint = "16777220:8402344:64:1755000000000000000:1755000000000000000";
const secondFingerprint = "16777220:8402344:96:1755600000000000000:1755600000000000000";
const movedFingerprint = "16777220:9001234:96:1755700000000000000:1755700000000000000";

describe("sqlite source bindings", () => {
  let databasePath: string;
  let dataDirectory: string;
  let repository: SqliteArtifactRepository;

  beforeEach(async () => {
    dataDirectory = await mkdtemp(path.join(tmpdir(), "artifact-source-binding-"));
    databasePath = path.join(dataDirectory, "artifact-server.db");
    repository = new SqliteArtifactRepository(databasePath);
  });

  afterEach(async () => {
    repository.close();
    await rm(dataDirectory, {force: true, recursive: true});
  });

  test("a link commit persists the first version and its source binding", async () => {
    expect.hasAssertions();
    const published = await commitLink(repository);

    expect(published.version.number).toBe(1);
    expect(published.artifact.id).toBe(linkedArtifactId);
    expect(await repository.findSourceBinding(defaultProjectId, linkedArtifactId))
      .toEqual({
        artifactId: linkedArtifactId,
        fingerprint: firstFingerprint,
        freshness: "in-sync",
        lastVerifiedAt: "2026-08-19T00:00:00.000Z",
        path: sourcePath,
        projectId: defaultProjectId,
      });
    expect(await actionKinds(repository, linkedArtifactId)).toEqual(["link"]);
  });

  test("a link commit replays under its original idempotency key", async () => {
    expect.hasAssertions();
    const published = await commitLink(repository);
    const replay = await commitLink(repository, {uploadId: "upl_link_replay"});

    expect(replay.replayed).toBe(true);
    expect(replay.version.id).toBe(published.version.id);
    expect(await actionKinds(repository, linkedArtifactId)).toEqual(["link"]);
  });

  test("recording freshness changes only the observed state", async () => {
    expect.hasAssertions();
    await commitLink(repository);

    const observed = await repository.recordSourceFreshness({
      artifactId: linkedArtifactId,
      freshness: "modified",
      projectId: defaultProjectId,
      verifiedAt: "2026-08-19T01:00:00.000Z",
    });

    expect(observed.freshness).toBe("modified");
    expect(observed.fingerprint).toBe(firstFingerprint);
    expect(observed.lastVerifiedAt).toBe("2026-08-19T01:00:00.000Z");
    expect(await repository.listArtifactVersions(defaultProjectId, linkedArtifactId))
      .toHaveLength(1);
    expect(await actionKinds(repository, linkedArtifactId)).toEqual(["link"]);
  });

  test("a captured version lands as an ordinary version row", async () => {
    expect.hasAssertions();
    const linked = await commitLink(repository);
    await repository.recordSourceFreshness({
      artifactId: linkedArtifactId,
      freshness: "modified",
      projectId: defaultProjectId,
      verifiedAt: "2026-08-19T01:00:00.000Z",
    });

    const captured = await commitCapture(repository, linked.version.id);

    expect(captured.version.number).toBe(2);
    expect(captured.artifact.currentVersionId).toBe(captured.version.id);
    const versions = await repository.listArtifactVersions(
      defaultProjectId,
      linkedArtifactId,
    );
    expect(versions.map((version) => version.number)).toEqual([2, 1]);
    expect(await repository.findSourceBinding(defaultProjectId, linkedArtifactId))
      .toMatchObject({
        fingerprint: secondFingerprint,
        freshness: "in-sync",
        lastVerifiedAt: "2026-08-19T02:00:00.000Z",
        path: sourcePath,
      });
    expect(await actionKinds(repository, linkedArtifactId))
      .toEqual(["capture", "link"]);
  });

  test("a relink keeps the artifact identity and every saved version", async () => {
    expect.hasAssertions();
    const linked = await commitLink(repository);
    await commitCapture(repository, linked.version.id);

    const relinked = await relink(repository);

    expect(relinked).toMatchObject({
      artifactId: linkedArtifactId,
      fingerprint: movedFingerprint,
      freshness: "in-sync",
      path: movedSourcePath,
    });
    const versions = await repository.listArtifactVersions(
      defaultProjectId,
      linkedArtifactId,
    );
    expect(versions.map((version) => version.number)).toEqual([2, 1]);
    const artifact = await repository.findArtifact(
      defaultProjectId,
      linkedArtifactId,
    );
    expect(artifact?.currentVersionId).toBe(versions[0]?.id);
    expect(await actionKinds(repository, linkedArtifactId))
      .toEqual(["relink", "capture", "link"]);
  });

  test("a replayed relink appends no second action record", async () => {
    expect.hasAssertions();
    await commitLink(repository);
    const first = await relink(repository);
    const replay = await relink(repository, {
      binding: {
        fingerprint: movedFingerprint,
        path: movedSourcePath,
        verifiedAt: "2026-08-19T09:00:00.000Z",
      },
    });

    expect(replay).toEqual(first);
    expect(await actionKinds(repository, linkedArtifactId))
      .toEqual(["relink", "link"]);
  });

  test("binding operations reject an artifact without a binding", async () => {
    expect.hasAssertions();
    const plain = await commitPlainPublication(repository);

    await expect(repository.recordSourceFreshness({
      artifactId: plainArtifactId,
      freshness: "missing",
      projectId: defaultProjectId,
      verifiedAt: "2026-08-19T01:00:00.000Z",
    })).rejects.toMatchObject({_tag: "ArtifactNotFound"});
    await expect(relink(repository, {artifactId: plainArtifactId}))
      .rejects.toMatchObject({_tag: "ArtifactNotFound"});
    await expect(commitCapture(repository, plain.version.id, {
      artifactId: plainArtifactId,
      uploadId: "upl_capture_plain",
    })).rejects.toMatchObject({_tag: "ArtifactNotFound"});

    expect(await repository.listArtifactVersions(defaultProjectId, plainArtifactId))
      .toHaveLength(1);
    expect(await actionKinds(repository, plainArtifactId)).toEqual(["publish"]);
  });

  test("an ordinary publication leaves every binding column null", async () => {
    expect.hasAssertions();
    await commitPlainPublication(repository);

    expect(await repository.findSourceBinding(defaultProjectId, plainArtifactId))
      .toBeNull();
    const inspector = new DatabaseSync(databasePath, {readOnly: true});
    try {
      expect(readBindingColumns(inspector, plainArtifactId)).toEqual({
        source_fingerprint: null,
        source_path: null,
        source_status: null,
        source_verified_at: null,
      });
    } finally {
      inspector.close();
    }
  });

  test("the stored schema rejects a partial or unknown binding state", async () => {
    expect.hasAssertions();
    await commitPlainPublication(repository);

    const writer = new DatabaseSync(databasePath, {timeout: 5_000});
    try {
      expect(() => writer.prepare(
        "UPDATE artifacts SET source_path = ? WHERE id = ?",
      ).run(sourcePath, plainArtifactId)).toThrow(/CHECK constraint failed/u);
      expect(() => writer.prepare(
        `UPDATE artifacts
         SET source_path = ?, source_fingerprint = ?,
           source_status = ?, source_verified_at = ?
         WHERE id = ?`,
      ).run(
        sourcePath,
        firstFingerprint,
        "stale",
        "2026-08-19T00:00:00.000Z",
        plainArtifactId,
      )).toThrow(/CHECK constraint failed/u);
    } finally {
      writer.close();
    }

    expect(await repository.findSourceBinding(defaultProjectId, plainArtifactId))
      .toBeNull();
  });
});

function manifestFor(body: string): CanonicalManifest {
  const bytes = new TextEncoder().encode(body);
  return createManifest({
    entryPath: "index.html",
    files: [{
      mediaType: "text/html",
      path: "index.html",
      sha256: createHash("sha256").update(bytes).digest("hex"),
      size: bytes.byteLength,
    }],
    routingMode: "static",
  });
}

async function stageUpload(
  repository: SqliteArtifactRepository,
  manifest: CanonicalManifest,
  uploadId: string,
  createdAt: string,
): Promise<PublicationSource> {
  const files = manifest.entries.map((entry, index) => ({
    entry,
    storageToken: `${uploadId}-file-${index}`,
  }));
  await repository.createStagedUpload({
    createdAt,
    expiresAt: "2026-12-31T00:00:00.000Z",
    files,
    id: uploadId,
    manifest,
    principalId,
    projectId: defaultProjectId,
  });
  await Promise.all(files.map((file) => repository.markStagedFileUploaded(
    defaultProjectId,
    uploadId,
    principalId,
    file.storageToken,
    createdAt,
  )));
  return {
    kind: "staged_upload",
    principalId,
    projectId: defaultProjectId,
    uploadId,
  };
}

async function commitLink(
  repository: SqliteArtifactRepository,
  overrides: {readonly uploadId?: string} = {},
) {
  const createdAt = "2026-08-19T00:00:00.000Z";
  const manifest = manifestFor("<p>linked</p>");
  const source = await stageUpload(
    repository,
    manifest,
    overrides.uploadId ?? "upl_link",
    createdAt,
  );
  return repository.commitLinkedArtifact({
    accessSetting: "account_required",
    artifactId: linkedArtifactId,
    authorizedByPrincipalId: null,
    binding: {
      fingerprint: firstFingerprint,
      path: sourcePath,
      verifiedAt: createdAt,
    },
    contentToken: `content-${source.uploadId}`,
    createdAt,
    idempotencyKey: "link-quarterly",
    inputDigest: "digest-link-quarterly",
    manifest,
    name: "Quarterly report",
    principalId,
    projectId: defaultProjectId,
    source,
    tags: [],
    versionId: "ver_linked_1",
  });
}

async function commitCapture(
  repository: SqliteArtifactRepository,
  expectedCurrentVersionId: string,
  overrides: {
    readonly artifactId?: string;
    readonly uploadId?: string;
  } = {},
) {
  const createdAt = "2026-08-19T02:00:00.000Z";
  const manifest = manifestFor("<p>captured</p>");
  const uploadId = overrides.uploadId ?? "upl_capture";
  const source = await stageUpload(repository, manifest, uploadId, createdAt);
  return repository.commitCapturedVersion({
    artifactId: overrides.artifactId ?? linkedArtifactId,
    authorizedByPrincipalId: null,
    binding: {
      fingerprint: secondFingerprint,
      path: sourcePath,
      verifiedAt: createdAt,
    },
    contentToken: `content-${uploadId}`,
    createdAt,
    expectedCurrentVersionId,
    idempotencyKey: `capture-${uploadId}`,
    inputDigest: `digest-${uploadId}`,
    manifest,
    principalId,
    projectId: defaultProjectId,
    source,
    versionId: `ver_${uploadId}`,
  });
}

function relink(
  repository: SqliteArtifactRepository,
  overrides: {
    readonly artifactId?: string;
    readonly binding?: {
      readonly fingerprint: string;
      readonly path: string;
      readonly verifiedAt: string;
    };
  } = {},
) {
  return repository.relinkSource({
    artifactId: overrides.artifactId ?? linkedArtifactId,
    authorizedByPrincipalId: null,
    binding: overrides.binding ?? {
      fingerprint: movedFingerprint,
      path: movedSourcePath,
      verifiedAt: "2026-08-19T03:00:00.000Z",
    },
    createdAt: "2026-08-19T03:00:00.000Z",
    idempotencyKey: "relink-quarterly",
    inputDigest: "digest-relink-quarterly",
    principalId,
    projectId: defaultProjectId,
  });
}

async function commitPlainPublication(repository: SqliteArtifactRepository) {
  const createdAt = "2026-08-19T00:00:00.000Z";
  const manifest = manifestFor("<p>ordinary</p>");
  const source = await stageUpload(repository, manifest, "upl_plain", createdAt);
  return repository.commitNewArtifact({
    accessSetting: "account_required",
    artifactId: plainArtifactId,
    authorizedByPrincipalId: null,
    contentToken: "content-upl_plain",
    createdAt,
    idempotencyKey: "publish-ordinary",
    inputDigest: "digest-publish-ordinary",
    manifest,
    name: "Ordinary report",
    principalId,
    projectId: defaultProjectId,
    source,
    tags: [],
    versionId: "ver_plain_1",
  });
}

async function actionKinds(
  repository: SqliteArtifactRepository,
  artifactId: string,
): Promise<readonly string[]> {
  const page = await repository.listArtifactActions({
    artifactId,
    cursor: null,
    limit: 50,
    projectId: defaultProjectId,
  });
  return page.items.map((action) => action.action);
}

function readBindingColumns(database: DatabaseSync, artifactId: string) {
  return database.prepare(
    `SELECT source_path, source_fingerprint, source_status, source_verified_at
     FROM artifacts WHERE id = ?`,
  ).get(artifactId);
}
