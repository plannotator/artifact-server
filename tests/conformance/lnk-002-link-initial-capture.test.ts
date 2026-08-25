import {createHash} from "node:crypto";
import {
  chmod,
  mkdir,
  mkdtemp,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import {createServer, type Server} from "node:net";
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

const sourceBindingSchema = z.object({
  lastVerifiedAt: z.iso.datetime(),
  path: z.string().min(1),
  status: z.enum(["in-sync", "modified", "missing", "unreadable"]),
}).strict();
const artifactRecordSchema = z.object({
  accessSetting: z.string(),
  createdAt: z.iso.datetime(),
  currentVersionId: z.string().min(1),
  deletedAt: z.null(),
  id: z.string().min(1),
  name: z.string(),
  projectId: z.string().min(1),
  tags: z.array(z.string()),
});
const versionRecordSchema = z.object({
  artifactId: z.string().min(1),
  contentToken: z.string().min(1),
  createdAt: z.iso.datetime(),
  entryPath: z.string().min(1),
  id: z.string().min(1),
  manifestDigest: z.string().min(1),
  number: z.number().int().positive(),
  projectId: z.string().min(1),
  publisherPrincipalId: z.string().min(1),
  routingMode: z.enum(["spa", "static"]),
});
const linkedPublicationSchema = z.object({
  artifact: artifactRecordSchema,
  links: z.object({
    artifact: z.string().min(1),
    live: z.string().min(1),
    review: z.string().min(1),
    version: z.string().min(1),
  }).strict(),
  replayed: z.boolean(),
  sourceBinding: sourceBindingSchema,
  version: versionRecordSchema,
}).loose();
const versionListSchema = z.object({
  artifactId: z.string().min(1),
  versions: z.array(z.object({version: versionRecordSchema}).loose()),
}).strict();
const versionDetailsSchema = z.object({
  manifest: z.object({
    digest: z.string().min(1),
    entries: z.array(z.object({
      disposition: z.enum(["attachment", "inline"]),
      mediaType: z.string().min(1),
      path: z.string().min(1),
      sha256: z.string().regex(/^[a-f0-9]{64}$/u),
      size: z.number().int().nonnegative(),
    })),
    entryPath: z.string().min(1),
    routingMode: z.enum(["spa", "static"]),
  }),
  version: versionRecordSchema,
}).loose();
const artifactDetailsSchema = z.object({
  artifact: artifactRecordSchema,
  current: versionDetailsSchema,
  sourceBinding: sourceBindingSchema,
}).loose();
const artifactPageSchema = z.object({
  artifacts: z.array(z.object({artifact: artifactRecordSchema}).loose()),
  nextCursor: z.string().nullable(),
}).strict();
const actionPageSchema = z.object({
  actions: z.array(z.object({
    action: z.string(),
    artifactId: z.string().min(1),
    authorizedByPrincipalId: z.string().nullable(),
    createdAt: z.iso.datetime(),
    id: z.string().min(1),
    idempotencyKey: z.string().min(1),
    principalId: z.string().min(1),
    projectId: z.string().min(1),
    versionId: z.string().min(1),
  }).strict()),
  nextCursor: z.string().nullable(),
}).strict();
const failureSchema = z.object({
  error: z.object({code: z.string(), message: z.string()}).strict(),
}).strict();

const linkedFileBytes = "# quarterly notes\nrevenue is up\n";

describe("linking a file publishes an ordinary first version", () => {
  let installation: TestInstallation;
  let server: RunningTestServer | null = null;
  let sourceRoot: string;
  let socketServer: Server | null = null;

  beforeEach(async () => {
    installation = await createTestInstallation();
    sourceRoot = await realpath(
      await mkdtemp(path.join(tmpdir(), "lnk-002-sources-")),
    );
    server = await startTestServer(installation, {
      linkRoots: [sourceRoot],
      linkedFiles: "on",
    });
  });

  afterEach(async () => {
    if (socketServer !== null) socketServer.close();
    socketServer = null;
    if (server !== null) await server.stop();
    server = null;
    await removeTestInstallation(installation);
    await rm(sourceRoot, {force: true, recursive: true});
  });

  test("LNK-002-B: one linked regular file becomes an artifact whose first version carries its verified bytes, manifest, and action", async () => {
    expect.hasAssertions();
    const sourcePath = path.join(sourceRoot, "notes.md");
    await writeFile(sourcePath, linkedFileBytes);

    const response = await linkFile(sourcePath, "lnk-002-behavior-link-000");
    expect(response.status).toBe(201);
    const linked = linkedPublicationSchema.parse(await response.json());
    expect(linked.replayed).toBe(false);
    expect(linked.sourceBinding).toMatchObject({
      path: sourcePath,
      status: "in-sync",
    });
    expect(linked.artifact.name).toBe("notes.md");
    expect(linked.artifact.currentVersionId).toBe(linked.version.id);
    expect(linked.version.number).toBe(1);
    expect(linked.version.artifactId).toBe(linked.artifact.id);
    expect(linked.version.entryPath).toBe("notes.md");

    // The captured version is an ordinary version row: the plain version
    // routes list it, describe its canonical manifest, and serve its bytes.
    const versions = await readJson(
      `/api/v1/artifacts/${linked.artifact.id}/versions`,
      versionListSchema,
    );
    expect(versions.versions.map((saved) => saved.version.id))
      .toEqual([linked.version.id]);
    const details = await readJson(
      `/api/v1/artifacts/${linked.artifact.id}/versions/${linked.version.id}`,
      versionDetailsSchema,
    );
    expect(details.manifest.entryPath).toBe("notes.md");
    expect(details.manifest.digest).toBe(linked.version.manifestDigest);
    expect(details.manifest.entries).toHaveLength(1);
    const entry = details.manifest.entries[0];
    if (entry === undefined) throw new Error("The manifest declares no entry.");
    expect(entry.path).toBe("notes.md");
    expect(entry.sha256).toBe(digestOf(linkedFileBytes));
    expect(entry.size).toBe(Buffer.byteLength(linkedFileBytes));

    const served = await fetch(
      new URL(
        `/api/v1/artifacts/${linked.artifact.id}/versions/${linked.version.id}/file?path=notes.md`,
        requiredServer().baseUrl,
      ),
      {headers: readHeaders()},
    );
    expect(served.status).toBe(200);
    const servedBytes = new Uint8Array(await served.arrayBuffer());
    expect(digestOfBytes(servedBytes)).toBe(entry.sha256);
    expect(new TextDecoder().decode(servedBytes)).toBe(linkedFileBytes);

    // The link is one attributed mutation in the ordinary action ledger.
    const ledger = await readJson(
      `/api/v1/artifacts/${linked.artifact.id}/actions?limit=100`,
      actionPageSchema,
    );
    expect(ledger.actions).toHaveLength(1);
    expect(ledger.actions[0]).toMatchObject({
      action: "link",
      artifactId: linked.artifact.id,
      idempotencyKey: "lnk-002-behavior-link-000",
      projectId: linked.artifact.projectId,
      versionId: linked.version.id,
    });

    // Nothing about the artifact is special beyond the binding decoration.
    const artifactDetails = await readJson(
      `/api/v1/artifacts/${linked.artifact.id}`,
      artifactDetailsSchema,
    );
    expect(artifactDetails.artifact).toStrictEqual(linked.artifact);
    expect(artifactDetails.current.version.id).toBe(linked.version.id);
    expect(artifactDetails.sourceBinding.status).toBe("in-sync");
    const listed = await readJson(
      "/api/v1/artifacts?limit=100",
      artifactPageSchema,
    );
    expect(listed.artifacts.map((item) => item.artifact.id))
      .toContain(linked.artifact.id);
  });

  test("LNK-002-F: a path that is not a readable regular file creates nothing, and replaying one link key returns the original artifact", async () => {
    expect.hasAssertions();
    const before = await readJson(
      "/api/v1/artifacts?limit=100",
      artifactPageSchema,
    );
    expect(before.artifacts).toEqual([]);

    const directoryPath = path.join(sourceRoot, "reports");
    await mkdir(directoryPath);
    const danglingPath = path.join(sourceRoot, "dangling.md");
    await symlink(path.join(sourceRoot, "absent-target.md"), danglingPath);
    const directorySymlinkPath = path.join(sourceRoot, "reports-link");
    await symlink(directoryPath, directorySymlinkPath);
    const socketPath = path.join(sourceRoot, "s.sock");
    socketServer = await listenOnSocket(socketPath);
    const lockedDirectory = path.join(sourceRoot, "locked");
    await mkdir(lockedDirectory);
    const lockedPath = path.join(lockedDirectory, "secret.md");
    await writeFile(lockedPath, "unreadable\n");

    const missing = await linkFile(
      path.join(sourceRoot, "absent.md"),
      "lnk-002-failure-missing-0",
    );
    await expectRefusal(missing, "INVALID_LINK_PATH");
    const directory = await linkFile(
      directoryPath,
      "lnk-002-failure-directory",
    );
    await expectRefusal(directory, "INVALID_LINK_PATH");
    const dangling = await linkFile(
      danglingPath,
      "lnk-002-failure-dangling-symlink",
    );
    await expectRefusal(dangling, "INVALID_LINK_PATH");
    const directorySymlink = await linkFile(
      directorySymlinkPath,
      "lnk-002-failure-symlinked-directory",
    );
    await expectRefusal(directorySymlink, "INVALID_LINK_PATH");
    const special = await linkFile(socketPath, "lnk-002-failure-socket-00");
    await expectRefusal(special, "INVALID_LINK_PATH");

    await chmod(lockedDirectory, 0o000);
    try {
      const unreadable = await linkFile(
        lockedPath,
        "lnk-002-failure-unreadable",
      );
      await expectRefusal(unreadable, "INVALID_LINK_PATH");
    } finally {
      await chmod(lockedDirectory, 0o700);
    }

    const afterRefusals = await readJson(
      "/api/v1/artifacts?limit=100",
      artifactPageSchema,
    );
    expect(afterRefusals.artifacts).toEqual([]);

    const sourcePath = path.join(sourceRoot, "notes.md");
    await writeFile(sourcePath, linkedFileBytes);
    const first = await linkFile(sourcePath, "lnk-002-failure-replay-00");
    expect(first.status).toBe(201);
    const original = linkedPublicationSchema.parse(await first.json());
    const replay = await linkFile(sourcePath, "lnk-002-failure-replay-00");
    expect(replay.status).toBe(201);
    const replayed = linkedPublicationSchema.parse(await replay.json());
    expect(replayed.replayed).toBe(true);
    expect(replayed.artifact.id).toBe(original.artifact.id);
    expect(replayed.version.id).toBe(original.version.id);

    const afterReplay = await readJson(
      "/api/v1/artifacts?limit=100",
      artifactPageSchema,
    );
    expect(afterReplay.artifacts.map((item) => item.artifact.id))
      .toEqual([original.artifact.id]);
    const versions = await readJson(
      `/api/v1/artifacts/${original.artifact.id}/versions`,
      versionListSchema,
    );
    expect(versions.versions).toHaveLength(1);
    const ledger = await readJson(
      `/api/v1/artifacts/${original.artifact.id}/actions?limit=100`,
      actionPageSchema,
    );
    expect(ledger.actions.map((record) => record.action)).toEqual(["link"]);
  });

  function requiredServer(): RunningTestServer {
    if (server === null) throw new Error("The test server is not running.");
    return server;
  }

  function readHeaders(): Headers {
    return new Headers({Authorization: `Bearer ${installation.apiToken}`});
  }

  async function linkFile(
    sourcePath: string,
    idempotencyKey: string,
  ): Promise<Response> {
    return fetch(new URL("/api/v1/artifacts/link", requiredServer().baseUrl), {
      body: JSON.stringify({path: sourcePath}),
      headers: apiHeaders(installation, idempotencyKey),
      method: "POST",
    });
  }

  async function readJson<Value>(
    route: string,
    schema: z.ZodType<Value>,
  ): Promise<Value> {
    const response = await fetch(
      new URL(route, requiredServer().baseUrl),
      {headers: readHeaders()},
    );
    if (response.status !== 200) {
      throw new Error(`Reading ${route} failed with ${response.status}.`);
    }
    return schema.parse(await response.json());
  }

  async function expectRefusal(
    response: Response,
    code: string,
  ): Promise<void> {
    expect(response.status).toBe(422);
    const failure = failureSchema.parse(await response.json());
    expect(failure.error.code).toBe(code);
    // Server messages never disclose the filesystem layout they refused.
    expect(failure.error.message).not.toContain(sourceRoot);
  }
});

function digestOf(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

function digestOfBytes(content: Uint8Array): string {
  return createHash("sha256").update(content).digest("hex");
}

async function listenOnSocket(socketPath: string): Promise<Server> {
  return new Promise((resolve, reject) => {
    const listener = createServer();
    listener.once("error", reject);
    listener.listen(socketPath, () => resolve(listener));
  });
}
