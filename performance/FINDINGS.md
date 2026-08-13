# Initial local performance findings

There is no critical performance bottleneck in the current local implementation slice under its 1 MiB inline-publication limit. This is an engineering baseline for regression detection, not a production capacity claim.

## Measured baseline

Machine: Apple M5 Max, Node.js 24.15.0, local APFS storage.

| Scenario | Publish p95 | Read p95 | Max event-loop delay | Restart |
| --- | ---: | ---: | ---: | ---: |
| 40 x 16 KiB publishes; 120 reads at concurrency 6 | 10.21 ms | 2.35 ms | 11.11 ms | 4.22 ms |
| 8 x 1 MiB publishes; 24 reads at concurrency 4 | 16.43 ms | 5.04 ms | 12.62 ms | 2.92 ms |

Both runs passed health, restart persistence, current-version delivery, and denial of anonymous access to a previous version. Neither produced an investigation warning. The default machine-readable result is in [`evidence/local-performance-baseline.json`](../evidence/local-performance-baseline.json); the bounded 1 MiB diagnostic is in [`evidence/local-performance-1mib.json`](../evidence/local-performance-1mib.json).

The shared-authorization and private-content iteration repeated the default
workload three times. Publish p95 ranged from 10.21 to 12.17 ms and public-read
p95 ranged from 3.04 to 5.35 ms. Throughput, restart, event-loop delay, and
memory remained inside the existing variance and produced no investigation
warning. The final machine-readable run is the current baseline file; the
range is recorded here so one unusually fast or slow laptop run is not treated
as a regression budget.

## What the pre-phase review changed

- Blob reads now stream from disk with backpressure. Normal GET requests do not load or fingerprint the complete file.
- Blob writes now consume a stream, verify the declared size and SHA-256 fingerprint, sync the completed file, atomically install it, and sync the containing directory before the database commit.
- HEAD requests inspect metadata without reading the file.
- The local server binds only to IPv4 loopback.
- Request paths are decoded, normalized, and checked against the manifest path rules before lookup.
- Inline request bodies have an explicit bound; malformed JSON returns a client error rather than an internal error.

These fixes remove the obvious read-amplification and crash-durability problems found during the foundation review.

## Remaining limits and risks

### Inline JSON publication is intentionally a small-file path

The inline HTTP API carries base64 inside JSON. That representation adds roughly one third to the request size and requires a complete JSON body plus decoded bytes before the application creates the blob write stream. The 1 MiB decoded-file ceiling keeps this behavior bounded. Complete sites now use the local staged-upload path, which streams raw bytes and verifies each file. Remote object-store adapters still need provider-native signed upload addresses before their deployments are supported.

### Writes favor durability over local write throughput

Local SQLite runs in WAL mode with `synchronous = FULL`, and each new blob syncs both its file and containing directory before its database transaction commits. This is the intended correctness tradeoff for local and one-server deployments. It serializes some write work and does not predict the capacity of Postgres and remote blob providers. Every future provider needs the same workload and failure tests.

### Memory is measured for the combined client and server

The default run increased combined-process RSS by 58.73 MiB; the 1 MiB diagnostic increased it by 106.70 MiB. The benchmark client constructs request bodies in the same process as the server, so these figures neither isolate server memory nor prove a leak. Before memory becomes a release gate, measure the server in a separate process and establish repeated controlled-run variance.

### Portability and multi-process behavior are not proved yet

The durable local blob path is currently exercised on APFS. Windows directory-sync behavior, network filesystems, multiple server processes, remote object stores, and database/blob commit failures need their own adapters and conformance tests. The current results apply only to the local single-process deployment.

## Baseline policy

- `pnpm verify:iteration` is the required end-of-iteration gate. It includes correctness, coverage diagnostics, conformance checks, and the default bounded baseline.
- `pnpm smoke` catches broken behavior and gross regressions with deliberately loose machine-timing limits.
- `pnpm perf:baseline` records diagnostics and reports investigation warnings without failing on normal laptop variance.
- Aggregate workload limits prevent command-line flags from accidentally creating a stress test.
- Set tighter regression budgets only after repeated runs on a controlled runner establish normal variance.
- Run the same behavior on local disk, every blob driver, Postgres, Kubernetes, and Cloudflare as those adapters are implemented.
