import {request} from "node:http";
import {mkdir, mkdtemp, realpath, rm, symlink, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import path from "node:path";

import {Effect, Redacted} from "effect";
import {afterEach, beforeEach, describe, expect, test} from "vitest";
import {z} from "zod";

import type {BearerCredentialVerifier} from "../../src/application/authentication.js";
import {AuthenticationRequired} from "../../src/core/errors.js";
import {
  defaultProject, expectFailure, folderLinkResultSchema, folderLinkSchema, historyCounts, LinkedFolderClient, withDatabase,
} from "../support/linked-folders.js";
import {
  createTestInstallation, removeTestInstallation, type RunningTestServer, startTestServer,
  type TestInstallation,
} from "../support/runtime-harness.js";

const serviceCredential = "lfd-001-unscoped-service-credential";
const unscopedVerifier: BearerCredentialVerifier = {
  verify: (credential) => Redacted.value(credential) === serviceCredential
    ? Effect.succeed({
      authorizedByPrincipalId: null,
      capabilities: [],
      displayName: "Unscoped automation",
      id: "service:lfd_001_unscoped",
      installationId: "local",
      kind: "service",
      membershipRole: "member",
    })
    : Effect.fail(new AuthenticationRequired({message: "The external credential is invalid."})),
};

const folderPageSchema = z.object({
  folders: z.array(z.object({id: z.string(), name: z.string()}).loose()),
}).loose();
const linkCountSchema = z.object({count: z.number().int()});

function postWithHost(server: RunningTestServer, hostname: string, pathname: string, body: string, token: string) {
  return new Promise<{readonly body: string; readonly status: number}>((resolve, reject) => {
    const outgoing = request({
      headers: [
        "Host", `${hostname}:${server.port}`,
        "Authorization", `Bearer ${token}`,
        "Content-Type", "application/json",
        "Idempotency-Key", "lfd-001-non-loopback-0001",
        "Content-Length", String(Buffer.byteLength(body)),
      ],
      hostname: "127.0.0.1",
      method: "POST",
      path: pathname,
      port: server.port,
    }, (incoming) => {
      const chunks: Buffer[] = [];
      incoming.on("data", (chunk: Buffer) => chunks.push(chunk));
      incoming.on("end", () => resolve({body: Buffer.concat(chunks).toString("utf8"), status: incoming.statusCode ?? 500}));
    });
    outgoing.on("error", reject);
    outgoing.end(body);
  });
}

describe("linking a folder binds one canonical directory and creates no history", () => {
  let installation: TestInstallation;
  let server: RunningTestServer | null = null;
  let sourceRoot: string;
  let outsideRoot: string;

  beforeEach(async () => {
    installation = await createTestInstallation();
    sourceRoot = await realpath(await mkdtemp(path.join(tmpdir(), "lfd-001-root-")));
    outsideRoot = await realpath(await mkdtemp(path.join(tmpdir(), "lfd-001-outside-")));
  });

  afterEach(async () => {
    if (server !== null) await server.stop();
    server = null;
    await removeTestInstallation(installation);
    await rm(sourceRoot, {force: true, recursive: true});
    await rm(outsideRoot, {force: true, recursive: true});
  });

  test("LFD-001-B: HTTP, MCP, and the CLI each link a directory with a folder, a first scan, and no artifact, version, or action", async () => {
    server = await startTestServer(installation, {linkRoots: [sourceRoot], linkedFiles: "on", linkedFolderWatch: "off"});
    const client = new LinkedFolderClient(server, installation.apiToken);
    await Promise.all(["http-out", "mcp-out", "cli-out"].map(async (name) => {
      await mkdir(path.join(sourceRoot, name, "nested"), {recursive: true});
      await writeFile(path.join(sourceRoot, name, "index.html"), `<h1>${name}</h1>`);
      await writeFile(path.join(sourceRoot, name, "nested", "notes.md"), `# ${name}\n`);
    }));
    const before = historyCounts(installation);

    const overHttp = await client.linkOk(path.join(sourceRoot, "http-out"), {name: "HTTP output"});
    expect(overHttp).toMatchObject({
      entryCount: 2, path: path.join(sourceRoot, "http-out"), pendingCount: 2, projectId: defaultProject, state: "active",
    });
    expect(overHttp.lastScanCompletedAt).not.toBeNull();

    const overMcp = await client.tool("folder_link", {newFolderName: "MCP output", path: path.join(sourceRoot, "mcp-out")});
    expect(overMcp.isError).not.toBe(true);
    const mcpLink = folderLinkResultSchema.parse(overMcp.structuredContent).folderLink;
    expect(mcpLink).toMatchObject({entryCount: 2, state: "active"});
    expect(mcpLink.lastScanCompletedAt).not.toBeNull();

    const tokenFile = path.join(installation.dataDirectory, "lfd-001.key");
    await writeFile(tokenFile, installation.apiToken, {mode: 0o600});
    const overCli = folderLinkResultSchema.parse(await client.cli(
      tokenFile, "link-folder", path.join(sourceRoot, "cli-out"), "--name", "CLI output",
    )).folderLink;
    expect(overCli).toMatchObject({entryCount: 2, path: path.join(sourceRoot, "cli-out"), state: "active"});

    const listed = z.object({folderLinks: z.array(folderLinkSchema)})
      .parse(await (await client.request(`/api/v1/projects/${defaultProject}/folder-links`)).json()).folderLinks;
    expect(listed.map((link) => link.id).toSorted()).toEqual([overHttp.id, mcpLink.id, overCli.id].toSorted());
    const root = folderPageSchema.parse(await (await client.request(`/api/v1/projects/${defaultProject}/folders/root`)).json());
    expect(root.folders.map((folder) => folder.name).toSorted()).toEqual(["CLI output", "HTTP output", "MCP output"]);
    expect(root.folders.map((folder) => folder.id).toSorted())
      .toEqual([overHttp.folderId, mcpLink.folderId, overCli.folderId].toSorted());

    const after = historyCounts(installation);
    expect(after).toEqual({...before, folder_actions: (before["folder_actions"] ?? 0) + 3, folders: (before["folders"] ?? 0) + 3});
    expect(after["artifacts"]).toBe(0);
    expect(after["versions"]).toBe(0);
    expect(after["actions"]).toBe(0);

    await mkdir(path.join(sourceRoot, "replay-out"));
    const replay = await client.linkOk(path.join(sourceRoot, "replay-out"), {key: "lfd-001-replay-key-0001", name: "Replay"});
    expect(await client.linkOk(path.join(sourceRoot, "replay-out"), {key: "lfd-001-replay-key-0001", name: "Replay"}))
      .toMatchObject({id: replay.id, revision: replay.revision});
  }, 60_000);

  test("LFD-001-F: files, symlinked, out-of-root, protected, and overlapping directories, foreign origins, unauthorized callers, and disabled deployments are refused with no record", async () => {
    server = await startTestServer(installation, {
      externalApiBearerVerifier: unscopedVerifier,
      linkRoots: [sourceRoot, installation.dataDirectory],
      linkedFiles: "on",
      linkedFolderWatch: "off",
    });
    const client = new LinkedFolderClient(server, installation.apiToken);
    const outputs = path.join(sourceRoot, "outputs");
    await mkdir(path.join(outputs, "child"), {recursive: true});
    await writeFile(path.join(outputs, "report.md"), "# report\n");

    const file = await expectFailure(await client.link(path.join(outputs, "report.md")), 422, "INVALID_LINK_PATH");
    expect(file).not.toContain(sourceRoot);
    await symlink(outputs, path.join(sourceRoot, "alias"));
    await expectFailure(await client.link(path.join(sourceRoot, "alias")), 422, "INVALID_LINK_PATH");
    const outside = await expectFailure(await client.link(outsideRoot), 403, "LINK_PATH_OUTSIDE_ROOTS");
    expect(outside).not.toContain(outsideRoot);
    await expectFailure(await client.link(path.join(sourceRoot, "..", path.basename(outsideRoot))), 403, "LINK_PATH_OUTSIDE_ROOTS");
    const protectedData = await expectFailure(await client.link(installation.dataDirectory), 403, "LINK_PATH_PROTECTED");
    expect(protectedData).not.toContain(installation.dataDirectory);
    await expectFailure(await client.link("relative/outputs"), 422, "INVALID_LINK_PATH");

    const anonymous = await fetch(new URL(`/api/v1/projects/${defaultProject}/folder-links`, server.baseUrl), {
      body: JSON.stringify({path: outputs}), headers: {"Content-Type": "application/json", "Idempotency-Key": "lfd-001-anonymous-01"},
      method: "POST",
    });
    expect(anonymous.status).toBe(401);
    const unauthorized = new LinkedFolderClient(server, serviceCredential);
    await expectFailure(await unauthorized.link(outputs), 403, "AUTHORIZATION_DENIED");
    const foreign = await postWithHost(
      server, "artifacts.example.com", `/api/v1/projects/${defaultProject}/folder-links`,
      JSON.stringify({path: outputs}), installation.apiToken,
    );
    expect([201, 200]).not.toContain(foreign.status);
    expect(foreign.body).not.toContain(outputs);
    const remoteMcp = await client.tool("folder_link", {path: outputs, projectId: defaultProject});
    expect(remoteMcp.isError).not.toBe(true);
    const linked = folderLinkResultSchema.parse(remoteMcp.structuredContent).folderLink;

    await expectFailure(await client.link(path.join(outputs, "child")), 409, "LINK_OVERLAP");
    await expectFailure(await client.link(sourceRoot), 409, "LINK_OVERLAP");
    await expectFailure(await client.link(outputs, {key: "lfd-001-second-link-01"}), 409, "LINK_OVERLAP");
    await expectFailure(await client.link(path.join(sourceRoot, "missing")), 422, "INVALID_LINK_PATH");
    expect(withDatabase(installation, (database) =>
      linkCountSchema.parse(database.prepare("SELECT COUNT(*) AS count FROM folder_links").get()).count)).toBe(1);
    expect(historyCounts(installation)["artifacts"]).toBe(0);
    expect(linked.path).toBe(outputs);

    await server.stop();
    server = await startTestServer(installation, {linkRoots: [sourceRoot], linkedFiles: "off"});
    const disabled = new LinkedFolderClient(server, installation.apiToken);
    await expectFailure(await disabled.link(outputs), 501, "CAPABILITY_UNAVAILABLE");
    const disabledTool = await disabled.tool("folder_link", {path: outputs});
    expect(disabledTool.isError).toBe(true);
    expect(JSON.stringify(disabledTool.structuredContent)).toContain("CAPABILITY_UNAVAILABLE");
    const capabilities = z.object({capabilities: z.object({linkedFolders: z.boolean()}).loose()}).loose()
      .parse(await (await disabled.request("/api/v1/session")).json());
    expect(capabilities.capabilities.linkedFolders).toBe(false);

    expect(withDatabase(installation, (database) =>
      linkCountSchema.parse(database.prepare("SELECT COUNT(*) AS count FROM folder_links").get()).count)).toBe(1);
  }, 60_000);
});
