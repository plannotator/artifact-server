import {Schema, type Effect} from "effect";

/** Nonsecret external location owned by one Artifact Server installation. */
export interface GitHistoryProviderIdentity {
  readonly accountId: string;
  readonly namespace: string;
  readonly provider: "cloudflare-artifacts";
}

/** Input used to claim one provider location after its first successful check. */
export interface ActivateGitHistoryProviderIdentity {
  readonly activatedAt: string;
  readonly identity: GitHistoryProviderIdentity;
}

/** Result of atomically claiming one provider location for an installation. */
export type GitHistoryProviderIdentityActivation =
  | {readonly _tag: "Activated"}
  | {readonly _tag: "Matched"}
  | {readonly _tag: "LocationClaimed"}
  | {
    readonly _tag: "Mismatch";
    readonly persisted: GitHistoryProviderIdentity;
  };

/** A provider-identity persistence operation could not complete safely. */
export class GitHistoryProviderIdentityStoreFailure extends
  Schema.TaggedError<GitHistoryProviderIdentityStoreFailure>()(
    "GitHistoryProviderIdentityStoreFailure",
    {
      cause: Schema.Defect(),
      operation: Schema.Literals(["activate", "read"]),
    },
  ) {}

/** Durable installation-scoped provider-identity behavior required by Git history. */
export interface GitHistoryProviderIdentityStore {
  readonly activate: (
    input: ActivateGitHistoryProviderIdentity,
  ) => Effect.Effect<
    GitHistoryProviderIdentityActivation,
    GitHistoryProviderIdentityStoreFailure
  >;
  readonly read: () => Effect.Effect<
    GitHistoryProviderIdentity | null,
    GitHistoryProviderIdentityStoreFailure
  >;
}

/** Compare two nonsecret provider locations exactly. */
export function gitHistoryProviderIdentitiesEqual(
  left: GitHistoryProviderIdentity,
  right: GitHistoryProviderIdentity,
): boolean {
  return left.provider === right.provider &&
    left.accountId === right.accountId &&
    left.namespace === right.namespace;
}
