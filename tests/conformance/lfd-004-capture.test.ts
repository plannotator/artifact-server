import {appendFile, mkdir, mkdtemp, realpath, rename, rm, symlink, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import path from "node:path";

import {afterEach, beforeEach, describe, expect, test} from "vitest";
import {z} from "zod";

import {
  defaultProject, historyCounts, type InventoryEntry, LinkedFolderClient,
} from "../support/linked-folders.js";
import {
  createTestInstallation, removeTestInstallation, type RunningTestServer, startTestServer,
  type TestInstallation,
} from "../support/runtime-harness.js";

const folderPageSchema = z.object({
  artifacts: z.array(z.object({artifact: z.object({folderId: z.string().nullable(), id: z.string(), name: z.string()}).loose()}).loose()),
  folders: z.array(z.object({id: z.string(), name: z.string()}).loose()),
}).loose();
const actionsSchema = z.object({
  actions: z.array(z.object({action: z.string(), principalId: z.string(), versionId: z.string()}).loose()),
}).loose();
const sessionSchema = z.object({principal: z.object({id: z.string()}).loose()}).loose();
const versionsSchema = z.object({versions: z.array(z.object({version: z.object({number: z.number()}).loose()}).loose())}).loose();

async function write(root: string, relative: string, contents: string): Promise<void> {
  await mkdir(path.dirname(path.join(root, relative)), {recursive: true});
  await writeFile(path.join(root, relative), contents);
}

function entryId(entries: readonly InventoryEntry[], relativePath: string): string {
  const entry = entries.find((candidate) => candidate.relativePath === relativePath);
  if (entry === undefined) throw new Error(`No inventory entry for ${relativePath}.`);
  return entry.id;
}

describe("one explicit, attributed capture turns pending inventory into history", () => {
  let installation: TestInstallation;
  let server: RunningTestServer | null = null;
  let sourceRoot: string;

  beforeEach(async () => {
    installation = await createTestInstallation();
    sourceRoot = await realpath(await mkdtemp(path.join(tmpdir(), "lfd-004-")));
  });

  afterEach(async () => {
    if (server !== null) await server.stop();
    server = null;
    await removeTestInstallation(installation);
    await rm(sourceRoot, {force: true, recursive: true});
  });

  test("LFD-004-B: capturing all pending entries creates one linked artifact per file in mirrored subfolders, one version per changed tracked file, attributed actions, and identical replays", async () => {
    server = await startTestServer(installation, {linkRoots: [sourceRoot], linkedFiles: "on", linkedFolderWatch: "off"});
    const client = new LinkedFolderClient(server, installation.apiToken);
    const caller = sessionSchema.parse(await (await client.request("/api/v1/session")).json()).principal.id;
    await write(sourceRoot, "top.md", "# top\n");
    await write(sourceRoot, "docs/a.md", "# a\n");
    await write(sourceRoot, "docs/guide/b.md", "# b\n");
    await write(sourceRoot, ".well-known/c.txt", "c\n");
    const link = await client.linkOk(sourceRoot, {name: "Output"});

    const first = await client.captureOk(link.id, {all: true}, "lfd-004-capture-all-0001");
    expect(first.map((result) => [result.relativePath, result.status])).toEqual([
      [".well-known/c.txt", "captured"], ["docs/a.md", "captured"], ["docs/guide/b.md", "captured"], ["top.md", "captured"],
    ]);
    expect(await client.captureOk(link.id, {all: true}, "lfd-004-capture-all-0001")).toEqual(first);

    const linkFolder = folderPageSchema.parse(await (await client.request(
      `/api/v1/projects/${defaultProject}/folders/${link.folderId}`,
    )).json());
    expect(linkFolder.folders.map((folder) => folder.name).toSorted()).toEqual(["_well-known", "docs"]);
    expect(linkFolder.artifacts.map(({artifact}) => artifact.name)).toEqual(["top.md"]);
    const docs = linkFolder.folders.find((folder) => folder.name === "docs");
    const docsPage = folderPageSchema.parse(await (await client.request(
      `/api/v1/projects/${defaultProject}/folders/${docs?.id ?? ""}`,
    )).json());
    expect(docsPage.folders.map((folder) => folder.name)).toEqual(["guide"]);
    expect(docsPage.artifacts.map(({artifact}) => artifact.name)).toEqual(["a.md"]);
    const guidePage = folderPageSchema.parse(await (await client.request(
      `/api/v1/projects/${defaultProject}/folders/${docsPage.folders[0]?.id ?? ""}`,
    )).json());
    expect(guidePage.artifacts.map(({artifact}) => artifact.name)).toEqual(["b.md"]);

    const actionPages = await Promise.all(first.map(async (result) => ({
      actions: actionsSchema.parse(await (await client.request(`/api/v1/artifacts/${result.artifactId ?? ""}/actions`)).json()).actions,
      result,
    })));
    for (const {actions, result} of actionPages) {
      expect(actions).toEqual([expect.objectContaining({action: "link", principalId: caller, versionId: result.versionId})]);
    }
    expect((await client.inventory(link.id)).every((entry) => entry.state === "tracked" && !entry.pending)).toBe(true);

    await write(sourceRoot, "docs/a.md", "# a, second draft\n");
    await client.scan(link.id);
    const pending = await client.inventory(link.id, "pending=true");
    expect(pending.map((entry) => entry.relativePath)).toEqual(["docs/a.md"]);
    const second = await client.captureOk(link.id, {all: true}, "lfd-004-capture-all-0002");
    const changed = first.find((result) => result.relativePath === "docs/a.md");
    expect(second).toEqual([expect.objectContaining({artifactId: changed?.artifactId, status: "captured"})]);
    const versions = versionsSchema.parse(await (await client.request(`/api/v1/artifacts/${changed?.artifactId ?? ""}/versions`)).json());
    expect(versions.versions.map(({version}) => version.number).toSorted((left, right) => left - right)).toEqual([1, 2]);
    const counts = historyCounts(installation);
    expect(await client.captureOk(link.id, {all: true}, "lfd-004-capture-all-0002")).toEqual(second);
    const unchanged = await client.captureOk(link.id, {entryIds: [entryId(await client.inventory(link.id), "top.md")]});
    expect(unchanged).toEqual([expect.objectContaining({status: "unchanged"})]);
    expect(historyCounts(installation)).toEqual(counts);
  }, 60_000);

  test("LFD-004-F: a path swapped after the scan is refused as source-moved and a mid-read change aborts with drift, without affecting other entries", async () => {
    let driftOnce = true;
    server = await startTestServer(installation, {
      linkRoots: [sourceRoot],
      linkedFiles: "on",
      linkedFolderHooks: {
        afterFirstCaptureRead: async (canonicalPath) => {
          if (driftOnce && canonicalPath.endsWith("drifts.md")) {
            driftOnce = false;
            await appendFile(canonicalPath, "changed during the read\n");
          }
        },
      },
      linkedFolderWatch: "off",
    });
    const client = new LinkedFolderClient(server, installation.apiToken);
    await write(sourceRoot, "sub/swapped.md", "# swapped parent\n");
    await write(sourceRoot, "steady.md", "# steady\n");
    await write(sourceRoot, "drifts.md", "# drifts\n");
    const link = await client.linkOk(sourceRoot, {name: "Hostile capture"});
    const entries = await client.inventory(link.id);
    await rename(path.join(sourceRoot, "sub"), path.join(sourceRoot, "sub-real"));
    await symlink(path.join(sourceRoot, "sub-real"), path.join(sourceRoot, "sub"));

    const ids = ["sub/swapped.md", "steady.md", "drifts.md"].map((relative) => entryId(entries, relative));
    const results = await client.captureOk(link.id, {entryIds: ids}, "lfd-004-hostile-capture-1");
    expect(results.map((result) => [result.relativePath, result.status, result.code])).toEqual([
      ["sub/swapped.md", "refused", "SOURCE_MOVED"],
      ["steady.md", "captured", null],
      ["drifts.md", "refused", "SOURCE_DRIFTED"],
    ]);
    const artifacts = z.object({artifacts: z.array(z.object({artifact: z.object({name: z.string()}).loose()}).loose())}).loose()
      .parse(await (await client.request(`/api/v1/artifacts?projectId=${defaultProject}`)).json());
    expect(artifacts.artifacts.map(({artifact}) => artifact.name)).toEqual(["steady.md"]);

    // The drift was retryable, so replaying the same request retries only that entry.
    const retried = await client.captureOk(link.id, {entryIds: ids}, "lfd-004-hostile-capture-1");
    expect(retried[0]).toEqual(results[0]);
    expect(retried[1]).toEqual(results[1]);
    expect(retried[2]).toMatchObject({relativePath: "drifts.md", status: "captured"});

    const conflict = await client.capture(link.id, {entryIds: [ids[1] ?? ""]}, "lfd-004-hostile-capture-1");
    expect(conflict.status).toBe(409);
  }, 60_000);
});
