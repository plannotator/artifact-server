import type {Effect} from "effect";

/** Stable, secret-free classification from one provider availability check. */
export type GitHistoryProviderHealthReason =
  | "access_rejected"
  | "invalid_response"
  | "namespace_missing"
  | "provider_unavailable"
  | "rate_limited"
  | "transport_failure";

/** Read-only provider availability observed outside authoritative storage. */
export type GitHistoryProviderHealth =
  | {readonly state: "available"}
  | {
    readonly reason: GitHistoryProviderHealthReason;
    readonly state: "degraded" | "misconfigured";
  };

/** Narrow read-only provider operation used by capability monitoring. */
export interface GitHistoryProviderHealthProbe {
  readonly check: () => Effect.Effect<GitHistoryProviderHealth>;
}
