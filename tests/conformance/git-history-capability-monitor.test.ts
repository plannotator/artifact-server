import {Effect, ManagedRuntime} from "effect";
import {TestClock} from "effect/testing";
import {afterAll, afterEach, describe, expect, test} from "vitest";

import {
  startGitHistoryCapabilityMonitor,
  type GitHistoryCapabilityMonitor,
} from "../../src/git-history/git-history-capability-monitor.js";
import type {GitHistoryProviderHealth} from
  "../../src/git-history/git-history-provider-health.js";
import type {GitHistoryProviderIdentity} from
  "../../src/git-history/git-history-provider-identity.js";

describe("Git history capability monitoring", () => {
  const runtime = ManagedRuntime.make(TestClock.layer());
  let monitor: GitHistoryCapabilityMonitor | null = null;

  afterEach(async () => {
    if (monitor !== null) await monitor.close();
    monitor = null;
  });
  afterAll(() => runtime.dispose());

  test("Git monitor lifecycle: a provider outage recovers and shutdown stops later checks", async () => {
    const identity: GitHistoryProviderIdentity = {
      accountId: "monitor-test-account",
      namespace: "monitor-test-namespace",
      provider: "cloudflare-artifacts",
    };
    let health: GitHistoryProviderHealth = {state: "available"};
    let checks = 0;
    monitor = startGitHistoryCapabilityMonitor(runtime, {
      clock: {now: () => new Date(0)},
      identity,
      identityStore: {
        activate: () => Effect.succeed({_tag: "Matched"}),
        read: () => Effect.succeed(identity),
      },
      initialCapability: {
        limits: {
          fileCopyBytes: 10 * 1024 * 1024,
          logicalCopiedBytes: 0,
          logicalReservedBytes: 0,
          storageBudgetBytes: null,
          versionCopyBytes: 50 * 1024 * 1024,
        },
        provider: "cloudflare-artifacts",
        providerState: "checking",
      },
      providerHealth: {
        check: () => Effect.sync(() => {
          checks += 1;
          return health;
        }),
      },
      refreshIntervalMilliseconds: 1_000,
    });

    await monitor.initialCheck;
    expect(monitor.reader.read().providerState).toBe("available");

    health = {reason: "provider_unavailable", state: "degraded"};
    await runtime.runPromise(TestClock.adjust("10 seconds"));
    expect(monitor.reader.read().providerState).toBe("degraded");

    health = {state: "available"};
    await runtime.runPromise(TestClock.adjust("10 seconds"));
    expect(monitor.reader.read().providerState).toBe("available");

    await monitor.close();
    monitor = null;
    const checksAtShutdown = checks;
    await runtime.runPromise(TestClock.adjust("1 minute"));
    expect(checks).toBe(checksAtShutdown);
  });
});
