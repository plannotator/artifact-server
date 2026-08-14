# Performance baselines

These are bounded diagnostics, not capacity or stress tests. They exercise the same publication and browser-content paths used by real clients.

```sh
pnpm verify:iteration
pnpm smoke
pnpm perf:baseline
pnpm perf:capacity
pnpm verify:external-storage-performance
```

`pnpm verify:iteration` is the required end-of-iteration command and includes the other verification layers plus the default baseline. Coverage is reported as a diagnostic; percentage movement is not a reason to add a test. `pnpm smoke` runs a very small CI-safe scenario and fails on broken behavior or only gross performance failures. `pnpm perf:baseline` runs 40 sequential 16 KiB publications, 120 content reads at concurrency 6, bounded version comparisons, HTTP artifact-list reads, modern MCP discovery and MCP `artifact_list` calls, the real file-first client against representative single-file and directory inputs, and one restart. The default run remains bounded and deletes its temporary server data when finished.

The baseline writes `evidence/local-performance-baseline.json`. Results are machine-specific. Compare the same machine, Node version, workload, and storage class when looking for a regression. Do not treat one laptop's operations-per-second number as a production capacity claim.

The JSON report records:

- publish, content read, comparison, HTTP artifact-list, MCP discovery, MCP artifact-list, file-client single-file, and file-client directory p50, p95, p99, mean, maximum, and throughput;
- event-loop delay and utilization;
- process CPU and memory change for the combined benchmark client and local
  server process, with an explicit collection point before the retained-memory
  sample;
- local storage bytes and file count;
- restart time and persistence checks;
- environment and workload details.

The manual baseline reports investigation warnings but does not fail on those heuristics. The smoke test uses intentionally broad limits so ordinary CI variance does not create noise.

The original local harness runs its HTTP client and server in one process so the
event-loop signal covers the complete local path. RSS remains a useful allocator
high-water signal but is not treated as retained memory. The harness runs with
`--expose-gc` and samples retained heap and external memory after collection.
That result still covers the combined process, not server-only memory. If memory
regresses there, use the server-only capacity matrix below to determine whether
the server or the load generator owns the change.

Safe command-line bounds prevent accidental stress runs:

```sh
pnpm perf:baseline --publications 100 --reads 500 --concurrency 8 --payload-kib 32
```

Publications are capped at 500, reads at 5,000, concurrency at 16, and payload size at 1 MiB. In addition, the measured publication payload is capped at 128 MiB, the measured read payload at 256 MiB, and the real file-client workload at 32 MiB, so combining maximum settings cannot accidentally create a stress test.

## Server-only concurrency matrix

`pnpm perf:capacity` builds the product, starts the normal compiled local CLI in
a separate child process, and measures only that server process. It runs browse
and staged-publication workflows at 1, 10, 25, 50, and 100 concurrent users.
The browse workflow streams content, lists artifacts through HTTP, compares two
versions, and lists artifacts through MCP. The publication workflow uses the
real create-plan, streamed-upload, and immutable-commit sequence.

The report records starting, peak, and post-collection server memory, server CPU
and event-loop delay, complete user-journey latency and throughput, health, and
correctness. It is written to `evidence/local-capacity-baseline.json` and is part
of `pnpm verify:iteration`.

The normal matrix hard-caps concurrency at 100, streamed artifact bytes at
512 MiB, publication payload bytes at 32 MiB, and repetition at five waves. These bounds make
the command safe to repeat on a development machine. It remains a same-machine
Compact-mode baseline, not a production capacity claim for Postgres, S3,
Kubernetes, or a managed cloud.

## External-storage Postgres and S3 baseline

`pnpm verify:external-storage-performance` builds the production CLI, creates disposable pinned Postgres and MinIO containers, and starts two independent compiled Artifact Server processes against one installation and bucket. The harness uses the real file-first client and records:

- readiness time for the providers, both initial server processes, and one replacement process;
- repeated 2 MiB single-file and 48-file directory publications, including cross-process content reads;
- 16 bounded concurrent publications and 80 cross-process content reads;
- authenticated artifact-list reads from both processes;
- provider-backed publication, cross-process visibility, exact bytes, health, and process-replacement checks.

Provider provisioning is measured separately and excluded from application-operation latency. The default run caps publication concurrency at 4, read concurrency at 8, aggregate measured publication data at 64 MiB, and aggregate measured read data at 128 MiB. Command-line settings cannot raise publication concurrency above 16 or the bounded operation counts above their configured caps.

The external-storage report is written to `evidence/external-storage-performance-baseline.json`. It is a regression baseline for the same machine, container runtime, Node version, workload, and storage class. MinIO on a laptop proves the S3-compatible application path; it does not claim production AWS S3 or Cloudflare R2 latency or capacity.
