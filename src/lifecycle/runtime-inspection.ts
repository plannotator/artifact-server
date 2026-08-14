import {HeadBucketCommand, S3Client} from "@aws-sdk/client-s3";
import path from "node:path";

import {createS3ClientConfig} from
  "../external-storage/create-external-storage-runtime.js";
import {PostgresDatabase} from "../storage/postgres-database.js";
import {
  requiredPostgresSchemaVersion,
  type PostgresMigrationStatus,
} from "../storage/postgres-migrations.js";
import {
  readSqliteMigrationStatus,
  type SqliteMigrationStatus,
} from "../storage/sqlite-schema.js";
import type {
  CompactRuntimeConfiguration,
  ExternalStorageRuntimeConfiguration,
} from "./runtime-configuration.js";

/** Safe status of one required runtime provider. */
export interface ProviderInspection {
  readonly status: "ready" | "unavailable";
}

/** Secret-free provider and migration state observed by lifecycle commands. */
export interface RuntimeInspection {
  readonly database: ProviderInspection;
  readonly migrations: PostgresMigrationStatus | SqliteMigrationStatus;
  readonly objectStorage: ProviderInspection;
  readonly status: "ready" | "not_ready";
}

/** Inspect configured providers without applying a migration or serving. */
export async function inspectRuntimeConfiguration(
  configuration: CompactRuntimeConfiguration | ExternalStorageRuntimeConfiguration,
): Promise<RuntimeInspection> {
  return configuration.deploymentMode === "compact"
    ? inspectCompactRuntime(configuration)
    : inspectExternalStorageRuntime(configuration);
}

function inspectCompactRuntime(
  configuration: CompactRuntimeConfiguration,
): RuntimeInspection {
  const migrations = readSqliteMigrationStatus(
    path.join(configuration.dataDirectory, "artifact-server.db"),
  );
  return {
    database: {status: "ready"},
    migrations,
    objectStorage: {status: "ready"},
    status: migrations.compatibility === "newer" ? "not_ready" : "ready",
  };
}

async function inspectExternalStorageRuntime(
  configuration: ExternalStorageRuntimeConfiguration,
): Promise<RuntimeInspection> {
  const database = await openDatabase(configuration);
  const client = new S3Client(createS3ClientConfig(configuration.objectStorage));
  try {
    const databaseStatus = await inspectProvider(() => database?.health());
    const migrations = database === null
      ? unavailablePostgresMigrationStatus
      : await database.migrationStatus().catch(() => unavailablePostgresMigrationStatus);
    const objectStorage = await inspectProvider(() => client.send(
      new HeadBucketCommand({Bucket: configuration.objectStorage.bucket}),
    ).then(() => undefined));
    return {
      database: databaseStatus,
      migrations,
      objectStorage,
      status: databaseStatus.status === "ready" &&
          migrations.compatibility === "current" &&
          objectStorage.status === "ready"
        ? "ready"
        : "not_ready",
    };
  } finally {
    client.destroy();
    await database?.close();
  }
}

async function openDatabase(
  configuration: ExternalStorageRuntimeConfiguration,
): Promise<PostgresDatabase | null> {
  return PostgresDatabase.inspect({
    applicationName: `artifact-server-config-check:${configuration.installationId}`,
    maxConnections: 1,
    url: configuration.databaseUrl,
  }).catch(() => null);
}

async function inspectProvider(
  probe: () => Promise<void> | undefined,
): Promise<ProviderInspection> {
  try {
    const result = probe();
    if (result === undefined) return {status: "unavailable"};
    await result;
    return {status: "ready"};
  } catch {
    return {status: "unavailable"};
  }
}

const unavailablePostgresMigrationStatus: PostgresMigrationStatus = {
  compatibility: "missing",
  currentVersion: 0,
  requiredVersion: requiredPostgresSchemaVersion,
};
