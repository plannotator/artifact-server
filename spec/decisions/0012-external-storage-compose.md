# ADR 0012: External-storage Compose is a stateless application overlay

Status: accepted

## Decision

External-storage Compose combines the production `compose.yaml` with
`compose.external-storage.yaml`. The override runs the external-storage CLI,
removes the compact volume and fixed container name, exposes only the internal
application port, and connects every application replica to existing Postgres
and object storage. It does not install either provider.

The package uses mounted files for the required Artifact Server API token and
Postgres URL. AWS deployments normally use the AWS SDK workload-identity chain.
An additional example overlay mounts a static S3 access-key pair for Cloudflare
R2 or another tested provider. Every application container remains non-root,
read-only, capability-free, and disposable.

The default scalable shape publishes no host port. An existing reverse proxy,
gateway, or load balancer joins the Compose network and routes the application
and wildcard content hosts to port 8787. A separate optional overlay publishes
one loopback port for a one-replica server. That overlay is not used when the
service is scaled.

Database migration remains an explicit release command. Serving replicas
validate the current schema and provider reachability before reporting ready;
they never apply migrations or fall back to container-local storage.

## Why

Compose is useful for teams that already operate managed providers or want a
small step toward Kubernetes. Bundling Postgres or an object-storage server
would create another database and storage product that Artifact Server would
have to patch, back up, scale, and recover. It would also hide the actual
production dependencies from operators.

An override keeps one image and one security boundary for both Compose
profiles. Removing the fixed container name and host port permits multiple
application replicas. Removing the compact volume makes accidental local
durability visible instead of silently creating split state.

Secret files keep long-lived credentials out of generated Compose output and
normal process environment configuration. Provider workload identity remains
preferable where it exists because no static object-storage secret then reaches
the container.

## Verification

The release gate builds and loads the exact multi-architecture production OCI
archive, starts independently managed Postgres and S3-compatible processes,
applies migrations, and launches two application replicas through the shipped
Compose files. It publishes a file and a complete site, reads through both
replicas, races two writes against one expected current version, proves exactly
one commit wins, and compares records, IDs, pointers, manifests, action
attribution, access settings, tags, and bytes.

The gate then force-recreates every application container and repeats the state
and byte comparison. Container inspection proves the root filesystem is
read-only and the only mounts are the four credential files; no artifact data
is mounted below `/var/lib/artifact-server`.

Failure cases remove required provider values and secret files, supply only one
static S3 credential, start against an unmigrated database, name a missing
bucket, and violate the application/content domain boundary. None reports
ready. A bounded 40-request read sample records packaging overhead without
turning the release gate into an unsafe load test.

## Recovery

Postgres and the complete installation prefix in object storage are one backup
unit. The first supported procedure stops every application replica, creates a
transaction-consistent logical Postgres dump, copies the complete object
prefix, and records one support and checksum manifest for both halves. Restore
targets empty providers and does not serve until the external integrity check
passes.

Compose does not pretend to implement provider snapshots. Existing runtime
integration tests already prove logical database and bucket backup and restore
with stable IDs and bytes. Provider-specific automation remains the operator's
responsibility until an Artifact Server recovery command can fail closed across
both systems without claiming transactionality that the providers do not
offer.

## Limits

This decision does not claim online backup, automatic proxy configuration,
autoscaling, multi-region failover, native GCS or Azure Blob support,
cross-version rollback, or compact-to-external-storage transfer. The current
official external adapter supports AWS S3 and Cloudflare R2. Another
S3-compatible provider becomes supported only after it passes the adapter
contract tests.
