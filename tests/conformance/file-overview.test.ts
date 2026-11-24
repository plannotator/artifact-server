import {execFile} from "node:child_process";
import {randomUUID} from "node:crypto";
import {writeFile} from "node:fs/promises";
import path from "node:path";
import {DatabaseSync} from "node:sqlite";
import {promisify} from "node:util";

import {
  CLIENT_CAPABILITIES_META_KEY, CLIENT_INFO_META_KEY, PROTOCOL_VERSION_META_KEY,
} from "@modelcontextprotocol/server";
import {afterEach, beforeEach, describe, expect, test} from "vitest";
import {z} from "zod";

import {issueApiKey, signInAdministrator} from "../support/agent-dispatch.js";
import {
  commitStagedUpload, createStagedUpload, parsePublishResponse, publishNew, publishVersion, type PublishResponse,
  type TestSiteFile, uploadEveryStagedFile,
} from "../support/publishing.js";
import {
  apiHeaders, createTestInstallation, fetchVersion, removeTestInstallation, startTestServer,
  type RunningTestServer, type TestInstallation,
} from "../support/runtime-harness.js";

const defaultProject = "prj_default";
const run = promisify(execFile);
const fileItemSchema = z.object({
  id: z.string(),
  name: z.string(),
  projectId: z.string(),
  projectName: z.string(),
  folderId: z.string().nullable(),
  folderPath: z.array(z.object({id: z.string(), name: z.string()})),
  fileKind: z.string(),
  currentVersionId: z.string(),
  currentVersionNumber: z.number(),
  size: z.number(),
  entryMediaType: z.string(),
  tags: z.array(z.string()),
  commentCount: z.number(),
  versionCount: z.number(),
  accessSetting: z.string(),
  linked: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
const filePage = z.object({items: z.array(fileItemSchema), nextCursor: z.string().nullable()});
const facetsSchema = z.object({
  facets: z.object({
    total: z.number(),
    kinds: z.array(z.object({kind: z.string(), count: z.number()})),
    projects: z.array(z.object({projectId: z.string(), count: z.number()})),
    tags: z.array(z.object({tag: z.string(), count: z.number()})),
  }),
});
const folderResult = z.object({folder: z.object({id: z.string(), revision: z.number()}).loose()});
const projectResult = z.object({project: z.object({id: z.string()})});
const batchSchema = z.object({
  operation: z.string(),
  results: z.array(z.object({
    index: z.number(),
    item: z.object({kind: z.string()}).loose(),
    status: z.enum(["ok", "conflict", "not-found", "refused"]),
    result: z.json().optional(),
    error: z.object({code: z.string(), message: z.string()}).loose().optional(),
  })),
});
const toolEnvelope = z.object({result: z.object({isError: z.boolean().optional(), structuredContent: z.json().optional()})});
type Json = z.infer<ReturnType<typeof z.json>>;
type Cookies = Awaited<ReturnType<typeof signInAdministrator>>;

describe("file overview and batch operations", () => {
  let installation: TestInstallation;
  let source: TestInstallation;
  let server: RunningTestServer | null;

  beforeEach(async () => {
    installation = await createTestInstallation();
    source = await createTestInstallation();
    server = await startTestServer(installation, {linkedFiles: "on", linkRoots: [source.dataDirectory]});
  });
  afterEach(async () => {
    if (server !== null) await server.stop();
    await Promise.all([removeTestInstallation(installation), removeTestInstallation(source)]);
  });

  test("FOV-001-B: filters combine across projects and folders, every sort pages without duplicates, and facets match", async () => {
    const research = await createProject("Research");
    const reports = await createFolder(defaultProject, "Reports");
    const quarterly = await createFolder(defaultProject, "Quarterly", reports.id);
    const early = await publish({name: "Early brief", tags: ["draft"]});
    const notes = await publish({name: "Field notes", mediaType: "text/markdown", path: "notes.md", tags: ["draft", "review"]});
    const table = await publish({name: "Budget table", mediaType: "text/csv", path: "budget.csv", content: "a,b\n1,2\n", projectId: research});
    await place(notes, reports.id);
    const nested = await publish({name: "Quarter summary", tags: ["review"]});
    await place(nested, quarterly.id);
    const boundary = nested.version.createdAt;
    const linked = await linkFile("linked.html");
    const updated = await publishVersion(running(), installation, {
      artifactId: early.artifact.id, expectedCurrentVersionId: early.version.id,
      content: "<!doctype html><title>Early brief, revised with a longer body</title>",
      idempotencyKey: randomUUID(), projectId: defaultProject,
    });
    expect(updated.response.status).toBe(201);
    await comment(notes);
    await comment(notes);
    await comment(table);

    const everything = await files();
    expect(everything.items.map(({id}) => id)).toEqual([
      early.artifact.id, linked.artifact.id, nested.artifact.id, table.artifact.id, notes.artifact.id,
    ]);
    const byId = new Map(everything.items.map((item) => [item.id, item]));
    expect(byId.get(early.artifact.id)).toMatchObject({
      projectId: defaultProject, projectName: "Default", folderId: null, folderPath: [], fileKind: "html",
      currentVersionId: updated.body.version.id, currentVersionNumber: 2, versionCount: 2,
      entryMediaType: "text/html; charset=utf-8", tags: ["draft"], linked: null,
      createdAt: early.artifact.createdAt, updatedAt: updated.body.version.createdAt,
    });
    expect(byId.get(nested.artifact.id)).toMatchObject({
      folderId: quarterly.id,
      folderPath: [{id: reports.id, name: "Reports"}, {id: quarterly.id, name: "Quarterly"}],
    });
    expect(byId.get(notes.artifact.id)).toMatchObject({fileKind: "markdown", commentCount: 2, size: Buffer.byteLength("Fixture body")});
    expect(byId.get(table.artifact.id)).toMatchObject({projectId: research, projectName: "Research", fileKind: "data"});
    expect(byId.get(linked.artifact.id)).toMatchObject({linked: "in-sync"});

    const ids = async (query: string) => (await files(query)).items.map(({id}) => id).toSorted();
    expect(await ids(`projectId=${research}`)).toEqual(sorted(table));
    expect(await ids(`projectId=${research}&projectId=${defaultProject}`)).toHaveLength(5);
    expect(await ids(`folderId=${reports.id}`)).toEqual(sorted(notes, nested));
    expect(await ids(`folderId=${reports.id}&recursive=false`)).toEqual(sorted(notes));
    expect(await ids("kind=markdown&kind=data")).toEqual(sorted(notes, table));
    expect(await ids("tag=review")).toEqual(sorted(notes, nested));
    expect(await ids("tag=draft&tag=review")).toEqual(sorted(early, notes, nested));
    expect(await ids("linked=linked")).toEqual(sorted(linked));
    expect(await ids("linked=not-linked")).toHaveLength(4);
    expect(await ids("linked=drifted")).toEqual([]);
    expect(await ids(`createdAfter=${encodeURIComponent(boundary)}`)).toEqual(sorted(nested, linked));
    expect(await ids(`createdBefore=${encodeURIComponent(boundary)}`)).toEqual(sorted(early, notes, table));
    expect(await ids(`updatedAfter=${encodeURIComponent(updated.body.version.createdAt)}`)).toEqual(sorted(early));
    expect(await ids(`updatedBefore=${encodeURIComponent(boundary)}`)).toEqual(sorted(notes, table));
    expect(await ids("search=QUARTER")).toEqual(sorted(nested));
    expect(await ids("search=draft")).toEqual(sorted(early, notes));
    expect(await ids(`kind=html&tag=review&projectId=${defaultProject}&folderId=${reports.id}`)).toEqual(sorted(nested));

    const orders = ["updated", "created", "name", "size", "comments"].flatMap((sort) =>
      ["asc", "desc"].map((direction) => `sort=${sort}&direction=${direction}`));
    await Promise.all(orders.map(async (order) => {
      const whole = (await files(`${order}&limit=100`)).items.map(({id}) => id);
      const paged = await pagedIds(order);
      expect(paged).toEqual(whole);
      expect(new Set(paged).size).toBe(5);
    }));
    expect((await files("sort=name")).items.map(({name}) => name)).toEqual([
      "Budget table", "Early brief", "Field notes", "linked.html", "Quarter summary",
    ]);
    expect((await files("sort=comments")).items.slice(0, 2).map(({id}) => id)).toEqual([notes.artifact.id, table.artifact.id]);

    await Promise.all(["", "tag=draft", `projectId=${defaultProject}&kind=html`, `folderId=${reports.id}`].map(async (query) => {
      const {items} = await files(`${query}&limit=100`);
      const {facets} = facetsSchema.parse(await (await request(`/api/v1/files/facets?${query}`)).json());
      expect(facets.total).toBe(items.length);
      expect(facets.kinds.reduce((sum, {count}) => sum + count, 0)).toBe(items.length);
      expect(facets.kinds.toSorted((a, b) => a.kind.localeCompare(b.kind))).toEqual(countBy(items.map(({fileKind}) => fileKind))
        .map(([kind, count]) => ({kind, count})));
      expect(facets.projects.toSorted((a, b) => a.projectId.localeCompare(b.projectId))).toEqual(countBy(items.map(({projectId}) => projectId))
        .map(([projectId, count]) => ({projectId, count})));
      expect(facets.tags.toSorted((a, b) => a.tag.localeCompare(b.tag))).toEqual(countBy(items.flatMap(({tags}) => tags))
        .map(([tag, count]) => ({tag, count})));
    }));

    const http = await files(`tag=review&projectId=${defaultProject}`);
    const viaMcp = z.object({items: z.array(fileItemSchema), facets: z.object({total: z.number()}).loose()}).loose()
      .parse((await tool("file_search", {tags: ["review"], projectIds: [defaultProject]})).structuredContent);
    expect(viaMcp.items).toEqual(http.items);
    expect(viaMcp.facets.total).toBe(2);
    const viaCli = filePage.parse(await cli("files", "--tag", "review", "--project", defaultProject));
    expect(viaCli.items).toEqual(http.items);
  });

  test("FOV-001-F: trashed and purged files never appear, unknown scopes disclose nothing, bad filters are refused, and listing needs authority", async () => {
    const live = await publish({name: "Live report"});
    const trashed = await publish({name: "Trashed report"});
    const purged = await publish({name: "Purged report"});
    const folder = await createFolder(defaultProject, "Doomed");
    const inFolder = await publish({name: "Inside the doomed folder"});
    await place(inFolder, folder.id);
    expect((await request(`/api/v1/artifacts/${trashed.artifact.id}?projectId=${defaultProject}`, "DELETE",
      {expectedCurrentVersionId: trashed.version.id})).status).toBe(200);
    expect((await request(`/api/v1/artifacts/${purged.artifact.id}?projectId=${defaultProject}`, "DELETE",
      {expectedCurrentVersionId: purged.version.id})).status).toBe(200);
    const cookies = await signInAdministrator(running(), installation);
    expect((await human(cookies, `/api/v1/artifacts/${purged.artifact.id}/purge?projectId=${defaultProject}`, "POST",
      {confirm: "Purged report"})).status).toBe(200);
    expect((await request(`/api/v1/projects/${defaultProject}/folders/${folder.id}?expectedRevision=1`, "DELETE")).status).toBe(200);

    expect((await files()).items.map(({id}) => id)).toEqual([live.artifact.id]);
    expect((await files("search=report")).items.map(({id}) => id)).toEqual([live.artifact.id]);
    const facets = facetsSchema.parse(await (await request("/api/v1/files/facets")).json()).facets;
    expect(facets).toMatchObject({total: 1, kinds: [{kind: "html", count: 1}], projects: [{projectId: defaultProject, count: 1}]});

    await expectFailure(await request("/api/v1/files?projectId=prj_unknown"), 404, "PROJECT_NOT_FOUND");
    await expectFailure(await request(`/api/v1/files?folderId=fld_${randomUUID()}`), 404, "FOLDER_NOT_FOUND");
    await expectFailure(await request(`/api/v1/files?folderId=${folder.id}`), 404, "FOLDER_NOT_FOUND");
    const other = await createTestInstallation();
    try {
      const foreignServer = await startTestServer(other);
      try {
        const foreignFolder = folderResult.parse(await (await fetch(`${foreignServer.baseUrl}/api/v1/projects/${defaultProject}/folders`, {
          method: "POST", headers: apiHeaders(other, randomUUID()), body: JSON.stringify({name: "Elsewhere", parentFolderId: null}),
        })).json()).folder;
        await expectFailure(await request(`/api/v1/files?folderId=${foreignFolder.id}`), 404, "FOLDER_NOT_FOUND");
      } finally {
        await foreignServer.stop();
      }
    } finally {
      await removeTestInstallation(other);
    }
    await Promise.all([
      "kind=spreadsheet", "linked=sometimes", "sort=random", "direction=sideways", "limit=0", "limit=101",
      "createdAfter=yesterday", "updatedBefore=2026-13-45T00:00:00Z", "folderId=Reports", "recursive=maybe",
      "cursor=not-a-cursor", `tag=${"x".repeat(41)}`,
    ].map(async (malformed) => expectFailure(await request(`/api/v1/files?${malformed}`), 422, "INVALID_INPUT")));
    await publish({name: "Second live report"});
    const first = await files("sort=updated&limit=1");
    await expectFailure(await request(`/api/v1/files?sort=name&cursor=${first.nextCursor ?? ""}`), 422, "INVALID_INPUT");
    expect(await tool("file_search", {kinds: ["spreadsheet"]})).toMatchObject({isError: true});
    expect(await tool("file_search", {projectIds: ["prj_unknown"]}))
      .toMatchObject({isError: true, structuredContent: {error: {code: "PROJECT_NOT_FOUND"}}});

    const writer = await issueApiKey(running(), cookies, ["comment:write"], "Comment-only key");
    await expectFailure(await fetch(`${running().baseUrl}/api/v1/files`, {headers: {Authorization: `Bearer ${writer}`}}),
      403, "AUTHORIZATION_DENIED");
    await expectFailure(await fetch(`${running().baseUrl}/api/v1/files/facets`, {headers: {Authorization: `Bearer ${writer}`}}),
      403, "AUTHORIZATION_DENIED");
    expect(await tool("file_search", {}, writer))
      .toMatchObject({isError: true, structuredContent: {error: {code: "AUTHORIZATION_DENIED"}}});
    expect((await fetch(`${running().baseUrl}/api/v1/files`)).status).toBe(401);
  });

  test("FOV-002-B: kinds follow the current version's media type, refine octet-stream by extension, and follow a restore", async () => {
    const fixtures = [
      {kind: "html", mediaType: "text/html; charset=utf-8", path: "page.html"},
      {kind: "markdown", mediaType: "text/markdown", path: "notes.md"},
      {kind: "pdf", mediaType: "application/pdf", path: "paper.pdf"},
      {kind: "image", mediaType: "image/png", path: "chart.png"},
      {kind: "video", mediaType: "video/mp4", path: "clip.mp4"},
      {kind: "audio", mediaType: "audio/mpeg", path: "voice.mp3"},
      {kind: "data", mediaType: "application/json", path: "data.json"},
      {kind: "code", mediaType: "text/javascript", path: "tool.js"},
      {kind: "archive", mediaType: "application/zip", path: "bundle.zip"},
      {kind: "text", mediaType: "text/plain", path: "readme.txt"},
      {kind: "other", mediaType: "application/octet-stream", path: "blob.bin"},
      {kind: "markdown", mediaType: "application/octet-stream", path: "exported.md"},
      {kind: "code", mediaType: "text/plain", path: "script.ts"},
    ];
    const published = await Promise.all(fixtures.map(async ({kind, mediaType, path: entryPath}) => ({
      kind, path: entryPath, id: (await publish({name: entryPath, mediaType, path: entryPath})).artifact.id,
    })));
    const site = await publishSite("Multi-file site", [
      {path: "index.html", mediaType: "text/html; charset=utf-8", bytes: new TextEncoder().encode("<!doctype html><title>Site</title>")},
      {path: "style.css", mediaType: "text/css", bytes: new TextEncoder().encode("body{color:black}")},
    ]);
    const kinds = new Map((await files("limit=100")).items.map((item) => [item.id, item.fileKind]));
    for (const fixture of published) expect([fixture.path, kinds.get(fixture.id)]).toEqual([fixture.path, fixture.kind]);
    expect(kinds.get(site.artifact.id)).toBe("site");
    expect((await files("kind=site")).items.map(({id}) => id)).toEqual([site.artifact.id]);
    expect((await files("kind=markdown")).items.map(({name}) => name).toSorted()).toEqual(["exported.md", "notes.md"]);

    const evolving = await publish({name: "Evolving", mediaType: "text/markdown", path: "evolving.md"});
    const second = await publishVersion(running(), installation, {
      artifactId: evolving.artifact.id, expectedCurrentVersionId: evolving.version.id, content: "{\"rows\": []}",
      mediaType: "application/json", path: "evolving.json", idempotencyKey: randomUUID(), projectId: defaultProject,
    });
    expect(await kindOf(evolving.artifact.id)).toBe("data");
    const restored = await request(`/api/v1/artifacts/${evolving.artifact.id}/restore?projectId=${defaultProject}`, "POST", {
      versionId: evolving.version.id, expectedCurrentVersionId: second.body.version.id,
    });
    expect(restored.status).toBe(200);
    expect(await kindOf(evolving.artifact.id)).toBe("markdown");
    expect((await files("kind=data")).items.map(({id}) => id)).not.toContain(evolving.artifact.id);
  });

  test("FOV-002-F: an octet-stream .html or .svg file is classified for filtering but served only as a typed download", async () => {
    const page = await publish({
      name: "Disguised page", mediaType: "application/octet-stream", path: "page.html",
      content: "<!doctype html><script>document.title='ran'</script>",
    });
    const drawing = await publish({
      name: "Disguised drawing", mediaType: "application/octet-stream", path: "drawing.svg",
      content: "<svg xmlns='http://www.w3.org/2000/svg'><script>alert(1)</script></svg>",
    });
    expect((await files("kind=html")).items.map(({id}) => id)).toEqual([page.artifact.id]);
    expect((await files("kind=image")).items.map(({id}) => id)).toEqual([drawing.artifact.id]);
    await Promise.all([page, drawing].map(async (artifact) => {
      const item = (await files()).items.find(({id}) => id === artifact.artifact.id);
      expect(item?.entryMediaType).toBe("application/octet-stream");
      const response = await fetchVersion(running(), artifact.links.version);
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toBe("application/octet-stream");
      expect(response.headers.get("content-disposition")).toBe("attachment");
      expect(response.headers.get("x-content-type-options")).toBe("nosniff");
      const manifest = z.object({current: z.object({manifest: z.object({entries: z.array(z.object({
        mediaType: z.string(), disposition: z.string(),
      }).loose())}).loose()}).loose()}).loose()
        .parse(await (await request(`/api/v1/artifacts/${artifact.artifact.id}?projectId=${defaultProject}`)).json());
      expect(manifest.current.manifest.entries).toEqual([
        expect.objectContaining({mediaType: "application/octet-stream", disposition: "attachment"}),
      ]);
    }));
  });

  test("FLD-005-B: a 100-item move with one stale item moves 99, reports the conflict, and replays identically", async () => {
    const destination = await createFolder(defaultProject, "Archive");
    const artifacts = await Promise.all(Array.from({length: 100}, (_, index) => publish({name: `Batch item ${index}`})));
    const stale = artifacts[37];
    if (stale === undefined) throw new Error("The fixture needs 100 artifacts.");
    const newer = await publishVersion(running(), installation, {
      artifactId: stale.artifact.id, expectedCurrentVersionId: stale.version.id, content: "Changed elsewhere",
      idempotencyKey: randomUUID(), projectId: defaultProject,
    });
    const body = {
      operation: "move",
      items: artifacts.map(guard),
      params: {toFolderId: destination.id},
      idempotencyKey: randomUUID(),
    };
    const first = await batch(body);
    expect(first.results.map(({index}) => index)).toEqual([...Array.from({length: 100}).keys()]);
    expect(first.results.filter(({status}) => status === "ok")).toHaveLength(99);
    expect(first.results[37]).toMatchObject({
      status: "conflict", item: {artifactId: stale.artifact.id},
      error: {code: "PUBLISH_CONFLICT", currentVersionId: newer.body.version.id},
    });
    expect(first.results[0]).toMatchObject({status: "ok", result: {id: artifacts[0]?.artifact.id, folderId: destination.id}});
    const moved = await files(`folderId=${destination.id}&limit=100`);
    expect(moved.items).toHaveLength(99);
    expect(moved.items.map(({id}) => id)).not.toContain(stale.artifact.id);
    const actionsBefore = actionCount();

    expect(await batch(body)).toEqual(first);
    expect(actionCount()).toBe(actionsBefore);
    expect(batchSchema.parse((await tool("batch_apply", body)).structuredContent)).toEqual(first);
    expect(actionCount()).toBe(actionsBefore);

    const tagged = await batch({
      operation: "tag-add", items: artifacts.slice(0, 3).map(guard), params: {tags: ["Q4"]}, idempotencyKey: randomUUID(),
    });
    expect(tagged.results.map(({status}) => status)).toEqual(["ok", "ok", "ok"]);
    expect((await files("tag=q4")).items).toHaveLength(3);
    const removed = await batch({
      operation: "tag-remove", items: artifacts.slice(0, 1).map(guard), params: {tags: ["q4"]}, idempotencyKey: randomUUID(),
    });
    expect(removed.results.map(({status}) => status)).toEqual(["ok"]);
    expect((await files("tag=q4")).items).toHaveLength(2);
    const trashed = await batch({operation: "trash", items: artifacts.slice(0, 2).map(guard), params: {}, idempotencyKey: randomUUID()});
    expect(trashed.results.map(({status}) => status)).toEqual(["ok", "ok"]);
    expect((await files(`folderId=${destination.id}&limit=100`)).items).toHaveLength(97);
    const recovered = await batch({operation: "recover", items: artifacts.slice(0, 2).map(guard), params: {}, idempotencyKey: randomUUID()});
    expect(recovered.results.map(({status}) => status)).toEqual(["ok", "ok"]);
    expect((await files(`folderId=${destination.id}&limit=100`)).items).toHaveLength(99);

    const tokenFile = path.join(installation.dataDirectory, "fixture.key");
    const itemsFile = path.join(installation.dataDirectory, "items.json");
    await writeFile(tokenFile, installation.apiToken, {mode: 0o600});
    await writeFile(itemsFile, JSON.stringify(artifacts.slice(5, 7).map(guard)));
    const viaCli = batchSchema.parse(await cli("batch", "move", "--items", itemsFile, "--to-folder", "root"));
    expect(viaCli.results.map(({status}) => status)).toEqual(["ok", "ok"]);
    expect((await files(`folderId=${destination.id}&limit=100`)).items).toHaveLength(97);
  });

  test("FLD-005-F: invalid batches are refused before any work and each item is authorized on its own", async () => {
    const first = await publish({name: "First"});
    const second = await publish({name: "Second"});
    const artifacts = [first, second, await publish({name: "Third"})];
    const before = snapshot();
    const refuse = async (body: Json, code: string) => {
      const response = await request("/api/v1/batch", "POST", body);
      await expectFailure(response, 422, code);
    };
    await refuse({operation: "trash", items: [], params: {}, idempotencyKey: randomUUID()}, "INVALID_INPUT");
    await refuse({
      operation: "trash", items: Array.from({length: 101}, () => guard(first)),
      params: {}, idempotencyKey: randomUUID(),
    }, "INVALID_INPUT");
    await refuse({operation: "trash", items: [guard(first), guard(first)], params: {}, idempotencyKey: randomUUID()}, "INVALID_INPUT");
    await refuse({operation: "move", items: artifacts.map(guard), params: {}, idempotencyKey: randomUUID()}, "INVALID_INPUT");
    await refuse({operation: "tag-add", items: artifacts.map(guard), params: {tags: []}, idempotencyKey: randomUUID()}, "INVALID_INPUT");
    await refuse({operation: "trash", items: artifacts.map(guard), params: {}, idempotencyKey: "short"}, "INVALID_INPUT");
    await refuse({operation: "explode", items: artifacts.map(guard), params: {}, idempotencyKey: randomUUID()}, "INVALID_INPUT");
    await refuse({operation: "purge", items: artifacts.map(guard), params: {}, idempotencyKey: randomUUID()}, "PURGE_CONFIRMATION_MISMATCH");
    await refuse({operation: "purge", items: artifacts.map(guard), params: {}, idempotencyKey: randomUUID(), confirm: "purge 2 items"}, "PURGE_CONFIRMATION_MISMATCH");
    expect(snapshot()).toEqual(before);

    const archived = await createProject("Frozen");
    const frozen = await publish({name: "Frozen report", projectId: archived});
    expect((await request(`/api/v1/projects/${archived}/archive`, "POST")).status).toBe(200);
    const mixed = await batch({
      operation: "move",
      items: [
        guard(first), guard(frozen),
        {kind: "artifact", projectId: defaultProject, artifactId: `art_${randomUUID()}`, expectedCurrentVersionId: "ver_unknown"},
        guard(second),
      ],
      params: {toFolderId: null},
      idempotencyKey: randomUUID(),
    });
    expect(mixed.results.map(({status, error}) => [status, error?.code ?? null])).toEqual([
      ["ok", null], ["refused", "PROJECT_ARCHIVED"], ["not-found", "ARTIFACT_NOT_FOUND"], ["ok", null],
    ]);

    const cookies = await signInAdministrator(running(), installation);
    const reader = await issueApiKey(running(), cookies, ["artifact:read"], "Read-only key");
    const denied = batchSchema.parse(await (await fetch(`${running().baseUrl}/api/v1/batch`, {
      method: "POST",
      headers: {Authorization: `Bearer ${reader}`, "Content-Type": "application/json"},
      body: JSON.stringify({operation: "trash", items: artifacts.map(guard), params: {}, idempotencyKey: randomUUID()}),
    })).json());
    expect(denied.results.map(({status, error}) => [status, error?.code])).toEqual(
      artifacts.map(() => ["refused", "AUTHORIZATION_DENIED"]),
    );
    // Archived projects stay readable, so their files stay listed.
    expect((await files()).items).toHaveLength(4);

    const trashed = await batch({operation: "trash", items: artifacts.slice(0, 2).map(guard), params: {}, idempotencyKey: randomUUID()});
    expect(trashed.results.map(({status}) => status)).toEqual(["ok", "ok"]);
    const purgeBody = {
      operation: "purge", items: artifacts.map(guard), params: {}, idempotencyKey: randomUUID(), confirm: "purge 3 items",
    };
    const asService = await batch(purgeBody);
    expect(asService.results.map(({status, error}) => [status, error?.code])).toEqual(
      artifacts.map(() => ["refused", "AUTHORIZATION_DENIED"]),
    );
    const asPerson = batchSchema.parse(await (await human(cookies, "/api/v1/batch", "POST", {...purgeBody, idempotencyKey: randomUUID()})).json());
    expect(asPerson.results.map(({status, error}) => [status, error?.code ?? null])).toEqual([
      ["ok", null], ["ok", null], ["refused", "NOT_IN_TRASH"],
    ]);
  });

  function running(): RunningTestServer {
    if (server === null) throw new Error("Start the fixture server first.");
    return server;
  }

  function readDatabase<Result>(operation: (database: DatabaseSync) => Result): Result {
    const database = new DatabaseSync(path.join(installation.dataDirectory, "artifact-server.db"));
    try {
      return operation(database);
    } finally {
      database.close();
    }
  }

  function snapshot() {
    return readDatabase((database) => Object.fromEntries(["artifacts", "actions", "artifact_tags", "idempotency_records"]
      .map((table) => [table, database.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()])));
  }

  function actionCount(): number {
    return readDatabase((database) => z.object({count: z.number()})
      .parse(database.prepare("SELECT COUNT(*) AS count FROM actions").get()).count);
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

  async function files(query = "") {
    const response = await request(`/api/v1/files?${query}`);
    expect(response.status).toBe(200);
    return filePage.parse(await response.json());
  }

  async function pagedIds(query: string, cursor: string | null = null): Promise<string[]> {
    const page = await files(`${query}&limit=2${cursor === null ? "" : `&cursor=${cursor}`}`);
    const ids = page.items.map(({id}) => id);
    return page.nextCursor === null ? ids : [...ids, ...await pagedIds(query, page.nextCursor)];
  }

  async function kindOf(artifactId: string): Promise<string | undefined> {
    return (await files("limit=100")).items.find(({id}) => id === artifactId)?.fileKind;
  }

  async function batch(body: Json) {
    const response = await request("/api/v1/batch", "POST", body);
    expect(response.status).toBe(200);
    return batchSchema.parse(await response.json());
  }

  async function createProject(name: string): Promise<string> {
    const response = await request("/api/v1/projects", "POST", {name});
    expect(response.status).toBe(201);
    return projectResult.parse(await response.json()).project.id;
  }

  async function createFolder(projectId: string, name: string, parentFolderId: string | null = null) {
    const response = await request(`/api/v1/projects/${projectId}/folders`, "POST", {name, parentFolderId});
    expect(response.status).toBe(201);
    return folderResult.parse(await response.json()).folder;
  }

  async function publish(input: {
    readonly name: string;
    readonly content?: string;
    readonly mediaType?: string;
    readonly path?: string;
    readonly projectId?: string;
    readonly tags?: readonly string[];
  }): Promise<PublishResponse> {
    const result = await publishNew(running(), installation, {
      accessSetting: "public_link",
      content: input.content ?? "Fixture body",
      idempotencyKey: randomUUID(),
      name: input.name,
      mediaType: input.mediaType ?? "text/html; charset=utf-8",
      path: input.path ?? "index.html",
      projectId: input.projectId ?? defaultProject,
      tags: input.tags ?? [],
    });
    expect(result.response.status).toBe(201);
    return result.body;
  }

  async function publishSite(name: string, siteFiles: readonly TestSiteFile[]): Promise<PublishResponse> {
    const upload = await createStagedUpload(running(), installation, "index.html", siteFiles, defaultProject);
    expect(upload.response.status).toBe(201);
    expect((await uploadEveryStagedFile(installation, upload.body, siteFiles)).every(({ok}) => ok)).toBe(true);
    const committed = await commitStagedUpload(installation, upload.body, randomUUID(), {
      kind: "new_artifact", name, accessSetting: "account_required",
    });
    expect(committed.response.status).toBe(201);
    return committed.body;
  }

  async function place(artifact: PublishResponse, toFolderId: string) {
    const result = await request(`/api/v1/artifacts/${artifact.artifact.id}/move?projectId=${artifact.artifact.projectId}`, "POST",
      {toFolderId, expectedCurrentVersionId: artifact.version.id});
    expect(result.status).toBe(200);
  }

  async function comment(artifact: PublishResponse) {
    const response = await request(
      `/api/v1/artifacts/${artifact.artifact.id}/versions/${artifact.version.id}/comments?projectId=${artifact.artifact.projectId}`,
      "POST", {body: "Check this."},
    );
    expect(response.status).toBe(201);
  }

  async function linkFile(name: string): Promise<PublishResponse> {
    const sourcePath = path.join(source.dataDirectory, name);
    await writeFile(sourcePath, "<!doctype html><title>Linked</title>");
    const response = await request("/api/v1/artifacts/link", "POST", {path: sourcePath, projectId: defaultProject});
    expect(response.status).toBe(201);
    return parsePublishResponse(await response.json());
  }

  async function cli(...args: readonly string[]): Promise<Json> {
    const tokenFile = path.join(installation.dataDirectory, "fixture.key");
    await writeFile(tokenFile, installation.apiToken, {mode: 0o600});
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
            [CLIENT_INFO_META_KEY]: {name: "file-overview-tests", version: "1"},
            [PROTOCOL_VERSION_META_KEY]: protocol,
          },
        },
      }),
    });
    expect(response.status).toBe(200);
    return toolEnvelope.parse(await response.json()).result;
  }
});

function guard(artifact: PublishResponse) {
  return {
    kind: "artifact" as const,
    projectId: artifact.artifact.projectId,
    artifactId: artifact.artifact.id,
    expectedCurrentVersionId: artifact.version.id,
  };
}

function sorted(...artifacts: PublishResponse[]): string[] {
  return artifacts.map(({artifact}) => artifact.id).toSorted();
}

function countBy(values: readonly string[]): [string, number][] {
  const counts = new Map<string, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return [...counts.entries()].toSorted(([a], [b]) => a.localeCompare(b));
}

async function expectFailure(response: Response, status: number, code: string): Promise<void> {
  expect(response.status).toBe(status);
  await expect(response.json()).resolves.toMatchObject({error: {code}});
}
