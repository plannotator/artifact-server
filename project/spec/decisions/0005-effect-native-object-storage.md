# Decision 0005: Keep object storage behind Artifact Server Effect ports

Status: accepted for Phase 3A

## Decision

Artifact Server keeps its application-owned immutable-blob and staging ports.
Provider SDKs remain outbound-adapter details and never enter application,
domain, HTTP, MCP, or persistence types.

The supported storage profiles are built incrementally:

- local disk remains the default for the local process;
- one S3-compatible adapter covers Amazon S3, MinIO, Cloudflare R2, Tigris,
  and services that implement the required S3 behavior;
- native Google Cloud Storage is a supported target, while the implemented
  Azure Blob Storage adapter remains preview until proved against real Azure;
  and
- Cloudflare may use the S3-compatible adapter in Node-based tests, but the
  Workers deployment will receive an R2-binding adapter so it does not carry an
  unnecessary Node AWS client.

Application services continue to sequence storage through typed Effect ports.
Concrete adapters may use Promise-based provider clients internally, but they
must classify every expected provider failure before it crosses the Effect
adapter layer.

## Storage SDK evaluation

Storage SDK was evaluated before this decision. Its provider coverage,
streaming API, range support, signed URLs, and adapter test suite are useful.
It is not adopted in Phase 3A because:

- Artifact Server needs only the smaller `inspect`, `open`, and verified `put`
  surface today;
- Artifact Server must independently enforce declared size and SHA-256
  fingerprints;
- Storage SDK snapshots and forks are not Artifact Server's version model and
  can copy complete buckets on providers without native support;
- the packages are young and pre-1.0; and
- the existing Artifact Server ports make later adoption or removal cheap.

The project can reconsider Storage SDK if the native provider adapters outgrow
the current boundary.
It would still sit behind the existing ports.

## Adapter reuse audit

The existing adapters and application services were reviewed:

- `LocalBlobStore` already provides durable, content-addressed local files;
- `LocalStagingStore` already verifies uncommitted local uploads;
- `PublishArtifactService`, `CompareArtifactService`, and content delivery
  already depend on narrow storage capabilities; and
- `createLocalApplicationLayer` already converts outbound Promise failures into
  typed Effect failures.

The local adapters remain unchanged as the supported local implementation.
The S3-compatible adapter is a separate outbound adapter because network object
storage has different configuration, streaming, failure, and lifecycle
mechanics. It implements the existing ports rather than introducing a second
application abstraction.

## Phase 3A scope

Phase 3A includes:

- installation-scoped keys that cannot be selected by an artifact, upload, or
  request value;
- immutable content-addressed blob inspection, streaming reads, and verified
  streaming writes;
- remote staged-upload inspection, reads, and verified writes;
- multipart-safe streaming without buffering a complete artifact in memory;
- explicit provider resource responsibility and cleanup at the composition root;
- a pinned MinIO container used as the first real S3-compatible conformance
  target; and
- normal, hostile, concurrent, restart, and installation-isolation tests.

Phase 3A does not include:

- changing local startup or requiring Docker for local product use;
- Postgres metadata repositories;
- direct-to-object-storage signed upload URLs;
- garbage collection or retention policy;
- native GCS, preview Azure Blob, or Workers R2 bindings;
- CDN delivery; or
- marking the cross-provider `DEP-011` requirement verified.

## Integrity and publication rules

Blob keys derive only from a parsed SHA-256 fingerprint and an
installation-scoped prefix derived from trusted startup configuration. Staging
keys derive from parsed server-issued upload identifiers and storage tokens.

Every incoming stream is hashed and counted while it is uploaded. A mismatch
fails the upload before the provider can complete a multipart object. A
successful write is followed by provider metadata inspection before success is
returned.

Artifact publication still commits metadata only after every referenced blob
write succeeds. No database transaction is held open during a provider call.
Unreferenced provider bytes are safe and will be collected by later retention
work.

Provider credentials, endpoints, bucket names, raw errors, and signed URLs are
adapter concerns. They are never persisted in artifact records or exposed to
published content.

## Verification

The S3-compatible adapter is accepted only when a real MinIO process proves:

- correct bytes survive streaming writes, reads, and provider restart;
- a false size or fingerprint cannot replace an existing immutable blob;
- concurrent writes to one fingerprint remain idempotent;
- one installation cannot inspect or open another installation's keys;
- staging identifiers cannot escape their installation prefix;
- unavailable or unauthorized storage fails closed; and
- local conformance, coverage, build, smoke, and performance gates remain
  green.

Provider-specific release claims require the same contract suite against the
real managed provider. Passing MinIO proves only the S3-compatible adapter.
