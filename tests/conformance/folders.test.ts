import {execFile} from "node:child_process";
import {randomUUID} from "node:crypto";
import {cp, mkdir, readFile, realpath, writeFile} from "node:fs/promises";
import path from "node:path";
import {DatabaseSync} from "node:sqlite";
import {promisify} from "node:util";

import {
  CLIENT_CAPABILITIES_META_KEY, CLIENT_INFO_META_KEY, PROTOCOL_VERSION_META_KEY,
} from "@modelcontextprotocol/server";
import {Effect, Redacted} from "effect";
import {afterEach, beforeEach, describe, expect, test} from "vitest";
import {z} from "zod";

import {browserLoginKinds, privateTeamBrowserAccess} from "../../src/core/browser-access.js";
import {OidcIdentityProvider} from "../../src/identity/oidc-identity-provider.js";
import {
  defaultGitHistoryFileCopyBytes, defaultGitHistoryVersionCopyBytes,
} from "../../src/git-history/git-history-capability.js";
import type {NodeGitHistoryConfiguration} from "../../src/git-history/node-git-history-configuration.js";
import {checkCompactIntegrity} from "../../src/lifecycle/integrity-check.js";
import {SqliteArtifactRepository} from "../../src/storage/sqlite-artifact-repository.js";
import {fileCatalogSqliteIndexes} from "../../src/storage/sqlite-file-catalog-schema.js";
import {requiredSqliteSchemaVersion} from "../../src/storage/sqlite-schema.js";
import {parsePublishResponse, publishNew, publishVersion, type PublishResponse} from "../support/publishing.js";
import {
  apiHeaders, createTestInstallation, fetchVersion, removeTestInstallation, reserveLoopbackPort,
  startTestServer, type RunningTestServer, type TestInstallation,
} from "../support/runtime-harness.js";
import {startStubOidcProvider} from "../support/stub-oidc-provider.js";
import {
  ApiClient, dispatchCreationSchema, dispatchEnvelopeSchema, issueApiKey, signInAdministrator,
} from "../support/agent-dispatch.js";
import {RecordingGitHistoryProvider} from "../support/git-history-provider.js";
import {LinkedFolderClient, waitFor} from "../support/linked-folders.js";
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
const filePage = z.object({items: z.array(idSchema.loose()), nextCursor: z.string().nullable()}).loose();
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

  test("FLD-004-B: artifacts and folder subtrees change project with identical identities, links and child scope", async () => {
    const destination = await createProject();
    const inbox = await createFolder("Inbox", null, undefined, destination);
    const reports = await createFolder("Reports");
    const nested = await createFolder("2026", reports.id);
    const single = await publish();
    const contained = await publish();
    const overMcp = await publish();
    await place(contained, nested.id);
    const linked = await linkFile();
    await place(linked.artifact, nested.id);
    const singleThread = await addComment(single);
    await addComment(contained);
    const reply = await request(`${routeFor(single)}/comments/${singleThread}/replies?projectId=${defaultProject}`, "POST", {body: "Still applies."});
    expect(reply.status).toBe(201);
    const moving = [single, contained, linked.artifact, overMcp].map(({artifact}) => artifact.id);
    const identities = () => readDatabase((db) => ({
      versions: db.prepare(`SELECT id, artifact_id, number, content_token, manifest_digest FROM versions
        WHERE artifact_id IN (SELECT value FROM json_each(?)) ORDER BY id`).all(JSON.stringify(moving)),
      threads: db.prepare(`SELECT id, artifact_id, version_id, body FROM comment_threads
        WHERE artifact_id IN (SELECT value FROM json_each(?)) ORDER BY id`).all(JSON.stringify(moving)),
      replies: db.prepare("SELECT id, thread_id, body FROM comment_replies ORDER BY id").all(),
      blobs: db.prepare(`SELECT version_id, path, sha256 FROM manifest_entries
        WHERE version_id IN (SELECT id FROM versions WHERE artifact_id IN (SELECT value FROM json_each(?)))
        ORDER BY version_id, path`).all(JSON.stringify(moving)),
    }));
    const before = identities();
    const bindingBefore = await artifactJson(linked.artifact.artifact.id, defaultProject);

    const key = "cross-project-artifact-move-key";
    const body = {toProjectId: destination, toFolderId: inbox.id, expectedCurrentVersionId: single.version.id};
    const moved = await request(`${routeFor(single)}/move?projectId=${defaultProject}`, "POST", body, key);
    expect(moved.status).toBe(200);
    const movedBody = await moved.json();
    expect(movedBody).toEqual({artifact: {
      id: single.artifact.id, projectId: destination, folderId: inbox.id, name: "Fixture",
      currentVersionId: single.version.id,
    }});
    expect(await (await request(`${routeFor(single)}/move?projectId=${defaultProject}`, "POST", body, key)).json()).toEqual(movedBody);
    const folderMove = await request(`${foldersPath}/${reports.id}/move-to-project`, "POST", {
      toProjectId: destination, toParentFolderId: inbox.id, expectedRevision: 1,
    });
    expect(folderMove.status).toBe(200);
    expect(folderResult.parse(await folderMove.json()).folder).toEqual({
      id: reports.id, name: "Reports", parentFolderId: inbox.id, revision: 2,
    });
    const mcpMove = await tool("artifact_move", {
      artifactId: overMcp.artifact.id, projectId: defaultProject, toProjectId: destination, toFolderId: null,
      expectedCurrentVersionId: overMcp.version.id, idempotencyKey: randomUUID(),
    });
    expect(mcpMove.isError).not.toBe(true);
    expect(mcpMove.structuredContent).toMatchObject({artifact: {id: overMcp.artifact.id, projectId: destination, folderId: null}});
    const cliFolder = await createFolder("Shared");
    const tokenFile = path.join(installation.dataDirectory, "move-fixture.key");
    await writeFile(tokenFile, installation.apiToken, {mode: 0o600});
    expect(await cli(tokenFile, "mv", cliFolder.id, "root", "--project", defaultProject, "--to-project", destination,
      "--expected-revision", "1")).toMatchObject({folder: {id: cliFolder.id, projectId: destination, parentFolderId: null}});

    expect(identities()).toEqual(before);
    expect(readDatabase((db) => ["artifacts", "versions", "actions", "comment_threads"].map((table) =>
      db.prepare(`SELECT DISTINCT project_id FROM ${table} WHERE ${table === "artifacts" ? "id" : "artifact_id"}
        IN (SELECT value FROM json_each(?))`).all(JSON.stringify(moving))))).toEqual(
      Array.from({length: 4}, () => [{project_id: destination}]),
    );
    expect(readDatabase((db) => db.prepare("SELECT DISTINCT project_id FROM comment_replies").all()))
      .toEqual([{project_id: destination}]);
    expect(readDatabase((db) => db.prepare("SELECT id, project_id FROM folders WHERE id IN (?, ?) ORDER BY id")
      .all(reports.id, nested.id))).toEqual([reports.id, nested.id].toSorted().map((id) => ({id, project_id: destination})));
    expect((await request(`${routeFor(contained)}?projectId=${defaultProject}`)).status).toBe(404);
    const destinationFolder = await request(`/api/v1/projects/${destination}/folders/${nested.id}`);
    expect(folderPage.parse(await destinationFolder.json())).toMatchObject({
      breadcrumbs: [inbox, {id: reports.id}, nested].map(({id}) => expect.objectContaining({id})),
      artifacts: expect.arrayContaining([contained, linked.artifact].map(({artifact}) =>
        ({artifact: expect.objectContaining({id: artifact.id, folderId: nested.id})}))),
    });
    expect((await artifactJson(linked.artifact.artifact.id, destination)).sourceBinding).toEqual(bindingBefore.sourceBinding);
    const threads = await request(`${routeFor(single)}/comments?projectId=${destination}`);
    expect(z.object({items: z.array(idSchema)}).parse(await threads.json()).items.map(({id}) => id)).toEqual([singleThread]);
    expect((await fetch(single.links.artifact, {redirect: "manual"})).status).toBe(302);
    expect(await (await fetchVersion(running(), contained.links.version)).text()).toBe(content);
    const {actions} = actionsResult.parse(await (await request(`${routeFor(single)}/actions?projectId=${destination}`)).json());
    expect(actions).toEqual(expect.arrayContaining([expect.objectContaining({action: "move", versionId: single.version.id})]));
    expect(readDatabase((db) => db.prepare("SELECT project_id, action FROM folder_actions WHERE folder_id = ? ORDER BY rowid")
      .all(reports.id))).toEqual([{project_id: defaultProject, action: "create"}, {project_id: destination, action: "move"}]);
    const location = await request(`/api/v1/artifacts/${contained.artifact.id}/location`);
    expect(await location.json()).toEqual({location: {artifactId: contained.artifact.id, projectId: destination, folderId: nested.id}});
    expect(await tool("artifact_get", {artifactId: contained.artifact.id, projectId: defaultProject})).toMatchObject({
      isError: true,
      structuredContent: {error: {code: "ARTIFACT_NOT_FOUND", location: {projectId: destination, folderId: nested.id}}},
    });
    await stop();
    readDatabase((db) => {
      expect(() => db.prepare("UPDATE versions SET project_id = ? WHERE artifact_id = ?").run(defaultProject, single.artifact.id))
        .toThrow("version project cannot change");
      expect(() => db.prepare("UPDATE artifacts SET project_id = ? WHERE id = ?").run(defaultProject, single.artifact.id))
        .toThrow("artifact project cannot change");
    });
    expect((await Effect.runPromise(checkCompactIntegrity(installation.dataDirectory))).problems).toEqual([]);
  }, 45_000);

  test("FLD-004-F: held dispatches, archived projects, Git history, oversized subtrees and foreign readers change and disclose nothing", async () => {
    await stop();
    const provider = new RecordingGitHistoryProvider();
    server = await startTestServer(installation, {
      gitHistory: gitHistoryConfiguration(),
      gitHistoryHealthProbe: {check: () => Effect.succeed({state: "available"})},
      gitHistoryProvider: provider,
    });
    const destination = await createProject();
    const publishKey = "cross-project-pre-move-publish";
    const artifact = (await publishNew(running(), installation, {
      accessSetting: "account_required", content, name: "Held", idempotencyKey: publishKey, projectId: defaultProject,
    })).body;
    const tables = [
      "artifacts", "versions", "actions", "comment_threads", "comment_replies", "folders",
      "folder_actions", "idempotency_records", "agent_dispatches",
    ];
    const move = (subject: PublishResponse) => request(`${routeFor(subject)}/move?projectId=${defaultProject}`, "POST", {
      toProjectId: destination, toFolderId: null, expectedCurrentVersionId: subject.version.id,
    });
    const refused = async (attempt: () => Promise<Response>, code: string) => {
      const before = dbSnapshot(tables);
      await expectFailure(await attempt(), 409, code);
      expect(dbSnapshot(tables)).toEqual(before);
    };

    const client = new ApiClient(running(), installation.apiToken);
    const agent = await client.registerAgent({
      connectionKey: "cross-project-move-agent", displayName: "move worker", workingDirectory: "/work/move",
    });
    const thread = (await client.openThread(artifact, "Hold this artifact.", "cross-project-held-thread")).id;
    const sent = await client.sendDispatch({
      agentId: agent.id, idempotencyKey: "cross-project-held-send", projectId: defaultProject, threadIds: [thread],
    });
    expect(sent.status).toBe(201);
    const dispatchId = dispatchCreationSchema.parse(await sent.json()).dispatch.id;
    await refused(() => move(artifact), "DISPATCH_HELD");
    expect((await client.claim(agent.id)).status).toBe(200);
    await refused(() => move(artifact), "DISPATCH_HELD");
    expect((await client.reportDelivered(dispatchId, agent.id)).status).toBe(200);
    await refused(() => move(artifact), "DISPATCH_HELD");
    expect((await client.setThreadState(artifact, thread, "resolved")).status).toBe(200);
    expect(dispatchEnvelopeSchema.parse(await (await client.getDispatch(dispatchId, defaultProject)).json()).dispatch.state)
      .toBe("addressed");

    const refusedWhileArchived = async (archived: string) => {
      expect((await request(`/api/v1/projects/${archived}/archive`, "POST")).status).toBe(200);
      await refused(() => move(artifact), "PROJECT_ARCHIVED");
      expect((await request(`/api/v1/projects/${archived}/unarchive`, "POST")).status).toBe(200);
    };
    await refusedWhileArchived(destination);
    await refusedWhileArchived(defaultProject);

    const tagKey = "cross-project-pre-move-tags";
    expect((await request(`${routeFor(artifact)}/tags?projectId=${defaultProject}`, "PATCH",
      {tags: ["draft"], expectedCurrentVersionId: artifact.version.id}, tagKey)).status).toBe(200);
    expect((await move(artifact)).status).toBe(200);
    const afterMove = dbSnapshot(tables);
    await expect(publishNew(running(), installation, {
      accessSetting: "account_required", content, name: "Held", idempotencyKey: publishKey, projectId: defaultProject,
    })).rejects.toThrow(/HTTP 404.*ARTIFACT_NOT_FOUND/u);
    await expectFailure(await request(`${routeFor(artifact)}/tags?projectId=${defaultProject}`, "PATCH",
      {tags: ["draft"], expectedCurrentVersionId: artifact.version.id}, tagKey), 404, "ARTIFACT_NOT_FOUND");
    expect(dbSnapshot(tables)).toEqual(afterMove);

    const cookies = await signInAdministrator(running(), installation);
    const publisherKey = await issueApiKey(running(), cookies, ["artifact:create"], "Publisher only");
    const locate = (id: string, token: string) => fetch(`${running().baseUrl}/api/v1/artifacts/${id}/location`, {
      headers: {Authorization: `Bearer ${token}`},
    });
    await expectFailure(await locate(artifact.artifact.id, publisherKey), 404, "ARTIFACT_NOT_FOUND");
    await expectFailure(await locate("art_missing", installation.apiToken), 404, "ARTIFACT_NOT_FOUND");

    const bulk = await createFolder("Bulk");
    const template = await publish();
    // Seed 1,001 complete artifacts directly: publishing them one by one would
    // only measure the upload path, not the bound this test proves.
    readDatabase((db) => db.prepare(`
      WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 1001)
      INSERT INTO artifacts (id, project_id, name, search_name, access_setting, created_at, folder_id)
      SELECT 'bulk-' || i, project_id, name, search_name, access_setting, created_at, ? FROM artifacts, n WHERE id = ?
    `).run(bulk.id, template.artifact.id));
    readDatabase((db) => {
      db.prepare(`
        INSERT INTO versions (
          id, project_id, artifact_id, number, manifest_digest, entry_path, routing_mode, content_token,
          publisher_principal_id, created_at
        ) SELECT 'version-' || artifact.id, version.project_id, artifact.id, 1, version.manifest_digest,
          version.entry_path, version.routing_mode, 'token-' || artifact.id, version.publisher_principal_id, version.created_at
        FROM artifacts artifact, versions version WHERE artifact.id LIKE 'bulk-%' AND version.id = ?
      `).run(template.version.id);
      db.exec("UPDATE artifacts SET current_version_id = 'version-' || id WHERE id LIKE 'bulk-%'");
    });
    await refused(() => request(`${foldersPath}/${bulk.id}/move-to-project`, "POST", {
      toProjectId: destination, toParentFolderId: null, expectedRevision: 1,
    }), "MOVE_TOO_LARGE");

    const mirrored = await publish();
    await waitForGitHistoryAvailable();
    const gitHistory = (projectId: string, enabled: boolean) => request(`/api/v1/projects/${projectId}/git-history`, "PUT",
      enabled ? {confirmEstimate: true, enabled} : {enabled});
    expect((await gitHistory(destination, true)).status).toBe(200);
    await refused(() => move(mirrored), "GIT_HISTORY_ENABLED");
    expect((await gitHistory(destination, false)).status).toBe(200);
    expect((await gitHistory(defaultProject, true)).status).toBe(200);
    await expect.poll(() => provider.commits.get(mirrored.artifact.id)?.has(mirrored.version.id), {timeout: 15_000}).toBe(true);
    expect((await gitHistory(defaultProject, false)).status).toBe(200);
    await refused(() => move(mirrored), "GIT_HISTORY_ENABLED");
  }, 60_000);

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

  test("FLD-007-B: HTTP, MCP and the CLI share folder, move, trash, overview, batch and linked-folder records", async () => {
    const surfaces = ["folders", "crossProjectMove", "trash", "fileOverview", "batch", "linkedFolders"] as const;
    const advertised = z.object(Object.fromEntries(surfaces.map((name) => [name, z.object({available: z.boolean()}).loose()])))
      .loose().parse((await tool("artifact_capabilities", {})).structuredContent);
    expect(surfaces.map((name) => advertised[name]?.available)).toEqual(surfaces.map(() => true));
    expect(await (await request("/api/v1/session")).json()).toMatchObject({
      capabilities: Object.fromEntries(surfaces.map((name) => [name, true])),
    });
    const tokenFile = path.join(installation.dataDirectory, "fixture.key");
    await writeFile(tokenFile, installation.apiToken, {mode: 0o600});
    const artifact = await publish();
    const traveller = await publish();

    // Create a folder over MCP, replay it over HTTP, move over the CLI, rename over MCP.
    const id = `fld_${randomUUID()}`;
    const created = await tool("folder_create", {id, name: "Reports"});
    expect(created.isError).not.toBe(true);
    const {folder} = folderResult.parse(created.structuredContent);
    expect(await createFolder("Reports", null, id)).toEqual(folder);
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

    // Cross-project move over MCP is visible to HTTP and the CLI file overview.
    const other = await createProject();
    const travelled = await tool("artifact_move", {
      artifactId: traveller.artifact.id, projectId: defaultProject, toProjectId: other, toFolderId: null,
      expectedCurrentVersionId: traveller.version.id, idempotencyKey: randomUUID(),
    });
    expect(travelled.structuredContent).toMatchObject({artifact: {id: traveller.artifact.id, projectId: other}});
    expect(await (await request(`/api/v1/artifacts/${traveller.artifact.id}/location`)).json())
      .toMatchObject({location: {projectId: other, folderId: null}});
    const filesOverHttp = filePage.parse(await (await request(`/api/v1/files?projectId=${other}`)).json());
    expect(filesOverHttp.items.map(({id: fileId}) => fileId)).toEqual([traveller.artifact.id]);
    expect(filePage.parse((await tool("file_search", {projectIds: [other], includeFacets: false})).structuredContent).items)
      .toEqual(filesOverHttp.items);
    expect(filePage.parse(await cli(tokenFile, "files", "--project", other)).items).toEqual(filesOverHttp.items);

    // Batch over HTTP replays identically over MCP and the CLI.
    const items = [{kind: "artifact", projectId: defaultProject, artifactId: artifact.artifact.id,
      expectedCurrentVersionId: artifact.version.id}];
    const batchBody = {operation: "tag-add", items, params: {tags: ["parity"]}, idempotencyKey: randomUUID()};
    const batched = await (await request("/api/v1/batch", "POST", batchBody)).json();
    expect(batched).toMatchObject({operation: "tag-add", results: [{status: "ok"}]});
    // A replay returns the same per-item results, marked as replayed.
    const replayed = z.json().parse(JSON.parse(JSON.stringify(batched).replaceAll('"replayed":false', '"replayed":true')));
    expect((await tool("batch_apply", batchBody)).structuredContent).toEqual(replayed);
    const itemsFile = path.join(installation.dataDirectory, "batch-items.json");
    await writeFile(itemsFile, JSON.stringify(items));
    expect(await cli(tokenFile, "batch", "tag-add", "--items", itemsFile, "--tag", "parity",
      "--idempotency-key", batchBody.idempotencyKey)).toEqual(replayed);
    expect(filePage.parse((await tool("file_search", {tags: ["parity"], includeFacets: false})).structuredContent).items
      .map(({id: fileId}) => fileId)).toEqual([artifact.artifact.id]);

    // Trash over HTTP and the CLI, list over all three, recover over MCP and HTTP.
    const scoped = `?projectId=${defaultProject}`;
    const trashed = await request(`${routeFor(artifact)}${scoped}`, "DELETE", {expectedCurrentVersionId: artifact.version.id});
    expect(await trashed.json()).toMatchObject({recoverable: true});
    const folderRevision = z.object({breadcrumbs: z.array(folderSchema)})
      .parse(await (await request(`${foldersPath}/${id}`)).json()).breadcrumbs.at(-1)?.revision;
    expect(await cli(tokenFile, "rm", "-r", id, "--project", defaultProject, "--expected-revision", String(folderRevision)))
      .toMatchObject({folder: {id}});
    const trashOverHttp = await (await request("/api/v1/trash")).json();
    expect(trashOverHttp).toMatchObject({items: expect.arrayContaining([
      expect.objectContaining({id: artifact.artifact.id}), expect.objectContaining({id}),
    ])});
    expect((await tool("trash_list", {})).structuredContent).toEqual(trashOverHttp);
    expect(await cli(tokenFile, "trash", "ls")).toEqual(trashOverHttp);
    const recovered = await tool("artifact_recover", {
      artifactId: artifact.artifact.id, projectId: defaultProject, idempotencyKey: randomUUID(),
    });
    expect(recovered.structuredContent).toMatchObject({artifact: {id: artifact.artifact.id}});
    expect((await request(`${foldersPath}/${id}/recover`, "POST", {})).status).toBe(200);
    expect(await (await request("/api/v1/trash")).json()).toMatchObject({items: []});
    expect(actionsResult.parse(await (await request(`${routeFor(artifact)}/actions${scoped}`)).json()).actions.map(({action}) => action))
      .toEqual(expect.arrayContaining(["move", "rename", "change_tags", "delete", "recover"]));

    // Link a directory over MCP; HTTP and the CLI read and rescan the same link and inventory.
    const linkedDirectory = path.join(await realpath(source.dataDirectory), "parity-output");
    await mkdir(linkedDirectory);
    await writeFile(path.join(linkedDirectory, "notes.md"), "# Notes\n");
    const linked = await tool("folder_link", {newFolderName: "Linked output", path: linkedDirectory, projectId: defaultProject});
    expect(linked.isError).not.toBe(true);
    const link = z.object({folderLink: z.object({id: z.string(), folderId: z.string()}).loose()})
      .parse(linked.structuredContent).folderLink;
    const linkOverHttp = await (await request(`/api/v1/folder-links/${link.id}`)).json();
    expect(linkOverHttp).toMatchObject({folderLink: {id: link.id, entryCount: 1, pendingCount: 1}});
    expect(await cli(tokenFile, "link-folder", linkedDirectory, "--scan", "--project", defaultProject))
      .toMatchObject({folderLink: {id: link.id, entryCount: 1, pendingCount: 1}});
    const inventoryOverHttp = await (await request(`/api/v1/folder-links/${link.id}/inventory`)).json();
    expect((await tool("folder_link_inventory", {folderLinkId: link.id})).structuredContent).toEqual(inventoryOverHttp);
    expect((await list("root")).folders.map(({id: folderId}) => folderId)).toContain(link.folderId);
  }, 90_000);

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
    const surfaces = ["folders", "crossProjectMove", "trash", "fileOverview", "batch", "linkedFolders"] as const;
    expect(await (await request("/api/v1/session")).json()).toMatchObject({
      capabilities: Object.fromEntries(surfaces.map((name) => [name, false])),
    });
    expect((await tool("artifact_capabilities", {})).structuredContent).toMatchObject(
      Object.fromEntries(surfaces.map((name) => [name, {available: false}])),
    );
    const artifact = await publish();
    const unavailableRoutes: readonly (readonly [string, string, Json?])[] = [
      [`${foldersPath}/root`, "GET"],
      [foldersPath, "POST", {name: "No folder"}],
      [`${foldersPath}/fld_${randomUUID()}/move-to-project`, "POST", {toProjectId: defaultProject, toParentFolderId: null, expectedRevision: 1}],
      [`${routeFor(artifact)}/move`, "POST", {toFolderId: null, expectedCurrentVersionId: artifact.version.id}],
      [`${routeFor(artifact)}/recover`, "POST"],
      ["/api/v1/trash", "GET"],
      [`/api/v1/files?projectId=${defaultProject}`, "GET"],
      ["/api/v1/files/facets", "GET"],
      ["/api/v1/batch", "POST", {operation: "trash", items: [], params: {}, idempotencyKey: randomUUID()}],
      [`/api/v1/projects/${defaultProject}/folder-links`, "POST", {path: installation.dataDirectory}],
    ];
    for (const [route, method, body] of unavailableRoutes) {
      // Each route is checked on its own so a failure names it.
      // eslint-disable-next-line no-await-in-loop
      await expectFailure(await request(route, method, body), 501, "CAPABILITY_UNAVAILABLE");
    }
    const unavailableTools: readonly (readonly [string, Json])[] = [
      ["folder_create", {id: `fld_${randomUUID()}`, name: "No folder"}],
      ["artifact_move", {artifactId: artifact.artifact.id, toFolderId: null,
        expectedCurrentVersionId: artifact.version.id, idempotencyKey: randomUUID()}],
      ["trash_list", {}],
      ["artifact_recover", {artifactId: artifact.artifact.id, idempotencyKey: randomUUID()}],
      ["file_search", {}],
      ["batch_apply", {operation: "trash", items: [{kind: "artifact", projectId: defaultProject,
        artifactId: artifact.artifact.id, expectedCurrentVersionId: artifact.version.id}], params: {}, idempotencyKey: randomUUID()}],
      ["folder_link", {path: installation.dataDirectory}],
    ];
    for (const [name, args] of unavailableTools) {
      // eslint-disable-next-line no-await-in-loop
      const result = await tool(name, args);
      expect({name, result}).toMatchObject({name, result: {isError: true}});
      expect(JSON.stringify(result.structuredContent)).toContain("CAPABILITY_UNAVAILABLE");
    }
    const tokenFile = path.join(installation.dataDirectory, "team-fixture.key");
    await writeFile(tokenFile, installation.apiToken, {mode: 0o600});
    for (const args of [["ls"], ["files"], ["trash", "ls"]]) {
      // eslint-disable-next-line no-await-in-loop
      await expect(cli(tokenFile, ...args)).rejects.toMatchObject({
        stderr: expect.stringContaining("CAPABILITY_UNAVAILABLE"),
      });
    }
    const deletion = await request(routeFor(artifact), "DELETE", {expectedCurrentVersionId: artifact.version.id});
    expect(deletion.ok).toBe(true);
    await expect(deletion.json()).resolves.toMatchObject({recoverable: false});
    expect((await request(routeFor(artifact))).status).toBe(404);
  }, 30_000);

  test("FLD-008-B: restoring a stopped compact directory preserves folders, trash, moves, and links, and the link waits for a scan", async () => {
    const parent = await createFolder("Reports");
    const nested = await createFolder("Final", parent.id);
    const artifact = await publish();
    await place(artifact, nested.id);
    // A recoverable folder trash group, a purged group, and a recovered artifact.
    const archive = await createFolder("Archive");
    const archived = await publish();
    await place(archived, (await createFolder("Old", archive.id)).id);
    expect((await request(`${foldersPath}/${archive.id}?expectedRevision=1`, "DELETE")).ok).toBe(true);
    const doomed = await createFolder("Doomed");
    await place(await publish(), doomed.id);
    expect((await request(`${foldersPath}/${doomed.id}?expectedRevision=1`, "DELETE")).ok).toBe(true);
    await purgeFolder(doomed.id, "Doomed");
    const returned = await publish();
    await trashArtifact(returned);
    expect((await request(`${routeFor(returned)}/recover`, "POST")).status).toBe(200);
    // A recorded cross-project move leaves request-scoped records in the source project.
    const destination = await createProject();
    const traveller = await publish();
    expect((await request(`${routeFor(traveller)}/move?projectId=${defaultProject}`, "POST", {
      toProjectId: destination, toFolderId: null, expectedCurrentVersionId: traveller.version.id,
    })).status).toBe(200);
    // A folder link with one captured entry and a live-preview grant on the other.
    const linked = await linkDirectory("restored-output", ["a.md", "b.md"]);
    const [captured] = await linked.client.captureOk(linked.link.id, {entryIds: [linked.entry("a.md").id]});
    expect((await linked.client.request(`/api/v1/folder-links/${linked.link.id}/entries/${linked.entry("b.md").id}/live-sessions`, "POST")).status).toBe(201);
    const surfaces = async () => ({
      folder: await list(nested.id),
      trash: await (await request("/api/v1/trash")).json(),
      files: await Promise.all([defaultProject, destination].map(async (projectId) =>
        filePage.parse(await (await request(`/api/v1/files?projectId=${projectId}`)).json()).items)),
      moved: (await request(`${routeFor(traveller)}?projectId=${destination}`)).status,
      recovered: (await request(`${routeFor(returned)}?projectId=${defaultProject}`)).status,
    });
    const surfacesBefore = await surfaces();
    expect(surfacesBefore).toMatchObject({moved: 200, recovered: 200});
    await stop();
    const before = readDatabase(backupSnapshot);
    expect({
      groups: new Set(before["folders"]?.map((row) => row["trash_group_id"]).filter((group) => group !== null)).size,
      purged: before["artifacts"]?.filter((row) => row["purged_at"] !== null).length,
      links: before["folder_links"]?.length,
      captures: before["folder_link_captures"]?.length,
      grants: before["folder_entry_live_grants"]?.length,
      overviewIndexes: before["overview_indexes"]?.length,
    }).toEqual({groups: 2, purged: 1, links: 1, captures: 1, grants: 1, overviewIndexes: fileCatalogSqliteIndexes.length});

    const restore = await createTestInstallation();
    try {
      await cp(installation.dataDirectory, restore.dataDirectory, {recursive: true});
      expect(withDatabaseAt(restore, backupSnapshot)).toEqual(before);
      const report = await Effect.runPromise(checkCompactIntegrity(restore.dataDirectory));
      expect(report.problems).toEqual([]);

      // Folder links are machine-bound: restored where the directory is not linkable, the link stays unavailable.
      const elsewhere = path.join(await realpath(source.dataDirectory), "elsewhere");
      await mkdir(elsewhere);
      server = await startTestServer(restore, {linkedFiles: "on", linkRoots: [elsewhere]});
      const restoredBytes = new URL(artifact.links.version);
      restoredBytes.port = String(running().port);
      expect(await (await fetchVersion(running(), restoredBytes.toString())).text()).toBe(content);
      expect(await surfaces()).toEqual(surfacesBefore);
      let client = new LinkedFolderClient(running(), restore.apiToken);
      const backedUpScan = before["folder_links"]?.[0]?.["last_scan_started_at"];
      const unavailable = await waitFor(() => client.get(linked.link.id), (current) =>
        current.scanActivity === "idle" && current.lastScanStartedAt !== backedUpScan);
      expect(unavailable.state).toBe("unavailable");
      expect((await client.scan(linked.link.id)).state).toBe("unavailable");
      await stop();

      server = await startTestServer(restore, {linkedFiles: "on", linkRoots: [source.dataDirectory]});
      client = new LinkedFolderClient(running(), restore.apiToken);
      expect(await waitFor(() => client.get(linked.link.id), (current) => current.state === "active"))
        .toMatchObject({entryCount: 2, folderId: linked.link.folderId, path: linked.directory});
      expect((await client.inventory(linked.link.id)).map(({artifactId, relativePath, state}) => ({artifactId, relativePath, state})))
        .toEqual([
          {artifactId: captured?.artifactId, relativePath: "a.md", state: "tracked"},
          {artifactId: null, relativePath: "b.md", state: "untracked"},
        ]);
      await stop();
      const scanned = withDatabaseAt(restore, backupSnapshot);
      for (const table of ["folders", "folder_actions", "actions", "artifacts", "versions", "idempotency_records", "folder_link_captures", "overview_indexes"]) {
        expect({table, rows: scanned[table]}).toEqual({table, rows: before[table]});
      }
      expect((await Effect.runPromise(checkCompactIntegrity(restore.dataDirectory))).problems).toEqual([]);
    } finally {
      if (server !== null) await stop();
      await removeTestInstallation(restore);
    }
  }, 60_000);

  test("FLD-008-F: integrity reports each kind of folder, trash, move, link, and overview corruption with a specific finding", async () => {
    const parent = await createFolder("Reports");
    const child = await createFolder("Final", parent.id);
    const duplicate = await createFolder("Other", parent.id);
    const other = await createProject();
    const foreign = await createFolder("Foreign", null, undefined, other);
    const artifact = await publish();
    await addComment(artifact);
    const purged = await createFolder("Purged");
    await place(await publish(), purged.id);
    expect((await request(`${foldersPath}/${purged.id}?expectedRevision=1`, "DELETE")).ok).toBe(true);
    await purgeFolder(purged.id, "Purged");
    const archive = await createFolder("Archive");
    const grouped = await publish();
    await place(grouped, archive.id);
    expect((await request(`${foldersPath}/${archive.id}?expectedRevision=1`, "DELETE")).ok).toBe(true);
    const marked = await createFolder("Marked");
    const underPurged = await createFolder("Under purged");
    const livePlaced = await publish();
    const traveller = await publish();
    expect((await request(`${routeFor(traveller)}/move?projectId=${defaultProject}`, "POST", {
      toProjectId: other, toFolderId: null, expectedCurrentVersionId: traveller.version.id,
    })).status).toBe(200);
    const stale = await publish();
    const linked = await linkDirectory("corrupt-output", ["a.md", "b.md", "c.md"]);
    const captures = await linked.client.captureOk(linked.link.id, {entryIds: [linked.entry("a.md").id, linked.entry("c.md").id]});
    const [tracked = "", relinked = ""] = captures.map(({artifactId}) => artifactId ?? "");
    await linked.client.scan(linked.link.id);
    expect((await waitFor(() => linked.client.inventory(linked.link.id), (entries) =>
      entries.filter(({state}) => state === "tracked").length === 2)).map(({artifactId}) => artifactId))
      .toEqual([tracked, null, relinked]);
    expect((await linked.client.request(`/api/v1/folder-links/${linked.link.id}/entries/${linked.entry("b.md").id}/live-sessions`, "POST")).status).toBe(201);
    const target = await linkDirectory("retargeted-output", ["d.md"]);
    await stop();
    expect((await Effect.runPromise(checkCompactIntegrity(installation.dataDirectory))).problems).toEqual([]);

    const later = new Date(Date.now() + 60_000).toISOString();
    readDatabase((db) => {
      db.exec("PRAGMA foreign_keys = OFF");
      db.prepare("UPDATE folders SET parent_folder_id = ? WHERE id = ?").run(child.id, parent.id);
      db.prepare("UPDATE folders SET name = ? WHERE id = ?").run("Ｆｉｎａｌ", duplicate.id);
      db.prepare("UPDATE artifacts SET folder_id = ? WHERE id = ?").run(foreign.id, artifact.artifact.id);
      db.prepare("UPDATE comment_threads SET project_id = ? WHERE artifact_id = ?").run(other, artifact.artifact.id);
      // Trash: a group mark without a tombstone, a group purged without its artifact, live rows under a purged folder.
      db.prepare("UPDATE folders SET trash_group_id = ? WHERE id = ?").run(randomUUID(), marked.id);
      db.prepare("UPDATE folders SET purged_at = trashed_at WHERE id = ?").run(archive.id);
      db.prepare("UPDATE artifacts SET folder_id = ? WHERE id = ?").run(purged.id, livePlaced.artifact.id);
      db.prepare("UPDATE folders SET parent_folder_id = ? WHERE id = ?").run(purged.id, underPurged.id);
      // A cross-project move whose record is gone leaves its source-project records unexplained.
      db.prepare("UPDATE idempotency_records SET placement_result_json = NULL WHERE operation = 'move' AND artifact_id = ?")
        .run(traveller.artifact.id);
      // Links: a tracked entry bound elsewhere, an entry without a link, a capture whose artifact is gone,
      // a grant in another project, and a link whose folder was purged.
      db.prepare("UPDATE folder_inventory SET disk_path = 'renamed.md' WHERE artifact_id = ?").run(tracked);
      db.prepare(`
        INSERT INTO folder_inventory (id, folder_link_id, relative_path, disk_path, observed_at, state, pending, seen_generation)
        VALUES (?, 'flk_missing', 'lost.md', 'lost.md', ?, 'untracked', 1, 1)
      `).run(`fle_${randomUUID()}`, later);
      db.prepare("UPDATE folder_link_captures SET result_json = json_set(result_json, '$.artifactId', 'art_gone') WHERE folder_link_id = ?")
        .run(linked.link.id);
      db.prepare("UPDATE folder_entry_live_grants SET project_id = ? WHERE folder_link_id = ?").run(other, linked.link.id);
      db.prepare("UPDATE folder_links SET folder_id = ? WHERE id = ?").run(purged.id, target.link.id);
      // A relink after the link's last scan explains its tracked entry's drift.
      db.prepare("UPDATE artifacts SET source_path = ? WHERE id = ?").run(path.join(linked.directory, "moved.md"), relinked);
      db.prepare(`
        INSERT INTO actions (id, project_id, artifact_id, version_id, action, principal_id, idempotency_key, created_at)
        SELECT ?, project_id, id, current_version_id, 'relink', 'fixture', ?, ? FROM artifacts WHERE id = ?
      `).run(randomUUID(), randomUUID(), later, relinked);
      // Overview: a stale denormalized size and a dropped overview index.
      db.prepare("UPDATE artifacts SET current_size = current_size + 1 WHERE id = ?").run(stale.artifact.id);
      db.exec("DROP INDEX artifacts_files_size");
    });
    const report = await Effect.runPromise(checkCompactIntegrity(installation.dataDirectory));
    expect(report.status).toBe("corrupt");
    expect(report.problems).toEqual(expect.arrayContaining([
      expect.objectContaining({code: "folder_cycle", folderId: parent.id}),
      expect.objectContaining({code: "folder_duplicate_name"}),
      expect.objectContaining({code: "folder_placement_mismatch", artifactId: artifact.artifact.id}),
      expect.objectContaining({code: "project_scope_mismatch", artifactId: artifact.artifact.id}),
      expect.objectContaining({code: "trash_state_invalid", folderId: marked.id}),
      expect.objectContaining({code: "trash_group_mismatch", artifactId: grouped.artifact.id}),
      expect.objectContaining({code: "trash_placement_invalid", artifactId: livePlaced.artifact.id}),
      expect.objectContaining({code: "trash_placement_invalid", folderId: underPurged.id}),
      expect.objectContaining({code: "project_scope_mismatch", artifactId: traveller.artifact.id}),
      expect.objectContaining({code: "folder_inventory_binding_mismatch", artifactId: tracked, path: "renamed.md"}),
      expect.objectContaining({code: "folder_inventory_orphan", folderLinkId: "flk_missing"}),
      expect.objectContaining({code: "folder_capture_orphan", artifactId: "art_gone", folderLinkId: linked.link.id}),
      expect.objectContaining({code: "folder_live_grant_invalid", folderLinkId: linked.link.id}),
      expect.objectContaining({code: "folder_link_target_invalid", folderLinkId: target.link.id}),
      expect.objectContaining({code: "file_catalog_stale", artifactId: stale.artifact.id}),
      expect.objectContaining({code: "file_catalog_index_missing", message: expect.stringContaining("artifacts_files_size")}),
    ]));
    expect(report.problems.filter(({artifactId}) => artifactId === relinked)).toEqual([]);
  }, 30_000);

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

  async function trashArtifact(artifact: PublishResponse): Promise<void> {
    const response = await request(`${routeFor(artifact)}?projectId=${artifact.artifact.projectId}`, "DELETE", {
      expectedCurrentVersionId: artifact.version.id,
    });
    expect(response.status).toBe(200);
  }

  async function purgeFolder(folderId: string, confirm: string): Promise<void> {
    const cookies = await signInAdministrator(running(), installation);
    const key = await issueApiKey(running(), cookies, ["artifact:purge", "artifact:read"], "Purge key");
    const response = await new LinkedFolderClient(running(), key).request(`${foldersPath}/${folderId}/purge`, "POST", {confirm});
    expect(response.status).toBe(200);
  }

  async function linkDirectory(name: string, files: readonly string[]) {
    const directory = path.join(await realpath(source.dataDirectory), name);
    await mkdir(directory);
    await Promise.all(files.map((file) => writeFile(path.join(directory, file), `# ${file}\n`)));
    const client = new LinkedFolderClient(running(), installation.apiToken);
    const link = await client.linkOk(directory, {key: randomUUID(), name});
    const entries = await client.inventory(link.id);
    const entry = (relativePath: string) => {
      const found = entries.find((candidate) => candidate.relativePath === relativePath);
      if (found === undefined) throw new Error(`The link has no ${relativePath} entry.`);
      return found;
    };
    return {client, directory, entry, link};
  }

  async function addComment(artifact: PublishResponse): Promise<string> {
    const response = await request(`${routeFor(artifact)}/versions/${artifact.version.id}/comments?projectId=${artifact.artifact.projectId}`, "POST", {body: "Review the saved bytes."});
    expect(response.status).toBe(201);
    return z.object({thread: idSchema}).parse(await response.json()).thread.id;
  }

  async function artifactJson(id: string, projectId: string) {
    const response = await request(`/api/v1/artifacts/${id}?projectId=${projectId}`);
    expect(response.status).toBe(200);
    return z.object({sourceBinding: z.json().optional()}).loose().parse(await response.json());
  }

  async function waitForGitHistoryAvailable(): Promise<void> {
    await expect.poll(async () => z.object({capabilities: z.object({
      gitHistory: z.object({providerState: z.string()}).loose(),
    }).loose()}).loose().parse(await (await request("/api/v1/session")).json()).capabilities.gitHistory.providerState,
    {timeout: 5_000}).toBe("available");
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

function gitHistoryConfiguration(): NodeGitHistoryConfiguration {
  return {
    _tag: "CloudflareArtifactsRest",
    apiToken: Redacted.make("cross-project-move-test-token"),
    capability: {
      limits: {
        fileCopyBytes: defaultGitHistoryFileCopyBytes,
        logicalCopiedBytes: 0,
        logicalReservedBytes: 0,
        storageBudgetBytes: null,
        versionCopyBytes: defaultGitHistoryVersionCopyBytes,
      },
      provider: "cloudflare-artifacts",
      providerState: "checking",
    },
    identity: {accountId: "cross-project-account", namespace: "cross-project-namespace", provider: "cloudflare-artifacts"},
    issues: [],
  };
}

function routeFor(artifact: PublishResponse): string {
  return `/api/v1/artifacts/${artifact.artifact.id}`;
}

function rootPageQuery(cursor: string | null): string {
  const query = new URLSearchParams({limit: "1", foldersOnly: "true"});
  if (cursor !== null && cursor !== "") query.set("cursor", cursor);
  return `root?${query}`;
}

const backupTables = [
  "folders", "folder_actions", "actions", "versions", "artifacts", "idempotency_records",
  "folder_links", "folder_inventory", "folder_link_captures", "folder_entry_live_grants",
];

/** Every record a stopped-directory backup must carry for the file-management features. */
function backupSnapshot(database: DatabaseSync) {
  return Object.fromEntries([
    ...backupTables.map((table) => [table, database.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()] as const),
    ["overview_indexes", database.prepare(`
      SELECT name, sql FROM sqlite_schema WHERE type = 'index' AND name IN (SELECT value FROM json_each(?)) ORDER BY name
    `).all(JSON.stringify(fileCatalogSqliteIndexes))] as const,
  ]);
}

function withDatabaseAt<Result>(target: TestInstallation, operation: (database: DatabaseSync) => Result): Result {
  const database = new DatabaseSync(path.join(target.dataDirectory, "artifact-server.db"), {readOnly: true});
  try {
    return operation(database);
  } finally {
    database.close();
  }
}

function snapshot(database: DatabaseSync, tables: readonly string[]) {
  return Object.fromEntries(tables.map((table) => [table, database.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()]));
}

async function expectFailure(response: Response, status: number, code: string): Promise<void> {
  expect(response.status).toBe(status);
  await expect(response.json()).resolves.toMatchObject({error: {code}});
}
