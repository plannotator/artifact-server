import {mkdir, mkdtemp, realpath, rename, rm, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import path from "node:path";

import {afterEach, beforeEach, describe, expect, test} from "vitest";
import {z} from "zod";

import {
  defaultProject, expectFailure, LinkedFolderClient, withDatabase,
} from "../support/linked-folders.js";
import {
  createTestInstallation, removeTestInstallation, type RunningTestServer, startTestServer,
  type TestInstallation,
} from "../support/runtime-harness.js";

const suggestionsSchema = z.object({
  suggestions: z.array(z.object({
    artifactId: z.string(),
    artifactName: z.string(),
    expectedSha256: z.string(),
    fromRelativePath: z.string(),
    toEntryId: z.string(),
    toRelativePath: z.string(),
  }).strict()),
}).strict();
const artifactSchema = z.object({
  artifact: z.object({deletedAt: z.null(), id: z.string()}).loose(),
  sourceBinding: z.object({path: z.string(), status: z.string()}).loose(),
}).loose();
const versionsSchema = z.object({versions: z.array(z.object({version: z.object({id: z.string()}).loose()}).loose())}).loose();
const threadsSchema = z.object({items: z.array(z.object({id: z.string()}).loose())}).loose();

/** History state that disk events must never change (binding freshness excluded). */
function historySnapshot(installation: TestInstallation) {
  return withDatabase(installation, (database) => ({
    actions: database.prepare("SELECT * FROM actions ORDER BY id").all(),
    artifacts: database.prepare(`SELECT id, project_id, name, access_setting, current_version_id, deleted_at,
      source_path, source_fingerprint, folder_id FROM artifacts ORDER BY id`).all(),
    folders: database.prepare("SELECT * FROM folders ORDER BY id").all(),
    threads: database.prepare("SELECT id, artifact_id, body FROM comment_threads ORDER BY id").all(),
    versions: database.prepare("SELECT * FROM versions ORDER BY id").all(),
  }));
}

describe("deletes and renames on disk never change artifacts automatically", () => {
  let installation: TestInstallation;
  let server: RunningTestServer | null = null;
  let sourceRoot: string;

  beforeEach(async () => {
    installation = await createTestInstallation();
    sourceRoot = await realpath(await mkdtemp(path.join(tmpdir(), "lfd-005-")));
  });

  afterEach(async () => {
    if (server !== null) await server.stop();
    server = null;
    await removeTestInstallation(installation);
    await rm(sourceRoot, {force: true, recursive: true});
  });

  test("LFD-005-B: a deleted file leaves its artifact missing and unchanged, and a renamed file yields a relink suggestion that keeps the artifact ID, versions, and comments", async () => {
    server = await startTestServer(installation, {linkRoots: [sourceRoot], linkedFiles: "on", linkedFolderWatch: "off"});
    const client = new LinkedFolderClient(server, installation.apiToken);
    await writeFile(path.join(sourceRoot, "keep.md"), "# keep\n");
    await writeFile(path.join(sourceRoot, "gone.md"), "# gone soon\n");
    await writeFile(path.join(sourceRoot, "moved.md"), "# moved soon, with distinct size\n");
    const link = await client.linkOk(sourceRoot, {name: "Output"});
    const captured = await client.captureOk(link.id, {all: true});
    const gone = captured.find((result) => result.relativePath === "gone.md");
    const moved = captured.find((result) => result.relativePath === "moved.md");
    const thread = await client.request(
      `/api/v1/artifacts/${moved?.artifactId ?? ""}/versions/${moved?.versionId ?? ""}/comments?projectId=${defaultProject}`,
      "POST", {body: "Keep this comment through the move."},
    );
    expect(thread.status).toBe(201);
    const before = historySnapshot(installation);

    await rm(path.join(sourceRoot, "gone.md"));
    await mkdir(path.join(sourceRoot, "archive"));
    await rename(path.join(sourceRoot, "moved.md"), path.join(sourceRoot, "archive", "moved.md"));
    await client.scan(link.id);
    expect(historySnapshot(installation)).toEqual(before);

    const goneArtifact = artifactSchema.parse(await (await client.request(`/api/v1/artifacts/${gone?.artifactId ?? ""}`)).json());
    expect(goneArtifact.sourceBinding.status).toBe("missing");
    expect(goneArtifact.artifact.deletedAt).toBeNull();
    const {suggestions} = suggestionsSchema.parse(await (await client.request(
      `/api/v1/folder-links/${link.id}/relink-suggestions`,
    )).json());
    expect(suggestions).toEqual([expect.objectContaining({
      artifactId: moved?.artifactId, artifactName: "moved.md", fromRelativePath: "moved.md", toRelativePath: "archive/moved.md",
    })]);
    expect(historySnapshot(installation)).toEqual(before);

    const [suggestion] = suggestions;
    const accepted = await client.request(`/api/v1/folder-links/${link.id}/relink`, "POST", {
      artifactId: suggestion?.artifactId ?? "", entryId: suggestion?.toEntryId ?? "",
      expectedSha256: suggestion?.expectedSha256 ?? "",
    });
    expect(accepted.status).toBe(200);
    const relinked = artifactSchema.parse(await (await client.request(`/api/v1/artifacts/${moved?.artifactId ?? ""}`)).json());
    expect(relinked).toMatchObject({
      artifact: {id: moved?.artifactId},
      sourceBinding: {path: path.join(sourceRoot, "archive", "moved.md"), status: "in-sync"},
    });
    const versions = versionsSchema.parse(await (await client.request(`/api/v1/artifacts/${moved?.artifactId ?? ""}/versions`)).json());
    expect(versions.versions.map(({version}) => version.id)).toEqual([moved?.versionId]);
    const threads = threadsSchema.parse(await (await client.request(
      `/api/v1/artifacts/${moved?.artifactId ?? ""}/comments?projectId=${defaultProject}`,
    )).json());
    expect(threads.items).toHaveLength(1);
    const inventory = await client.inventory(link.id);
    expect(inventory.find((entry) => entry.relativePath === "archive/moved.md")).toMatchObject({
      artifactId: moved?.artifactId, state: "tracked",
    });
  }, 60_000);

  test("LFD-005-F: a same-size file with other content suggests nothing, a stale suggestion fails the hash check, and disk events change only binding freshness", async () => {
    server = await startTestServer(installation, {linkRoots: [sourceRoot], linkedFiles: "on", linkedFolderWatch: "on"});
    const client = new LinkedFolderClient(server, installation.apiToken);
    await writeFile(path.join(sourceRoot, "same-size.md"), "# alpha\n");
    await writeFile(path.join(sourceRoot, "stale.md"), "# stale original body\n");
    const link = await client.linkOk(sourceRoot, {name: "Guarded"});
    await client.captureOk(link.id, {all: true});
    const before = historySnapshot(installation);

    await rm(path.join(sourceRoot, "same-size.md"));
    await writeFile(path.join(sourceRoot, "impostor.md"), "# omega\n");
    await client.scan(link.id);
    const none = suggestionsSchema.parse(await (await client.request(
      `/api/v1/folder-links/${link.id}/relink-suggestions`,
    )).json());
    expect(none.suggestions).toEqual([]);

    await rename(path.join(sourceRoot, "stale.md"), path.join(sourceRoot, "renamed.md"));
    await client.scan(link.id);
    const {suggestions} = suggestionsSchema.parse(await (await client.request(
      `/api/v1/folder-links/${link.id}/relink-suggestions`,
    )).json());
    expect(suggestions).toHaveLength(1);
    const [stale] = suggestions;
    await writeFile(path.join(sourceRoot, "renamed.md"), "# stale edited, same-ish\n");
    await expectFailure(await client.request(`/api/v1/folder-links/${link.id}/relink`, "POST", {
      artifactId: stale?.artifactId ?? "", entryId: stale?.toEntryId ?? "", expectedSha256: stale?.expectedSha256 ?? "",
    }), 422, "INVALID_LINK_PATH");

    // Further disk churn with watching on: still only freshness may change.
    await writeFile(path.join(sourceRoot, "churn.md"), "# churn\n");
    await rm(path.join(sourceRoot, "impostor.md"));
    await new Promise((resolve) => setTimeout(resolve, 2_000));
    await client.scan(link.id);
    expect(historySnapshot(installation)).toEqual(before);
  }, 60_000);
});
