import {mkdtemp, realpath, rm, stat, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import path from "node:path";

import {
  CLIENT_CAPABILITIES_META_KEY,
  CLIENT_INFO_META_KEY,
  PROTOCOL_VERSION_META_KEY,
} from "@modelcontextprotocol/server";
import {afterEach, beforeEach, describe, expect, test} from "vitest";
import {z} from "zod";

import {
  apiHeaders,
  createTestInstallation,
  removeTestInstallation,
  type RunningTestServer,
  startTestServer,
  type TestInstallation,
} from "../support/runtime-harness.js";

const protocolVersion = "2026-07-28";

const linkedPublicationSchema = z.object({
  artifact: z.object({id: z.string().min(1)}).loose(),
  sourceBinding: z.object({
    path: z.string().min(1),
    status: z.enum(["in-sync", "modified", "missing", "unreadable"]),
  }).loose(),
}).loose();

const artifactListSchema = z.object({
  artifacts: z.array(z.object({
    artifact: z.object({id: z.string()}).loose(),
  }).loose()),
}).loose();

const sessionSchema = z.object({
  capabilities: z.object({
    gitHistory: z.unknown(),
    linkedArtifacts: z.boolean(),
  }).strict(),
}).loose();

const errorSchema = z.object({
  error: z.object({code: z.string(), message: z.string()}).loose(),
}).loose();

async function callTool(
  server: RunningTestServer,
  token: string,
  name: string,
  toolArguments: Readonly<Record<string, string>>,
) {
  const response = await fetch(`${server.baseUrl}/mcp`, {
    body: JSON.stringify({
      id: crypto.randomUUID(),
      jsonrpc: "2.0",
      method: "tools/call",
      params: {
        _meta: {
          [CLIENT_CAPABILITIES_META_KEY]: {},
          [CLIENT_INFO_META_KEY]: {name: "lnk-001-test", version: "1"},
          [PROTOCOL_VERSION_META_KEY]: protocolVersion,
        },
        arguments: toolArguments,
        name,
      },
    }),
    headers: {
      Accept: "application/json, text/event-stream",
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      "MCP-Protocol-Version": protocolVersion,
      "Mcp-Method": "tools/call",
      "Mcp-Name": name,
    },
    method: "POST",
  });
  expect(response.status).toBe(200);
  return z.object({
    result: z.object({
      content: z.array(z.object({text: z.string()}).loose()),
      isError: z.boolean().optional(),
      structuredContent: z.unknown().optional(),
    }).loose(),
  }).loose().parse(await response.json()).result;
}

describe("linked artifacts are off by default and reference in place", () => {
  let installation: TestInstallation;
  let server: RunningTestServer | null = null;
  let sourceRoot: string;

  beforeEach(async () => {
    installation = await createTestInstallation();
    sourceRoot = await realpath(
      await mkdtemp(path.join(tmpdir(), "lnk-001-sources-")),
    );
  });

  afterEach(async () => {
    if (server !== null) await server.stop();
    server = null;
    await removeTestInstallation(installation);
    await rm(sourceRoot, {force: true, recursive: true});
  });

  test("LNK-001-B: an enabled local deployment advertises the capability, links one file in place over HTTP and MCP, and never absorbs an unlinked file", async () => {
    expect.hasAssertions();
    server = await startTestServer(installation, {
      linkRoots: [sourceRoot],
      linkedFiles: "on",
    });

    const httpSource = path.join(sourceRoot, "http-notes.md");
    const mcpSource = path.join(sourceRoot, "mcp-notes.md");
    const neverLinked = path.join(sourceRoot, "bystander.md");
    await writeFile(httpSource, "# http body\n");
    await writeFile(mcpSource, "# mcp body\n");
    await writeFile(neverLinked, "# never referenced\n");
    const httpSourceBefore = await stat(httpSource);

    const session = sessionSchema.parse(await (await fetch(
      new URL("/api/v1/session", server.baseUrl),
      {headers: {Authorization: `Bearer ${installation.apiToken}`}},
    )).json());
    expect(session.capabilities.linkedArtifacts).toBe(true);

    const capabilities = z.object({
      linkedArtifacts: z.object({available: z.boolean()}).loose(),
    }).loose().parse((await callTool(
      server,
      installation.apiToken,
      "artifact_capabilities",
      {},
    )).structuredContent);
    expect(capabilities.linkedArtifacts.available).toBe(true);

    const httpLink = await fetch(new URL("/api/v1/artifacts/link", server.baseUrl), {
      body: JSON.stringify({path: httpSource}),
      headers: apiHeaders(installation, "lnk-001-http-link-0001"),
      method: "POST",
    });
    expect(httpLink.status).toBe(201);
    const httpLinked = linkedPublicationSchema.parse(await httpLink.json());
    expect(httpLinked.sourceBinding.path).toBe(httpSource);

    const mcpResult = await callTool(server, installation.apiToken, "artifact_link", {
      path: mcpSource,
    });
    expect(mcpResult.isError ?? false).toBe(false);
    const mcpLinked = linkedPublicationSchema.parse(mcpResult.structuredContent);
    expect(mcpLinked.sourceBinding.path).toBe(mcpSource);
    expect(mcpLinked.artifact.id).not.toBe(httpLinked.artifact.id);

    // Reference in place: the file is neither copied nor moved — same inode, same bytes.
    const httpSourceAfter = await stat(httpSource);
    expect(httpSourceAfter.ino).toBe(httpSourceBefore.ino);
    expect(await (await fetch(new URL("/api/v1/artifacts", server.baseUrl), {
      headers: {Authorization: `Bearer ${installation.apiToken}`},
    })).json()).toBeDefined();

    // Only explicitly linked files became artifacts; the bystander never did.
    const listed = artifactListSchema.parse(await (await fetch(
      new URL("/api/v1/artifacts", server.baseUrl),
      {headers: {Authorization: `Bearer ${installation.apiToken}`}},
    )).json());
    const ids = listed.artifacts.map((entry) => entry.artifact.id).toSorted();
    expect(ids).toEqual([httpLinked.artifact.id, mcpLinked.artifact.id].toSorted());
  });

  test("LNK-001-F: with the feature off the capability is absent, every linked route and tool answers the stable shape, and no file becomes an artifact", async () => {
    expect.hasAssertions();
    server = await startTestServer(installation);
    const source = path.join(sourceRoot, "unreachable.md");
    await writeFile(source, "# unreachable\n");

    const session = sessionSchema.parse(await (await fetch(
      new URL("/api/v1/session", server.baseUrl),
      {headers: {Authorization: `Bearer ${installation.apiToken}`}},
    )).json());
    expect(session.capabilities.linkedArtifacts).toBe(false);

    const capabilities = z.object({
      linkedArtifacts: z.object({available: z.boolean()}).loose(),
    }).loose().parse((await callTool(
      server,
      installation.apiToken,
      "artifact_capabilities",
      {},
    )).structuredContent);
    expect(capabilities.linkedArtifacts.available).toBe(false);

    const activeServer = server;
    const routeResponses = await Promise.all([
      fetch(new URL("/api/v1/artifacts/link", activeServer.baseUrl), {
        body: JSON.stringify({path: source}),
        headers: apiHeaders(installation, "lnk-001-off-link-00001"),
        method: "POST",
      }),
      fetch(new URL("/api/v1/artifacts/art_missing/capture", activeServer.baseUrl), {
        body: JSON.stringify({expectedCurrentVersionId: "ver_missing"}),
        headers: apiHeaders(installation, "lnk-001-off-capture-001"),
        method: "POST",
      }),
      fetch(new URL("/api/v1/artifacts/art_missing/source", activeServer.baseUrl), {
        body: JSON.stringify({expectedSha256: "a".repeat(64), path: source}),
        headers: apiHeaders(installation, "lnk-001-off-relink-001"),
        method: "PUT",
      }),
      fetch(new URL("/api/v1/artifacts/art_missing/live-sessions", activeServer.baseUrl), {
        body: JSON.stringify({}),
        headers: apiHeaders(installation, "lnk-001-off-live-00001"),
        method: "POST",
      }),
    ]);
    const routeResults = await Promise.all(routeResponses.map(async (response) => ({
      code: errorSchema.parse(await response.json()).error.code,
      status: response.status,
    })));
    for (const result of routeResults) {
      expect(result.status).toBe(501);
      expect(result.code).toBe("CAPABILITY_UNAVAILABLE");
    }

    const toolCalls: ReadonlyArray<readonly [string, Readonly<Record<string, string>>]> = [
      ["artifact_link", {path: source}],
      [
        "artifact_capture",
        {artifactId: "art_missing", expectedCurrentVersionId: "ver_missing"},
      ],
      [
        "artifact_relink",
        {artifactId: "art_missing", expectedSha256: "a".repeat(64), path: source},
      ],
    ];
    const toolResults = await Promise.all(toolCalls.map(([name, toolArguments]) =>
      callTool(activeServer, installation.apiToken, name, toolArguments)
    ));
    for (const result of toolResults) {
      expect(result.isError).toBe(true);
      expect(z.object({error: z.object({code: z.string()}).loose()}).loose()
        .parse(result.structuredContent).error.code).toBe("CAPABILITY_UNAVAILABLE");
    }

    const listed = artifactListSchema.parse(await (await fetch(
      new URL("/api/v1/artifacts", server.baseUrl),
      {headers: {Authorization: `Bearer ${installation.apiToken}`}},
    )).json());
    expect(listed.artifacts).toEqual([]);
  });
});
