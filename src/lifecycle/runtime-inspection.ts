import path from "node:path";

import type {ObjectStorageProvider} from
  "../storage/object-storage-provider.js";
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
  const objectStorage = createObjectStorage(configuration);
  try {
    const databaseStatus = await inspectProvider(() => database?.health());
    const migrations = database === null
      ? unavailablePostgresMigrationStatus
      : await database.migrationStatus().catch(() => unavailablePostgresMigrationStatus);
    const objectStorageStatus = await inspectProvider(() =>
      objectStorage?.readiness(AbortSignal.timeout(3_000))
    );
    return {
      database: databaseStatus,
      migrations,
      objectStorage: objectStorageStatus,
      status: databaseStatus.status === "ready" &&
          migrations.compatibility === "current" &&
          objectStorageStatus.status === "ready"
        ? "ready"
        : "not_ready",
    };
  } finally {
    await Promise.all([
      objectStorage?.close() ?? Promise.resolve(),
      database?.close() ?? Promise.resolve(),
    ]);
  }
}

function createObjectStorage(
  configuration: ExternalStorageRuntimeConfiguration,
): ObjectStorageProvider | null {
  try {
    return configuration.objectStorage.create(configuration.installationId);
  } catch {
    return null;
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
