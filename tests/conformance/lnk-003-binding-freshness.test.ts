import {createHash} from "node:crypto";
import {
  chmod,
  mkdir,
  mkdtemp,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import {tmpdir} from "node:os";
import path from "node:path";
import {DatabaseSync} from "node:sqlite";

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
  id: z.string().min(1),
  number: z.number().int().positive(),
}).loose();
const linkedPublicationSchema = z.object({
  artifact: artifactRecordSchema,
  replayed: z.boolean(),
  sourceBinding: sourceBindingSchema,
  version: versionRecordSchema,
}).loose();
const artifactDetailsSchema = z.object({
  artifact: artifactRecordSchema,
  current: z.object({version: versionRecordSchema}).loose(),
  sourceBinding: sourceBindingSchema,
}).loose();
const versionListSchema = z.object({
  artifactId: z.string().min(1),
  versions: z.array(z.object({version: versionRecordSchema}).loose()),
}).strict();
const actionPageSchema = z.object({
  actions: z.array(z.object({
    action: z.string(),
    id: z.string().min(1),
    versionId: z.string().min(1),
  }).loose()),
  nextCursor: z.string().nullable(),
}).strict();

const capturedBytes = "# original notes\n";

describe("linked source freshness on ordinary metadata reads", () => {
  let installation: TestInstallation;
  let server: RunningTestServer | null = null;
  let sourceRoot: string;

  beforeEach(async () => {
    installation = await createTestInstallation();
    sourceRoot = await realpath(
      await mkdtemp(path.join(tmpdir(), "lnk-003-sources-")),
    );
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

  test("LNK-003-B: external modification, replacement, and removal move freshness while the version list and delivered bytes hold still", async () => {
    expect.hasAssertions();
    const sourcePath = path.join(sourceRoot, "notes.md");
    await writeFile(sourcePath, capturedBytes);
    const linked = await linkFile(sourcePath, "lnk-003-behavior-link-0");
    expect(linked.sourceBinding.status).toBe("in-sync");

    const fresh = await readArtifact(linked.artifact.id);
    expect(fresh.sourceBinding.status).toBe("in-sync");
    expect(fresh.sourceBinding.path).toBe(sourcePath);

    await writeFile(sourcePath, "# edited outside the server\n");
    const modified = await readArtifact(linked.artifact.id);
    expect(modified.sourceBinding.status).toBe("modified");

    // A regular file replaced by a directory is never followed; the binding
    // reports it as unreadable instead of erroring the read.
    await rm(sourcePath);
    await mkdir(sourcePath);
    const unreadable = await readArtifact(linked.artifact.id);
    expect(unreadable.sourceBinding.status).toBe("unreadable");

    await rm(sourcePath, {recursive: true});
    const missing = await readArtifact(linked.artifact.id);
    expect(missing.sourceBinding.status).toBe("missing");

    // Restoring a readable regular file recovers the binding on the next
    // read: it reports drift again rather than staying missing.
    await writeFile(sourcePath, "# restored on disk\n");
    const restored = await readArtifact(linked.artifact.id);
    expect(restored.sourceBinding.status).toBe("modified");
    expect(restored.sourceBinding.path).toBe(sourcePath);
    expect(Date.parse(restored.sourceBinding.lastVerifiedAt))
      .toBeGreaterThanOrEqual(Date.parse(fresh.sourceBinding.lastVerifiedAt));

    // Nothing about the artifact itself moved while its source did.
    for (const observed of [fresh, modified, unreadable, missing, restored]) {
      expect(observed.artifact).toStrictEqual(linked.artifact);
      expect(observed.current.version.id).toBe(linked.version.id);
    }
    const versions = await readJson(
      `/api/v1/artifacts/${linked.artifact.id}/versions`,
      versionListSchema,
    );
    expect(versions.versions.map((saved) => saved.version.id))
      .toEqual([linked.version.id]);
    const ledger = await readJson(
      `/api/v1/artifacts/${linked.artifact.id}/actions?limit=100`,
      actionPageSchema,
    );
    expect(ledger.actions.map((record) => record.action)).toEqual(["link"]);
    expect(await deliveredBytes(linked.artifact.id, linked.version.id))
      .toBe(capturedBytes);
  });

  test("LNK-003-F: a refresh cannot write a version or an action, and a failed stat degrades only the freshness field", async () => {
    expect.hasAssertions();
    const sourcePath = path.join(sourceRoot, "notes.md");
    await writeFile(sourcePath, capturedBytes);
    const linked = await linkFile(sourcePath, "lnk-003-failure-link-00");
    const ledgerAfterLink = await readJson(
      `/api/v1/artifacts/${linked.artifact.id}/actions?limit=100`,
      actionPageSchema,
    );
    expect(ledgerAfterLink.actions).toHaveLength(1);

    // The database itself refuses every version and action write, so a
    // refresh that attempted one would fail the read instead of passing.
    refuseVersionAndActionWrites();
    try {
      await writeFile(sourcePath, "# edited outside the server\n");
      const modified = await readArtifact(linked.artifact.id);
      expect(modified.sourceBinding.status).toBe("modified");
      const repeated = await readArtifact(linked.artifact.id);
      expect(repeated.sourceBinding.status).toBe("modified");
      await rm(sourcePath);
      const missing = await readArtifact(linked.artifact.id);
      expect(missing.sourceBinding.status).toBe("missing");
      await writeFile(sourcePath, capturedBytes);
      const readable = await readArtifact(linked.artifact.id);
      expect(readable.sourceBinding.status).toBe("modified");
      expect(readable.artifact).toStrictEqual(linked.artifact);
    } finally {
      allowVersionAndActionWrites();
    }

    // A stat that fails outright degrades the freshness field alone.
    const lockedDirectory = path.join(sourceRoot, "locked");
    await mkdir(lockedDirectory);
    const lockedPath = path.join(lockedDirectory, "locked.md");
    await writeFile(lockedPath, capturedBytes);
    const locked = await linkFile(lockedPath, "lnk-003-failure-locked-00");
    expect(locked.sourceBinding.status).toBe("in-sync");
    await chmod(lockedDirectory, 0o000);
    try {
      const denied = await readArtifact(locked.artifact.id);
      expect(denied.sourceBinding.status).toBe("unreadable");
      expect(denied.artifact).toStrictEqual(locked.artifact);
      expect(denied.current.version.id).toBe(locked.version.id);
    } finally {
      await chmod(lockedDirectory, 0o700);
    }

    const versions = await readJson(
      `/api/v1/artifacts/${linked.artifact.id}/versions`,
      versionListSchema,
    );
    expect(versions.versions.map((saved) => saved.version.id))
      .toEqual([linked.version.id]);
    const ledger = await readJson(
      `/api/v1/artifacts/${linked.artifact.id}/actions?limit=100`,
      actionPageSchema,
    );
    expect(ledger.actions.map((record) => record.action)).toEqual(["link"]);
    expect(await deliveredBytes(linked.artifact.id, linked.version.id))
      .toBe(capturedBytes);
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

  async function readArtifact(
    artifactId: string,
  ): Promise<z.infer<typeof artifactDetailsSchema>> {
    return readJson(`/api/v1/artifacts/${artifactId}`, artifactDetailsSchema);
  }

  async function deliveredBytes(
    artifactId: string,
    versionId: string,
  ): Promise<string> {
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
    const bytes = new Uint8Array(await response.arrayBuffer());
    expect(createHash("sha256").update(bytes).digest("hex"))
      .toBe(createHash("sha256").update(capturedBytes, "utf8").digest("hex"));
    return new TextDecoder().decode(bytes);
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

  function refuseVersionAndActionWrites(): void {
    withInstallationDatabase((database) => {
      database.exec(
        `CREATE TRIGGER freshness_version_outage
         BEFORE INSERT ON versions
         BEGIN
           SELECT RAISE(ABORT, 'a refresh must never write a version');
         END;
         CREATE TRIGGER freshness_action_outage
         BEFORE INSERT ON actions
         BEGIN
           SELECT RAISE(ABORT, 'a refresh must never write an action');
         END;`,
      );
    });
  }

  function allowVersionAndActionWrites(): void {
    withInstallationDatabase((database) => {
      database.exec(
        `DROP TRIGGER freshness_version_outage;
         DROP TRIGGER freshness_action_outage;`,
      );
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
