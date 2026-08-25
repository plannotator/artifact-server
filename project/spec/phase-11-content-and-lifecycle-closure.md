# Phase 11: content and lifecycle closure

Status: shared behavior implemented with selected local and live-cloud probes;
complete acceptance and package-path proof remains open

## Outcome

This phase closes the remaining gaps in the core Artifact Server product before
new optional features are added. The implemented behavior is:

- a publisher can explicitly choose static-site or single-page-application
  routing;
- finished sites and ordinary files have the promised browser behavior,
  including safe byte-range delivery;
- expired uploads that were never committed are removed safely;
- backup and restore behavior is exercised through selected integrity and live
  recovery probes; and
- package-specific tests exercise direct local, Compact Compose,
  External-storage Compose, and Kubernetes paths.

Those implementation facts do not satisfy every acceptance sentence or every
deployment named in the ledger.

The phase changes the existing server. It does not add a management interface,
a second product, or a new deployment abstraction.

## Corrections to the earlier work list

### Do not add permanent deletion

Artifact deletion is already implemented as a tombstone. It stops application
and content access while retaining the artifact's committed versions and
files. That is the accepted initial-release behavior.

This phase does not physically delete committed blobs, delete one committed
version, or expire committed versions. Committed-blob garbage collection stays
disabled under `ART-007`, `OPS-006`, and `OPS-007`. A future collector requires
its own backup-aware design and proof. The earlier README item that named
"permanent deletion" as ordinary remaining product work was incorrect.

### Do not invent one universal backup file

The durable systems differ by deployment. Compact mode can copy one stopped
data directory. External-storage deployments must coordinate a database backup
with object storage. Cloudflare uses D1 and R2 procedures. AWS and GCP use their
provider-native database and object-storage procedures.

The common product contract is the restored result, not the archive format.
Every supported restore must preserve the same installation, project,
artifact, version, manifest, content, tag, and action identities and
must pass `artifactserver integrity check` before becoming ready.

## Starting point

The following behavior already exists and is not rebuilt:

- project-scoped artifacts and versions;
- immutable content-addressed blobs;
- file-first local and remote publication;
- account-required and public-link reads;
- version comparison and restore;
- tags, action history, and tombstone deletion;
- local, S3, GCS, Azure Blob preview, and R2 storage adapters;
- SQLite, Postgres, and D1 repositories;
- direct local, Compose, Helm, AWS, GCP, and Cloudflare packages; and
- compact backup scripts, integrity checks, and existing cloud recovery probes.

The implementation gaps this phase closed were:

1. `routingMode` accepts only `static`, and no SPA fallback exists.
2. Content responses have safe media headers and `GET`/`HEAD`, but not byte
   ranges.
3. Uploads expire, but no cleanup pass removes expired upload records and
   staging bytes.
4. Recovery exists in several deployment packages, but the proof is not yet a
   single repeatable acceptance matrix with consistent evidence.

## Architectural rule

Protocol code stays thin:

```text
HTTP / MCP / CLI / scheduled trigger
                  |
                  v
        Effect application service
                  |
                  v
        deployment-neutral port
                  |
                  v
 SQLite / Postgres / D1 / local disk / S3 / GCS / Azure Blob / R2
```

HTTP, MCP, and CLI must call the same application operations. Provider SDK
types remain inside storage and deployment adapters. No network or object-store
operation runs inside a database transaction.

Effect owns workflows, typed failures, interruption, bounded concurrency,
scheduling, tracing, metrics, and resource lifetime. Plain TypeScript owns pure
range parsing, request classification, path handling, and manifest
transformations. Hono, provider SDKs, Alchemy, Pulumi, Compose, and Helm keep
their native interfaces.

## Workstream A: complete content delivery

### Explicit routing at publication

Add these manifest values:

```text
static
spa
```

`static` remains the default for compatibility. The server never guesses the
routing mode from a framework or directory layout.

The publication surfaces accept one optional `routingMode` value:

- HTTP upload-plan request: `routingMode: "static" | "spa"`;
- MCP upload-plan tool: the same field and explanation;
- file publication client: a typed routing-mode field; and
- CLI: `artifactserver publish <path> --routing static|spa`.

Omitting the field means `static`. A SPA entry must be an inline HTML file.
Single-file HTML may use SPA routing. Non-HTML entry files cannot.

The response, manifest digest, saved version, comparison metadata, backup,
restore, and integrity check all retain the selected mode. SQLite, Postgres,
and D1 receive forward-only migrations that expand the existing constraint
without changing any saved `static` version.

### Exact path first, fallback second

The content service resolves every request in this order:

1. Normalize and validate the requested path.
2. Return the exact manifest entry when it exists.
3. When it does not exist, return 404 for static routing.
4. For SPA routing, use the entry HTML only when the request is an HTML
   document navigation.
5. Return 404 for every missing script, stylesheet, image, font, media file,
   source map, manifest, worker, or data request.

A request qualifies as a document navigation only when it is `GET` or `HEAD`,
accepts `text/html`, and any present Fetch Metadata agrees with a document
navigation (`Sec-Fetch-Dest: document` and `Sec-Fetch-Mode: navigate`). Missing
Fetch Metadata is allowed for compatible clients. A conflicting destination or
mode disables fallback. File extensions are not used to guess intent.

The HTTP request classifier decides whether the request is an HTML document
navigation. The content application service carries that bounded decision as
`none` or `entry`, and the repository resolves the exact entry and fallback
from one consistent saved-version read. This avoids a second mutable lookup
between authorization and resolution.

### Safe byte ranges

Add one deployment-neutral blob operation for an exact inclusive byte range.
Local disk, S3, GCS, Azure Blob, and R2 implement it with their native ranged
read. A ranged response must not read or buffer the complete object.

The first release supports one `bytes` range:

- `bytes=start-end`;
- `bytes=start-`; and
- `bytes=-suffixLength`.

A valid range returns `206`, `Content-Range`, `Accept-Ranges: bytes`, the exact
range length, and the same strong `ETag`, media type, disposition, cache, and
security headers as a full response. `HEAD` returns the same status and headers
without opening a body stream. An unsatisfiable or malformed range returns
`416` with `Content-Range: bytes */<size>`. Multiple ranges are not supported
in this release and return `416` rather than being partly interpreted.

`If-None-Match` is evaluated before a range and may return `304`. When
`If-Range` contains the current strong ETag, the range is served. Otherwise the
server returns the complete `200` response. Empty files cannot produce a
satisfiable range.

### Content fixture contract

One shared fixture suite covers:

- plain HTML and a multi-page static site;
- a small finished React, Vue, and Svelte site;
- a SPA route, refresh, missing script, and missing source map;
- root-relative HTML, CSS, JavaScript, image, and font references;
- image, PDF, audio, video, text, Markdown, JSON, source, ZIP, office, and
  unknown files; and
- a hostile site with misleading extensions, forms, fetches, frames, and a
  service worker.

Artifact Server uses browser-native display or playback. Unknown, archive, and
office files download. It does not add viewers, transcoding, source builds,
archive inspection, or content rewriting.

This work closes the implementation gaps behind `CNT-001`, `CNT-002`,
`CNT-007`, `CNT-008`, and `CNT-009`. Origin and browser-isolation release proof
for `CNT-003`, `CNT-004`, and `CNT-006` remains a deployment qualification,
not a reason to put browser policy in the artifact service.

## Workstream B: remove expired uncommitted uploads

### What may be removed

Cleanup may remove only a staged upload that is still `open` and whose
`expiresAt` plus the configured settle delay is in the past. It removes the
server-issued staging objects named by that record and then conditionally
removes the upload record and its file rows.

It never scans the immutable blob namespace for deletion. It never derives
deletion candidates from an absent database reference. It never deletes a
committed upload, a committed version, or a content-addressed blob.

### Concurrency rule

No new file upload or commit may start after the upload expires. A transfer or
commit that starts before expiration receives a deadline no later than
`expiresAt`; interruption propagates an `AbortSignal` through the staging and
blob adapters. The repository rechecks expiration when a file is marked
uploaded and again in the final publication transaction.

Cleanup waits an additional settle delay after expiration. That delay exists
only to let interrupted provider operations finish cancellation. Every storage
adapter must prove that an interrupted staging write cannot later recreate an
object after cleanup. An adapter that cannot prove that behavior cannot enable
automatic cleanup.

This uses the existing expiry boundary instead of adding a queue, leader,
distributed lock, or durable lease. The proof condition is strict: the maximum
operation deadline is `expiresAt`, and cleanup eligibility is later than
`expiresAt`.

### One idempotent cleanup pass

Add `ExpiredStagingCleanupService.runPass({ limit })`:

1. Read a bounded page of eligible open uploads and their exact storage
   tokens.
2. Delete each named staging object through an idempotent `StagingStore.remove`
   operation.
3. After every object for one upload is absent, conditionally delete the
   database record only if it is still open and eligible under the same
   cutoff.
4. Keep the record when any provider deletion fails so a later pass can retry.
5. Return counts for selected, deleted, already absent, failed, and remaining
   records without returning object keys or content.

Several replicas may select the same upload. Provider deletion is idempotent,
and the conditional database delete has at most one winner. Duplicate work is
acceptable; unsafe deletion is not.

Direct local and Compose processes run one pass at startup and then start one
scoped Effect schedule. The initial defaults are a 15-minute interval, a
five-minute settle delay, a 100-upload batch, and concurrency of four.
Kubernetes calls the same one-pass operation from a Helm-managed CronJob every
15 minutes. AWS uses a scheduled ECS task, GCP uses Cloud Scheduler with a
Cloud Run job, and Cloudflare uses a scheduled Worker event. These deployments
do not rely on request-serving processes receiving background CPU. The
lifecycle CLI exposes
`artifactserver maintenance cleanup-staging --once --limit <count>` for direct
operator use and qualification. These are triggers around one application
service, not separate cleanup implementations.

Use Effect `Config` for the interval, settle delay, and batch size. Validate
their relationship at startup. Use `Schedule` for repetition,
`Effect.forEach` for bounded concurrency, `Effect.scoped` for shutdown, and
typed storage and repository failures. Do not retry a non-idempotent step.

This work closes `PUB-009` and supplies the behavior required by `OPS-006`.
`OPS-007` remains a disabled-feature gate, not an implementation assignment.

## Workstream C: recovery and integrity qualification

Keep the existing deployment-native procedures:

| Deployment | Backup and restore mechanism |
| --- | --- |
| Direct local / Compact Compose | Stop writes and copy the complete data directory with checksum and support manifest. |
| External-storage Compose | Quiesce writes, create a transaction-consistent Postgres dump, copy the installation object prefix, and restore both into empty providers. |
| Kubernetes | Use the configured Postgres and object-store procedures; the chart does not own those durable providers. |
| AWS | RDS snapshot plus S3 copy, using the existing qualification harness. |
| GCP | Cloud SQL backup plus GCS copy, using the existing qualification harness. |
| Cloudflare | D1 backup plus R2 copy, owned by the parallel Cloudflare operations track. |

Add one shared recovery fixture and state-snapshot oracle. The fixture contains
multiple projects, access settings, tags, versions, a restore action, a
tombstone, static and SPA manifests, and ordinary and ranged media files. The
oracle compares stable records and bytes before and after restore and then runs
the normal integrity check.

The target stays unready when the restore is incomplete, corrupt, belongs to a
different installation, omits either the database or files, contains an unsafe
archive entry, targets populated storage, or fails integrity. Recovery never
silently repairs or merges data.

This phase does not implement compact-to-external migration (`OPS-011`), point-
in-time recovery promises, regional disaster recovery, or a customer data
export format. Those are separate product and deployment gates.

## Workstream D: deployment and end-to-end proof

Every implementation step first passes real local services. The completed
phase then runs this matrix:

| Path | Required proof |
| --- | --- |
| Direct local package | Publish static and SPA fixtures, ordinary files and media; open, range-read, expire, clean, tombstone, restart, back up, restore, and run integrity. |
| Compact Compose | Repeat the product path across container replacement and stopped-volume backup and restore. |
| External-storage Compose | Repeat against real Postgres and MinIO, including concurrent cleanup workers and coordinated recovery. |
| Kubernetes/Helm | Repeat with multiple application replicas, scheduled cleanup, restart, rollback-compatible schema, and external durable providers. |
| Storage adapters | Run the same open, range, interrupt, staging-remove, retry, and not-found contract against local, S3/MinIO, GCS, Azure Blob preview, and R2 adapters. |
| Cloudflare | After the parallel branch lands, apply the same application, D1, R2, scheduled-event, and recovery cases without forking product behavior. |

AWS and GCP live qualification are release gates, not default iteration tests.
Their existing lifecycle harnesses consume the same fixtures and evidence
schema. WorkOS, public DNS changes, and customer domains are not required for
this phase.

## Failure model

Expected application failures are typed Effect errors and keep protocol mapping
outside the application services. Add specific errors for:

- invalid routing mode or SPA entry;
- expired upload cleanup repository failure; and
- staging removal failure.

The pure range parser returns a closed result type: absent, satisfiable, or
invalid. The HTTP adapter maps invalid to `416`; range syntax does not enter an
application service as an HTTP-shaped error.

HTTP maps these to existing error envelopes and appropriate status codes. MCP
returns the same reason in short agent-facing language. Storage corruption,
impossible persisted states, and violated adapter contracts remain defects,
not ordinary client errors.

## Observability

Name public and nontrivial Effect workflows with `Effect.fn`. Add spans for:

- `ContentAccessService.authorizeVersionContent` with bounded resolution mode;
- blob full or range open, with byte count but no digest or path as a metric
  label;
- `ExpiredStagingCleanupService.runPass`; and
- lifecycle integrity and recovery qualification.

Record cleanup selected, deleted, failed, and remaining counts; content status
and bytes; and recovery outcome. Logs and traces
may contain installation-safe internal IDs where existing policy permits them,
but never credentials, cookies, upload addresses, raw URLs, object keys, file
content, or unbounded paths. Metrics use bounded operation, adapter, status, and
deployment values.

## Performance guardrails

The phase is rejected if it introduces a large regression into the established
1, 10, 25, 50, and 100-user server baseline.

Measure these properties before and after implementation:

- a SPA exact hit performs no fallback blob read;
- a fallback resolves through one repository read and one entry blob open;
- a ranged read transfers and buffers only the selected bytes;
- `HEAD` and `304` do not open a blob body;
- cleanup memory and provider concurrency are bounded by batch settings, not
  the number of expired uploads;
- several cleanup replicas remain safe and produce bounded duplicate work;
- restore verification streams blobs and does not load an installation into
  memory.

Fix measured bottlenecks only. Do not add caches, queues, leaders, worker pools,
or provider-specific fast paths without evidence.

## Test standard

Tests must prove externally visible behavior or an important failure boundary.
Use:

- real temporary SQLite and filesystem storage;
- real Hono requests through the assembled application;
- real Postgres and MinIO for external-storage tests;
- provider emulators only where the adapter contract is the subject;
- `TestClock`, `Deferred`, and controllable streams for expiry, interruption,
  and races; and
- actual packages, Compose, and Helm for release evidence.

Do not use module mocks, arbitrary sleeps, snapshots of implementation detail,
coverage-only tests, or tests that restate a pure assignment. A failure test
must observe unchanged durable state, no leaked authorization, or correct
recovery, not merely an error class.

## Remaining release-qualification risks

The shared implementation and package-specific local, Compose, Helm, lint,
type, performance, and capacity gates have passing records. Live qualification
on 2026-08-16 produced selected deployment evidence, not full ledger
conformance:

| Target | Proved live | Still open |
| --- | --- | --- |
| AWS | Static/SPA route probes, selected media-range probes, populated migration, EventBridge cleanup, redeployment, outage/recovery, restore summary, and safe Pulumi destroy. | Complete `CNT-008`, `PUB-009-F`, `OPS-006-B`, signed direct-cloud, and full product-conformance proof. |
| GCP | Static/SPA route probes, selected media-range probes after the CDN fix, populated migration, Scheduler cleanup, redeployment, outage/recovery, restore summary, and safe Pulumi destroy. | Detailed application-level restore evidence plus complete `CNT-008`, `PUB-009-F`, `OPS-006-B`, signed direct-cloud, and full product-conformance proof. |
| Cloudflare | D1 migration, Cron cleanup, Worker replacement, R2 failure detection, coordinated restore, destruction, wildcard TLS, and selected routing/range probes. | Complete `CNT-008`, `PUB-009-F`, `OPS-006-B`, optional package release proof, and full product-conformance proof. Hosted-service operating policy is outside the core OSS gate. |

The first populated D1 migration found a real foreign-key ordering defect. The
migration now snapshots the old rows, gives the empty replacement the final
table name, and then repopulates it. A second real D1 and R2 run preserved every
dependent row and exact byte with zero foreign-key violations.

The first GCP range run found that Cloud CDN could answer an unsupported
multiple-range request from cache with a full `200` response even though the
origin returned `416`. The GCP backend now bypasses Cloud CDN whenever `Range`
is present. Repeated live requests proved exact `206` single ranges and `416`
multiple ranges through the final public edge.

The following deployment claims have live evidence:

- Live R2 passed selected routing and range probes through a real wildcard
  content host: static routing, SPA navigation fallback, missing-asset failure,
  conditional requests, ranged HEAD, exact single byte ranges, and
  multiple-range rejection. This is narrower than the full `CNT-008` fixture.
- The public Cloudflare run used `phase11.artifactserver.com` for the trusted
  application and `*.agentartifacts.org` for isolated version content.
  Cloudflare served valid certificates for both. The temporary resources are
  qualification infrastructure, not the production installation.
- An interrupted-client cancellation probe against live R2 remains an adapter
  resilience check. It does not block the public routing, TLS, or byte-range
  delivery claims proved here.
- Cloudflare coordinated recovery is repeatable through the checked-in operator
  command and runbook and has live exact-byte, metadata, integrity, readiness,
  and cleanup evidence.

Each risk has a fail-closed result. It can delay support for one adapter or
deployment, but it does not change the application model.

## Implementation order

Keep the repository green after every step.

1. Add pure routing and range parsers with focused behavior and hostile tests.
2. Expand the domain model and forward-only SQLite/Postgres migrations for
   `spa`; add the provider-neutral ports.
3. Implement content resolution and ranged reads in the local adapters and
   assembled local HTTP path.
4. Thread routing through HTTP, file client, CLI, MCP, responses, skill text,
   integrity, and backup metadata.
5. Make staging writes interruptible, enforce expiry at completion, add
   idempotent staging removal, and implement one bounded cleanup pass.
6. Add the Node schedule, lifecycle one-pass command, Kubernetes CronJob, and
   cleanup telemetry.
7. Implement the same range, interruption, and removal ports in S3, GCS, Azure
   Blob preview, and external Postgres paths; run adapter contracts.
8. Add the shared recovery fixture and qualify direct local, Compact Compose,
   External-storage Compose, and Helm.
9. Integrate the Cloudflare operational work, adapt D1/R2 to the new
    contracts, and run the Cloudflare-local qualification without changing the
    core design.
10. Add the scheduled ECS task and Cloud Run job to their existing Pulumi
    packages and static tests. Live execution remains part of each cloud's
    release qualification.
11. Run lint, type checking, conformance validation, high-value tests, package
    tests, the capacity baseline, Compose, and Helm through
    `pnpm verify:iteration`; record evidence before changing requirement status.

## Not in this phase

- committed-blob garbage collection or permanent deletion;
- automatic committed-version expiry;
- deleting an individual committed version;
- optional Git history;
- WorkOS activation or hosted browser OAuth;
- public DNS, customer domains, or certificate changes;
- a management interface;
- Plannotator pairing or review features;
- compact-to-external migration;
- an operator Agent Skill; or
- a replacement deployment tool or generic wrapper over Pulumi, Alchemy,
  Compose, or Helm.

## Completion gate

The phase is complete only when:

- `PUB-009`, `CNT-001`, `CNT-002`, `CNT-007`, and `CNT-008` have
  passing behavior and hostile evidence in every applicable implementation
  path reached by this phase;
- `AUD-001`, `AUTH-008`, `OPS-003`, `OPS-004`, `OPS-005`, and `OPS-006` have
  the new recovery, integrity, and cleanup evidence they require;
- tombstoned and committed bytes survive cleanup, restart, and restore;
- no provider can recreate an interrupted staged object after it becomes
  cleanup-eligible;
- HTTP and MCP make the same routing decisions;
- the existing capacity envelope shows no critical regression;
- Oxlint, TypeScript, conformance validation, and all applicable runtime gates
  pass without suppressions or weakened rules; and
- `project/spec/conformance.yml` contains the evidence paths and honest status for
  every result.

Phase completion permits `behavior_verified` when the shared implementation
and the phase's local, single-server, and Kubernetes paths pass. A requirement
becomes `verified` only after every deployment named in the ledger, including
the applicable Cloudflare, AWS, and GCP release qualification, has its own
passing evidence.

The audited evidence does not meet this completion gate. `CNT-008` and
`OPS-006` remain `implementing`; `PUB-009` has behavior-only evidence; and the
complete direct-package, Compact Compose, External-storage Compose, and
Kubernetes acceptance matrix is not attached to these IDs.
