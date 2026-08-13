# Local performance baseline

This directory contains a bounded diagnostic, not a capacity or stress test. It starts a real local server with a temporary SQLite database and real disk blobs, then exercises the same HTTP routes a client uses.

```sh
pnpm verify:iteration
pnpm smoke
pnpm perf:baseline
```

`pnpm verify:iteration` is the required end-of-iteration command and includes the other verification layers plus the default baseline. `pnpm smoke` runs a very small CI-safe scenario and fails on broken behavior or only gross performance failures. `pnpm perf:baseline` runs 40 sequential 16 KiB publications, 120 content reads at concurrency 6, bounded version comparisons and artifact-list reads, and one restart. The default run moves only a few megabytes and deletes its temporary server data when finished.

The baseline writes `evidence/local-performance-baseline.json`. Results are machine-specific. Compare the same machine, Node version, workload, and storage class when looking for a regression. Do not treat one laptop's operations-per-second number as a production capacity claim.

The JSON report records:

- publish, content read, comparison, and artifact-list p50, p95, p99, mean, maximum, and throughput;
- event-loop delay and utilization;
- process CPU and memory change for the combined benchmark client and local server process;
- local storage bytes and file count;
- restart time and persistence checks;
- environment and workload details.

The manual baseline reports investigation warnings but does not fail on those heuristics. The smoke test uses intentionally broad limits so ordinary CI variance does not create noise.

The current harness runs its HTTP client and server in one process so the event-loop signal covers the complete local path. Its memory result is therefore a high-water signal for that combined process, not a claim about server-only memory or a leak. If memory becomes a release gate, collect server-process telemetry separately before setting a tight budget.

Safe command-line bounds prevent accidental stress runs:

```sh
pnpm perf:baseline --publications 100 --reads 500 --concurrency 8 --payload-kib 32
```

Publications are capped at 500, reads at 5,000, concurrency at 16, and payload size at 1 MiB. In addition, the measured publication payload is capped at 128 MiB and the measured read payload at 256 MiB, so combining maximum flags cannot accidentally create a stress test.
