# Shared Postgres and S3 performance baseline

Status: complete

## Purpose

Detect obvious regressions in the shared publication and content-delivery path
before cloud packaging begins. This is a bounded engineering diagnostic. It is
not a load test, hosting-cost model, or capacity promise.

## Runtime under test

- the compiled production CLI, not an in-process substitute;
- two independent Artifact Server processes for one installation;
- one digest-pinned Postgres provider;
- one digest-pinned MinIO S3-compatible provider and bucket;
- the real file-first client, including filesystem inspection, SHA-256 hashing,
  upload-plan creation, streaming file uploads, and commit;
- one replacement server process after the measured phases.

The shared correctness suite and this baseline use the same disposable-provider
wrapper so provider versions, credentials, readiness checks, and cleanup cannot
drift.

## Default workload

1. Warm both processes outside the recorded operation summaries.
2. Publish a 2 MiB file three times and read each exact version through the
   other process.
3. Publish a 48-file directory three times and read one non-entry asset through
   the other process.
4. Publish sixteen 16 KiB files at concurrency four across both processes.
5. Read eighty exact versions at concurrency eight across both processes.
6. Read the authenticated artifact list sixteen times from both processes.
7. Replace one process and read bytes published before its replacement.

The report keeps provider provisioning, server readiness, and application
operation latency separate.

## Safety bounds

- at most 100 measured concurrent publications;
- at most 1,000 measured reads;
- at most 16 concurrent publications or reads;
- at most 64 MiB of measured publication data;
- at most 128 MiB of measured read data;
- at most five repeated representative file publications;
- at most 128 files in the representative directory.

Timing thresholds create investigation warnings only. They do not fail a run
based on one developer machine. Correctness checks do fail the run.

## Completion evidence

- [x] Both compiled processes report healthy against the same providers.
- [x] Single-file and directory publications open with exact bytes through the
      other process.
- [x] Concurrent publications and reads finish within the bounded workload.
- [x] Authenticated lists include cross-process publications.
- [x] A replacement process reads an earlier committed version.
- [x] Provider provisioning is excluded from request-latency summaries.
- [x] The JSON evidence records environment, workload, percentiles, throughput,
      readiness, checks, and warnings.
- [x] `pnpm verify:shared-performance` passes.

Evidence: `evidence/shared-performance-baseline.json`.

## Still unproved

The baseline does not qualify AWS S3, Cloudflare R2, managed Postgres,
Kubernetes, a public network, sustained load, provider throttling, connection
pool exhaustion, hosting cost, or a published service limit. Those remain
separate release evidence under `GATE-009`.
