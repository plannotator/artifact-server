import {mkdtemp, readFile, realpath, rm, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import path from "node:path";
import {DatabaseSync} from "node:sqlite";

import {Effect, Redacted} from "effect";
import {afterEach, beforeEach, describe, expect, test} from "vitest";
import {z} from "zod";

import type {BearerCredentialVerifier} from
  "../../src/application/authentication.js";
import {AuthenticationRequired} from "../../src/core/errors.js";
import {
  membershipRoles,
  principalKinds,
} from "../../src/core/identity.js";
import {
  apiHeaders,
  createTestInstallation,
  removeTestInstallation,
  type RunningTestServer,
  startTestServer,
  type TestInstallation,
} from "../support/runtime-harness.js";

const commenterToken = "linked-comment-commenter-credential";
const commenterPrincipalId = "member_commenter";

const sourceBindingSchema = z.object({
  lastVerifiedAt: z.iso.datetime(),
  path: z.string().min(1),
  status: z.enum(["in-sync", "modified", "missing", "unreadable"]),
}).strict();
const versionRecordSchema = z.object({
  id: z.string().min(1),
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
const commentThreadSchema = z.object({
  artifactId: z.string().min(1),
  author: z.object({principalId: z.string().min(1)}).loose(),
  body: z.string(),
  id: z.string().min(1),
  versionId: z.string().min(1),
}).loose();
const createdThreadSchema = z.object({
  replayed: z.boolean(),
  thread: commentThreadSchema,
}).loose();
const threadDetailsSchema = z.object({
  thread: commentThreadSchema,
}).loose();
const threadPageSchema = z.object({
  items: z.array(commentThreadSchema),
  nextCursor: z.string().nullable(),
}).loose();
const versionListSchema = z.object({
  artifactId: z.string().min(1),
  versions: z.array(z.object({version: versionRecordSchema}).loose()),
}).strict();
const actionPageSchema = z.object({
  actions: z.array(z.object({
    action: z.string(),
    id: z.string().min(1),
    principalId: z.string().min(1),
    versionId: z.string().min(1),
  }).loose()),
  nextCursor: z.string().nullable(),
}).strict();
const failureSchema = z.object({
  error: z.object({code: z.string(), message: z.string()}).strict(),
}).strict();

const capturedBytes = "# design review\nthe first captured state\n";
const driftedBytes = "# design review\nedited on disk after the capture\n";

describe("comment threads on a linked artifact anchor to captured versions", () => {
  let installation: TestInstallation;
  let server: RunningTestServer | null = null;
  let sourcePath: string;
  let sourceRoot: string;

  beforeEach(async () => {
    installation = await createTestInstallation();
    sourceRoot = await realpath(
      await mkdtemp(path.join(tmpdir(), "lnk-008-sources-")),
    );
    sourcePath = path.join(sourceRoot, "review.md");
    await writeFile(sourcePath, capturedBytes);
    server = await startTestServer(installation, {
      externalApiBearerVerifier: commenterVerifier,
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

  test("LNK-008-B: an in-sync thread anchors to the current version and a drifted one implicitly captures for the commenting principal", async () => {
    expect.hasAssertions();
    const linked = await linkFile("lnk-008-behavior-link-0");
    expect(linked.sourceBinding.status).toBe("in-sync");
    expect(linked.version.publisherPrincipalId).not.toBe(commenterPrincipalId);

    const inSync = createdThreadSchema.parse(
      await (await createThread(
        linked.artifact.id,
        linked.version.id,
        "The heading is clear while the file is in sync.",
        "lnk-008-behavior-thread-in-sync",
      )).json(),
    );
    expect(inSync.thread.versionId).toBe(linked.version.id);
    expect(inSync.thread.author.principalId).toBe(commenterPrincipalId);
    const afterInSync = await readJson(
      `/api/v1/artifacts/${linked.artifact.id}/versions`,
      versionListSchema,
    );
    expect(afterInSync.versions.map((saved) => saved.version.id))
      .toEqual([linked.version.id]);
    const ledgerAfterInSync = await readJson(
      `/api/v1/artifacts/${linked.artifact.id}/actions?limit=100`,
      actionPageSchema,
    );
    expect(ledgerAfterInSync.actions.some((record) =>
      record.action === "capture"
    )).toBe(false);

    // The file drifts past the last capture; the same create-thread call now
    // captures first and anchors the thread on the captured version.
    await writeFile(sourcePath, driftedBytes);
    const drifted = createdThreadSchema.parse(
      await (await createThread(
        linked.artifact.id,
        linked.version.id,
        "This note lands on the freshly captured bytes.",
        "lnk-008-behavior-thread-drifted",
      )).json(),
    );
    expect(drifted.thread.versionId).not.toBe(linked.version.id);
    expect(drifted.thread.author.principalId).toBe(commenterPrincipalId);

    const versions = await readJson(
      `/api/v1/artifacts/${linked.artifact.id}/versions`,
      versionListSchema,
    );
    expect(versions.versions).toHaveLength(2);
    const captured = versions.versions.find((saved) =>
      saved.version.id === drifted.thread.versionId
    );
    if (captured === undefined) {
      throw new Error("The thread anchored to a version that was not saved.");
    }
    expect(captured.version.number).toBe(2);
    expect(captured.version.publisherPrincipalId).toBe(commenterPrincipalId);
    expect(new TextDecoder().decode(
      await deliveredBytes(linked.artifact.id, drifted.thread.versionId),
    )).toBe(driftedBytes);
    expect(await readFile(sourcePath, "utf8")).toBe(driftedBytes);

    const ledger = await readJson(
      `/api/v1/artifacts/${linked.artifact.id}/actions?limit=100`,
      actionPageSchema,
    );
    const captureAction = ledger.actions.find((record) =>
      record.action === "capture"
    );
    if (captureAction === undefined) {
      throw new Error("The implicit capture appended no action record.");
    }
    expect(captureAction.principalId).toBe(commenterPrincipalId);
    expect(captureAction.versionId).toBe(drifted.thread.versionId);

    // Both threads keep naming their own captured version on every surface.
    const detail = await readJson(
      `/api/v1/artifacts/${linked.artifact.id}/comments/${drifted.thread.id}`,
      threadDetailsSchema,
    );
    expect(detail.thread.versionId).toBe(drifted.thread.versionId);
    const onFirstVersion = await readJson(
      `/api/v1/artifacts/${linked.artifact.id}/comments?versionId=${linked.version.id}`,
      threadPageSchema,
    );
    expect(onFirstVersion.items.map((item) => item.id))
      .toEqual([inSync.thread.id]);
    const onCapturedVersion = await readJson(
      `/api/v1/artifacts/${linked.artifact.id}/comments?versionId=${drifted.thread.versionId}`,
      threadPageSchema,
    );
    expect(onCapturedVersion.items.map((item) => item.id))
      .toEqual([drifted.thread.id]);
  });

  test("LNK-008-F: an aborted implicit capture fails the whole comment request and leaves no thread and no version", async () => {
    expect.hasAssertions();
    const linked = await linkFile("lnk-008-failure-link-00");
    const anchored = createdThreadSchema.parse(
      await (await createThread(
        linked.artifact.id,
        linked.version.id,
        "This thread predates the drift.",
        "lnk-008-failure-thread-first",
      )).json(),
    );
    expect(anchored.thread.versionId).toBe(linked.version.id);

    await writeFile(sourcePath, driftedBytes);
    const invalid = await createThread(
      linked.artifact.id,
      linked.version.id,
      " ",
      "lnk-008-failure-thread-invalid",
    );
    expect(invalid.status).toBe(422);
    const afterInvalid = await readJson(
      `/api/v1/artifacts/${linked.artifact.id}/versions`,
      versionListSchema,
    );
    expect(afterInvalid.versions.map((saved) => saved.version.id))
      .toEqual([linked.version.id]);

    refuseCaptureActions();
    try {
      const aborted = await createThread(
        linked.artifact.id,
        linked.version.id,
        "This note must never exist without a durable capture.",
        "lnk-008-failure-thread-aborted",
      );
      expect(aborted.status).toBe(500);
      const failure = failureSchema.parse(await aborted.json());
      expect(failure.error.code).toBe("INTERNAL_ERROR");
      expect(failure.error.message).not.toContain(sourceRoot);
    } finally {
      allowCaptureActions();
    }

    // No thread, no version, and the saved bytes are still the captured ones
    // rather than the live bytes the aborted request read.
    const threads = await readJson(
      `/api/v1/artifacts/${linked.artifact.id}/comments`,
      threadPageSchema,
    );
    expect(threads.items.map((item) => item.id)).toEqual([anchored.thread.id]);
    const versions = await readJson(
      `/api/v1/artifacts/${linked.artifact.id}/versions`,
      versionListSchema,
    );
    expect(versions.versions.map((saved) => saved.version.id))
      .toEqual([linked.version.id]);
    expect(new TextDecoder().decode(
      await deliveredBytes(linked.artifact.id, linked.version.id),
    )).toBe(capturedBytes);
    const ledger = await readJson(
      `/api/v1/artifacts/${linked.artifact.id}/actions?limit=100`,
      actionPageSchema,
    );
    expect(ledger.actions.some((record) => record.action === "capture"))
      .toBe(false);

    // Once the capture can commit, the same call anchors the thread on a
    // durably captured version rather than on live bytes.
    const recovered = createdThreadSchema.parse(
      await (await createThread(
        linked.artifact.id,
        linked.version.id,
        "This note lands after the capture commits.",
        "lnk-008-failure-thread-recovered",
      )).json(),
    );
    expect(recovered.thread.versionId).not.toBe(linked.version.id);
    const recoveredVersions = await readJson(
      `/api/v1/artifacts/${linked.artifact.id}/versions`,
      versionListSchema,
    );
    expect(recoveredVersions.versions.map((saved) => saved.version.id))
      .toContain(recovered.thread.versionId);
    expect(new TextDecoder().decode(
      await deliveredBytes(linked.artifact.id, recovered.thread.versionId),
    )).toBe(driftedBytes);
  });

  function requiredServer(): RunningTestServer {
    if (server === null) throw new Error("The test server is not running.");
    return server;
  }

  function commenterHeaders(idempotencyKey: string | null): Headers {
    const headers = new Headers({
      Authorization: `Bearer ${commenterToken}`,
      "Content-Type": "application/json",
    });
    if (idempotencyKey !== null) {
      headers.set("Idempotency-Key", idempotencyKey);
    }
    return headers;
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
        headers: commenterHeaders(idempotencyKey),
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
        `/api/v1/artifacts/${artifactId}/versions/${versionId}/file?path=review.md`,
        requiredServer().baseUrl,
      ),
      {headers: commenterHeaders(null)},
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
      {headers: commenterHeaders(null)},
    );
    if (response.status !== 200) {
      throw new Error(`Reading ${route} failed with ${response.status}.`);
    }
    return schema.parse(await response.json());
  }

  function refuseCaptureActions(): void {
    withInstallationDatabase((database) => {
      database.exec(
        `CREATE TRIGGER linked_capture_outage
         BEFORE INSERT ON actions
         WHEN NEW.action = 'capture'
         BEGIN
           SELECT RAISE(ABORT, 'the action ledger refused the capture');
         END;`,
      );
    });
  }

  function allowCaptureActions(): void {
    withInstallationDatabase((database) => {
      database.exec("DROP TRIGGER linked_capture_outage;");
    });
  }

  function withInstallationDatabase(
    operation: (database: DatabaseSync) => void,
  ): void {
    const database = new DatabaseSync(
      path.join(installation.dataDirectory, "artifact-server.db"),
      {timeout: 5_000},
    );
    try {
      operation(database);
    } finally {
      database.close();
    }
  }
});

const commenterVerifier: BearerCredentialVerifier = {
  verify: (credential) => {
    if (Redacted.value(credential) === commenterToken) {
      return Effect.succeed({
        authorizedByPrincipalId: null,
        capabilities: [],
        displayName: "Dana Reviewer",
        id: commenterPrincipalId,
        installationId: "local",
        kind: principalKinds.human,
        membershipRole: membershipRoles.administrator,
      });
    }
    return Effect.fail(new AuthenticationRequired({
      message: "The comment credential is invalid.",
    }));
  },
};
