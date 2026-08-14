import * as PgClient from "@effect/sql-pg/PgClient";
import {
  Effect,
  ManagedRuntime,
  Schema,
  type Redacted,
} from "effect";
import {SqlClient} from "effect/unstable/sql/SqlClient";
import type {SqlError} from "effect/unstable/sql/SqlError";

import {
  readPostgresMigrationStatus,
  runPostgresMigrations,
  type PostgresMigrationStatus,
} from "./postgres-migrations.js";

type PostgresRuntime = ManagedRuntime.ManagedRuntime<
  PgClient.PgClient | SqlClient,
  SqlError
>;

/** Configuration for one process-local Postgres pool. */
export interface PostgresDatabaseConfig {
  readonly applicationName?: string;
  readonly maxConnections?: number;
  readonly url: Redacted.Redacted;
}

/** Whether opening Postgres may mutate its schema. */
export type PostgresMigrationMode = "apply" | "validate";

/** The database schema cannot be served by this application build. */
export class PostgresSchemaIncompatibleError extends Schema.TaggedError<PostgresSchemaIncompatibleError>()(
  "PostgresSchemaIncompatibleError",
  {
    compatibility: Schema.Literals([
      "divergent",
      "missing",
      "newer",
      "pending",
    ]),
    currentVersion: Schema.Int,
    message: Schema.String,
    requiredVersion: Schema.Int,
  },
) {}

/** One owned Postgres pool and migration boundary shared by persistence adapters. */
export class PostgresDatabase {
  readonly #runtime: PostgresRuntime;

  private constructor(runtime: PostgresRuntime) {
    this.#runtime = runtime;
  }

  /** Connect and apply or validate migrations before returning Postgres. */
  static async open(
    config: PostgresDatabaseConfig,
    migrationMode: PostgresMigrationMode,
  ): Promise<PostgresDatabase> {
    const database = await PostgresDatabase.inspect({
      ...config,
      applicationName: config.applicationName ?? "artifact-server",
      maxConnections: config.maxConnections ?? 10,
    });
    try {
      if (migrationMode === "apply") {
        await database.#runtime.runPromise(runPostgresMigrations);
      }
      const status = await database.migrationStatus();
      assertCompatibleMigrationStatus(status);
      return database;
    } catch (cause) {
      await database.close();
      throw cause;
    }
  }

  /** Connect without applying or validating migrations for operator inspection. */
  static async inspect(
    config: PostgresDatabaseConfig,
  ): Promise<PostgresDatabase> {
    const runtime: PostgresRuntime = ManagedRuntime.make(PgClient.layer({
      applicationName: config.applicationName ?? "artifact-server-inspection",
      connectTimeout: "10 seconds",
      idleTimeout: "30 seconds",
      maxConnections: config.maxConnections ?? 1,
      url: config.url,
    }));
    try {
      await runtime.context();
      return new PostgresDatabase(runtime);
    } catch (cause) {
      await runtime.dispose();
      throw cause;
    }
  }

  /** Read migration compatibility without applying schema changes. */
  migrationStatus(): Promise<PostgresMigrationStatus> {
    return this.#runtime.runPromise(readPostgresMigrationStatus);
  }

  /** Run one Effect SQL program against the owned pool. */
  run<A, E>(
    program: Effect.Effect<A, E, SqlClient | PgClient.PgClient>,
  ): Promise<A> {
    return this.#runtime.runPromise(program);
  }

  /** Verify that Postgres accepts a query before reporting ready. */
  health(): Promise<void> {
    return this.#runtime.runPromise(
      Effect.gen(function*() {
        const sql = yield* SqlClient;
        yield* sql`SELECT 1 AS healthy`;
      }).pipe(Effect.timeout("3 seconds")),
    );
  }

  /** Close the process-local Postgres pool. */
  close(): Promise<void> {
    return this.#runtime.dispose();
  }
}

function assertCompatibleMigrationStatus(status: PostgresMigrationStatus): void {
  if (status.compatibility === "current") return;
  throw new PostgresSchemaIncompatibleError({
    compatibility: status.compatibility,
    currentVersion: status.currentVersion,
    message: `Postgres schema ${status.currentVersion} is ${status.compatibility}; ` +
      `this build requires schema ${status.requiredVersion}.`,
    requiredVersion: status.requiredVersion,
  });
}
