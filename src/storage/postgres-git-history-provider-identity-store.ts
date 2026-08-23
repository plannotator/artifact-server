import {Effect, Schema} from "effect";
import {SqlClient} from "effect/unstable/sql/SqlClient";

import {
  GitHistoryProviderIdentityStoreFailure,
  type ActivateGitHistoryProviderIdentity,
  type GitHistoryProviderIdentity,
  type GitHistoryProviderIdentityActivation,
  type GitHistoryProviderIdentityStore,
} from "../git-history/git-history-provider-identity.js";
import type {PostgresDatabase} from "./postgres-database.js";

const identityRow = Schema.Struct({
  account_id: Schema.String,
  namespace: Schema.String,
  provider: Schema.Literal("cloudflare-artifacts"),
});
interface IdentityRow extends Schema.Schema.Type<typeof identityRow> {}

/** Postgres provider-identity adapter for stateless external-storage processes. */
export class PostgresGitHistoryProviderIdentityStore implements
  GitHistoryProviderIdentityStore {
  readonly #database: PostgresDatabase;
  readonly #installationId: string;

  constructor(database: PostgresDatabase, installationId: string) {
    this.#database = database;
    this.#installationId = installationId;
  }

  /** Atomically claim the checked location or report its existing owner/state. */
  activate(
    input: ActivateGitHistoryProviderIdentity,
  ): Effect.Effect<
    GitHistoryProviderIdentityActivation,
    GitHistoryProviderIdentityStoreFailure
  > {
    return activateIdentity(this.#database, this.#installationId, input);
  }

  /** Read the installation's persisted nonsecret provider location. */
  read(): Effect.Effect<
    GitHistoryProviderIdentity | null,
    GitHistoryProviderIdentityStoreFailure
  > {
    return readIdentity(this.#database, this.#installationId);
  }
}

const readIdentity = Effect.fn("GitHistory.PostgresIdentityStore.read")(
  function*(
    database: PostgresDatabase,
    installationId: string,
  ): Effect.fn.Return<
    GitHistoryProviderIdentity | null,
    GitHistoryProviderIdentityStoreFailure
  > {
    return yield* Effect.tryPromise({
      try: () => database.run(Effect.gen(function*() {
        const sql = yield* SqlClient;
        const rows = yield* sql<{
          readonly account_id: string;
          readonly namespace: string;
          readonly provider: string;
        }>`
          SELECT provider, account_id, namespace
          FROM git_history_provider_identity
          WHERE installation_id = ${installationId}
        `.withoutTransform;
        const row = rows[0];
        return row === undefined
          ? null
          : projectIdentityRow(Schema.decodeUnknownSync(identityRow)(row));
      })),
      catch: (cause) => new GitHistoryProviderIdentityStoreFailure({
        cause,
        operation: "read",
      }),
    });
  },
);

const activateIdentity = Effect.fn("GitHistory.PostgresIdentityStore.activate")(
  function*(
    database: PostgresDatabase,
    installationId: string,
    input: ActivateGitHistoryProviderIdentity,
  ): Effect.fn.Return<
    GitHistoryProviderIdentityActivation,
    GitHistoryProviderIdentityStoreFailure
  > {
    return yield* Effect.tryPromise({
      try: () => database.run(Effect.gen(function*() {
        const sql = yield* SqlClient;
        return yield* sql.withTransaction(Effect.gen(function*() {
          const inserted = yield* sql<{readonly installation_id: string}>`
            INSERT INTO git_history_provider_identity (
              installation_id, provider, account_id, namespace, activated_at
            ) VALUES (
              ${installationId}, ${input.identity.provider},
              ${input.identity.accountId}, ${input.identity.namespace},
              ${input.activatedAt}
            )
            ON CONFLICT DO NOTHING
            RETURNING installation_id
          `.withoutTransform;
          const rows = yield* sql<{
            readonly account_id: string;
            readonly namespace: string;
            readonly provider: string;
          }>`
            SELECT provider, account_id, namespace
            FROM git_history_provider_identity
            WHERE installation_id = ${installationId}
          `.withoutTransform;
          const row = rows[0];
          const persisted = row === undefined
            ? null
            : projectIdentityRow(Schema.decodeUnknownSync(identityRow)(row));
          if (persisted === null) return {_tag: "LocationClaimed"} as const;
          if (
            persisted.provider === input.identity.provider &&
            persisted.accountId === input.identity.accountId &&
            persisted.namespace === input.identity.namespace
          ) {
            return inserted.length === 1
              ? {_tag: "Activated"} as const
              : {_tag: "Matched"} as const;
          }
          return {_tag: "Mismatch", persisted} as const;
        }));
      })),
      catch: (cause) => new GitHistoryProviderIdentityStoreFailure({
        cause,
        operation: "activate",
      }),
    });
  },
);

function projectIdentityRow(parsed: IdentityRow): GitHistoryProviderIdentity {
  return {
    accountId: parsed.account_id,
    namespace: parsed.namespace,
    provider: parsed.provider,
  };
}
