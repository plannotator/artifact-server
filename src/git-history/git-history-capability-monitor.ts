import {Effect, Fiber, type ManagedRuntime, Result, Schedule} from "effect";
import type {Clock} from "../core/ports.js";
import type {
  GitHistoryCapability,
  GitHistoryCapabilityReader,
  GitHistoryProviderState,
} from "./git-history-capability.js";
import type {GitHistoryProviderHealthProbe} from
  "./git-history-provider-health.js";
import {
  gitHistoryProviderIdentitiesEqual,
  type GitHistoryProviderIdentity,
  type GitHistoryProviderIdentityActivation,
  type GitHistoryProviderIdentityStore,
} from "./git-history-provider-identity.js";

const defaultRefreshIntervalMilliseconds = 5 * 60 * 1_000;
const ignoreInitialCheck = (): void => undefined;

/** Dependencies for one process-local optional-provider capability monitor. */
export interface GitHistoryCapabilityMonitorConfig {
  readonly clock: Clock;
  readonly identity: GitHistoryProviderIdentity;
  readonly identityStore: GitHistoryProviderIdentityStore;
  readonly initialCapability: GitHistoryCapability;
  readonly providerHealth: GitHistoryProviderHealthProbe;
  readonly refreshIntervalMilliseconds?: number;
}

/** Live capability reader plus deterministic startup and shutdown hooks. */
export interface GitHistoryCapabilityMonitor {
  readonly close: () => Promise<void>;
  readonly initialCheck: Promise<void>;
  readonly reader: GitHistoryCapabilityReader;
}

/** Start an interruptible provider monitor whose first pass runs immediately. */
export function startGitHistoryCapabilityMonitor<R>(
  runtime: ManagedRuntime.ManagedRuntime<R, never>,
  config: GitHistoryCapabilityMonitorConfig,
): GitHistoryCapabilityMonitor {
  let capability = config.initialCapability;
  const reader: GitHistoryCapabilityReader = {read: () => capability};
  const updateProviderState = (providerState: GitHistoryProviderState): void => {
    capability = {...capability, providerState};
  };
  const refresh = refreshGitHistoryCapability({
    ...config,
    updateProviderState,
  });
  let settleInitialCheck = ignoreInitialCheck;
  const initialCheck = new Promise<void>((resolve) => {
    settleInitialCheck = resolve;
  });
  const pass = refresh.pipe(Effect.ensuring(Effect.sync(settleInitialCheck)));
  const fiber = runtime.runFork(Effect.repeat(
    pass,
    Schedule.spaced(
      config.refreshIntervalMilliseconds ?? defaultRefreshIntervalMilliseconds,
    ).pipe(Schedule.jittered),
  ));
  return {
    close: () => runtime.runPromise(Fiber.interrupt(fiber)),
    initialCheck,
    reader,
  };
}

interface RefreshGitHistoryCapabilityConfig extends
  GitHistoryCapabilityMonitorConfig {
  readonly updateProviderState: (state: GitHistoryProviderState) => void;
}

const refreshGitHistoryCapability = Effect.fn(
  "GitHistory.CapabilityMonitor.refresh",
)(function*(
  config: RefreshGitHistoryCapabilityConfig,
): Effect.fn.Return<void> {
  config.updateProviderState(yield* resolveGitHistoryProviderState(config));
});

/** Resolve one provider state without retaining process-local monitor state. */
export const resolveGitHistoryProviderState = Effect.fn(
  "GitHistory.CapabilityMonitor.resolveState",
)(function*(
  config: Pick<
    GitHistoryCapabilityMonitorConfig,
    "clock" | "identity" | "identityStore" | "providerHealth"
  >,
): Effect.fn.Return<GitHistoryProviderState> {
  const persisted = yield* config.identityStore.read().pipe(Effect.result);
  if (Result.isFailure(persisted)) {
    yield* logMonitorIssue("identity_read_failed");
    return "degraded";
  }
  if (
    persisted.success !== null &&
    !gitHistoryProviderIdentitiesEqual(persisted.success, config.identity)
  ) {
    yield* logMonitorIssue("identity_mismatch");
    return "migration-required";
  }

  const health = yield* config.providerHealth.check();
  if (health.state !== "available") {
    yield* logMonitorIssue(health.reason);
    return health.state;
  }
  if (persisted.success !== null) {
    return "available";
  }

  const activated = yield* config.identityStore.activate({
    activatedAt: config.clock.now().toISOString(),
    identity: config.identity,
  }).pipe(Effect.result);
  if (Result.isFailure(activated)) {
    yield* logMonitorIssue("identity_activation_failed");
    return "degraded";
  }
  const activationState = providerStateFromActivation(activated.success);
  if (activationState !== "available") {
    yield* logMonitorIssue(
      activationState === "migration-required"
        ? "identity_activation_mismatch"
        : "identity_location_claimed",
    );
  }
  return activationState;
});

function providerStateFromActivation(
  activation: GitHistoryProviderIdentityActivation,
): GitHistoryProviderState {
  const states = {
    Activated: "available",
    LocationClaimed: "misconfigured",
    Matched: "available",
    Mismatch: "migration-required",
  } as const;
  return states[activation._tag];
}

function logMonitorIssue(reason: string): Effect.Effect<void> {
  return Effect.logWarning("Optional Git history provider is not available.").pipe(
    Effect.annotateLogs({git_history_reason: reason}),
  );
}
