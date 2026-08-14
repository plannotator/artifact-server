# Phase 7: backend capacity closure

## Purpose

Close the current backend phase with repeatable evidence about concurrent use.
The test must answer a practical question: what happens to one Artifact Server
process when 1, 10, 25, 50, or 100 people use it at the same time?

This phase is deliberately bounded. It is a regression and bottleneck test, not
a claim about production capacity on every machine or storage provider.

## Required measurement boundary

The load generator and Artifact Server run in different processes. The server
process is the compiled product started through the normal local CLI. Memory,
CPU, and event-loop measurements come from the server process only.

The harness forces garbage collection before and after each measured stage when
the Node.js runtime exposes it. Every stage records:

- starting, peak, and post-collection server memory;
- server CPU time and event-loop delay;
- completed operations, failures, throughput, and latency percentiles;
- the exact workload, concurrency, machine, Node.js version, and product build.

## Workload matrix

Every normal run executes the following concurrency levels in order:

`1, 10, 25, 50, 100`

Each level runs two profiles against the same server process.

### Browse profile

Each simulated user completes the common read and management path:

1. stream one public artifact response;
2. list artifacts through the HTTP API;
3. compare two saved text versions;
4. list artifacts through MCP.

The streamed artifact is large enough to exercise response buffers without
turning the test into a disk or network stress test.

### Publish profile

Each simulated user publishes one small file through the real staged-upload
protocol:

1. create an upload plan;
2. stream the file bytes;
3. commit the immutable version.

This profile intentionally exercises the local durability path: file hashing,
file and directory synchronization, SQLite transactions, and authorization.

Each profile uses several bounded waves so the result shows repeated work, not
only the first request. Aggregate bytes and operation counts have hard limits so
a command-line mistake cannot turn the normal command into an uncontrolled load
test.

## Interpretation and gates

The run fails when:

- any expected operation fails or returns the wrong bytes or identity;
- the server exits, becomes unhealthy, or stops accepting work;
- the harness cannot obtain server-only measurements;
- configuration exceeds the fixed workload safety bounds.

The run records an investigation warning, without inventing a capacity claim,
when:

- post-collection live heap grows materially across concurrency levels;
- peak memory grows disproportionately to the configured concurrent work;
- event-loop delay or latency crosses a deliberately loose gross-regression
  threshold.

The human review also compares useful throughput between levels. A material
drop is investigated before the result is accepted; the harness does not guess
whether CPU, storage, or another dependency explains it.

One laptop run does not set a production service limit. A server concurrency
limit, queue, or rejection policy is added only when repeated measurements show
an actual unbounded or damaging path. The fix must preserve streaming,
durability, authorization, and immutable versions.

## Commands and evidence

- `pnpm perf:capacity` runs the complete local matrix and writes
  `evidence/local-capacity-baseline.json`.
- `pnpm verify:iteration` includes the complete matrix so every backend
  iteration repeats the proof.
- `performance/FINDINGS.md` records the human interpretation and remaining
  risks.

Later provider phases reuse the workload and report shape against Postgres,
managed object storage, Kubernetes, and Cloudflare. Passing the local matrix
does not stand in for those provider-specific results.

## Completion rule

This phase is complete when the full matrix passes from the compiled product,
the evidence records server-only measurements, any confirmed bottleneck is
fixed and remeasured, and the repository's complete iteration verification
passes without weakened lint, type, correctness, or conformance checks.
