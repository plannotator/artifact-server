# Decision 0009: One operator lifecycle across deployment profiles

Status: accepted for the pre-image packaging phase

## Decision

Artifact Server exposes one lifecycle CLI for direct packages, containers,
Compose, and Kubernetes. Packaging layers call these commands; they do not
reimplement initialization, configuration, migration, diagnostics, integrity,
or shutdown policy.

The compact profile owns one initialized data directory. `init` creates its
stable installation identity and restrictive secret files. It returns the
browser bootstrap credential once. Later compact starts read that state and do
not print credentials or login links.

The external-storage profile separates migration from serving. `migrate status`
is read-only. `migrate apply` holds the existing Postgres advisory lock. Serving
validates the exact migration history and refuses a missing, pending, divergent,
or newer schema. It never applies a migration during replica startup.

`config check` parses the same configuration used by serving and probes the
selected providers. Direct credential values and mounted `*_FILE` values are
mutually exclusive. Output contains only credential-source labels. The
application origin and content domain must use HTTPS and different registrable
domains; this check uses the Public Suffix List through `tldts`, not a
last-two-label guess.

`support manifest` reports product, runtime, schema, adapter, configuration,
migration, and provider state without credential values or credential-bearing
URLs. `integrity check` reads artifacts, versions, and entries independently,
validates pointers and canonical manifests, hashes each unique referenced blob
once, and never repairs state. Compact uses SQLite and local files. External
storage uses Postgres and the configured S3 adapter through the same integrity
contract.

Every deployed Node HTTP process uses the same lifecycle gate. Startup remains
unready until the listener and providers are ready. Shutdown changes readiness
to `draining`, waits a bounded routing-withdrawal interval, stops accepting new
connections, lets accepted work finish to a deadline, and closes providers only
after HTTP drain completes. The close operation is idempotent.

## Effect boundary

Expected initialization and configuration failures are typed Effect schema
errors. File and environment input is decoded at the boundary. Credentials are
held as `Redacted` values after parsing. Provider implementations remain at the
composition root; application services do not know which lifecycle command or
deployment package called them.

Node's HTTP server, Postgres pool, S3 client, SQLite reader, and file streams are
explicitly owned and closed. Provider inspection deliberately returns bounded
component states instead of raw SDK or connection errors, because those errors
can contain endpoints or other sensitive configuration.

## Verification boundary

The current real-process tests prove compact initialization, restrictive file
permissions, secret-free configuration and support output, readiness
withdrawal, clean shutdown, successful integrity scans, and detection of a
corrupted committed blob. The Docker-backed external suite proves read-only
migration status, explicit migration apply, serving validation, current
migration readiness, and integrity checks over real Postgres and MinIO data.

These are lifecycle foundations, not full claims for rolling Kubernetes
replacement, every interrupted publish point, prior-version upgrade recovery,
or every corruption class. Those broader conformance requirements remain
specified until the OCI, Compose, and Helm phases exercise them through the
released packages.
