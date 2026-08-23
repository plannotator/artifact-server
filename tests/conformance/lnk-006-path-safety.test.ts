import {request} from "node:http";
import {mkdtemp, realpath, rm, symlink, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import path from "node:path";

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

const linkedPublicationSchema = z.object({
  artifact: z.object({id: z.string().min(1)}).loose(),
  sourceBinding: z.object({
    path: z.string().min(1),
    status: z.enum(["in-sync", "modified", "missing", "unreadable"]),
  }).loose(),
}).loose();

const errorSchema = z.object({
  error: z.object({code: z.string(), message: z.string()}).loose(),
}).loose();

/** Issue a POST with a chosen Host header so a non-loopback origin can be exercised. */
function postWithHost(
  server: RunningTestServer,
  hostname: string,
  pathname: string,
  body: {readonly path: string},
  token: string,
): Promise<{status: number; body: string}> {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const outgoing = request(
      {
        headers: [
          "Host", `${hostname}:${server.port}`,
          "Authorization", `Bearer ${token}`,
          "Content-Type", "application/json",
          "Idempotency-Key", "lnk-006-non-loopback-00001",
          "Content-Length", String(Buffer.byteLength(payload)),
        ],
        hostname: "127.0.0.1",
        method: "POST",
        path: pathname,
        port: server.port,
      },
      (incoming) => {
        const chunks: Uint8Array[] = [];
        incoming.on("data", (chunk: Buffer) => chunks.push(chunk));
        incoming.on("end", () => {
          resolve({
            body: Buffer.concat(chunks).toString("utf8"),
            status: incoming.statusCode ?? 500,
          });
        });
      },
    );
    outgoing.on("error", reject);
    outgoing.end(payload);
  });
}

describe("linked source paths are canonicalized, root-checked, and self-protected", () => {
  let installation: TestInstallation;
  let server: RunningTestServer | null = null;
  let sourceRoot: string;
  let outsideRoot: string;

  beforeEach(async () => {
    installation = await createTestInstallation();
    sourceRoot = await realpath(
      await mkdtemp(path.join(tmpdir(), "lnk-006-root-")),
    );
    outsideRoot = await realpath(
      await mkdtemp(path.join(tmpdir(), "lnk-006-outside-")),
    );
  });

  afterEach(async () => {
    if (server !== null) await server.stop();
    server = null;
    await removeTestInstallation(installation);
    await rm(sourceRoot, {force: true, recursive: true});
    await rm(outsideRoot, {force: true, recursive: true});
  });

  async function attemptLink(
    activeServer: RunningTestServer,
    pathname: string,
    key: string,
  ): Promise<{status: number; code: string | null; raw: string}> {
    const response = await fetch(new URL("/api/v1/artifacts/link", activeServer.baseUrl), {
      body: JSON.stringify({path: pathname}),
      headers: apiHeaders(installation, key),
      method: "POST",
    });
    const raw = await response.text();
    let code: string | null = null;
    try {
      code = errorSchema.parse(JSON.parse(raw)).error.code;
    } catch {
      code = null;
    }
    return {code, raw, status: response.status};
  }

  test("LNK-006-B: an admitted member links inside a root over loopback and reads the path only through authenticated metadata", async () => {
    expect.hasAssertions();
    server = await startTestServer(installation, {
      linkRoots: [sourceRoot],
      linkedFiles: "on",
    });
    const source = path.join(sourceRoot, "design.md");
    await writeFile(source, "# design\n");

    const link = await fetch(new URL("/api/v1/artifacts/link", server.baseUrl), {
      body: JSON.stringify({path: source}),
      headers: apiHeaders(installation, "lnk-006-link-inside-0001"),
      method: "POST",
    });
    expect(link.status).toBe(201);
    const linked = linkedPublicationSchema.parse(await link.json());
    expect(linked.sourceBinding.path).toBe(source);

    const authed = await fetch(
      new URL(`/api/v1/artifacts/${linked.artifact.id}`, server.baseUrl),
      {headers: {Authorization: `Bearer ${installation.apiToken}`}},
    );
    expect(authed.status).toBe(200);
    expect(z.object({
      sourceBinding: z.object({path: z.string()}).loose(),
    }).loose().parse(await authed.json()).sourceBinding.path).toBe(source);

    // Anonymous metadata read reveals nothing — no path leaks without authentication.
    const anonymous = await fetch(
      new URL(`/api/v1/artifacts/${linked.artifact.id}`, server.baseUrl),
    );
    expect(anonymous.status).toBe(401);
    expect(await anonymous.text()).not.toContain(source);
  });

  test("LNK-006-F: every escape, protected target, unauthorized caller, and non-loopback origin is refused without disclosing a path", async () => {
    expect.hasAssertions();
    server = await startTestServer(installation, {
      linkRoots: [sourceRoot, installation.dataDirectory],
      linkedFiles: "on",
    });
    const activeServer = server;

    // A file entirely outside every configured root.
    const outsideFile = path.join(outsideRoot, "secret.md");
    await writeFile(outsideFile, "# outside\n");
    const outside = await attemptLink(activeServer, outsideFile, "lnk-006-outside-00001");
    expect(outside.status).toBe(403);
    expect(outside.code).toBe("LINK_PATH_OUTSIDE_ROOTS");
    expect(outside.raw).not.toContain(outsideFile);
    expect(outside.raw).not.toContain(outsideRoot);

    // A dot-dot traversal that resolves outside the root after canonicalization.
    const traversal = path.join(sourceRoot, "..", path.basename(outsideRoot), "secret.md");
    const escaped = await attemptLink(activeServer, traversal, "lnk-006-traversal-0001");
    expect(escaped.status).toBe(403);
    expect(escaped.code).toBe("LINK_PATH_OUTSIDE_ROOTS");
    expect(escaped.raw).not.toContain(outsideRoot);

    // A symlink that sits inside the root but points outside it.
    const symlinkInside = path.join(sourceRoot, "escape-link.md");
    await symlink(outsideFile, symlinkInside);
    const symlinked = await attemptLink(activeServer, symlinkInside, "lnk-006-symlink-00001");
    expect(symlinked.status).toBe(403);
    expect(symlinked.code).toBe("LINK_PATH_OUTSIDE_ROOTS");
    expect(symlinked.raw).not.toContain(outsideFile);

    // The server's own database file is protected even though it is inside a root.
    const databasePath = path.join(installation.dataDirectory, "artifact-server.db");
    const database = await attemptLink(activeServer, databasePath, "lnk-006-database-00001");
    expect(database.status).toBe(403);
    expect(database.code).toBe("LINK_PATH_PROTECTED");
    expect(database.raw).not.toContain(databasePath);
    expect(database.raw).not.toContain(installation.dataDirectory);

    // Anonymous callers are refused by authentication before any path is observed.
    const source = path.join(sourceRoot, "authz.md");
    await writeFile(source, "# authz\n");
    const anonymous = await fetch(new URL("/api/v1/artifacts/link", server.baseUrl), {
      body: JSON.stringify({path: source}),
      headers: {"Content-Type": "application/json", "Idempotency-Key": "lnk-006-anon-000001"},
      method: "POST",
    });
    expect(anonymous.status).toBe(401);
    expect(await anonymous.text()).not.toContain(source);

    // A non-loopback application origin never links, regardless of the path.
    const nonLoopback = await postWithHost(
      server,
      "artifacts.example.com",
      "/api/v1/artifacts/link",
      {path: source},
      installation.apiToken,
    );
    expect(nonLoopback.status).not.toBe(201);
    expect(nonLoopback.status).not.toBe(200);
    expect(nonLoopback.body).not.toContain(source);

    // Relink obeys the identical ladder: a valid link cannot be re-pointed outside the roots.
    const valid = await fetch(new URL("/api/v1/artifacts/link", server.baseUrl), {
      body: JSON.stringify({path: source}),
      headers: apiHeaders(installation, "lnk-006-valid-link-0001"),
      method: "POST",
    });
    expect(valid.status).toBe(201);
    const linked = linkedPublicationSchema.parse(await valid.json());
    const relink = await fetch(
      new URL(`/api/v1/artifacts/${linked.artifact.id}/source`, server.baseUrl),
      {
        body: JSON.stringify({expectedSha256: "a".repeat(64), path: outsideFile}),
        headers: apiHeaders(installation, "lnk-006-relink-out-0001"),
        method: "PUT",
      },
    );
    expect(relink.status).toBe(403);
    expect(await relink.text()).not.toContain(outsideFile);
  });
});
