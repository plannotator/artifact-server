/** Managed Git providers accepted by this release. */
export const gitHistoryProviders = ["cloudflare-artifacts"] as const;

/** The managed Git provider shipped by the first handoff implementation. */
export type GitHistoryProvider = typeof gitHistoryProviders[number];

/** Installation-level lifecycle of the optional Git provider. */
export const gitHistoryProviderStates = [
  "disabled",
  "checking",
  "available",
  "degraded",
  "misconfigured",
  "migration-required",
] as const;

export type GitHistoryProviderState = typeof gitHistoryProviderStates[number];

/** Safe limits and logical accounting exposed through capability discovery. */
export interface GitHistoryLimits {
  readonly fileCopyBytes: number;
  readonly logicalCopiedBytes: number;
  readonly logicalReservedBytes: number;
  readonly storageBudgetBytes: number | null;
  readonly versionCopyBytes: number;
}

/** Secret-free installation-level Git handoff capability. */
export interface GitHistoryCapability {
  readonly limits: GitHistoryLimits;
  readonly provider: GitHistoryProvider | null;
  readonly providerState: GitHistoryProviderState;
}

/** Cached capability source read by protocol discovery without provider I/O. */
export interface GitHistoryCapabilityReader {
  readonly read: () => GitHistoryCapability;
}

/** Default maximum copied bytes for one file in a mirrored version. */
export const defaultGitHistoryFileCopyBytes = 10 * 1024 * 1024;

/** Default maximum total copied bytes for one mirrored version. */
export const defaultGitHistoryVersionCopyBytes = 50 * 1024 * 1024;

/** Default maximum number of authored files copied into one Git commit. */
export const defaultGitHistoryMaximumCopiedFiles = 500;

/** Provider-safe upper bound accepted for one version-copy configuration. */
export const maximumGitHistoryVersionCopyBytes = 10 * 1024 * 1024 * 1024;

/** Build the off-by-default capability used when no Git provider is selected. */
export function disabledGitHistoryCapability(): GitHistoryCapability {
  return {
    limits: {
      fileCopyBytes: defaultGitHistoryFileCopyBytes,
      logicalCopiedBytes: 0,
      logicalReservedBytes: 0,
      storageBudgetBytes: null,
      versionCopyBytes: defaultGitHistoryVersionCopyBytes,
    },
    provider: null,
    providerState: "disabled",
  };
}

/** Adapt an immutable startup capability to the live discovery boundary. */
export function fixedGitHistoryCapabilityReader(
  capability: GitHistoryCapability,
): GitHistoryCapabilityReader {
  return {read: () => capability};
}
