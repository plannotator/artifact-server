import {createHash} from "node:crypto";
import {mkdtemp, readFile, realpath, rm, writeFile} from "node:fs/promises";
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
  artifactId: z.string().min(1),
  entryPath: z.string().min(1),
  id: z.string().min(1),
  manifestDigest: z.string().min(1),
  number: z.number().int().positive(),
  publisherPrincipalId: z.string().min(1),
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
const versionListSchema = z.object({
  artifactId: z.string().min(1),
  versions: z.array(z.object({version: versionRecordSchema}).loose()),
}).strict();
const versionDetailsSchema = z.object({
  manifest: z.object({
    digest: z.string().min(1),
    entries: z.array(z.object({
      path: z.string().min(1),
      sha256: z.string().regex(/^[a-f0-9]{64}$/u),
      size: z.number().int().nonnegative(),
    }).loose()),
    entryPath: z.string().min(1),
  }).loose(),
  version: versionRecordSchema,
}).loose();
const actionPageSchema = z.object({
  actions: z.array(z.object({
    action: z.string(),
    id: z.string().min(1),
    idempotencyKey: z.string().min(1),
    principalId: z.string().min(1),
    versionId: z.string().min(1),
  }).loose()),
  nextCursor: z.string().nullable(),
}).strict();
const failureSchema = z.object({
  error: z.object({code: z.string(), message: z.string()}).strict(),
}).strict();

const firstBytes = "# revenue notes\nq1 is flat\n";
const secondBytes = "# revenue notes\nq1 is flat\nq2 grew twelve percent\n";
const thirdBytes = "# revenue notes\nrewritten again on disk\n";

describe("capturing a linked source as a new immutable version", () => {
  let installation: TestInstallation;
  let server: RunningTestServer | null = null;
  let sourceRoot: string;
  let sourcePath: string;

  beforeEach(async () => {
    installation = await createTestInstallation();
    sourceRoot = await realpath(
      await mkdtemp(path.join(tmpdir(), "lnk-004-sources-")),
    );
    sourcePath = path.join(sourceRoot, "notes.md");
    server = await startTestServer(installation, {
      linkRoots: [sourceRoot],
      linkedFiles: "on",
    });
  });

  afterEach(async () => {
    if (server !== null) await server.stop();
    server = null;
    await removeTestInstallation(installation);
    await rm(sourceRoot, {force: true, recursive: true});
  });

  test("LNK-004-B: capture publishes the current source bytes as a new version and an in-sync capture replays the current one", async () => {
    expect.hasAssertions();
    await writeFile(sourcePath, firstBytes);
    const linked = await linkFile("lnk-004-behavior-link-0");
    expect(linked.version.number).toBe(1);

    await writeFile(sourcePath, secondBytes);
    const captureResponse = await captureSource(
      linked.artifact.id,
      linked.version.id,
      "lnk-004-behavior-capture-one",
    );
    expect(captureResponse.status).toBe(201);
    const captured = linkedPublicationSchema.parse(await captureResponse.json());
    expect(captured.replayed).toBe(false);
    expect(captured.version.id).not.toBe(linked.version.id);
    expect(captured.version.number).toBe(2);
    expect(captured.artifact.currentVersionId).toBe(captured.version.id);
    expect(captured.sourceBinding.status).toBe("in-sync");
    expect(captured.sourceBinding.path).toBe(sourcePath);

    // The published bytes are the bytes on disk: the manifest fingerprint and
    // the delivered version bytes both hash-match the source file itself.
    const onDisk = new Uint8Array(await readFile(sourcePath));
    const details = await readJson(
      `/api/v1/artifacts/${linked.artifact.id}/versions/${captured.version.id}`,
      versionDetailsSchema,
    );
    const entry = details.manifest.entries[0];
    if (entry === undefined) throw new Error("The manifest declares no entry.");
    expect(entry.sha256).toBe(digestOf(onDisk));
    expect(entry.size).toBe(onDisk.byteLength);
    const served = await deliveredBytes(
      linked.artifact.id,
      captured.version.id,
    );
    expect(digestOf(served)).toBe(digestOf(onDisk));
    expect(new TextDecoder().decode(served)).toBe(secondBytes);

    // The first captured version keeps its own immutable bytes.
    const original = await deliveredBytes(
      linked.artifact.id,
      linked.version.id,
    );
    expect(new TextDecoder().decode(original)).toBe(firstBytes);

    const versions = await readJson(
      `/api/v1/artifacts/${linked.artifact.id}/versions`,
      versionListSchema,
    );
    expect(versions.versions.map((saved) => saved.version.id).toSorted())
      .toEqual([linked.version.id, captured.version.id].toSorted());
    const ledger = await readJson(
      `/api/v1/artifacts/${linked.artifact.id}/actions?limit=100`,
      actionPageSchema,
    );
    expect(ledger.actions.map((record) => record.action).toSorted())
      .toEqual(["capture", "link"]);
    const captureAction = ledger.actions.find((record) =>
      record.action === "capture"
    );
    if (captureAction === undefined) {
      throw new Error("The capture appended no action record.");
    }
    expect(captureAction.versionId).toBe(captured.version.id);
    expect(captureAction.idempotencyKey).toBe("lnk-004-behavior-capture-one");

    // Capturing an unchanged source is a no-op that returns the current
    // version under a brand-new idempotency key.
    const inSyncResponse = await captureSource(
      linked.artifact.id,
      captured.version.id,
      "lnk-004-behavior-capture-two",
    );
    expect(inSyncResponse.status).toBe(201);
    const inSync = linkedPublicationSchema.parse(await inSyncResponse.json());
    expect(inSync.version.id).toBe(captured.version.id);
    expect(inSync.replayed).toBe(true);
    expect(inSync.sourceBinding.status).toBe("in-sync");
    const afterNoOp = await readJson(
      `/api/v1/artifacts/${linked.artifact.id}/versions`,
      versionListSchema,
    );
    expect(afterNoOp.versions).toHaveLength(2);
    const ledgerAfterNoOp = await readJson(
      `/api/v1/artifacts/${linked.artifact.id}/actions?limit=100`,
      actionPageSchema,
    );
    expect(ledgerAfterNoOp.actions).toHaveLength(ledger.actions.length);
  });

  test("LNK-004-F: a stale expected current version returns the publish conflict with the actual current version and no version is written", async () => {
    expect.hasAssertions();
    await writeFile(sourcePath, firstBytes);
    const linked = await linkFile("lnk-004-failure-link-00");
    await writeFile(sourcePath, secondBytes);
    const captured = linkedPublicationSchema.parse(
      await (await captureSource(
        linked.artifact.id,
        linked.version.id,
        "lnk-004-failure-capture-one",
      )).json(),
    );

    await writeFile(sourcePath, thirdBytes);
    const stale = await captureSource(
      linked.artifact.id,
      linked.version.id,
      "lnk-004-failure-stale-capture",
    );
    expect(stale.status).toBe(409);
    const conflict = failureSchema.parse(await stale.json());
    expect(conflict.error.code).toBe("PUBLISH_CONFLICT");
    expect(conflict.error.message).toContain(captured.version.id);
    expect(conflict.error.message).not.toContain(sourceRoot);

    const afterConflict = await readJson(
      `/api/v1/artifacts/${linked.artifact.id}/versions`,
      versionListSchema,
    );
    expect(afterConflict.versions.map((saved) => saved.version.id).toSorted())
      .toEqual([linked.version.id, captured.version.id].toSorted());
    const ledger = await readJson(
      `/api/v1/artifacts/${linked.artifact.id}/actions?limit=100`,
      actionPageSchema,
    );
    expect(ledger.actions.map((record) => record.action).toSorted())
      .toEqual(["capture", "link"]);
    expect(new TextDecoder().decode(
      await deliveredBytes(linked.artifact.id, captured.version.id),
    )).toBe(secondBytes);

    // A source that vanished before the capture reads it writes nothing
    // either, and the refusal names no filesystem path.
    await rm(sourcePath);
    const vanished = await captureSource(
      linked.artifact.id,
      captured.version.id,
      "lnk-004-failure-missing-source",
    );
    expect(vanished.status).toBe(409);
    const missing = failureSchema.parse(await vanished.json());
    expect(missing.error.code).toBe("SOURCE_MISSING");
    expect(missing.error.message).not.toContain(sourceRoot);
    const afterVanished = await readJson(
      `/api/v1/artifacts/${linked.artifact.id}/versions`,
      versionListSchema,
    );
    expect(afterVanished.versions).toHaveLength(2);

    // The capture succeeds under the actual current version once the source
    // is readable again, so the conflict refused only the stale attempt.
    await writeFile(sourcePath, thirdBytes);
    const retried = await captureSource(
      linked.artifact.id,
      captured.version.id,
      "lnk-004-failure-retry-capture",
    );
    expect(retried.status).toBe(201);
    const retriedBody = linkedPublicationSchema.parse(await retried.json());
    expect(retriedBody.version.number).toBe(3);
    expect(new TextDecoder().decode(
      await deliveredBytes(linked.artifact.id, retriedBody.version.id),
    )).toBe(thirdBytes);
  });

  function requiredServer(): RunningTestServer {
    if (server === null) throw new Error("The test server is not running.");
    return server;
  }

  function readHeaders(): Headers {
    return new Headers({Authorization: `Bearer ${installation.apiToken}`});
  }

  async function linkFile(
    idempotencyKey: string,
  ): Promise<z.infer<typeof linkedPublicationSchema>> {
    const response = await fetch(
      new URL("/api/v1/artifacts/link", requiredServer().baseUrl),
      {
        body: JSON.stringify({path: sourcePath}),
        headers: apiHeaders(installation, idempotencyKey),
        method: "POST",
      },
    );
    if (response.status !== 201) {
      throw new Error(`Linking failed with ${response.status}.`);
    }
    return linkedPublicationSchema.parse(await response.json());
  }

  async function captureSource(
    artifactId: string,
    expectedCurrentVersionId: string,
    idempotencyKey: string,
  ): Promise<Response> {
    return fetch(
      new URL(
        `/api/v1/artifacts/${artifactId}/capture`,
        requiredServer().baseUrl,
      ),
      {
        body: JSON.stringify({expectedCurrentVersionId}),
        headers: apiHeaders(installation, idempotencyKey),
        method: "POST",
      },
    );
  }

  async function deliveredBytes(
    artifactId: string,
    versionId: string,
  ): Promise<Uint8Array> {
    const response = await fetch(
      new URL(
        `/api/v1/artifacts/${artifactId}/versions/${versionId}/file?path=notes.md`,
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
});

function digestOf(content: Uint8Array): string {
  return createHash("sha256").update(content).digest("hex");
}
