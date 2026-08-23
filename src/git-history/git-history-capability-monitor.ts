import {Effect, Fiber, Result, Schedule} from "effect";

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
export function startGitHistoryCapabilityMonitor(
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
  const fiber = Effect.runFork(Effect.repeat(
    pass,
    Schedule.spaced(
      config.refreshIntervalMilliseconds ?? defaultRefreshIntervalMilliseconds,
    ).pipe(Schedule.jittered),
  ));
  return {
    close: () => Effect.runPromise(Fiber.interrupt(fiber)),
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
  const persisted = yield* config.identityStore.read().pipe(Effect.result);
  if (Result.isFailure(persisted)) {
    config.updateProviderState("degraded");
    yield* logMonitorIssue("identity_read_failed");
    return;
  }
  if (
    persisted.success !== null &&
    !gitHistoryProviderIdentitiesEqual(persisted.success, config.identity)
  ) {
    config.updateProviderState("migration-required");
    yield* logMonitorIssue("identity_mismatch");
    return;
  }

  const health = yield* config.providerHealth.check();
  if (health.state !== "available") {
    config.updateProviderState(health.state);
    yield* logMonitorIssue(health.reason);
    return;
  }
  if (persisted.success !== null) {
    config.updateProviderState("available");
    return;
  }

  const activated = yield* config.identityStore.activate({
    activatedAt: config.clock.now().toISOString(),
    identity: config.identity,
  }).pipe(Effect.result);
  if (Result.isFailure(activated)) {
    config.updateProviderState("degraded");
    yield* logMonitorIssue("identity_activation_failed");
    return;
  }
  const activationState = providerStateFromActivation(activated.success);
  config.updateProviderState(activationState);
  if (activationState !== "available") {
    yield* logMonitorIssue(
      activationState === "migration-required"
        ? "identity_activation_mismatch"
        : "identity_location_claimed",
    );
  }
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
