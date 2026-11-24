import {execFile} from "node:child_process";
import {randomUUID} from "node:crypto";
import {cp, readFile, writeFile} from "node:fs/promises";
import path from "node:path";
import {DatabaseSync} from "node:sqlite";
import {promisify} from "node:util";

import {
  CLIENT_CAPABILITIES_META_KEY, CLIENT_INFO_META_KEY, PROTOCOL_VERSION_META_KEY,
} from "@modelcontextprotocol/server";
import {Effect} from "effect";
import {afterEach, beforeEach, describe, expect, test} from "vitest";
import {z} from "zod";

import {browserLoginKinds, privateTeamBrowserAccess} from "../../src/core/browser-access.js";
import {OidcIdentityProvider} from "../../src/identity/oidc-identity-provider.js";
import {checkCompactIntegrity} from "../../src/lifecycle/integrity-check.js";
import {SqliteArtifactRepository} from "../../src/storage/sqlite-artifact-repository.js";
import {requiredSqliteSchemaVersion} from "../../src/storage/sqlite-schema.js";
import {parsePublishResponse, publishNew, publishVersion, type PublishResponse} from "../support/publishing.js";
import {
  apiHeaders, createTestInstallation, fetchVersion, removeTestInstallation, reserveLoopbackPort,
  startTestServer, type RunningTestServer, type TestInstallation,
} from "../support/runtime-harness.js";
import {startStubOidcProvider} from "../support/stub-oidc-provider.js";
import {issueApiKey, signInAdministrator} from "../support/agent-dispatch.js";
import {downgradeToSchemaTwelve} from "../support/schema-twelve.js";

const defaultProject = "prj_default";
const foldersPath = `/api/v1/projects/${defaultProject}/folders`;
const content = "<!doctype html><title>Immutable folder fixture</title>";
const run = promisify(execFile);
const idSchema = z.object({id: z.string()});
const folderSchema = idSchema.extend({name: z.string(), parentFolderId: z.string().nullable(), revision: z.number()});
const folderResult = z.object({folder: folderSchema});
const folderPage = z.object({
  folders: z.array(folderSchema),
  breadcrumbs: z.array(folderSchema),
  artifacts: z.array(z.object({artifact: idSchema.extend({name: z.string(), folderId: z.string().nullable()})})),
  nextCursor: z.string().nullable(),
});
const projectResult = z.object({project: idSchema});
const actionsResult = z.object({actions: z.array(z.object({
  action: z.string(), principalId: z.string(), versionId: z.string(),
}).loose())});
const toolEnvelope = z.object({result: z.object({isError: z.boolean().optional(), structuredContent: z.json()})});
type Json = z.infer<ReturnType<typeof z.json>>;

describe("local folders and artifact placement", () => {
  let installation: TestInstallation;
  let server: RunningTestServer | null;
  let source: TestInstallation;

  beforeEach(async () => {
    installation = await createTestInstallation();
    source = await createTestInstallation();
    server = await startTestServer(installation, {linkedFiles: "on", linkRoots: [source.dataDirectory]});
  });
  afterEach(async () => {
    if (server !== null) await server.stop();
    await Promise.all([removeTestInstallation(installation), removeTestInstallation(source)]);
  });

  test("FLD-001-B: folders have stable identities, browsable breadcrumbs and keyset pages", async () => {
    const id = `fld_${randomUUID()}`;
    const parent = await createFolder("Reports", null, id);
    const child = await createFolder("2026", parent.id);
    const sibling = await createFolder("Design");
    expect(parent).toEqual({id, name: "Reports", parentFolderId: null, revision: 1});
    expect(await createFolder("Reports", null, id)).toEqual(parent);
    await expectFailure(await request(foldersPath, "POST", {id, name: "Different"}), 409, "IDEMPOTENCY_CONFLICT");
    const first = await list(rootPageQuery(null));
    expect(first.folders.map((record) => record.id)).toEqual([sibling.id]);
    expect(first.nextCursor).toEqual(expect.any(String));
    const second = await list(rootPageQuery(first.nextCursor));
    expect(second.folders).toEqual([parent]);
    expect(second.nextCursor).toBeNull();
    expect(await list(parent.id)).toMatchObject({breadcrumbs: [parent], folders: [child]});
    expect(await list(child.id)).toMatchObject({breadcrumbs: [parent, child]});
    const deleted = await request(`${foldersPath}/${child.id}?expectedRevision=1`, "DELETE", undefined, "test-delete-folder-key");
    expect(deleted.status).toBe(200);
    expect((await list(parent.id)).folders).toEqual([]);
    const replay = await request(`${foldersPath}/${child.id}?expectedRevision=1`, "DELETE", undefined, "test-delete-folder-key");
    expect(replay.status).toBe(200);
    expect(folderResult.parse(await replay.json()).folder).toEqual(child);
  });

  test("FLD-001-F: invalid names, excess depth, foreign parents and archived writes leave no folder", async () => {
    const hostileNames = ["", "a".repeat(121), "a\u0001b", "a\u202Eb", "a/b", "a\\b", "a／b", ".", "..", ".a", "a.", "a "];
    await Promise.all(hostileNames.map(async (name) =>
      expectFailure(await request(foldersPath, "POST", {name}), 422, "INVALID_INPUT")));
    const root = await createFolder("Reports");
    await Promise.all(["REPORTS", "Ｒｅｐｏｒｔｓ"].map(async (name) =>
      expectFailure(await request(foldersPath, "POST", {name}), 409, "NAME_CONFLICT")));
    const other = await createProject();
    const foreign = await createFolder("Foreign", null, undefined, other);
    await Promise.all([foreign.id, `fld_${randomUUID()}`].map(async (parentFolderId) =>
      expectFailure(await request(foldersPath, "POST", {name: "Invalid", parentFolderId}), 404, "FOLDER_NOT_FOUND")));
    const parent = await Array.from({length: 15}, (_, index) => index + 2).reduce(
      async (ancestor, depth) => createFolder(`Level ${depth}`, (await ancestor).id),
      Promise.resolve(root),
    );
    await expectFailure(await request(foldersPath, "POST", {name: "Too deep", parentFolderId: parent.id}), 409, "FOLDER_LIMIT");
    expect((await request(`/api/v1/projects/${other}/archive`, "POST")).status).toBe(200);
    await expectFailure(await request(`/api/v1/projects/${other}/folders`, "POST", {name: "Archived"}), 409, "PROJECT_ARCHIVED");
    expect((await list("root")).folders).toEqual([root]);
  });

  test("FLD-002-B: folder rename and move preserve public bytes, comments, bindings and descendant identities", async () => {
    const root = await createFolder("Reports");
    const child = await createFolder("Drafts", root.id);
    const destination = await createFolder("Archive");
    const artifact = await publish();
    const artifactPath = routeFor(artifact);
    await place(artifact, child.id);
    const linked = await linkFile();
    await place(linked.artifact, child.id);
    const originalBinding = await request(routeFor(linked.artifact)).then((response) => response.json());
    await addComment(artifact);
    const unchanged = dbSnapshot(["versions", "manifest_entries", "comment_threads", "artifact_tags"]);
    const original = await request(artifactPath).then((response) => response.json());
    const renamed = await updateFolder(root.id, {name: "Final", expectedRevision: 1});
    expect(renamed).toMatchObject({id: root.id, revision: 2, name: "Final"});
    const moveKey = "move-folder-same-retry";
    const moved = await updateFolder(root.id, {parentFolderId: destination.id, expectedRevision: 2}, moveKey);
    expect(await updateFolder(root.id, {parentFolderId: destination.id, expectedRevision: 2}, moveKey)).toEqual(moved);
    expect(moved).toMatchObject({revision: 3, parentFolderId: destination.id});
    expect(await list(child.id)).toMatchObject({breadcrumbs: [destination, moved, child], artifacts: expect.arrayContaining([{artifact: expect.objectContaining({id: artifact.artifact.id})}])});
    expect(dbSnapshot(["versions", "manifest_entries", "comment_threads", "artifact_tags"])).toEqual(unchanged);
    expect(await request(artifactPath).then((response) => response.json())).toEqual(original);
    expect(await request(routeFor(linked.artifact)).then((response) => response.json())).toEqual(originalBinding);
    expect(await readFile(linked.path, "utf8")).toBe(content);
    expect(await (await fetchVersion(running(), artifact.links.version)).text()).toBe(content);
    expect((await fetch(artifact.links.artifact, {redirect: "manual"})).status).toBe(302);
    expect(readDatabase((db) => db.prepare("SELECT action, principal_id FROM folder_actions WHERE folder_id = ? ORDER BY created_at").all(root.id)))
      .toEqual(["create", "rename", "move"].map((action) => ({action, principal_id: "local-api-token"})));
  });

  test("FLD-002-F: stale revisions, hierarchy cycles and sibling collisions change nothing", async () => {
    const root = await createFolder("Reports");
    const child = await createFolder("Drafts", root.id);
    const target = await createFolder("Archive");
    await createFolder("Reports", target.id);
    const before = dbSnapshot(["folders", "folder_actions"]);
    const stale = await request(`${foldersPath}/${root.id}`, "PATCH", {name: "Latest", expectedRevision: 2});
    expect(stale.status).toBe(409);
    await expect(stale.json()).resolves.toMatchObject({error: {code: "FOLDER_REVISION_CONFLICT", current: root}});
    await Promise.all([root.id, child.id].map(async (parentFolderId) =>
      expectFailure(await request(`${foldersPath}/${root.id}`, "PATCH", {parentFolderId, expectedRevision: 1}), 409, "FOLDER_CYCLE")));
    await expectFailure(await request(`${foldersPath}/${root.id}`, "PATCH", {parentFolderId: target.id, expectedRevision: 1}), 409, "NAME_CONFLICT");
    expect(dbSnapshot(["folders", "folder_actions"])).toEqual(before);
  });

  test("FLD-003-B: moving and renaming an artifact preserve versions, tokens, comments and delivery", async () => {
    const folder = await createFolder("Reports");
    const artifact = await publish();
    const duplicate = await publish();
    await addComment(artifact);
    const route = routeFor(artifact);
    const versions = await request(`${route}/versions`).then((response) => response.json());
    const comments = dbSnapshot(["comment_threads", "versions", "manifest_entries"]);
    await place(artifact, folder.id);
    await place(duplicate, folder.id);
    expect((await list(folder.id)).artifacts.map(({artifact: record}) => record.name)).toEqual(["Fixture", "Fixture"]);
    const renamed = await request(`${route}/name`, "PATCH", {name: "Final report", expectedCurrentVersionId: artifact.version.id});
    expect(renamed.status).toBe(200);
    expect((await list(`${folder.id}?search=ＦＩＮＡＬ`)).artifacts).toMatchObject([{artifact: {id: artifact.artifact.id, name: "Final report", folderId: folder.id}}]);
    expect(await request(`${route}/versions`).then((response) => response.json())).toEqual(versions);
    expect(dbSnapshot(["comment_threads", "versions", "manifest_entries"])).toEqual(comments);
    const {actions} = actionsResult.parse(await (await request(`${route}/actions`)).json());
    expect(actions.filter(({action}) => action === "move" || action === "rename").toSorted((a, b) => a.action.localeCompare(b.action)))
      .toMatchObject(["move", "rename"].map((action) => ({action, principalId: "local-api-token", versionId: artifact.version.id})));
    expect(await (await fetchVersion(running(), artifact.links.version)).text()).toBe(content);
  });

  test("FLD-003-F: version, project and replay guards refuse mismatched placement", async () => {
    const folder = await createFolder("Reports");
    const otherProject = await createProject();
    const foreign = await createFolder("Reports", null, undefined, otherProject);
    const artifact = await publish();
    const newVersion = await publishVersion(running(), installation, {
      artifactId: artifact.artifact.id, expectedCurrentVersionId: artifact.version.id,
      content: "Second version", idempotencyKey: randomUUID(), projectId: defaultProject,
    });
    const key = "same-artifact-move-test-key";
    const route = routeFor(artifact);
    const stale = await request(`${route}/move?projectId=${defaultProject}`, "POST", {toFolderId: folder.id, expectedCurrentVersionId: artifact.version.id}, key);
    expect(stale.status).toBe(409);
    await expect(stale.json()).resolves.toMatchObject({error: {code: "PUBLISH_CONFLICT", currentVersionId: newVersion.body.version.id}});
    const expectedCurrentVersionId = newVersion.body.version.id;
    await expectFailure(await request(`${route}/move?projectId=${defaultProject}`, "POST", {toFolderId: foreign.id, expectedCurrentVersionId}), 404, "FOLDER_NOT_FOUND");
    const deleted = await createFolder("Removed");
    expect((await request(`${foldersPath}/${deleted.id}?expectedRevision=1`, "DELETE")).ok).toBe(true);
    await expectFailure(await request(`${route}/move?projectId=${defaultProject}`, "POST", {toFolderId: deleted.id, expectedCurrentVersionId}), 404, "FOLDER_NOT_FOUND");
    const first = await (await request(`${route}/move?projectId=${defaultProject}`, "POST", {toFolderId: folder.id, expectedCurrentVersionId}, key)).json();
    expect((await request(`${route}/move?projectId=${defaultProject}`, "POST", {toFolderId: null, expectedCurrentVersionId})).ok).toBe(true);
    expect(await (await request(`${route}/move?projectId=${defaultProject}`, "POST", {toFolderId: folder.id, expectedCurrentVersionId}, key)).json()).toEqual(first);
    await expectFailure(await request(`${route}/move?projectId=${defaultProject}`, "POST", {toFolderId: null, expectedCurrentVersionId}, key), 409, "IDEMPOTENCY_CONFLICT");
    expect((await list("root")).artifacts).toMatchObject([{artifact: {id: artifact.artifact.id, folderId: null}}]);
  });

  test("FLD-006-B: schema 12 backfill preserves publication, comments, source binding and tombstone records", async () => {
    const artifact = await publish();
    await addComment(artifact);
    const removed = await publish();
    expect((await request(routeFor(removed), "DELETE", {expectedCurrentVersionId: removed.version.id})).ok).toBe(true);
    await linkFile();
    const markdown = await publishNew(running(), installation, {
      accessSetting: "account_required", content: "# Markdown", path: "readme.md",
      idempotencyKey: randomUUID(), mediaType: "application/octet-stream",
    });
    await stop();
    readDatabase(downgradeToSchemaTwelve);
    const original = migrationSnapshot();
    server = await startTestServer(installation);
    expect(migrationSnapshot()).toEqual(original);
    expect(readDatabase((db) => db.prepare("SELECT folder_id, file_kind, current_size FROM artifacts WHERE id = ?")
      .get(markdown.body.artifact.id))).toEqual({folder_id: null, file_kind: "markdown", current_size: 10});
    expect(readDatabase((db) => db.prepare("SELECT folder_id, file_kind, current_size, current_version_created_at FROM artifacts WHERE id = ?")
      .get(artifact.artifact.id))).toEqual({folder_id: null, file_kind: "html", current_size: Buffer.byteLength(content), current_version_created_at: artifact.version.createdAt});
    expect(await (await fetchVersion(running(), artifact.links.version)).text()).toBe(content);
    await stop();
    server = await startTestServer(installation);
    expect(migrationSnapshot()).toEqual(original);
  });

  test("FLD-006-F: an interrupted schema transaction rolls back and SQLite refuses newer revisions", async () => {
    const artifact = await publish();
    await stop();
    readDatabase((db) => {
      downgradeToSchemaTwelve(db);
      db.exec(`CREATE TRIGGER fail_backfill BEFORE UPDATE ON artifacts
        BEGIN SELECT RAISE(ABORT, 'fixture interrupts backfill'); END;`);
    });
    expect(() => new SqliteArtifactRepository(databasePath())).toThrow("fixture interrupts backfill");
    readDatabase((db) => {
      expect(db.prepare("PRAGMA user_version").get()).toMatchObject({user_version: 12});
      expect(db.prepare("SELECT name FROM sqlite_schema WHERE name IN ('folders', 'folder_actions')").all()).toEqual([]);
      expect(db.prepare("SELECT current_version_id FROM artifacts WHERE id = ?").get(artifact.artifact.id))
        .toMatchObject({current_version_id: artifact.version.id});
      db.exec("DROP TRIGGER fail_backfill");
    });
    server = await startTestServer(installation);
    expect((await list("root")).artifacts).toMatchObject([{artifact: {id: artifact.artifact.id}}]);
    await stop();
    const newer = requiredSqliteSchemaVersion + 1;
    readDatabase((db) => db.exec(`PRAGMA user_version = ${newer}`));
    expect(() => new SqliteArtifactRepository(databasePath())).toThrow(/newer schema/u);
    expect(readDatabase((db) => db.prepare("PRAGMA user_version").get())).toMatchObject({user_version: newer});
  });

  test("FLD-007-B: phase-one HTTP, MCP and CLI share folder and placement records", async () => {
    expect((await tool("artifact_capabilities", {})).structuredContent).toMatchObject({folders: {available: true}});
    expect(await (await request("/api/v1/session")).json()).toMatchObject({capabilities: {folders: true}});
    const artifact = await publish();
    const id = `fld_${randomUUID()}`;
    const created = await tool("folder_create", {id, name: "Reports"});
    expect(created.isError).not.toBe(true);
    const {folder} = folderResult.parse(created.structuredContent);
    const overHttp = await createFolder("Reports", null, id);
    expect(overHttp).toEqual(folder);
    const tokenFile = path.join(installation.dataDirectory, "fixture.key");
    await writeFile(tokenFile, installation.apiToken, {mode: 0o600});
    const move = await cli(tokenFile, "mv", artifact.artifact.id, id, "--expected-current-version", artifact.version.id);
    expect(move).toMatchObject({artifact: {id: artifact.artifact.id, folderId: id}});
    const rename = await tool("artifact_rename", {
      artifactId: artifact.artifact.id, expectedCurrentVersionId: artifact.version.id,
      name: "Updated", idempotencyKey: randomUUID(),
    });
    expect(rename.isError).not.toBe(true);
    expect(rename.structuredContent).toMatchObject({artifact: {id: artifact.artifact.id, name: "Updated"}});
    const http = await request(`${foldersPath}/${id}`).then((response) => response.json());
    expect((await tool("folder_list", {folderId: id})).structuredContent).toEqual(http);
    expect(await cli(tokenFile, "ls", id)).toEqual(http);
    expect(await cli(tokenFile, "ls", "Ｒｅｐｏｒｔｓ")).toEqual(http);
    expect(actionsResult.parse(await (await request(`${routeFor(artifact)}/actions`)).json()).actions)
      .toEqual(expect.arrayContaining([expect.objectContaining({action: "move"}), expect.objectContaining({action: "rename"})]));
  }, 45_000);

  test("FLD-007-F: a private-team deployment advertises absent folders and answers stable failures", async () => {
    await createFolder("Read-only fixture");
    const cookies = await signInAdministrator(running(), installation);
    const readKey = await issueApiKey(running(), cookies, ["artifact:read"], "Read folders");
    const denied = await fetch(`${running().baseUrl}${foldersPath}`, {
      method: "POST",
      body: JSON.stringify({name: "Denied"}),
      headers: {
        Authorization: `Bearer ${readKey}`,
        "Content-Type": "application/json",
        "Idempotency-Key": randomUUID(),
      },
    });
    await expectFailure(denied, 403, "AUTHORIZATION_DENIED");
    expect((await tool("folder_list", {}, readKey)).isError).not.toBe(true);
    expect(await tool("folder_create", {id: `fld_${randomUUID()}`, name: "Denied"}, readKey)).toMatchObject({
      isError: true, structuredContent: {error: {code: "AUTHORIZATION_DENIED"}},
    });
    await stop();
    await removeTestInstallation(installation);
    installation = await createTestInstallation();
    const provider = await startStubOidcProvider({clientId: "folders-capability-test"});
    try {
      const port = await reserveLoopbackPort();
      const applicationOrigin = `http://127.0.0.1:${port}`;
      server = await startTestServer(installation, {
        port,
        applicationOrigin,
        browserAccess: privateTeamBrowserAccess(browserLoginKinds.oidc),
        interactiveIdentityProvider: new OidcIdentityProvider({
          clientId: provider.clientId, clientSecret: null, issuer: provider.issuer,
          redirectUri: `${applicationOrigin}/auth/callback`, scopes: "openid email profile",
        }),
      });
    } finally {
      await provider.stop();
    }
    expect(await (await request("/api/v1/session")).json()).toMatchObject({capabilities: {folders: false}});
    expect((await tool("artifact_capabilities", {})).structuredContent).toMatchObject({folders: {available: false}});
    await expectFailure(await request(`${foldersPath}/root`), 501, "CAPABILITY_UNAVAILABLE");
    await expectFailure(await request(foldersPath, "POST", {name: "No folder"}), 501, "CAPABILITY_UNAVAILABLE");
    const tokenFile = path.join(installation.dataDirectory, "team-fixture.key");
    await writeFile(tokenFile, installation.apiToken, {mode: 0o600});
    await expect(cli(tokenFile, "ls")).rejects.toMatchObject({
      stderr: expect.stringContaining("CAPABILITY_UNAVAILABLE"),
    });
    expect(await tool("folder_create", {id: `fld_${randomUUID()}`, name: "No folder"})).toMatchObject({
      isError: true, structuredContent: {error: {code: "CAPABILITY_UNAVAILABLE"}},
    });
    const artifact = await publish();
    const deletion = await request(routeFor(artifact), "DELETE", {expectedCurrentVersionId: artifact.version.id});
    expect(deletion.ok).toBe(true);
    await expect(deletion.json()).resolves.toMatchObject({recoverable: false});
    expect((await request(routeFor(artifact))).status).toBe(404);
  }, 30_000);

  test("FLD-008-B: restoring a stopped compact directory preserves nested placement and immutable bytes", async () => {
    const parent = await createFolder("Reports");
    const nested = await createFolder("Final", parent.id);
    const artifact = await publish();
    await place(artifact, nested.id);
    const folderBefore = await list(nested.id);
    const before = dbSnapshot(["folders", "folder_actions", "actions", "versions"]);
    await stop();
    const restore = await createTestInstallation();
    try {
      await cp(installation.dataDirectory, restore.dataDirectory, {recursive: true});
      const report = await Effect.runPromise(checkCompactIntegrity(restore.dataDirectory));
      expect(report.problems).toEqual([]);
      const restored = await startTestServer(restore);
      try {
        const response = await fetch(`${restored.baseUrl}${foldersPath}/${nested.id}`, {headers: apiHeaders(restore, randomUUID())});
        const decoded = folderPage.parse(await response.json());
        expect(decoded).toEqual(folderBefore);
        const restoredVersion = new URL(artifact.links.version);
        restoredVersion.port = String(restored.port);
        expect(await (await fetchVersion(restored, restoredVersion.toString())).text()).toBe(content);
        const database = new DatabaseSync(path.join(restore.dataDirectory, "artifact-server.db"), {readOnly: true});
        try {
          expect(snapshot(database, ["folders", "folder_actions", "actions", "versions"])).toEqual(before);
        } finally {
          database.close();
        }
      } finally {
        await restored.stop();
      }
    } finally {
      await removeTestInstallation(restore);
    }
  });

  test("FLD-008-F: integrity reports folder cycles, duplicate siblings, and foreign placement and child scope", async () => {
    const parent = await createFolder("Reports");
    const child = await createFolder("Final", parent.id);
    const duplicate = await createFolder("Other", parent.id);
    const other = await createProject();
    const foreign = await createFolder("Foreign", null, undefined, other);
    const artifact = await publish();
    await addComment(artifact);
    await stop();
    readDatabase((db) => {
      db.prepare("UPDATE folders SET parent_folder_id = ? WHERE id = ?").run(child.id, parent.id);
      db.prepare("UPDATE folders SET name = ? WHERE id = ?").run("Ｆｉｎａｌ", duplicate.id);
      db.prepare("UPDATE artifacts SET folder_id = ? WHERE id = ?").run(foreign.id, artifact.artifact.id);
      db.prepare("UPDATE comment_threads SET project_id = ? WHERE artifact_id = ?").run(other, artifact.artifact.id);
    });
    const report = await Effect.runPromise(checkCompactIntegrity(installation.dataDirectory));
    expect(report.problems).toEqual(expect.arrayContaining([
      expect.objectContaining({code: "folder_cycle", folderId: parent.id}),
      expect.objectContaining({code: "folder_duplicate_name"}),
      expect.objectContaining({code: "folder_placement_mismatch", artifactId: artifact.artifact.id}),
      expect.objectContaining({code: "project_scope_mismatch", artifactId: artifact.artifact.id}),
    ]));
  });

  function running(): RunningTestServer {
    if (server === null) throw new Error("Start the fixture server first.");
    return server;
  }

  async function stop(): Promise<void> {
    await running().stop();
    server = null;
  }

  function databasePath(): string {
    return path.join(installation.dataDirectory, "artifact-server.db");
  }

  function readDatabase<Result>(operation: (database: DatabaseSync) => Result): Result {
    const database = new DatabaseSync(databasePath());
    try {
      return operation(database);
    } finally {
      database.close();
    }
  }

  function dbSnapshot(tables: readonly string[]) {
    return readDatabase((database) => snapshot(database, tables));
  }

  function migrationSnapshot() {
    return readDatabase((database) => ({
      ...snapshot(database, ["versions", "manifest_entries", "comment_threads", "artifact_tags", "actions"]),
      artifacts: database.prepare(`
        SELECT id, project_id, name, access_setting, current_version_id, created_at, deleted_at,
          source_path, source_fingerprint, source_status, source_verified_at
        FROM artifacts ORDER BY id
      `).all(),
    }));
  }

  async function request(route: string, method = "GET", body?: Json, key: string = randomUUID()) {
    const init: RequestInit = {headers: apiHeaders(installation, key), method};
    if (body !== undefined) init.body = JSON.stringify(body);
    return fetch(`${running().baseUrl}${route}`, init);
  }

  async function createProject(): Promise<string> {
    return projectResult.parse(await (await request("/api/v1/projects", "POST", {name: "Second project"})).json()).project.id;
  }

  async function createFolder(name: string, parentFolderId: string | null = null, id?: string, projectId = defaultProject) {
    const input: z.input<typeof folderCreateTestSchema> = {name, parentFolderId};
    if (id !== undefined) input.id = id;
    const body = folderCreateTestSchema.parse(input);
    const response = await request(`/api/v1/projects/${projectId}/folders`, "POST", body);
    expect(response.status).toBe(201);
    return folderResult.parse(await response.json()).folder;
  }

  async function updateFolder(id: string, body: Json, key: string = randomUUID()) {
    const response = await request(`${foldersPath}/${id}`, "PATCH", body, key);
    expect(response.status).toBe(200);
    return folderResult.parse(await response.json()).folder;
  }

  async function list(folder: string) {
    const response = await request(`${foldersPath}/${folder}`);
    expect(response.status).toBe(200);
    return folderPage.parse(await response.json());
  }

  async function publish(): Promise<PublishResponse> {
    const result = await publishNew(running(), installation, {
      accessSetting: "public_link", content, name: "Fixture", idempotencyKey: randomUUID(), projectId: defaultProject,
    });
    expect(result.response.status).toBe(201);
    return result.body;
  }

  async function linkFile() {
    const sourcePath = path.join(source.dataDirectory, "linked.html");
    await writeFile(sourcePath, content);
    const response = await request("/api/v1/artifacts/link", "POST", {path: sourcePath, projectId: defaultProject});
    expect(response.status).toBe(201);
    return {artifact: parsePublishResponse(await response.json()), path: sourcePath};
  }

  async function place(artifact: PublishResponse, toFolderId: string) {
    const result = await request(`${routeFor(artifact)}/move?projectId=${artifact.artifact.projectId}`, "POST", {toFolderId, expectedCurrentVersionId: artifact.version.id});
    expect(result.status).toBe(200);
  }

  async function addComment(artifact: PublishResponse) {
    const response = await request(`${routeFor(artifact)}/versions/${artifact.version.id}/comments?projectId=${artifact.artifact.projectId}`, "POST", {body: "Review the saved bytes."});
    expect(response.status).toBe(201);
  }

  async function cli(tokenFile: string, ...args: readonly string[]): Promise<Json> {
    const {stdout} = await run(process.execPath, [
      "--import", "tsx", "src/cli/main.ts", ...args, "--server", running().baseUrl, "--token-file", tokenFile,
    ]);
    return z.json().parse(JSON.parse(stdout));
  }

  async function tool(name: string, args: Json, token = installation.apiToken) {
    const protocol = "2026-07-28";
    const response = await fetch(`${running().baseUrl}/mcp`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        "MCP-Protocol-Version": protocol,
        "Mcp-Method": "tools/call",
        "Mcp-Name": name,
      },
      body: JSON.stringify({
        id: randomUUID(), jsonrpc: "2.0", method: "tools/call",
        params: {
          name, arguments: args,
          _meta: {
            [CLIENT_CAPABILITIES_META_KEY]: {},
            [CLIENT_INFO_META_KEY]: {name: "folder-tests", version: "1"},
            [PROTOCOL_VERSION_META_KEY]: protocol,
          },
        },
      }),
    });
    expect(response.status).toBe(200);
    return toolEnvelope.parse(await response.json()).result;
  }
});

const folderCreateTestSchema = z.object({
  id: z.string().optional(),
  name: z.string(),
  parentFolderId: z.string().nullable(),
}).transform(({id, ...input}) => id === undefined ? input : {...input, id});

function routeFor(artifact: PublishResponse): string {
  return `/api/v1/artifacts/${artifact.artifact.id}`;
}

function rootPageQuery(cursor: string | null): string {
  const query = new URLSearchParams({limit: "1", foldersOnly: "true"});
  if (cursor !== null && cursor !== "") query.set("cursor", cursor);
  return `root?${query}`;
}

function snapshot(database: DatabaseSync, tables: readonly string[]) {
  return Object.fromEntries(tables.map((table) => [table, database.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()]));
}

async function expectFailure(response: Response, status: number, code: string): Promise<void> {
  expect(response.status).toBe(status);
  await expect(response.json()).resolves.toMatchObject({error: {code}});
}
