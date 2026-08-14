import {HeadBucketCommand, S3Client} from "@aws-sdk/client-s3";
import {createHash} from "node:crypto";
import {DatabaseSync} from "node:sqlite";
import path from "node:path";

import {Effect, type Redacted, Schema} from "effect";
import {SqlClient} from "effect/unstable/sql/SqlClient";

import type {BlobStore} from "../core/ports.js";
import {createS3ClientConfig} from
  "../external-storage/create-external-storage-runtime.js";
import {createManifest} from "../manifest/create-manifest.js";
import {LocalBlobStore} from "../storage/local-blob-store.js";
import {PostgresDatabase} from "../storage/postgres-database.js";
import {createS3ObjectStorageAdapters} from "../storage/s3-object-storage.js";
import type {ExternalObjectStorageConfig} from
  "../external-storage/create-external-storage-runtime.js";

const artifactRowSchema = Schema.Struct({
  currentVersionId: Schema.NullOr(Schema.String),
  id: Schema.String,
});
const versionRowSchema = Schema.Struct({
  artifactId: Schema.String,
  entryPath: Schema.String,
  id: Schema.String,
  manifestDigest: Schema.String,
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

type ArtifactRow = typeof artifactRowSchema.Type;
type VersionRow = typeof versionRowSchema.Type;
type EntryRow = typeof entryRowSchema.Type;

interface IntegrityCatalog {
  readonly artifacts: readonly ArtifactRow[];
  readonly entries: readonly EntryRow[];
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
    | "orphan_entry"
    | "orphan_version";
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
    provider: Schema.Literals(["filesystem", "postgres", "s3", "sqlite"]),
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
  readonly objectStorage: ExternalObjectStorageConfig;
}

/** Run the same read-only integrity contract against Postgres and S3. */
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
  const client = new S3Client(createS3ClientConfig(configuration.objectStorage));
  try {
    const catalog = await database.health().then(() => database.run(
      readExternalCatalog(configuration.installationId),
    )).catch(() => {
      throw new IntegrityCheckError({
        message: "Postgres could not be inspected.",
        provider: "postgres",
      });
    });
    await client.send(new HeadBucketCommand({
      Bucket: configuration.objectStorage.bucket,
    })).catch(() => {
      throw new IntegrityCheckError({
        message: "Object storage could not be inspected.",
        provider: "s3",
      });
    });
    const {blobs} = createS3ObjectStorageAdapters({
      bucket: configuration.objectStorage.bucket,
      client,
      installationId: configuration.installationId,
    });
    return await Effect.runPromise(checkCatalog(catalog, blobs));
  } catch (error) {
    if (error instanceof IntegrityCheckError) throw error;
    throw new IntegrityCheckError({
      message: "The external providers could not be inspected.",
      provider: "postgres",
    });
  } finally {
    client.destroy();
    await database.close();
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
        SELECT id, current_version_id AS currentVersionId
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
      versions: decodeVersionRows(database.prepare(`
        SELECT
          id,
          artifact_id AS artifactId,
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
    const [artifacts, versions, entries] = yield* Effect.all([
      sql<ArtifactRow>`
        SELECT id, current_version_id AS "currentVersionId"
        FROM artifacts
        WHERE installation_id = ${installationId}
        ORDER BY id
      `.withoutTransform,
      sql<VersionRow>`
        SELECT
          id,
          artifact_id AS "artifactId",
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
    ]);
    return {
      artifacts: decodeArtifactRows(artifacts),
      entries: decodeEntryRows(entries),
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
  const versions = new Map(catalog.versions.map((version) => [version.id, version]));
  const entriesByVersion = new Map<string, EntryRow[]>();

  for (const version of catalog.versions) {
    if (!artifacts.has(version.artifactId)) {
      problems.push({
        artifactId: version.artifactId,
        code: "orphan_version",
        message: "A saved version refers to an artifact that does not exist.",
        path: null,
        versionId: version.id,
      });
    }
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
    if (current !== null && versions.get(current)?.artifactId !== artifact.id) {
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
