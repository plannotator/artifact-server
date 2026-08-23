import {createHash} from "node:crypto";
import {
  mkdir,
  mkdtemp,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
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
const versionRecordSchema = z.object({
  id: z.string().min(1),
  number: z.number().int().positive(),
}).loose();
const linkedPublicationSchema = z.object({
  artifact: z.object({
    currentVersionId: z.string().min(1),
    id: z.string().min(1),
    projectId: z.string().min(1),
  }).loose(),
  replayed: z.boolean(),
  sourceBinding: sourceBindingSchema,
  version: versionRecordSchema,
}).loose();
const relinkResponseSchema = z.object({
  sourceBinding: sourceBindingSchema,
}).strict();
const artifactBindingSchema = z.object({
  sourceBinding: sourceBindingSchema,
}).loose();
const versionListSchema = z.object({
  artifactId: z.string().min(1),
  versions: z.array(z.object({version: versionRecordSchema}).loose()),
}).strict();
const commentThreadSchema = z.object({
  artifactId: z.string().min(1),
  body: z.string(),
  id: z.string().min(1),
  state: z.enum(["open", "resolved"]),
  versionId: z.string().min(1),
}).loose();
const createdThreadSchema = z.object({
  replayed: z.boolean(),
  thread: commentThreadSchema,
}).loose();
const threadPageSchema = z.object({
  items: z.array(commentThreadSchema),
  nextCursor: z.string().nullable(),
}).loose();
const actionPageSchema = z.object({
  actions: z.array(z.object({
    action: z.string(),
    id: z.string().min(1),
    idempotencyKey: z.string().min(1),
    versionId: z.string().min(1),
  }).loose()),
  nextCursor: z.string().nullable(),
}).strict();
const failureSchema = z.object({
  error: z.object({code: z.string(), message: z.string()}).strict(),
}).strict();

const linkedBytes = "# roadmap\nship the linked artifact slice\n";
const otherBytes = "# roadmap\nan entirely different file\n";

describe("relinking one binding at a moved source file", () => {
  let installation: TestInstallation;
  let outsideRoot: string;
  let server: RunningTestServer | null = null;
  let sourcePath: string;
  let sourceRoot: string;

  beforeEach(async () => {
    installation = await createTestInstallation();
    sourceRoot = await realpath(
      await mkdtemp(path.join(tmpdir(), "lnk-005-sources-")),
    );
    outsideRoot = await realpath(
      await mkdtemp(path.join(tmpdir(), "lnk-005-outside-")),
    );
    sourcePath = path.join(sourceRoot, "roadmap.md");
    await writeFile(sourcePath, linkedBytes);
    // The data directory is deliberately inside a configured link root so the
    // self-protection rung is reached rather than shadowed by the root check.
    server = await startTestServer(installation, {
      linkRoots: [sourceRoot, installation.dataDirectory],
      linkedFiles: "on",
    });
  });

  afterEach(async () => {
    if (server !== null) await server.stop();
    server = null;
    await removeTestInstallation(installation);
    await rm(sourceRoot, {force: true, recursive: true});
    await rm(outsideRoot, {force: true, recursive: true});
  });

  test("LNK-005-B: a moved file relinks under its expected hash and keeps the artifact, versions, and comment threads", async () => {
    expect.hasAssertions();
    const linked = await linkFile(sourcePath, "lnk-005-behavior-link-0");
    const thread = createdThreadSchema.parse(
      await (await createThread(
        linked.artifact.id,
        linked.version.id,
        "The second paragraph needs a date.",
        "lnk-005-behavior-thread-0",
      )).json(),
    );
    expect(thread.thread.versionId).toBe(linked.version.id);

    const movedDirectory = path.join(sourceRoot, "moved");
    await mkdir(movedDirectory);
    const movedPath = path.join(movedDirectory, "roadmap.md");
    await rename(sourcePath, movedPath);
    const missing = await readArtifactBinding(linked.artifact.id);
    expect(missing.status).toBe("missing");

    const response = await relink(
      linked.artifact.id,
      movedPath,
      digestOf(linkedBytes),
      "lnk-005-behavior-relink-0",
    );
    expect(response.status).toBe(200);
    const relinked = relinkResponseSchema.parse(await response.json());
    expect(relinked.sourceBinding.path).toBe(movedPath);
    expect(relinked.sourceBinding.status).toBe("in-sync");

    const healthy = await readArtifactBinding(linked.artifact.id);
    expect(healthy).toStrictEqual(relinked.sourceBinding);

    // Identity, history, and conversation are untouched by the move.
    const versions = await readJson(
      `/api/v1/artifacts/${linked.artifact.id}/versions`,
      versionListSchema,
    );
    expect(versions.artifactId).toBe(linked.artifact.id);
    expect(versions.versions.map((saved) => saved.version.id))
      .toEqual([linked.version.id]);
    const threads = await readJson(
      `/api/v1/artifacts/${linked.artifact.id}/comments`,
      threadPageSchema,
    );
    expect(threads.items).toHaveLength(1);
    expect(threads.items[0]).toStrictEqual(thread.thread);
    expect(new TextDecoder().decode(
      await deliveredBytes(linked.artifact.id, linked.version.id),
    )).toBe(linkedBytes);

    const ledger = await readJson(
      `/api/v1/artifacts/${linked.artifact.id}/actions?limit=100`,
      actionPageSchema,
    );
    const relinkAction = ledger.actions.find((record) =>
      record.action === "relink"
    );
    if (relinkAction === undefined) {
      throw new Error("The relink appended no action record.");
    }
    expect(relinkAction.versionId).toBe(linked.version.id);
    expect(relinkAction.idempotencyKey).toBe("lnk-005-behavior-relink-0");
  });

  test("LNK-005-F: a mismatched hash, a path outside every root, and a path inside the data directory all change nothing", async () => {
    expect.hasAssertions();
    const linked = await linkFile(sourcePath, "lnk-005-failure-link-00");
    const thread = createdThreadSchema.parse(
      await (await createThread(
        linked.artifact.id,
        linked.version.id,
        "This thread must survive every refused relink.",
        "lnk-005-failure-thread-00",
      )).json(),
    );

    const impostorPath = path.join(sourceRoot, "impostor.md");
    await writeFile(impostorPath, otherBytes);
    const mismatched = await relink(
      linked.artifact.id,
      impostorPath,
      digestOf(linkedBytes),
      "lnk-005-failure-mismatched-hash",
    );
    expect(mismatched.status).toBe(422);
    await expectRefusal(mismatched, "INVALID_LINK_PATH");

    const outsidePath = path.join(outsideRoot, "roadmap.md");
    await writeFile(outsidePath, linkedBytes);
    const outside = await relink(
      linked.artifact.id,
      outsidePath,
      digestOf(linkedBytes),
      "lnk-005-failure-outside-roots",
    );
    expect(outside.status).toBe(403);
    await expectRefusal(outside, "LINK_PATH_OUTSIDE_ROOTS");

    const protectedPath = path.join(
      installation.dataDirectory,
      "roadmap-copy.md",
    );
    await writeFile(protectedPath, linkedBytes);
    const protectedTarget = await relink(
      linked.artifact.id,
      protectedPath,
      digestOf(linkedBytes),
      "lnk-005-failure-protected-path",
    );
    expect(protectedTarget.status).toBe(403);
    await expectRefusal(protectedTarget, "LINK_PATH_PROTECTED");

    // Every refusal left the original binding, history, and thread in place.
    const binding = await readArtifactBinding(linked.artifact.id);
    expect(binding.path).toBe(sourcePath);
    expect(binding.status).toBe("in-sync");
    const versions = await readJson(
      `/api/v1/artifacts/${linked.artifact.id}/versions`,
      versionListSchema,
    );
    expect(versions.versions.map((saved) => saved.version.id))
      .toEqual([linked.version.id]);
    const threads = await readJson(
      `/api/v1/artifacts/${linked.artifact.id}/comments`,
      threadPageSchema,
    );
    expect(threads.items).toStrictEqual([thread.thread]);
    const ledger = await readJson(
      `/api/v1/artifacts/${linked.artifact.id}/actions?limit=100`,
      actionPageSchema,
    );
    expect(ledger.actions.some((record) => record.action === "relink"))
      .toBe(false);
    expect(new TextDecoder().decode(
      await deliveredBytes(linked.artifact.id, linked.version.id),
    )).toBe(linkedBytes);
  });

  function requiredServer(): RunningTestServer {
    if (server === null) throw new Error("The test server is not running.");
    return server;
  }

  function readHeaders(): Headers {
    return new Headers({Authorization: `Bearer ${installation.apiToken}`});
  }

  async function linkFile(
    linkPath: string,
    idempotencyKey: string,
  ): Promise<z.infer<typeof linkedPublicationSchema>> {
    const response = await fetch(
      new URL("/api/v1/artifacts/link", requiredServer().baseUrl),
      {
        body: JSON.stringify({path: linkPath}),
        headers: apiHeaders(installation, idempotencyKey),
        method: "POST",
      },
    );
    if (response.status !== 201) {
      throw new Error(`Linking failed with ${response.status}.`);
    }
    return linkedPublicationSchema.parse(await response.json());
  }

  async function relink(
    artifactId: string,
    linkPath: string,
    expectedSha256: string,
    idempotencyKey: string,
  ): Promise<Response> {
    return fetch(
      new URL(
        `/api/v1/artifacts/${artifactId}/source`,
        requiredServer().baseUrl,
      ),
      {
        body: JSON.stringify({expectedSha256, path: linkPath}),
        headers: apiHeaders(installation, idempotencyKey),
        method: "PUT",
      },
    );
  }

  async function createThread(
    artifactId: string,
    versionId: string,
    body: string,
    idempotencyKey: string,
  ): Promise<Response> {
    return fetch(
      new URL(
        `/api/v1/artifacts/${artifactId}/versions/${versionId}/comments`,
        requiredServer().baseUrl,
      ),
      {
        body: JSON.stringify({body}),
        headers: apiHeaders(installation, idempotencyKey),
        method: "POST",
      },
    );
  }

  async function readArtifactBinding(
    artifactId: string,
  ): Promise<z.infer<typeof sourceBindingSchema>> {
    const details = await readJson(
      `/api/v1/artifacts/${artifactId}`,
      artifactBindingSchema,
    );
    return details.sourceBinding;
  }

  async function deliveredBytes(
    artifactId: string,
    versionId: string,
  ): Promise<Uint8Array> {
    const response = await fetch(
      new URL(
        `/api/v1/artifacts/${artifactId}/versions/${versionId}/file?path=roadmap.md`,
        requiredServer().baseUrl,
      ),
      {headers: readHeaders()},
    );
    if (response.status !== 200) {
      throw new Error(`Reading version bytes failed with ${response.status}.`);
    }
    return new Uint8Array(await response.arrayBuffer());
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
    const failure = failureSchema.parse(await response.json());
    expect(failure.error.code).toBe(code);
    // A refusal never discloses the filesystem layout it inspected.
    expect(failure.error.message).not.toContain(sourceRoot);
    expect(failure.error.message).not.toContain(outsideRoot);
    expect(failure.error.message).not.toContain(installation.dataDirectory);
  }
});

function digestOf(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}
