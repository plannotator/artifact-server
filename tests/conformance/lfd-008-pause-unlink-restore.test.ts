import {cp, mkdir, mkdtemp, realpath, rm, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import path from "node:path";

import {afterEach, beforeEach, describe, expect, test} from "vitest";
import {z} from "zod";

import {issueApiKey, signInAdministrator} from "../support/agent-dispatch.js";
import {
  defaultProject, expectFailure, LinkedFolderClient, treeHash, waitFor, withDatabase,
} from "../support/linked-folders.js";
import {
  createTestInstallation, removeTestInstallation, type RunningTestServer, startTestServer,
  type TestInstallation,
} from "../support/runtime-harness.js";

const artifactSchema = z.object({
  artifact: z.object({folderId: z.string().nullable(), id: z.string()}).loose(),
  current: z.object({version: z.object({id: z.string()}).loose()}).loose(),
  sourceBinding: z.object({path: z.string(), status: z.string()}).loose(),
}).loose();
const folderSchema = z.object({folder: z.object({id: z.string(), revision: z.number()}).loose()}).loose();
const projectSchema = z.object({project: z.object({id: z.string()}).loose()}).loose();
const folderPath = (folderId: string, projectId = defaultProject) => `/api/v1/projects/${projectId}/folders/${folderId}`;

describe("pause, trash, unlink, and restore of a linked folder never touch the disk", () => {
  let installation: TestInstallation;
  let restored: TestInstallation | null = null;
  let server: RunningTestServer | null = null;
  let sourceRoot: string;

  beforeEach(async () => {
    installation = await createTestInstallation();
    sourceRoot = await realpath(await mkdtemp(path.join(tmpdir(), "lfd-008-")));
  });

  afterEach(async () => {
    if (server !== null) await server.stop();
    server = null;
    await removeTestInstallation(installation);
    if (restored !== null) await removeTestInstallation(restored);
    restored = null;
    await rm(sourceRoot, {force: true, recursive: true});
  });

  test("LFD-008-B: pause and resume a link, trash and recover its folder with a fresh scan, unlink it with captured artifacts still linked individually, and restore a backup whose link stays unavailable until a successful scan", async () => {
    const linked = path.join(sourceRoot, "outputs");
    await mkdir(path.join(linked, "docs"), {recursive: true});
    await writeFile(path.join(linked, "docs", "spec.md"), "# spec\n");
    server = await startTestServer(installation, {linkRoots: [sourceRoot], linkedFiles: "on", linkedFolderWatch: "on"});
    let client = new LinkedFolderClient(server, installation.apiToken);
    const link = await client.linkOk(linked, {name: "Outputs"});
    const [captured] = await client.captureOk(link.id, {all: true});
    await waitFor(() => client.get(link.id), (current) => current.scanActivity === "idle");

    const paused = await client.update(link.id, {expectedRevision: link.revision, paused: true});
    expect(paused.state).toBe("paused");
    await writeFile(path.join(linked, "while-paused.md"), "# written while paused\n");
    await new Promise((resolve) => setTimeout(resolve, 2_000));
    expect((await client.inventory(link.id)).map((entry) => entry.relativePath)).toEqual(["docs/spec.md"]);
    const resumed = await client.update(link.id, {expectedRevision: paused.revision, paused: false});
    expect(resumed.state).toBe("active");
    expect((await client.inventory(link.id)).map((entry) => entry.relativePath).toSorted())
      .toEqual(["docs/spec.md", "while-paused.md"]);

    // Trashing the linked folder pauses the link: no watching, scheduled or
    // explicit scans, or captures until the folder is recovered.
    const trashed = await client.request(`${folderPath(link.folderId)}?expectedRevision=1`, "DELETE");
    expect(trashed.status).toBe(200);
    await expect(trashed.json()).resolves.toMatchObject({recoverable: true});
    const inTrash = await waitFor(() => client.get(link.id), (current) => current.scanActivity === "idle");
    expect(inTrash).toMatchObject({inTrash: true, paused: false, state: "paused"});
    expect((await client.request(`/api/v1/artifacts/${captured?.artifactId ?? ""}`)).status).toBe(404);
    await writeFile(path.join(linked, "while-trashed.md"), "# written while trashed\n");
    await new Promise((resolve) => setTimeout(resolve, 2_000));
    expect(await client.get(link.id)).toMatchObject({lastScanStartedAt: inTrash.lastScanStartedAt, state: "paused"});
    expect((await client.inventory(link.id)).map((entry) => entry.relativePath).toSorted())
      .toEqual(["docs/spec.md", "while-paused.md"]);
    await expectFailure(await client.request(`/api/v1/folder-links/${link.id}/scan`, "POST"), 409, "FOLDER_LINK_IN_TRASH");
    await expectFailure(await client.capture(link.id, {all: true}), 409, "FOLDER_LINK_IN_TRASH");
    await expectFailure(
      await client.request(`/api/v1/folder-links/${link.id}`, "PATCH", {expectedRevision: inTrash.revision, paused: true}),
      409, "FOLDER_LINK_IN_TRASH",
    );
    expect(await client.tool("folder_link_scan", {folderLinkId: link.id})).toMatchObject({
      isError: true, structuredContent: {error: {code: "FOLDER_LINK_IN_TRASH"}},
    });

    // Recovering the folder resumes the link with a fresh scan that sees the
    // file written while it was in Trash, and brings the capture back.
    const recoveredFolder = await client.request(`${folderPath(link.folderId)}/recover`, "POST", {});
    expect(recoveredFolder.status).toBe(200);
    await expect(recoveredFolder.json()).resolves.toMatchObject({placement: "original", recoveredArtifactCount: 1});
    const rescanned = await waitFor(() => client.get(link.id), (current) =>
      current.scanActivity === "idle" && current.state === "active"
      && current.lastScanStartedAt !== inTrash.lastScanStartedAt);
    expect(rescanned.inTrash).toBe(false);
    // The inventory is listed in relative-path order.
    expect((await client.inventory(link.id)).map((entry) => [entry.relativePath, entry.state]))
      .toEqual([["docs/spec.md", "tracked"], ["while-paused.md", "untracked"], ["while-trashed.md", "untracked"]]);
    const back = artifactSchema.parse(await (await client.request(`/api/v1/artifacts/${captured?.artifactId ?? ""}`)).json());
    expect(back.sourceBinding).toEqual(expect.objectContaining({path: path.join(linked, "docs", "spec.md"), status: "in-sync"}));

    // Backup: copy the stopped data directory; restore it where the directory is not linkable.
    await server.stop();
    server = null;
    restored = await createTestInstallation();
    await rm(restored.dataDirectory, {force: true, recursive: true});
    await cp(installation.dataDirectory, restored.dataDirectory, {recursive: true});
    const elsewhere = await realpath(await mkdtemp(path.join(tmpdir(), "lfd-008-elsewhere-")));
    server = await startTestServer(restored, {linkRoots: [elsewhere], linkedFiles: "on", linkedFolderWatch: "on"});
    client = new LinkedFolderClient(server, installation.apiToken);
    const unavailable = await waitFor(() => client.get(link.id), (current) =>
      current.scanActivity === "idle" && current.lastScanStartedAt !== rescanned.lastScanStartedAt);
    expect(unavailable.state).toBe("unavailable");
    expect((await client.scan(link.id)).state).toBe("unavailable");
    await server.stop();
    server = await startTestServer(restored, {linkRoots: [sourceRoot], linkedFiles: "on", linkedFolderWatch: "off"});
    client = new LinkedFolderClient(server, installation.apiToken);
    const recovered = await waitFor(() => client.get(link.id), (current) => current.state === "active");
    expect(recovered.entryCount).toBe(3);
    await rm(elsewhere, {force: true, recursive: true});

    const unlinked = await client.request(`/api/v1/folder-links/${link.id}?expectedRevision=${recovered.revision}`, "DELETE");
    expect(unlinked.status).toBe(200);
    await expectFailure(await client.request(`/api/v1/folder-links/${link.id}`), 404, "FOLDER_LINK_NOT_FOUND");
    const artifact = artifactSchema.parse(await (await client.request(`/api/v1/artifacts/${captured?.artifactId ?? ""}`)).json());
    expect(artifact.sourceBinding).toEqual(expect.objectContaining({path: path.join(linked, "docs", "spec.md"), status: "in-sync"}));
    expect(artifact.artifact.folderId).not.toBeNull();
    const relinked = await client.linkOk(linked, {folderId: link.folderId, key: "lfd-008-relink-after-unlink"});
    expect((await client.inventory(relinked.id)).find((entry) => entry.relativePath === "docs/spec.md"))
      .toMatchObject({artifactId: captured?.artifactId, state: "tracked"});
  }, 60_000);

  test("LFD-008-F: no pause, scan, capture, rename, move, trash, recover, cross-project move, unlink, or purge writes anything under the linked directory", async () => {
    const linked = path.join(sourceRoot, "outputs");
    await mkdir(path.join(linked, "nested"), {recursive: true});
    await writeFile(path.join(linked, "a.md"), "# a\n");
    await writeFile(path.join(linked, "nested", "b.md"), "# b\n");
    await writeFile(path.join(linked, ".artifactignore"), "*.log\n");
    await writeFile(path.join(linked, "ignored.log"), "log\n");
    const before = await treeHash(linked);
    server = await startTestServer(installation, {linkRoots: [sourceRoot], linkedFiles: "on", linkedFolderWatch: "on"});
    const client = new LinkedFolderClient(server, installation.apiToken);
    const link = await client.linkOk(linked, {name: "Read-only"});
    const results = await client.captureOk(link.id, {all: true});
    const paused = await client.update(link.id, {expectedRevision: link.revision, paused: true});
    const resumed = await client.update(link.id, {expectedRevision: paused.revision, paused: false});
    await client.scan(link.id);

    const target = folderSchema.parse(await (await client.request(`/api/v1/projects/${defaultProject}/folders`, "POST", {
      name: "Elsewhere", parentFolderId: null,
    })).json()).folder;
    const nested = results.find((result) => result.relativePath === "nested/b.md");
    const moved = await client.request(`/api/v1/artifacts/${nested?.artifactId ?? ""}/move?projectId=${defaultProject}`, "POST", {
      expectedCurrentVersionId: nested?.versionId ?? "", toFolderId: target.id,
    });
    expect(moved.status).toBe(200);
    const renamed = await client.request(`/api/v1/artifacts/${nested?.artifactId ?? ""}/name?projectId=${defaultProject}`, "PATCH", {
      expectedCurrentVersionId: nested?.versionId ?? "", name: "b renamed.md",
    });
    expect(renamed.status).toBe(200);
    const linkFolder = await client.request(`/api/v1/projects/${defaultProject}/folders/${link.folderId}`, "PATCH", {
      expectedRevision: 1, name: "Renamed outputs",
    });
    expect(linkFolder.status).toBe(200);
    // Trash and recover the linked folder; an owner's pause outlives the
    // trash, and the resumed scan still tracks the capture that moved elsewhere.
    const pausedAgain = await client.update(link.id, {expectedRevision: resumed.revision, paused: true});
    const trashed = await client.request(`${folderPath(link.folderId)}?expectedRevision=2`, "DELETE");
    expect(trashed.status).toBe(200);
    expect((await client.get(link.id)).state).toBe("paused");
    expect(await treeHash(linked)).toBe(before);
    const recoveredFolder = await client.request(`${folderPath(link.folderId)}/recover`, "POST", {});
    expect(recoveredFolder.status).toBe(200);
    const recoveredRevision = folderSchema.parse(await recoveredFolder.json()).folder.revision;
    expect(await client.get(link.id)).toMatchObject({inTrash: false, paused: true, state: "paused"});
    const resumedAgain = await client.update(link.id, {expectedRevision: pausedAgain.revision, paused: false});
    expect(resumedAgain.state).toBe("active");
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    await client.scan(link.id);
    expect(await treeHash(linked)).toBe(before);
    expect((await client.inventory(link.id)).find((entry) => entry.relativePath === "nested/b.md"))
      .toMatchObject({artifactId: nested?.artifactId, state: "tracked"});

    // A cross-project move of the linked folder carries the link with it.
    const second = projectSchema.parse(await (await client.request("/api/v1/projects", "POST", {
      name: "Second project",
    })).json()).project.id;
    const crossProject = await client.request(`${folderPath(link.folderId)}/move-to-project`, "POST", {
      expectedRevision: recoveredRevision, toParentFolderId: null, toProjectId: second,
    });
    expect(crossProject.status).toBe(200);
    expect(await client.scan(link.id)).toMatchObject({projectId: second, state: "active"});
    const top = results.find((result) => result.relativePath === "a.md");
    expect((await client.inventory(link.id)).find((entry) => entry.relativePath === "a.md"))
      .toMatchObject({artifactId: top?.artifactId, state: "tracked"});
    expect(await treeHash(linked)).toBe(before);

    const removed = await client.request(`/api/v1/folder-links/${link.id}?expectedRevision=${resumedAgain.revision}`, "DELETE");
    expect(removed.status).toBe(200);
    expect(await treeHash(linked)).toBe(before);

    // Purging a trashed linked folder removes its link and inventory.
    const relinked = await client.linkOk(linked, {key: "lfd-008-purge-link", name: "Relinked"});
    expect((await client.inventory(relinked.id)).length).toBeGreaterThan(0);
    expect((await client.request(`${folderPath(relinked.folderId)}?expectedRevision=1`, "DELETE")).status).toBe(200);
    const cookies = await signInAdministrator(server, installation);
    const purger = new LinkedFolderClient(server, await issueApiKey(server, cookies, ["artifact:purge", "artifact:read"], "Purge key"));
    const purged = await purger.request(`${folderPath(relinked.folderId)}/purge`, "POST", {confirm: "Relinked"});
    expect(purged.status).toBe(200);
    await expectFailure(await client.request(`/api/v1/folder-links/${relinked.id}`), 404, "FOLDER_LINK_NOT_FOUND");
    expect(withDatabase(installation, (database) => database.prepare(`
      SELECT (SELECT COUNT(*) FROM folder_links WHERE id = ?) AS links,
        (SELECT COUNT(*) FROM folder_inventory WHERE folder_link_id = ?) AS entries
    `).get(relinked.id, relinked.id))).toEqual({entries: 0, links: 0});
    expect(await treeHash(linked)).toBe(before);
  }, 60_000);
});
