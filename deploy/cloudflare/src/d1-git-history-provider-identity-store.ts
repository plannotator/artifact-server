import {Effect} from "effect";

import {
  GitHistoryProviderIdentityStoreFailure,
  type ActivateGitHistoryProviderIdentity,
  type GitHistoryProviderIdentity,
  type GitHistoryProviderIdentityActivation,
  type GitHistoryProviderIdentityStore,
} from "../../../src/git-history/git-history-provider-identity.js";

interface IdentityRow {
  readonly accountId: string;
  readonly namespace: string;
  readonly provider: "cloudflare-artifacts";
}

/** D1 persistence for the installation's nonsecret Cloudflare location. */
export class D1GitHistoryProviderIdentityStore implements
  GitHistoryProviderIdentityStore {
  readonly #database: D1Database;
  readonly #installationId: string;

  constructor(database: D1Database, installationId: string) {
    this.#database = database;
    this.#installationId = installationId;
  }

  read(): Effect.Effect<
    GitHistoryProviderIdentity | null,
    GitHistoryProviderIdentityStoreFailure
  > {
    return Effect.tryPromise({
      try: async () => {
        const row = await this.#database.prepare(`
          SELECT provider, account_id AS accountId, namespace
          FROM git_history_provider_identity
          WHERE installation_id = ?
        `).bind(this.#installationId).first<IdentityRow>();
        return row ?? null;
      },
      catch: (cause) => new GitHistoryProviderIdentityStoreFailure({
        cause,
        operation: "read",
      }),
    });
  }

  activate(
    input: ActivateGitHistoryProviderIdentity,
  ): Effect.Effect<
    GitHistoryProviderIdentityActivation,
    GitHistoryProviderIdentityStoreFailure
  > {
    return Effect.tryPromise({
      try: async () => {
        const inserted = await this.#database.prepare(`
          INSERT OR IGNORE INTO git_history_provider_identity (
            installation_id, provider, account_id, namespace, activated_at
          ) VALUES (?, ?, ?, ?, ?)
        `).bind(
          this.#installationId,
          input.identity.provider,
          input.identity.accountId,
          input.identity.namespace,
          input.activatedAt,
        ).run();
        const persisted = await this.#database.prepare(`
          SELECT provider, account_id AS accountId, namespace
          FROM git_history_provider_identity
          WHERE installation_id = ?
        `).bind(this.#installationId).first<IdentityRow>();
        if (persisted === null) return {_tag: "LocationClaimed"} as const;
        if (
          persisted.provider === input.identity.provider &&
          persisted.accountId === input.identity.accountId &&
          persisted.namespace === input.identity.namespace
        ) {
          return inserted.meta.changes === 1
            ? {_tag: "Activated"} as const
            : {_tag: "Matched"} as const;
        }
        return {_tag: "Mismatch", persisted} as const;
      },
      catch: (cause) => new GitHistoryProviderIdentityStoreFailure({
        cause,
        operation: "activate",
      }),
    });
  }
}
