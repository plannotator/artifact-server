# Performance findings

There is no critical local bottleneck in the measured file sizes, but complete
directory publication has a confirmed per-file scaling cost. This is an
engineering baseline for regression detection, not a production capacity claim.

The server-only concurrency matrix completed every browse and publication
journey at 1, 10, 25, 50, and 100 concurrent users. Across four standalone
complete runs, the 100-user browse p95 ranged from 847 to 924 ms and sustained
240 to 244 user journeys per second. The 100-user staged-publication p95 ranged
from 1,082 to 1,114 ms and sustained 94 to 96 complete publications per second.
The same matrix, run after every other check in the complete iteration gate,
recorded 1,065 ms browse p95 at 201 journeys per second and 1,162 ms publication
p95 at 95 publications per second. Maximum event-loop delay remained below
108 ms, health checks passed after every stage, and no request failed.

Peak server RSS ranged from 619 to 683 MiB during the complete sustained matrix.
After explicit collection, final live heap grew only 4.7 to 5.6 MiB across the
entire run and settled around 60 to 67 MiB. That result is consistent with
temporary allocation and allocator high-water behavior; it is not evidence of
retained per-user state or a memory leak. It is still operationally meaningful:
one Compact process deliberately serving this exact 100-user burst should not
be placed in a 512 MiB memory
limit. A 1 GiB process allocation provides reasonable headroom for this measured
local workload, but it is not a provider-independent production recommendation.

No application request throttle was added. At the measured ceiling, the server
completed all work, retained throughput, recovered live heap, and kept event-loop
delay bounded. Rejecting or queueing work at an invented threshold would reduce
utility without addressing a confirmed failure. External-storage and managed
provider capacity must be measured separately before Kubernetes or hosted
resource defaults claim the same 100-user envelope.

## File overview baseline (FOV-003)

`pnpm perf:file-overview` seeds a temporary compact database with the file
management spec's section 13 data set (100,000 artifacts across 20 projects and
2,000 folders, one leaf folder holding 10,000 artifacts, and one artifact with
200 versions and 500 comment threads) and times the storage paths behind the
Files page and folder operations with 5 warm-up and 40 measured iterations
(5 for folder trash, 20 for the cross-project move). It writes
`project/evidence/file-overview-baseline.json`.

Machine: Apple M5 Max, Node.js 24.15, local APFS storage, November 24, 2026.

| Operation | p50 | p95 | Section 13 budget (p95) |
| --- | ---: | ---: | ---: |
| `listFiles`, first page of 100, default sort, no filter | 2.1 ms | 3.2 ms | 150 ms |
| `listFiles` with kind + tag + updated-time filters | 29.2 ms | 32.2 ms | 200 ms |
| `listFolder`, one page of a 10,000-artifact folder | 0.4 ms | 0.6 ms | 50 ms |
| Rename the 10,000-artifact folder | 0.1 ms | 0.2 ms | 20 ms |
| Move the 200-version, 500-thread artifact across projects | 16.7 ms | 18.3 ms | 250 ms |
| Trash the 10,000-artifact folder subtree (one transaction) | 390 ms | 415 ms | 2 s |
| 100 sequential per-item move transactions | 19.0 ms | 19.9 ms | 1.5 s |
| `fileFacets`, no filter | 253 ms | 260 ms | none |

Every budgeted path is inside its budget. Schema 16 indexes the denormalized
current-version columns, so a page never sorts or joins version tables per row;
a folder rename is one row; the cross-project move rewrites child rows by
artifact ID. Folder trash is the slowest budgeted write at about a fifth of its
budget, because it stamps every artifact in the subtree inside one transaction.
The open risk is facets: an unfiltered facet read scans every live artifact
once for kind and project counts and once more for tags, about 255 ms at
100,000 artifacts. The Files page requests facets beside every page, so a
filter change waits on that scan. If it becomes noticeable, cache facets per
filter for a short time or drop tag facets from the unfiltered view.

## Linked-folder scan baseline (FOV-003)

`pnpm perf:linked-folder-scan` links a 20,000-file directory (20 directories of
1,000 small files) on a real in-process local server, then runs five warm full
rescans. Before each scan it sends the same sequential request mix (four reads
of the current exact version for every publish of a new version) for an idle
window of the same length, so drift between windows cancels out.

| Measure | Result | Budget |
| --- | ---: | ---: |
| First scan (inside the link request) | 0.89 s | — |
| Warm full scan, maximum of 5 | 1.20 s | 5 s |
| Read p95, idle → during scan | 0.68 → 0.58 ms | within 10% |
| Publish p95, idle → during scan | 22.2 → 30.6 ms (+38%) | within 10% |
| Write lock free between pages | 160 of 160 samples | every sample |
| Pages visible one commit at a time | 10 partial counts | — |

Full scans are a quarter of their budget, reads are unaffected, and scan pages
never hold the write transaction across pages. **Publish latency during a scan
misses the 10% budget**: across repeated runs the publish p95 rose 35–40%.
The cause is the synchronous page transaction. Each 2,000-entry page is one
SQLite transaction on the shared connection, and while it runs (about 10 ms
warm, longer when the commit triggers a WAL checkpoint) the event loop serves
nothing. A publish is three requests over about 22 ms, so roughly one in six
overlaps a page and waits for it. Reads are short enough that few collide.

This iteration cut the warm page from about 17 ms to 11 ms: a rescan that
re-observes an unchanged entry now stamps only its scan generation, which no
index covers, instead of rewriting the row and its three indexes (publish p95
during scans went from +72% to +35–40%). Splitting each page into 250-entry
transactions did not help, so the remaining cost is not proportional to the
page size alone. Options to close the gap: apply scan pages on a dedicated
SQLite connection in a worker thread, so the request path never waits on them;
batch the per-entry inventory and binding lookups into set-based statements;
or tune WAL auto-checkpointing so a scan commit never runs a checkpoint inline.
Until one of these lands, FOV-003-F stays unproved.

## Measured baseline

Machine: Apple M5 Max, Node.js 24.15.0, local APFS storage.

| Scenario | Publish p95 | Read p95 | Max event-loop delay | Restart |
| --- | ---: | ---: | ---: | ---: |
| 40 x 16 KiB publishes; 120 reads at concurrency 6 | 10.21 ms | 2.35 ms | 11.11 ms | 4.22 ms |
| 8 x 1 MiB publishes; 24 reads at concurrency 4 | 16.43 ms | 5.04 ms | 12.62 ms | 2.92 ms |

Both runs passed health, restart persistence, current-version delivery, and denial of anonymous access to a previous version. Neither produced an investigation warning. The default machine-readable result is in [`project/evidence/local-performance-baseline.json`](../evidence/local-performance-baseline.json); the bounded 1 MiB diagnostic is in [`project/evidence/local-performance-1mib.json`](../evidence/local-performance-1mib.json).

The shared-authorization and private-content iteration repeated the default
workload three times. Publish p95 ranged from 10.21 to 12.17 ms and public-read
p95 ranged from 3.04 to 5.35 ms. Throughput, restart, event-loop delay, and
memory remained inside the existing variance and produced no investigation
warning. The final machine-readable run is the current baseline file; the
range is recorded here so one unusually fast or slow laptop run is not treated
as a regression budget.

The artifact-lifecycle iteration added bounded artifact-list reads to every
baseline run. Its final default run measured publish p95 at 13.71 ms, public
read p95 at 5.06 ms, comparison p95 at 10.48 ms, artifact-list p95 at 7.34 ms,
and restart at 4.78 ms. No investigation warning fired. These results show no
obvious local regression from the tombstone, action-history, pagination-index,
or migration work; they do not establish shared-database capacity.

The file-first client iteration added the actual user path: filesystem walk,
SHA-256 calculation, upload-plan creation, streamed file uploads, commit, and
retrieval. A 2 MiB file measured 28–41 ms across bounded runs. A 48-file
directory containing 4 KiB files measured 651–936 ms. A focused file-count
curve using 2 KiB files measured 53 ms for 2 files, 210 ms for 12 files, and
936 ms for 48 files. Increasing client upload concurrency from four to eight
did not materially improve the result, so the production setting remains four.

The modern MCP iteration added 20 bounded `server/discover` calls and 20
authenticated `artifact_list` calls at concurrency six. Two consecutive default
runs measured discovery p95 at 27.10–28.00 ms and list p95 at 17.61–19.01 ms.
Both use a fresh protocol server per request and the real application runtime;
no obvious local control-plane bottleneck appeared.

Those runs raised the combined-process RSS high-water mark by 225–260 MiB. An
explicit diagnostic collection after the same default workload returned live
heap slightly below its starting value. Three consecutive MCP-enabled smoke
runs also kept post-collection heap flat while RSS stabilized at 319–324 MiB.
This is allocator high-water, not evidence of per-request retained MCP state.
The harness now uses an explicit collection point and gates retained heap and
external memory rather than treating unreclaimed RSS as a leak.

The observability iteration runs the default local baseline with Effect request
metrics and spans enabled and one-percent normal completion-log sampling. Its
final bounded run measured 46.50 sequential 16 KiB publications per second at
24.79 ms p95, 3,176.90 content reads per second at 2.88 ms p95, MCP discovery at
24.20 ms p95, MCP artifact-list at 34.94 ms p95, the 2 MiB file client at
40.58 ms p95, and the 48-file directory at 879.46 ms p95. After explicit
collection, retained heap grew 12.62 MiB and external memory 0.03 MiB. No
investigation warning fired. A paired run with JSON and OTLP export disabled
measured 23.41 ms publication p95 versus 24.79 ms with deployed observability,
which is inside normal laptop variance. The older approximately 10 ms baseline
predates the file-first, MCP, shared-policy, and observability work, so this phase
does not claim a single cause for that broader difference.

The first two external-storage-runtime baselines used two independent compiled server
processes, one Postgres database, and one MinIO S3-compatible bucket. Providers
became ready in 1,044–1,144 ms; initial server processes became ready in
265–347 ms, and replacements became ready in 187–193 ms. Sixteen 16 KiB
file-first publications at concurrency four measured 89–106 operations per
second with 82–111 ms p95. Eighty cross-process reads at concurrency eight
measured 2,381–2,386 operations per second with 4.64–5.2 ms p95. Authenticated
artifact lists measured 2.89–3.32 ms p95. The repeated 2 MiB single-file path
measured 95–96 ms p95, while the 48-file directory path measured 359–411 ms
p95. Every exact-byte, cross-process, health, and replacement check passed
without an investigation warning.

These numbers prove that no obvious Postgres, S3-adapter, or process-boundary
bottleneck appears in this bounded local-container workload. They do not
predict managed Postgres, AWS S3, Cloudflare R2, cross-region, Kubernetes, or
public-network capacity.

## What the pre-phase review changed

- Blob reads now stream from disk with backpressure. Normal GET requests do not load or fingerprint the complete file.
- Blob writes now consume a stream, verify the declared size and SHA-256 fingerprint, sync the completed file, atomically install it, and sync the containing directory before the database commit.
- HEAD requests inspect metadata without reading the file.
- The local server binds only to IPv4 loopback.
- Request paths are decoded, normalized, and checked against the manifest path rules before lookup.
- Upload-plan request bodies have an explicit bound; malformed JSON returns a client error rather than an internal error.

These fixes remove the obvious read-amplification and crash-durability problems found during the foundation review.

## Remaining limits and risks

### P2: Directory publication cost grows approximately with file count

The client sends one verified upload request per file. Local storage syncs every
staged file durably and records its uploaded state before commit. The measured
2/12/48-file curve is close to linear, and doubling client concurrency did not
remove it. A site with hundreds or thousands of small assets will therefore be
noticeably slower even when its total byte size is small.

Do not weaken integrity checks or filesystem durability to hide this cost. The
next transport investigation should compare a bounded multipart small-file
batch and the separately specified verified local-import helper. Provider-native
signed uploads remain required for cloud deployments. Verification must repeat
the file-count curve and the existing mismatch, restart, and isolation tests.

### Writes favor durability over local write throughput

Local SQLite runs in WAL mode with `synchronous = FULL`, and each new blob syncs both its file and containing directory before its database transaction commits. This is the intended correctness tradeoff for local and one-server deployments. It serializes some write work and does not predict the capacity of Postgres and remote blob providers. Every future provider needs the same workload and failure tests.

### Memory is measured for the combined client and server

The file-client baseline raised combined-process RSS substantially while
post-collection live heap and external memory stayed bounded. Native allocator
high-water behavior therefore dominates the RSS signal. This is not evidence of
a growing live-memory leak, but it is not a server-memory proof either. Before
memory becomes a release gate, measure the compiled server processes separately
across repeated runs and record retained heap, external memory, and RSS after an
explicit settling period.

### Managed-provider and sustained capacity are not measured yet

The external-storage baseline now measures multiple processes against pinned Postgres and
MinIO, but it is deliberately short and bounded. It does not establish a
sustained connection-pool limit, managed-provider tail latency, provider request
cost, multi-node network behavior, or failure behavior under dependency
throttling. AWS S3, Cloudflare R2, managed Postgres, Kubernetes, Windows, and
network filesystems still require their own provider evidence before their
capacity is advertised.

## Baseline policy

- `pnpm verify:iteration` is the required end-of-iteration gate. It includes correctness, a coverage report, conformance checks, and the default bounded baseline. Coverage percentage is not a test-design target.
- `pnpm smoke` catches broken behavior and gross regressions with deliberately loose machine-timing limits.
- `pnpm perf:baseline` records diagnostics and reports investigation warnings without failing on normal laptop variance.
- `pnpm verify:external-storage-performance` runs the real compiled two-process Postgres and S3-compatible path and records provider startup separately from application latency.
- Aggregate workload limits prevent command-line flags from accidentally creating a stress test.
- Set tighter regression budgets only after repeated runs on a controlled runner establish normal variance.
- Run the same behavior on local disk, every blob driver, Postgres, Kubernetes, and Cloudflare as those adapters are implemented.
