import {describe, expect, test} from "vitest";

import {
  runLocalBaseline,
  smokeBaselineConfig,
} from "../../performance/local-baseline.js";

describe("bounded local runtime smoke", () => {
  test("publishes, reads concurrently, restarts, and stays within gross safety limits", async () => {
    const report = await runLocalBaseline(smokeBaselineConfig);

    expect(report.checks).toEqual({
      healthEndpoint: "passed",
      previousVersionDeniedAfterRestart: "passed",
      restartPersistence: "passed",
    });
    expect(report.publish.latency.count).toBe(smokeBaselineConfig.publications);
    expect(report.read.latency.count).toBe(smokeBaselineConfig.reads);
    expect(report.publish.latency.p95Milliseconds).toBeLessThan(2_000);
    expect(report.read.latency.p95Milliseconds).toBeLessThan(2_000);
    expect(report.eventLoop.maximumDelayMilliseconds).toBeLessThan(1_000);
    expect(report.memory.rssDeltaBytes).toBeLessThan(268_435_456);
    expect(report.storage.files).toBeGreaterThan(0);
  });

  test("rejects a workload whose aggregate bytes would become a stress test", async () => {
    await expect(runLocalBaseline({
      concurrency: 16,
      payloadBytes: 1_048_576,
      publications: 500,
      reads: 5_000,
      warmupPublications: 3,
    })).rejects.toThrow("workload must stay at or below 128 MiB");
  });
});
