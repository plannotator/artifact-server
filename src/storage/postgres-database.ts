import * as PgClient from "@effect/sql-pg/PgClient";
import {
  Effect,
  ManagedRuntime,
  type Redacted,
} from "effect";
import {SqlClient} from "effect/unstable/sql/SqlClient";
import type {SqlError} from "effect/unstable/sql/SqlError";

import {runPostgresMigrations} from "./postgres-migrations.js";

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

/** One owned Postgres pool and migration boundary shared by persistence adapters. */
export class PostgresDatabase {
  readonly #runtime: PostgresRuntime;

  private constructor(runtime: PostgresRuntime) {
    this.#runtime = runtime;
  }

  /** Connect, migrate, and return one ready Postgres database boundary. */
  static async open(config: PostgresDatabaseConfig): Promise<PostgresDatabase> {
    const runtime: PostgresRuntime = ManagedRuntime.make(PgClient.layer({
      applicationName: config.applicationName ?? "artifact-server",
      connectTimeout: "10 seconds",
      idleTimeout: "30 seconds",
      maxConnections: config.maxConnections ?? 10,
      url: config.url,
    }));
    try {
      await runtime.context();
      await runtime.runPromise(runPostgresMigrations);
      return new PostgresDatabase(runtime);
    } catch (cause) {
      await runtime.dispose();
      throw cause;
    }
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
