import {createHash} from "node:crypto";
import {DatabaseSync} from "node:sqlite";
import path from "node:path";

import {Effect, type Redacted, Schema} from "effect";
import {SqlClient} from "effect/unstable/sql/SqlClient";

import type {BlobStore} from "../core/ports.js";
import {createManifest} from "../manifest/create-manifest.js";
import {LocalBlobStore} from "../storage/local-blob-store.js";
import type {
  ObjectStorageProvider,
  ObjectStorageProviderFactory,
} from
  "../storage/object-storage-provider.js";
import {objectStorageProviderKinds} from
  "../storage/object-storage-provider.js";
import {PostgresDatabase} from "../storage/postgres-database.js";

const artifactRowSchema = Schema.Struct({
  currentVersionId: Schema.NullOr(Schema.String),
  id: Schema.String,
  projectId: Schema.String,
});
const versionRowSchema = Schema.Struct({
  artifactId: Schema.String,
  entryPath: Schema.String,
  id: Schema.String,
  manifestDigest: Schema.String,
  projectId: Schema.String,
});
const projectRowSchema = Schema.Struct({id: Schema.String});
const projectReferenceRowSchema = Schema.Struct({
  artifactId: Schema.NullOr(Schema.String),
  id: Schema.String,
  kind: Schema.String,
  projectId: Schema.String,
  versionId: Schema.NullOr(Schema.String),
});
const entryRowSchema = Schema.Struct({
  disposition: Schema.String,
  mediaType: Schema.String,
  path: Schema.String,
  sha256: Schema.String,
  size: Schema.Int,
  versionId: Schema.String,
});
const decodeArtifactRows = Schema.decodeUnknownSync(Schema.Array(artifactRowSchema));
const decodeVersionRows = Schema.decodeUnknownSync(Schema.Array(versionRowSchema));
const decodeEntryRows = Schema.decodeUnknownSync(Schema.Array(entryRowSchema));
const decodeProjectRows = Schema.decodeUnknownSync(Schema.Array(projectRowSchema));
const decodeProjectReferenceRows = Schema.decodeUnknownSync(
  Schema.Array(projectReferenceRowSchema),
);

type ArtifactRow = typeof artifactRowSchema.Type;
type VersionRow = typeof versionRowSchema.Type;
type EntryRow = typeof entryRowSchema.Type;
type ProjectRow = typeof projectRowSchema.Type;
type ProjectReferenceRow = typeof projectReferenceRowSchema.Type;

interface IntegrityCatalog {
  readonly artifacts: readonly ArtifactRow[];
  readonly entries: readonly EntryRow[];
  readonly projects: readonly ProjectRow[];
  readonly projectReferences: readonly ProjectReferenceRow[];
  readonly versions: readonly VersionRow[];
}

/** One concrete inconsistency found without changing installation state. */
export interface IntegrityProblem {
  readonly artifactId: string;
  readonly code:
    | "blob_digest_mismatch"
    | "blob_missing"
    | "blob_size_mismatch"
    | "blob_unreadable"
    | "current_pointer_missing"
    | "manifest_invalid"
    | "orphan_project"
    | "orphan_entry"
    | "orphan_version"
    | "project_scope_mismatch";
  readonly message: string;
  readonly path: string | null;
  readonly versionId: string | null;
}

/** Complete result of one read-only integrity scan. */
export interface IntegrityReport {
  readonly artifactsChecked: number;
  readonly blobsChecked: number;
  readonly bytesChecked: number;
  readonly manifestsChecked: number;
  readonly problems: readonly IntegrityProblem[];
  readonly status: "healthy" | "corrupt";
  readonly versionsChecked: number;
}

/** The integrity scanner could not inspect a required provider. */
export class IntegrityCheckError extends Schema.TaggedError<IntegrityCheckError>()(
  "IntegrityCheckError",
  {
    message: Schema.String,
    provider: Schema.Literals([
      ...objectStorageProviderKinds,
      "filesystem",
      "postgres",
      "sqlite",
    ]),
  },
) {}

/** Run a complete read-only compact installation integrity scan. */
export const checkCompactIntegrity = Effect.fn("checkCompactIntegrity")(
  function*(
    dataDirectory: string,
  ): Effect.fn.Return<IntegrityReport, IntegrityCheckError> {
    const databasePath = path.join(dataDirectory, "artifact-server.db");
    const catalog = yield* Effect.try({
      try: () => readCompactCatalog(databasePath),
      catch: () => new IntegrityCheckError({
        message: "The compact database could not be inspected.",
        provider: "sqlite",
      }),
    });
    const blobs = new LocalBlobStore(path.join(dataDirectory, "blobs"));
    return yield* checkCatalog(catalog, blobs);
  },
);

/** Provider values required by an external-storage integrity scan. */
export interface ExternalIntegrityConfiguration {
  readonly databaseUrl: Redacted.Redacted;
  readonly installationId: string;
  readonly objectStorage: ObjectStorageProviderFactory;
}

/** Run the same read-only integrity contract against external providers. */
export async function checkExternalStorageIntegrity(
  configuration: ExternalIntegrityConfiguration,
): Promise<IntegrityReport> {
  let database: PostgresDatabase;
  try {
    database = await PostgresDatabase.inspect({
      applicationName: `artifact-server-integrity:${configuration.installationId}`,
      maxConnections: 1,
      url: configuration.databaseUrl,
    });
  } catch {
    throw new IntegrityCheckError({
      message: "Postgres could not be inspected.",
      provider: "postgres",
    });
  }
  let objectStorage: ObjectStorageProvider;
  try {
    objectStorage = configuration.objectStorage.create(
      configuration.installationId,
    );
  } catch {
    await database.close();
    throw new IntegrityCheckError({
      message: "Object storage could not be inspected.",
      provider: configuration.objectStorage.kind,
    });
  }
  try {
    const catalog = await database.health().then(() => database.run(
      readExternalCatalog(configuration.installationId),
    )).catch(() => {
      throw new IntegrityCheckError({
        message: "Postgres could not be inspected.",
        provider: "postgres",
      });
    });
    await objectStorage.readiness(AbortSignal.timeout(3_000)).catch(() => {
      throw new IntegrityCheckError({
        message: "Object storage could not be inspected.",
        provider: objectStorage.kind,
      });
    });
    return await Effect.runPromise(checkCatalog(catalog, objectStorage.blobs));
  } catch (error) {
    if (error instanceof IntegrityCheckError) throw error;
    throw new IntegrityCheckError({
      message: "The external providers could not be inspected.",
      provider: "postgres",
    });
  } finally {
    await Promise.all([objectStorage.close(), database.close()]);
  }
}

function readCompactCatalog(databasePath: string): IntegrityCatalog {
  const database = new DatabaseSync(databasePath, {
    allowExtension: false,
    enableForeignKeyConstraints: true,
    open: true,
    readOnly: true,
    timeout: 5_000,
  });
  try {
    database.enableDefensive(true);
    const quickCheck = database.prepare("PRAGMA quick_check").all();
    if (!quickCheck.some((row) => row["quick_check"] === "ok")) {
      throw new Error("SQLite quick check failed.");
    }
    return {
      artifacts: decodeArtifactRows(database.prepare(`
        SELECT id, project_id AS projectId,
          current_version_id AS currentVersionId
        FROM artifacts
        ORDER BY id
      `).all()),
      entries: decodeEntryRows(database.prepare(`
        SELECT
          version_id AS versionId,
          path,
          size,
          media_type AS mediaType,
          sha256,
          disposition
        FROM manifest_entries
        ORDER BY version_id, path
      `).all()),
      projects: decodeProjectRows(database.prepare(`
        SELECT id FROM projects ORDER BY id
      `).all()),
      projectReferences: decodeProjectReferenceRows(database.prepare(`
        SELECT 'action' AS kind, id, project_id AS projectId,
          artifact_id AS artifactId, version_id AS versionId
        FROM actions
        UNION ALL
        SELECT 'idempotency', idempotency_key, project_id,
          artifact_id, version_id
        FROM idempotency_records
        UNION ALL
        SELECT 'staged_upload', id, project_id, NULL, committed_version_id
        FROM staged_uploads
        UNION ALL
        SELECT 'content_bootstrap', token_digest, project_id,
          artifact_id, version_id
        FROM content_bootstraps
        UNION ALL
        SELECT 'content_session', token_digest, project_id,
          artifact_id, version_id
        FROM content_sessions
        ORDER BY kind, id
      `).all()),
      versions: decodeVersionRows(database.prepare(`
        SELECT
          id,
          artifact_id AS artifactId,
          project_id AS projectId,
          manifest_digest AS manifestDigest,
          entry_path AS entryPath
        FROM versions
        ORDER BY artifact_id, number
      `).all()),
    };
  } finally {
    database.close();
  }
}

function readExternalCatalog(installationId: string) {
  return Effect.gen(function*() {
    const sql = yield* SqlClient;
    const [artifacts, versions, entries, projects, projectReferences] =
      yield* Effect.all([
      sql<ArtifactRow>`
        SELECT id, project_id AS "projectId",
          current_version_id AS "currentVersionId"
        FROM artifacts
        WHERE installation_id = ${installationId}
        ORDER BY id
      `.withoutTransform,
      sql<VersionRow>`
        SELECT
          id,
          artifact_id AS "artifactId",
          project_id AS "projectId",
          manifest_digest AS "manifestDigest",
          entry_path AS "entryPath"
        FROM versions
        WHERE installation_id = ${installationId}
        ORDER BY artifact_id, number
      `.withoutTransform,
      sql<EntryRow>`
        SELECT
          version_id AS "versionId",
          path,
          CAST(size AS DOUBLE PRECISION) AS size,
          media_type AS "mediaType",
          sha256,
          disposition
        FROM manifest_entries
        WHERE installation_id = ${installationId}
        ORDER BY version_id, path
      `.withoutTransform,
      sql<ProjectRow>`
        SELECT id FROM projects
        WHERE installation_id = ${installationId}
        ORDER BY id
      `.withoutTransform,
      sql<ProjectReferenceRow>`
        SELECT 'action' AS kind, id, project_id AS "projectId",
          artifact_id AS "artifactId", version_id AS "versionId"
        FROM actions WHERE installation_id = ${installationId}
        UNION ALL
        SELECT 'idempotency', idempotency_key, project_id,
          artifact_id, version_id
        FROM idempotency_records WHERE installation_id = ${installationId}
        UNION ALL
        SELECT 'staged_upload', id, project_id, NULL, committed_version_id
        FROM staged_uploads WHERE installation_id = ${installationId}
        UNION ALL
        SELECT 'content_bootstrap', token_digest, project_id,
          artifact_id, version_id
        FROM content_bootstraps WHERE installation_id = ${installationId}
        UNION ALL
        SELECT 'content_session', token_digest, project_id,
          artifact_id, version_id
        FROM content_sessions WHERE installation_id = ${installationId}
        ORDER BY kind, id
      `.withoutTransform,
    ]);
    return {
      artifacts: decodeArtifactRows(artifacts),
      entries: decodeEntryRows(entries),
      projects: decodeProjectRows(projects),
      projectReferences: decodeProjectReferenceRows(projectReferences),
      versions: decodeVersionRows(versions),
    } satisfies IntegrityCatalog;
  });
}

const checkCatalog = Effect.fn("checkIntegrityCatalog")(function*(
  catalog: IntegrityCatalog,
  blobs: BlobStore,
): Effect.fn.Return<IntegrityReport> {
  const problems: IntegrityProblem[] = [];
  const artifacts = new Map(catalog.artifacts.map((artifact) => [artifact.id, artifact]));
  const projects = new Set(catalog.projects.map((project) => project.id));
  const versions = new Map(catalog.versions.map((version) => [version.id, version]));
  const entriesByVersion = new Map<string, EntryRow[]>();

  for (const version of catalog.versions) {
    const artifact = artifacts.get(version.artifactId);
    if (artifact === undefined) {
      problems.push({
        artifactId: version.artifactId,
        code: "orphan_version",
        message: "A saved version refers to an artifact that does not exist.",
        path: null,
        versionId: version.id,
      });
    } else if (artifact.projectId !== version.projectId) {
      problems.push({
        artifactId: version.artifactId,
        code: "project_scope_mismatch",
        message: "A saved version belongs to a different project than its artifact.",
        path: null,
        versionId: version.id,
      });
    }
  }
  for (const artifact of catalog.artifacts) {
    if (projects.has(artifact.projectId)) continue;
    problems.push({
      artifactId: artifact.id,
      code: "orphan_project",
      message: "An artifact refers to a project that does not exist.",
      path: null,
      versionId: artifact.currentVersionId,
    });
  }
  for (const reference of catalog.projectReferences) {
    const artifact = reference.artifactId === null
      ? undefined
      : artifacts.get(reference.artifactId);
    const version = reference.versionId === null
      ? undefined
      : versions.get(reference.versionId);
    const projectMissing = !projects.has(reference.projectId);
    const artifactMismatch = reference.artifactId !== null &&
      (artifact === undefined || artifact.projectId !== reference.projectId);
    const versionMismatch = reference.versionId !== null &&
      (version === undefined ||
        version.projectId !== reference.projectId ||
        (reference.artifactId !== null &&
          version.artifactId !== reference.artifactId));
    if (!projectMissing && !artifactMismatch && !versionMismatch) continue;
    problems.push({
      artifactId: reference.artifactId ?? version?.artifactId ?? "unknown",
      code: projectMissing ? "orphan_project" : "project_scope_mismatch",
      message: projectMissing
        ? `A ${reference.kind} record refers to a project that does not exist.`
        : `A ${reference.kind} record crosses an artifact project boundary.`,
      path: null,
      versionId: reference.versionId,
    });
  }
  for (const entry of catalog.entries) {
    const version = versions.get(entry.versionId);
    if (version === undefined) {
      problems.push({
        artifactId: "unknown",
        code: "orphan_entry",
        message: "A manifest entry refers to a version that does not exist.",
        path: entry.path,
        versionId: entry.versionId,
      });
      continue;
    }
    const entries = entriesByVersion.get(entry.versionId) ?? [];
    entries.push(entry);
    entriesByVersion.set(entry.versionId, entries);
  }
  for (const artifact of catalog.artifacts) {
    const current = artifact.currentVersionId;
    const currentVersion = current === null ? undefined : versions.get(current);
    if (
      current !== null &&
      (currentVersion?.artifactId !== artifact.id ||
        currentVersion.projectId !== artifact.projectId)
    ) {
      problems.push({
        artifactId: artifact.id,
        code: "current_pointer_missing",
        message: "The artifact's current version does not exist for this artifact.",
        path: null,
        versionId: current,
      });
    }
  }

  for (const version of catalog.versions) {
    const entries = entriesByVersion.get(version.id) ?? [];
    try {
      const manifest = createManifest({
        entryPath: version.entryPath,
        files: entries.map((entry) => ({
          mediaType: entry.mediaType,
          path: entry.path,
          sha256: entry.sha256,
          size: entry.size,
        })),
        routingMode: "static",
      });
      const dispositionByPath = new Map(
        manifest.entries.map((entry) => [entry.path, entry.disposition] as const),
      );
      if (
        manifest.digest !== version.manifestDigest ||
        entries.some((entry) =>
          dispositionByPath.get(entry.path) !== entry.disposition
        )
      ) {
        throw new Error("Stored manifest metadata differs.");
      }
    } catch {
      problems.push({
        artifactId: version.artifactId,
        code: "manifest_invalid",
        message: "The saved manifest does not match its stored entries.",
        path: null,
        versionId: version.id,
      });
    }
  }

  const uniqueBlobs = new Map<string, EntryRow>();
  for (const entry of catalog.entries) {
    const existing = uniqueBlobs.get(entry.sha256);
    if (existing !== undefined && existing.size !== entry.size) {
      const version = versions.get(entry.versionId);
      problems.push({
        artifactId: version?.artifactId ?? "unknown",
        code: "blob_size_mismatch",
        message: "The same blob fingerprint is recorded with conflicting sizes.",
        path: entry.path,
        versionId: entry.versionId,
      });
    } else if (existing === undefined) {
      uniqueBlobs.set(entry.sha256, entry);
    }
  }
  const blobVerifications = yield* Effect.forEach(
    [...uniqueBlobs.values()],
    (entry) => Effect.promise(() => verifyBlob(blobs, entry)).pipe(
      Effect.map((verification) => ({entry, verification})),
    ),
    {concurrency: 4},
  );
  let blobsChecked = 0;
  let bytesChecked = 0;
  for (const {entry, verification} of blobVerifications) {
    if (verification.opened) blobsChecked += 1;
    bytesChecked += verification.bytesRead;
    if (verification.problem !== null) {
      const version = versions.get(entry.versionId);
      problems.push({
        artifactId: version?.artifactId ?? "unknown",
        code: verification.problem,
        message: blobProblemMessage(verification.problem),
        path: entry.path,
        versionId: entry.versionId,
      });
    }
  }
  return {
    artifactsChecked: catalog.artifacts.length,
    blobsChecked,
    bytesChecked,
    manifestsChecked: catalog.versions.length,
    problems,
    status: problems.length === 0 ? "healthy" : "corrupt",
    versionsChecked: catalog.versions.length,
  };
});

interface BlobVerification {
  readonly bytesRead: number;
  readonly opened: boolean;
  readonly problem:
    | "blob_digest_mismatch"
    | "blob_missing"
    | "blob_size_mismatch"
    | "blob_unreadable"
    | null;
}

async function verifyBlob(
  blobs: BlobStore,
  entry: EntryRow,
): Promise<BlobVerification> {
  let opened: Awaited<ReturnType<BlobStore["open"]>>;
  try {
    opened = await blobs.open(entry.sha256);
  } catch {
    return {bytesRead: 0, opened: false, problem: "blob_missing"};
  }
  const fingerprint = createHash("sha256");
  let bytesRead = 0;
  try {
    await opened.body.pipeTo(new WritableStream<Uint8Array>({
      write(chunk) {
        bytesRead += chunk.byteLength;
        fingerprint.update(chunk);
      },
    }));
    const digest = fingerprint.digest("hex");
    return {
      bytesRead,
      opened: true,
      problem: opened.size !== entry.size || bytesRead !== entry.size
        ? "blob_size_mismatch"
        : digest !== entry.sha256
        ? "blob_digest_mismatch"
        : null,
    };
  } catch {
    return {bytesRead, opened: true, problem: "blob_unreadable"};
  }
}

function blobProblemMessage(
  code: Exclude<BlobVerification["problem"], null>,
): string {
  switch (code) {
    case "blob_digest_mismatch":
      return "A referenced blob does not match its fingerprint.";
    case "blob_missing":
      return "A referenced blob could not be opened.";
    case "blob_size_mismatch":
      return "A referenced blob has the wrong size.";
    case "blob_unreadable":
      return "A referenced blob could not be read completely.";
  }
  throw new Error("Unknown blob integrity problem.");
}
