import {execFile} from "node:child_process";
import {randomUUID} from "node:crypto";
import {readdir, writeFile} from "node:fs/promises";
import path from "node:path";
import {DatabaseSync} from "node:sqlite";
import {promisify} from "node:util";

import {
  CLIENT_CAPABILITIES_META_KEY, CLIENT_INFO_META_KEY, PROTOCOL_VERSION_META_KEY,
} from "@modelcontextprotocol/server";
import {afterEach, beforeEach, describe, expect, test} from "vitest";
import {z} from "zod";

import {browserLoginKinds, privateTeamBrowserAccess} from "../../src/core/browser-access.js";
import {OidcIdentityProvider} from "../../src/identity/oidc-identity-provider.js";
import {ApiClient, issueApiKey, signInAdministrator} from "../support/agent-dispatch.js";
import {parsePublishResponse, publishNew, publishVersion, type PublishResponse} from "../support/publishing.js";
import {
  apiHeaders, createTestInstallation, fetchVersion, removeTestInstallation, reserveLoopbackPort,
  startTestServer, type RunningTestServer, type TestInstallation,
} from "../support/runtime-harness.js";
import {downgradeToSchemaThirteen} from "../support/schema-thirteen.js";
import {startStubOidcProvider} from "../support/stub-oidc-provider.js";

const defaultProject = "prj_default";
const foldersPath = `/api/v1/projects/${defaultProject}/folders`;
const content = "<!doctype html><title>Recoverable trash fixture</title>";
const run = promisify(execFile);
const folderSchema = z.object({id: z.string(), name: z.string(), parentFolderId: z.string().nullable(), revision: z.number()});
const folderResult = z.object({folder: folderSchema});
const trashItemSchema = z.object({
  kind: z.enum(["artifact", "folder"]),
  id: z.string(),
  projectId: z.string(),
  name: z.string(),
  location: z.object({
    projectId: z.string(),
    folderId: z.string().nullable(),
    path: z.array(z.object({id: z.string(), name: z.string()})),
  }),
  trashedAt: z.string(),
  trashedBy: z.string().nullable(),
  trashGroupId: z.string().nullable(),
}).loose();
const trashPage = z.object({items: z.array(trashItemSchema), nextCursor: z.string().nullable()});
const artifactRecovery = z.object({
  artifact: z.object({
    id: z.string(), accessSetting: z.string(), folderId: z.string().nullable(), currentVersionId: z.string(),
  }).loose(),
  placement: z.enum(["original", "root"]),
  previousAccessSetting: z.string(),
  replayed: z.boolean(),
});
const folderRecovery = z.object({
  folder: folderSchema,
  placement: z.enum(["original", "root"]),
  recoveredArtifactCount: z.number(),
  previouslyPublicArtifactIds: z.array(z.string()),
});
const artifactPage = z.object({artifacts: z.array(z.object({artifact: z.object({id: z.string()}).loose()}).loose())}).loose();
const actionsResult = z.object({actions: z.array(z.object({action: z.string(), principalId: z.string()}).loose())});
const insightsResult = z.object({insights: z.object({overview: z.object({artifactCount: z.number()}).loose()}).loose()});
const projectResult = z.object({project: z.object({id: z.string()})});
const toolEnvelope = z.object({result: z.object({isError: z.boolean().optional(), structuredContent: z.json()})});
const dispatchResult = z.object({dispatch: z.object({id: z.string(), state: z.string()}).loose()}).loose();
type Json = z.infer<ReturnType<typeof z.json>>;
type Cookies = Awaited<ReturnType<typeof signInAdministrator>>;

describe("recoverable trash, recover and purge", () => {
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

  test("TRS-001-B: trashing an artifact and a folder subtree hides them everywhere but trash and keeps every byte", async () => {
    const reports = await createFolder("Reports");
    const drafts = await createFolder("Drafts", reports.id);
    const loose = await publish("Loose report");
    const filed = await publish("Filed report");
    const nested = await publish("Nested draft");
    await place(filed, reports.id);
    await place(nested, drafts.id);
    expect(await artifactCount()).toBe(3);
    const blobsBefore = await blobFiles();
    const versionsBefore = dbSnapshot(["versions", "manifest_entries", "artifact_tags"]);

    const removed = await request(routeFor(loose), "DELETE", {expectedCurrentVersionId: loose.version.id});
    expect(removed.status).toBe(200);
    await expect(removed.json()).resolves.toMatchObject({recoverable: true, retainedVersionCount: 1});
    const folderTrash = await request(`${foldersPath}/${reports.id}?expectedRevision=1`, "DELETE");
    expect(folderTrash.status).toBe(200);
    await expect(folderTrash.json()).resolves.toMatchObject({folder: reports, recoverable: true});

    expect(artifactPage.parse(await (await request("/api/v1/artifacts")).json()).artifacts).toEqual([]);
    expect(artifactPage.parse(await (await request("/api/v1/artifacts?search=report")).json()).artifacts).toEqual([]);
    const root = z.object({folders: z.array(folderSchema), artifacts: z.array(z.unknown())})
      .parse(await (await request(`${foldersPath}/root`)).json());
    expect(root).toMatchObject({folders: [], artifacts: []});
    await expectFailure(await request(`${foldersPath}/${drafts.id}`), 404, "FOLDER_NOT_FOUND");
    expect(await artifactCount()).toBe(0);

    const {items} = await trash();
    const byId = new Map(items.map((item) => [item.id, item]));
    expect(items.map(({id}) => id).toSorted()).toEqual([loose.artifact.id, filed.artifact.id, nested.artifact.id, reports.id].toSorted());
    const group = byId.get(reports.id)?.trashGroupId;
    expect(group).toMatch(/^tgr_/u);
    expect(byId.get(reports.id)).toMatchObject({kind: "folder", trashedBy: "local-api-token", artifactCount: 2, location: {folderId: null, path: []}});
    expect(byId.get(loose.artifact.id)).toMatchObject({kind: "artifact", trashGroupId: null, trashedBy: "local-api-token", location: {folderId: null}});
    expect(byId.get(filed.artifact.id)).toMatchObject({trashGroupId: group, location: {folderId: reports.id, path: [{id: reports.id, name: "Reports"}]}});
    expect(byId.get(nested.artifact.id)).toMatchObject({
      trashGroupId: group,
      location: {folderId: drafts.id, path: [{id: reports.id, name: "Reports"}, {id: drafts.id, name: "Drafts"}]},
    });
    expect(dbSnapshot(["versions", "manifest_entries", "artifact_tags"])).toEqual(versionsBefore);
    expect(await blobFiles()).toEqual(blobsBefore);
    const actions = actionsResult.parse(await (await request(`${routeFor(nested)}/actions`)).json()).actions;
    expect(actions).toEqual(expect.arrayContaining([expect.objectContaining({action: "delete", principalId: "local-api-token"})]));
  });

  test("TRS-001-F: trashed items refuse every access path, stale guards change nothing, and oversized groups are refused", async () => {
    const artifact = await publish("Public report");
    expect((await fetchVersion(running(), artifact.links.version)).status).toBe(200);
    const thread = await addComment(artifact);
    const linked = await linkFile();
    const folder = await createFolder("Reports");
    const staleArtifact = await request(routeFor(artifact), "DELETE", {expectedCurrentVersionId: "ver_stale"});
    expect(staleArtifact.status).toBe(409);
    await expectFailure(await request(`${foldersPath}/${folder.id}?expectedRevision=2`, "DELETE"), 409, "FOLDER_REVISION_CONFLICT");
    expect(dbSnapshot(["artifacts", "folders", "actions"])).toMatchObject({
      artifacts: expect.arrayContaining([expect.objectContaining({id: artifact.artifact.id, deleted_at: null})]),
    });
    expect((await trash()).items).toEqual([]);

    expect((await request(routeFor(artifact), "DELETE", {expectedCurrentVersionId: artifact.version.id})).ok).toBe(true);
    expect((await request(routeFor(linked), "DELETE", {expectedCurrentVersionId: linked.version.id})).ok).toBe(true);
    expect((await fetch(artifact.links.artifact, {redirect: "manual"})).status).toBe(404);
    expect((await fetchVersion(running(), artifact.links.version)).status).toBe(404);
    await expectFailure(await request(`${routeFor(artifact)}/versions/${artifact.version.id}`), 404, "ARTIFACT_NOT_FOUND");
    await expectFailure(await request(`${routeFor(artifact)}/versions/${artifact.version.id}/comments`, "POST", {body: "Late comment"}), 404, "ARTIFACT_NOT_FOUND");
    await expectFailure(await request(`${routeFor(artifact)}/comments/${thread}/replies`, "POST", {body: "Late reply"}), 404, "ARTIFACT_NOT_FOUND");
    await expectFailure(await request(`${routeFor(linked)}/live-sessions`, "POST"), 404, "ARTIFACT_NOT_FOUND");
    const clone = await request(`/api/v1/projects/${defaultProject}/artifacts/${artifact.artifact.id}/history/clone-token`, "POST");
    expect(clone.ok).toBe(false);

    const bulk = await createFolder("Bulk");
    await stop();
    readDatabase((database) => database.prepare(`
      WITH RECURSIVE bulk(position) AS (SELECT 1 UNION ALL SELECT position + 1 FROM bulk WHERE position < 10001)
      INSERT INTO artifacts (id, project_id, name, search_name, access_setting, created_at, folder_id)
      SELECT 'bulk_' || position, ?, 'Bulk', 'bulk', 'account_required', '2026-11-24T00:00:00.000Z', ?
      FROM bulk
    `).run(defaultProject, bulk.id));
    const before = dbSnapshot(["folders", "folder_actions", "actions"]);
    server = await startTestServer(installation);
    await expectFailure(await request(`${foldersPath}/${bulk.id}?expectedRevision=1`, "DELETE"), 409, "TRASH_TOO_LARGE");
    expect(dbSnapshot(["folders", "folder_actions", "actions"])).toEqual(before);
    expect(readDatabase((database) => database.prepare(
      "SELECT COUNT(*) AS count FROM artifacts WHERE folder_id = ? AND deleted_at IS NULL",
    ).get(bulk.id))).toEqual({count: 10_001});
  }, 30_000);

  test("TRS-002-B: recovery restores identities and placement, records the action and reports the former public setting", async () => {
    const reports = await createFolder("Reports");
    const single = await publish("Single report");
    await place(single, reports.id);
    const versions = await (await request(`${routeFor(single)}/versions`)).json();
    await trashArtifact(single);
    const recovered = artifactRecovery.parse(await (await request(`${routeFor(single)}/recover`, "POST")).json());
    expect(recovered).toMatchObject({
      artifact: {id: single.artifact.id, accessSetting: "account_required", folderId: reports.id, currentVersionId: single.version.id},
      placement: "original",
      previousAccessSetting: "public_link",
    });
    expect(await (await request(`${routeFor(single)}/versions`)).json()).toEqual(versions);
    expect(actionsResult.parse(await (await request(`${routeFor(single)}/actions`)).json()).actions)
      .toEqual(expect.arrayContaining([expect.objectContaining({action: "recover", principalId: "local-api-token"})]));

    const group = await createFolder("Quarterly");
    const child = await createFolder("Drafts", group.id);
    const grouped = await publish("Grouped report");
    const deep = await publish("Deep report", "account_required");
    await place(grouped, group.id);
    await place(deep, child.id);
    expect((await request(`${foldersPath}/${group.id}?expectedRevision=1`, "DELETE")).ok).toBe(true);
    const groupRecovery = folderRecovery.parse(await (await request(`${foldersPath}/${group.id}/recover`, "POST", {})).json());
    expect(groupRecovery).toEqual({
      folder: group, placement: "original", recoveredArtifactCount: 2, previouslyPublicArtifactIds: [grouped.artifact.id],
    });
    expect(await list(child.id)).toMatchObject({artifacts: [{artifact: {id: deep.artifact.id}}]});

    const doomed = await createFolder("Doomed");
    const orphan = await publish("Orphan report");
    await place(orphan, doomed.id);
    await trashArtifact(orphan);
    expect((await request(`${foldersPath}/${doomed.id}?expectedRevision=1`, "DELETE")).ok).toBe(true);
    const cookies = await signInAdministrator(running(), installation);
    expect((await human(cookies, `${foldersPath}/${doomed.id}/purge`, "POST", {confirm: "Doomed"})).status).toBe(200);
    const rooted = artifactRecovery.parse(await (await request(`${routeFor(orphan)}/recover`, "POST")).json());
    expect(rooted).toMatchObject({artifact: {id: orphan.artifact.id, folderId: null}, placement: "root"});
    expect((await trash()).items).toEqual([]);
  });

  test("TRS-002-F: purged items stay gone, a taken sibling name needs a new name, and recovery never republishes", async () => {
    const artifact = await publish("Public report");
    await trashArtifact(artifact);
    const versionCount = dbSnapshot(["versions"]);
    const recovered = await request(`${routeFor(artifact)}/recover`, "POST");
    expect(recovered.status).toBe(200);
    expect((await fetchVersion(running(), artifact.links.version)).status).not.toBe(200);
    expect(dbSnapshot(["versions"])).toEqual(versionCount);
    expect(readDatabase((database) => database.prepare("SELECT access_setting FROM artifacts WHERE id = ?").get(artifact.artifact.id)))
      .toEqual({access_setting: "account_required"});

    const old = await createFolder("Reports");
    expect((await request(`${foldersPath}/${old.id}?expectedRevision=1`, "DELETE")).ok).toBe(true);
    const replacement = await createFolder("Reports");
    const conflict = await request(`${foldersPath}/${old.id}/recover`, "POST", {});
    expect(conflict.status).toBe(409);
    await expect(conflict.json()).resolves.toMatchObject({error: {code: "NAME_CONFLICT", conflictingFolderId: replacement.id}});
    const renamedResponse = await request(`${foldersPath}/${old.id}/recover`, "POST", {name: "Reports (old)"});
    const renamed = folderRecovery.parse(await renamedResponse.json());
    expect(renamed.folder).toMatchObject({id: old.id, name: "Reports (old)", revision: 2});

    const gone = await publish("Gone report");
    await trashArtifact(gone);
    const cookies = await signInAdministrator(running(), installation);
    expect((await human(cookies, `${routeFor(gone)}/purge`, "POST", {confirm: "Gone report"})).status).toBe(200);
    await expectFailure(await request(`${routeFor(gone)}/recover`, "POST"), 404, "ARTIFACT_NOT_FOUND");
    expect((await request(`${foldersPath}/${replacement.id}?expectedRevision=1`, "DELETE")).ok).toBe(true);
    expect((await human(cookies, `${foldersPath}/${replacement.id}/purge`, "POST", {confirm: "Reports"})).status).toBe(200);
    await expectFailure(await request(`${foldersPath}/${replacement.id}/recover`, "POST", {}), 404, "FOLDER_NOT_FOUND");
  });

  test("TRS-003-B: purging with the exact name ends recoverability on every surface and keeps every blob", async () => {
    const artifact = await publish("Purged report");
    const folder = await createFolder("Old work");
    const inside = await publish("Inside report");
    await place(inside, folder.id);
    const blobsBefore = await blobFiles();
    await trashArtifact(artifact);
    expect((await request(`${foldersPath}/${folder.id}?expectedRevision=1`, "DELETE")).ok).toBe(true);
    const cookies = await signInAdministrator(running(), installation);
    const purged = await human(cookies, `${routeFor(artifact)}/purge`, "POST", {confirm: "Purged report"});
    expect(purged.status).toBe(200);
    await expect(purged.json()).resolves.toMatchObject({artifact: {id: artifact.artifact.id, purgedAt: expect.any(String)}, retainedVersionCount: 1});
    const cookieKey = await issueApiKey(running(), cookies, ["artifact:purge", "artifact:read"], "Purge key");
    const folderPurge = await fetch(`${running().baseUrl}${foldersPath}/${folder.id}/purge`, {
      method: "POST",
      body: JSON.stringify({confirm: "Old work"}),
      headers: {Authorization: `Bearer ${cookieKey}`, "Content-Type": "application/json", "Idempotency-Key": randomUUID()},
    });
    expect(folderPurge.status).toBe(200);
    await expect(folderPurge.json()).resolves.toMatchObject({folder: {id: folder.id}, purgedArtifactCount: 1});

    expect((await trash()).items).toEqual([]);
    await expectFailure(await request(`${routeFor(artifact)}/recover`, "POST"), 404, "ARTIFACT_NOT_FOUND");
    expect(await tool("artifact_recover", {artifactId: inside.artifact.id, idempotencyKey: randomUUID()})).toMatchObject({
      isError: true, structuredContent: {error: {code: "ARTIFACT_NOT_FOUND"}},
    });
    const tokenFile = path.join(installation.dataDirectory, "fixture.key");
    await writeFile(tokenFile, installation.apiToken, {mode: 0o600});
    await expect(cli(tokenFile, "trash", "recover", folder.id)).rejects.toMatchObject({
      stderr: expect.stringContaining("FOLDER_NOT_FOUND"),
    });
    const histories = await Promise.all([artifact, inside].map(async (subject) =>
      actionsResult.parse(await (await request(`${routeFor(subject)}/actions`)).json()).actions));
    for (const actions of histories) {
      expect(actions).toEqual(expect.arrayContaining([expect.objectContaining({action: "purge"})]));
    }
    expect(await blobFiles()).toEqual(blobsBefore);
  });

  test("TRS-003-F: purge refuses active items, wrong names, service keys without the capability and held threads", async () => {
    const active = await publish("Active report");
    const held = await publish("Held report");
    const cookies = await signInAdministrator(running(), installation);
    const client = new ApiClient(running(), installation.apiToken);
    const agent = await client.registerAgent({connectionKey: "trash-purge-held", displayName: "trash", workingDirectory: "/work/trash"});
    const thread = await client.openThread(held, "Fix the heading.", randomUUID());
    const sent = await client.sendDispatch({agentId: agent.id, idempotencyKey: randomUUID(), projectId: defaultProject, threadIds: [thread.id]});
    const dispatchId = dispatchResult.parse(await sent.json()).dispatch.id;
    await trashArtifact(held);
    const before = dbSnapshot(["artifacts", "actions", "idempotency_records", "git_history_jobs"]);

    await expectFailure(await human(cookies, `${routeFor(active)}/purge`, "POST", {confirm: "Active report"}), 409, "NOT_IN_TRASH");
    await expectFailure(await human(cookies, `${routeFor(held)}/purge`, "POST", {confirm: "held report"}), 422, "PURGE_CONFIRMATION_MISMATCH");
    await expectFailure(await request(`${routeFor(held)}/purge`, "POST", {confirm: "Held report"}), 403, "AUTHORIZATION_DENIED");
    const manager = await issueApiKey(running(), cookies, ["artifact:manage:any"], "Manager key");
    const managerPurge = await fetch(`${running().baseUrl}${routeFor(held)}/purge`, {
      method: "POST",
      body: JSON.stringify({confirm: "Held report"}),
      headers: {Authorization: `Bearer ${manager}`, "Content-Type": "application/json", "Idempotency-Key": randomUUID()},
    });
    await expectFailure(managerPurge, 403, "AUTHORIZATION_DENIED");
    await expectFailure(await human(cookies, `${routeFor(held)}/purge`, "POST", {confirm: "Held report"}), 409, "DISPATCH_HELD");
    expect((await client.claim(agent.id)).status).toBe(200);
    await expectFailure(await human(cookies, `${routeFor(held)}/purge`, "POST", {confirm: "Held report"}), 409, "DISPATCH_HELD");
    expect((await client.reportDelivered(dispatchId, agent.id)).status).toBe(200);
    await expectFailure(await human(cookies, `${routeFor(held)}/purge`, "POST", {confirm: "Held report"}), 409, "DISPATCH_HELD");
    expect(dbSnapshot(["artifacts", "actions", "idempotency_records", "git_history_jobs"])).toEqual(before);
  });

  test("TRS-004-B: trash pages across projects without gaps, and held threads of a trashed artifact answer artifact-in-trash", async () => {
    const other = projectResult.parse(await (await request("/api/v1/projects", "POST", {name: "Second project"})).json()).project.id;
    const trashed = await Promise.all(["One", "Two", "Three"].map((name) => publish(name)));
    const elsewhere = await Promise.all(["Four", "Five"].map((name) => publish(name, "account_required", other)));
    await Promise.all([...trashed, ...elsewhere].map(trashArtifact));
    const seen = await trashPages(null);
    expect(seen.toSorted()).toEqual([...trashed, ...elsewhere].map(({artifact}) => artifact.id).toSorted());
    expect(new Set(seen).size).toBe(seen.length);
    const filtered = trashPage.parse(await (await request(`/api/v1/trash?projectId=${other}`)).json());
    expect(filtered.items.map(({projectId}) => projectId)).toEqual([other, other]);
    expect((await tool("trash_list", {projectIds: [other]})).structuredContent).toEqual(filtered);

    const client = new ApiClient(running(), installation.apiToken);
    const live = await publish("Dispatched report");
    const agent = await client.registerAgent({connectionKey: "trash-held-thread", displayName: "trash", workingDirectory: "/work/trash"});
    const thread = await client.openThread(live, "Tighten the summary.", randomUUID());
    const sent = await client.sendDispatch({agentId: agent.id, idempotencyKey: randomUUID(), projectId: defaultProject, threadIds: [thread.id]});
    const dispatchId = dispatchResult.parse(await sent.json()).dispatch.id;
    expect((await client.claim(agent.id)).status).toBe(200);
    await trashArtifact(live);
    const scope = `?projectId=${defaultProject}`;
    await expectFailure(await request(`${routeFor(live)}/comments/${thread.id}/replies${scope}`, "POST", {body: "Done."}), 409, "ARTIFACT_IN_TRASH");
    await expectFailure(await request(`${routeFor(live)}/comments/${thread.id}${scope}`, "PATCH", {state: "resolved"}), 409, "ARTIFACT_IN_TRASH");
    expect(await tool("comment_reply", {
      artifactId: live.artifact.id, threadId: thread.id, body: "Done.", idempotencyKey: randomUUID(), projectId: defaultProject,
    })).toMatchObject({isError: true, structuredContent: {error: {code: "ARTIFACT_IN_TRASH"}}});
    const failed = await client.reportFailed(dispatchId, agent.id, "The artifact is in the trash.");
    expect(failed.status).toBe(200);
    expect(dispatchResult.parse(await failed.json()).dispatch.state).toBe("failed");
  });

  test("TRS-004-F: trash listing requires listing authority, hides purged items and bounds the page size", async () => {
    const artifact = await publish("Hidden report");
    const purged = await publish("Purged report");
    await trashArtifact(artifact);
    await trashArtifact(purged);
    const cookies = await signInAdministrator(running(), installation);
    expect((await human(cookies, `${routeFor(purged)}/purge`, "POST", {confirm: "Purged report"})).ok).toBe(true);
    const writer = await issueApiKey(running(), cookies, ["comment:write"], "Comment-only key");
    const denied = await fetch(`${running().baseUrl}/api/v1/trash`, {headers: {Authorization: `Bearer ${writer}`}});
    await expectFailure(denied, 403, "AUTHORIZATION_DENIED");
    expect(await tool("trash_list", {}, writer)).toMatchObject({isError: true, structuredContent: {error: {code: "AUTHORIZATION_DENIED"}}});
    expect((await trash()).items.map(({id}) => id)).toEqual([artifact.artifact.id]);
    expect((await request("/api/v1/trash?limit=101")).ok).toBe(false);
    expect((await request("/api/v1/trash?limit=101")).status).toBeGreaterThanOrEqual(400);
    expect(await rawTool("trash_list", {limit: 101})).toMatchObject({result: {isError: true}});
  });

  test("TRS-005-B: tombstones from before trash are recoverable and nothing is purged across restarts", async () => {
    const old = await publish("Old tombstone");
    const second = await publishVersion(running(), installation, {
      artifactId: old.artifact.id, expectedCurrentVersionId: old.version.id,
      content: "Second saved version", idempotencyKey: randomUUID(), projectId: defaultProject,
    });
    const versions = await versionRecords(old);
    await stop();
    readDatabase((database) => {
      downgradeToSchemaThirteen(database);
      database.prepare("UPDATE artifacts SET deleted_at = ? WHERE id = ?").run("2026-11-01T00:00:00.000Z", old.artifact.id);
    });
    server = await startTestServer(installation);
    expect(readDatabase((database) => database.prepare("PRAGMA user_version").get())).toEqual({user_version: 14});
    expect((await trash()).items).toMatchObject([{id: old.artifact.id, trashGroupId: null, trashedAt: "2026-11-01T00:00:00.000Z"}]);
    const recovered = artifactRecovery.parse(await (await request(`${routeFor(old)}/recover`, "POST")).json());
    expect(recovered.artifact).toMatchObject({id: old.artifact.id, currentVersionId: second.body.version.id});
    expect(await versionRecords(old)).toEqual(versions);

    const kept = await publish("Kept in trash");
    await trashArtifact(kept);
    await stop();
    server = await startTestServer(installation);
    await stop();
    server = await startTestServer(installation);
    expect((await trash()).items.map(({id}) => id)).toEqual([kept.artifact.id]);
    expect(readDatabase((database) => database.prepare("SELECT COUNT(*) AS count FROM artifacts WHERE purged_at IS NOT NULL").get()))
      .toEqual({count: 0});
  });

  test("TRS-005-F: without the trash capability delete stays one-way and recover and purge are unavailable", async () => {
    await stop();
    await removeTestInstallation(installation);
    installation = await createTestInstallation();
    const provider = await startStubOidcProvider({clientId: "trash-capability-test"});
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
    expect(await (await request("/api/v1/session")).json()).toMatchObject({capabilities: {trash: false}});
    expect((await tool("artifact_capabilities", {})).structuredContent).toMatchObject({trash: {available: false}});
    const artifact = await publish("One-way report");
    const deletion = await request(routeFor(artifact), "DELETE", {expectedCurrentVersionId: artifact.version.id});
    expect(deletion.ok).toBe(true);
    await expect(deletion.json()).resolves.toMatchObject({recoverable: false});
    expect(await tool("artifact_delete", {
      artifactId: (await publish("Another report")).artifact.id, expectedCurrentVersionId: "ver_unknown", idempotencyKey: randomUUID(),
    })).toMatchObject({isError: true});
    await expectFailure(await request(`${routeFor(artifact)}/recover`, "POST"), 501, "CAPABILITY_UNAVAILABLE");
    await expectFailure(await request(`${routeFor(artifact)}/purge`, "POST", {confirm: "One-way report"}), 501, "CAPABILITY_UNAVAILABLE");
    await expectFailure(await request("/api/v1/trash"), 501, "CAPABILITY_UNAVAILABLE");
    expect(await tool("artifact_recover", {artifactId: artifact.artifact.id, idempotencyKey: randomUUID()})).toMatchObject({
      isError: true, structuredContent: {error: {code: "CAPABILITY_UNAVAILABLE"}},
    });
    expect(await tool("trash_list", {})).toMatchObject({isError: true, structuredContent: {error: {code: "CAPABILITY_UNAVAILABLE"}}});
    expect((await request(routeFor(artifact))).status).toBe(404);
  }, 30_000);

  function running(): RunningTestServer {
    if (server === null) throw new Error("Start the fixture server first.");
    return server;
  }

  async function stop(): Promise<void> {
    await running().stop();
    server = null;
  }

  function readDatabase<Result>(operation: (database: DatabaseSync) => Result): Result {
    const database = new DatabaseSync(path.join(installation.dataDirectory, "artifact-server.db"));
    try {
      return operation(database);
    } finally {
      database.close();
    }
  }

  function dbSnapshot(tables: readonly string[]) {
    return readDatabase((database) => Object.fromEntries(tables.map((table) =>
      [table, database.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()])));
  }

  async function blobFiles(): Promise<string[]> {
    const entries = await readdir(path.join(installation.dataDirectory, "blobs"), {recursive: true, withFileTypes: true});
    return entries.filter((entry) => entry.isFile()).map((entry) => path.join(entry.parentPath, entry.name)).toSorted();
  }

  async function request(route: string, method = "GET", body?: Json, key: string = randomUUID()) {
    const init: RequestInit = {headers: apiHeaders(installation, key), method};
    if (body !== undefined) init.body = JSON.stringify(body);
    return fetch(`${running().baseUrl}${route}`, init);
  }

  async function human(cookies: Cookies, route: string, method: string, body: Json) {
    return fetch(`${running().baseUrl}${route}`, {
      method,
      body: JSON.stringify(body),
      headers: {
        "Content-Type": "application/json",
        Cookie: cookies.header,
        Origin: running().baseUrl,
        "Sec-Fetch-Mode": "cors",
        "Sec-Fetch-Site": "same-origin",
        "X-CSRF-Token": cookies.csrf,
        "Idempotency-Key": randomUUID(),
      },
    });
  }

  async function versionRecords(artifact: PublishResponse) {
    const response = await request(`${routeFor(artifact)}/versions`);
    expect(response.status).toBe(200);
    return z.object({versions: z.array(z.object({version: z.json()}).loose())}).parse(await response.json())
      .versions.map(({version}) => version);
  }

  async function trashPages(cursor: string | null): Promise<string[]> {
    const query = new URLSearchParams({limit: "2"});
    if (cursor !== null) query.set("cursor", cursor);
    const page = trashPage.parse(await (await request(`/api/v1/trash?${query}`)).json());
    const ids = page.items.map(({id}) => id);
    return page.nextCursor === null ? ids : [...ids, ...await trashPages(page.nextCursor)];
  }

  async function trash() {
    const response = await request("/api/v1/trash");
    expect(response.status).toBe(200);
    return trashPage.parse(await response.json());
  }

  async function artifactCount(): Promise<number> {
    return insightsResult.parse(await (await request("/api/v1/insights")).json()).insights.overview.artifactCount;
  }

  async function createFolder(name: string, parentFolderId: string | null = null) {
    const response = await request(foldersPath, "POST", {name, parentFolderId});
    expect(response.status).toBe(201);
    return folderResult.parse(await response.json()).folder;
  }

  async function list(folder: string) {
    const response = await request(`${foldersPath}/${folder}`);
    expect(response.status).toBe(200);
    return z.json().parse(await response.json());
  }

  async function publish(
    name: string,
    accessSetting: "account_required" | "public_link" = "public_link",
    projectId = defaultProject,
  ): Promise<PublishResponse> {
    const result = await publishNew(running(), installation, {
      accessSetting, content, name, idempotencyKey: randomUUID(), projectId,
    });
    expect(result.response.status).toBe(201);
    return result.body;
  }

  async function trashArtifact(artifact: PublishResponse): Promise<void> {
    const response = await request(
      `${routeFor(artifact)}?projectId=${artifact.artifact.projectId}`,
      "DELETE",
      {expectedCurrentVersionId: artifact.version.id},
    );
    expect(response.status).toBe(200);
  }

  async function linkFile(): Promise<PublishResponse> {
    const sourcePath = path.join(source.dataDirectory, "linked.html");
    await writeFile(sourcePath, content);
    const response = await request("/api/v1/artifacts/link", "POST", {path: sourcePath, projectId: defaultProject});
    expect(response.status).toBe(201);
    return parsePublishResponse(await response.json());
  }

  async function place(artifact: PublishResponse, toFolderId: string) {
    const result = await request(`${routeFor(artifact)}/move?projectId=${artifact.artifact.projectId}`, "POST", {toFolderId, expectedCurrentVersionId: artifact.version.id});
    expect(result.status).toBe(200);
  }

  async function addComment(artifact: PublishResponse): Promise<string> {
    const response = await request(`${routeFor(artifact)}/versions/${artifact.version.id}/comments`, "POST", {body: "Review the saved bytes."});
    expect(response.status).toBe(201);
    return z.object({thread: z.object({id: z.string()})}).parse(await response.json()).thread.id;
  }

  async function cli(tokenFile: string, ...args: readonly string[]): Promise<Json> {
    const {stdout} = await run(process.execPath, [
      "--import", "tsx", "src/cli/main.ts", ...args, "--server", running().baseUrl, "--token-file", tokenFile,
    ]);
    return z.json().parse(JSON.parse(stdout));
  }

  async function tool(name: string, args: Json, token = installation.apiToken) {
    return toolEnvelope.parse(await rawTool(name, args, token)).result;
  }

  async function rawTool(name: string, args: Json, token = installation.apiToken): Promise<Json> {
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
            [CLIENT_INFO_META_KEY]: {name: "trash-tests", version: "1"},
            [PROTOCOL_VERSION_META_KEY]: protocol,
          },
        },
      }),
    });
    expect(response.status).toBe(200);
    return z.json().parse(await response.json());
  }
});

function routeFor(artifact: PublishResponse): string {
  return `/api/v1/artifacts/${artifact.artifact.id}`;
}

async function expectFailure(response: Response, status: number, code: string): Promise<void> {
  expect(response.status).toBe(status);
  await expect(response.json()).resolves.toMatchObject({error: {code}});
}
