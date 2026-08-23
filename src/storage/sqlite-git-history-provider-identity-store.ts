import {DatabaseSync} from "node:sqlite";

import {Effect, Schema} from "effect";

import {
  GitHistoryProviderIdentityStoreFailure,
  type ActivateGitHistoryProviderIdentity,
  type GitHistoryProviderIdentity,
  type GitHistoryProviderIdentityActivation,
  type GitHistoryProviderIdentityStore,
} from "../git-history/git-history-provider-identity.js";

const identityRow = Schema.Struct({
  account_id: Schema.String,
  namespace: Schema.String,
  provider: Schema.Literal("cloudflare-artifacts"),
});
interface IdentityRow extends Schema.Schema.Type<typeof identityRow> {}

/** SQLite provider-identity adapter sharing one compact installation database. */
export class SqliteGitHistoryProviderIdentityStore implements
  GitHistoryProviderIdentityStore {
  readonly #database: DatabaseSync;
  readonly #installationId: string;

  constructor(databasePath: string, installationId: string) {
    this.#database = new DatabaseSync(databasePath, {
      allowExtension: false,
      enableForeignKeyConstraints: true,
      open: true,
      timeout: 5_000,
    });
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

  /** Close this adapter's SQLite handle. */
  close(): void {
    this.#database.close();
  }
}

const readIdentity = Effect.fn("GitHistory.SqliteIdentityStore.read")(
  function*(
    database: DatabaseSync,
    installationId: string,
  ): Effect.fn.Return<
    GitHistoryProviderIdentity | null,
    GitHistoryProviderIdentityStoreFailure
  > {
    return yield* Effect.try({
      try: () => {
        const row = database.prepare(`
          SELECT provider, account_id, namespace
          FROM git_history_provider_identity
          WHERE installation_id = ?
        `).get(installationId);
        return row === undefined
          ? null
          : projectIdentityRow(Schema.decodeUnknownSync(identityRow)(row));
      },
      catch: (cause) => new GitHistoryProviderIdentityStoreFailure({
        cause,
        operation: "read",
      }),
    });
  },
);

const activateIdentity = Effect.fn("GitHistory.SqliteIdentityStore.activate")(
  function*(
    database: DatabaseSync,
    installationId: string,
    input: ActivateGitHistoryProviderIdentity,
  ): Effect.fn.Return<
    GitHistoryProviderIdentityActivation,
    GitHistoryProviderIdentityStoreFailure
  > {
    return yield* Effect.try({
      try: () => {
        database.exec("BEGIN IMMEDIATE");
        try {
          const inserted = database.prepare(`
            INSERT OR IGNORE INTO git_history_provider_identity (
              installation_id, provider, account_id, namespace, activated_at
            ) VALUES (?, ?, ?, ?, ?)
          `).run(
            installationId,
            input.identity.provider,
            input.identity.accountId,
            input.identity.namespace,
            input.activatedAt,
          );
          const persistedRow = database.prepare(`
            SELECT provider, account_id, namespace
            FROM git_history_provider_identity
            WHERE installation_id = ?
          `).get(installationId);
          const persisted = persistedRow === undefined
            ? null
            : projectIdentityRow(
              Schema.decodeUnknownSync(identityRow)(persistedRow),
            );
          database.exec("COMMIT");
          if (persisted === null) return {_tag: "LocationClaimed"} as const;
          if (
            persisted.provider === input.identity.provider &&
            persisted.accountId === input.identity.accountId &&
            persisted.namespace === input.identity.namespace
          ) {
            return inserted.changes === 1
              ? {_tag: "Activated"} as const
              : {_tag: "Matched"} as const;
          }
          return {_tag: "Mismatch", persisted} as const;
        } catch (cause) {
          database.exec("ROLLBACK");
          throw cause;
        }
      },
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
