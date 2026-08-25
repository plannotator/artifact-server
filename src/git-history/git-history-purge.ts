import {
  gitHistoryProviderIdentitiesEqual,
  type GitHistoryProviderIdentity,
} from "./git-history-provider-identity.js";
import type {
  GitHistoryProvider,
  GitRepositoryCoordinates,
} from "./git-history-mirror.js";

/** Credential-free inventory returned before an installation-wide purge. */
export interface GitHistoryPurgePlan {
  readonly alreadyDeletedRepositories: number;
  readonly enabledProjects: number;
  readonly installationId: string;
  readonly logicalCopiedBytes: number;
  readonly providerIdentity: GitHistoryProviderIdentity;
  readonly repositories: number;
  readonly repositoriesToDelete: number;
}

/** Durable persistence required by the provider-neutral purge operation. */
export interface GitHistoryPurgeStore {
  completeGitHistoryPurge(
    coordinates: GitRepositoryCoordinates,
    completedAt: string,
  ): Promise<void>;
  listGitHistoryRepositoriesForPurge(
    afterArtifactId: string | null,
    limit: number,
  ): Promise<readonly GitRepositoryCoordinates[]>;
  readGitHistoryPurgePlan(): Promise<Omit<
    GitHistoryPurgePlan,
    "installationId" | "providerIdentity"
  >>;
}

export interface ApplyGitHistoryPurgeInput {
  readonly configuredIdentity: GitHistoryProviderIdentity;
  readonly confirmInstallationId: string;
  readonly installationId: string;
  readonly pageSize?: number;
  readonly persistedIdentity: GitHistoryProviderIdentity;
  readonly provider: GitHistoryProvider;
  readonly store: GitHistoryPurgeStore;
}

export interface GitHistoryPurgeResult extends GitHistoryPurgePlan {
  readonly deletedDuringRun: number;
}

/** Read a purge plan without constructing or calling a provider adapter. */
export async function planGitHistoryPurge(input: {
  readonly installationId: string;
  readonly persistedIdentity: GitHistoryProviderIdentity;
  readonly store: GitHistoryPurgeStore;
}): Promise<GitHistoryPurgePlan> {
  return {
    ...await input.store.readGitHistoryPurgePlan(),
    installationId: input.installationId,
    providerIdentity: input.persistedIdentity,
  };
}

/**
 * Delete only repositories named by persisted coordinates.
 *
 * Each provider confirmation is durably recorded before the next repository.
 * Re-running after interruption therefore resumes from the first non-deleted
 * coordinate and never needs an account- or namespace-wide list operation.
 */
export async function applyGitHistoryPurge(
  input: ApplyGitHistoryPurgeInput,
): Promise<GitHistoryPurgeResult> {
  if (input.confirmInstallationId !== input.installationId) {
    throw new Error("The purge confirmation does not match this installation ID.");
  }
  if (
    !gitHistoryProviderIdentitiesEqual(
      input.configuredIdentity,
      input.persistedIdentity,
    )
  ) {
    throw new Error(
      "The configured Git provider location does not own the persisted repositories.",
    );
  }
  const initialPlan = await planGitHistoryPurge({
    installationId: input.installationId,
    persistedIdentity: input.persistedIdentity,
    store: input.store,
  });
  if (initialPlan.enabledProjects > 0) {
    throw new Error(
      "Disable Git history for every project before purging its repositories.",
    );
  }
  const pageSize = input.pageSize ?? 25;
  if (!Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 100) {
    throw new Error("The purge page size must be an integer from 1 through 100.");
  }
  const drain = async (
    afterArtifactId: string | null,
    deleted: number,
  ): Promise<number> => {
    const page = await input.store.listGitHistoryRepositoriesForPurge(
      afterArtifactId,
      pageSize,
    );
    if (page.length === 0) return deleted;
    const deletePage = async (index: number): Promise<number> => {
      const coordinates = page[index];
      if (coordinates === undefined) return deleted + page.length;
      await input.provider.deleteRepository(coordinates);
      await input.store.completeGitHistoryPurge(
        coordinates,
        new Date().toISOString(),
      );
      return deletePage(index + 1);
    };
    const nextDeleted = await deletePage(0);
    const last = page.at(-1);
    if (last === undefined) return nextDeleted;
    return drain(last.artifactId, nextDeleted);
  };
  const deletedDuringRun = await drain(null, 0);
  return {
    ...await planGitHistoryPurge({
      installationId: input.installationId,
      persistedIdentity: input.persistedIdentity,
      store: input.store,
    }),
    deletedDuringRun,
  };
}
