# Artifact Server

Artifact Server stores finished browser files as immutable versions and serves each version from its own hostname.

This repository contains the local publication foundation and the first external-storage runtime. It is not the complete product yet. The current implementation proves:

- a file-first CLI backed by token-protected HTTP upload and commit operations;
- single-file publication through the same verified upload contract used by complete sites;
- complete multi-file site publication through durable staged uploads;
- expiring upload records and opaque, streaming file-upload locations;
- size and SHA-256 verification before a staged upload can commit;
- canonical SHA-256 manifests;
- immutable, content-addressed local blob storage;
- an installation-scoped S3-compatible blob and staging adapter proved against
  pinned MinIO with multipart, hostile, concurrency, and replacement tests;
- one SQLite transaction for artifact, version, manifest, action, and idempotency records;
- stable artifact links and unique `*.localhost` version hosts;
- intentional version publication with stale-write protection;
- idempotent retries;
- provider-neutral principals with ownership and explicit capability policy;
- installation-owned members with explicit administrator admission and deactivation;
- opaque browser sessions with host-only cookies and same-origin mutation checks;
- managed human and service API keys with capabilities, expiry, rotation, and revocation;
- replaceable interactive login with a WorkOS AuthKit adapter;
- authenticated artifact metadata, saved-version history, and canonical manifests;
- manifest-based file comparisons with unambiguous rename detection;
- bounded line comparisons for text and metadata-only binary comparisons;
- pointer-only restore of an existing immutable version;
- atomic changes between account-required and public-link access;
- bounded, cursor-paginated artifact and action-history lists;
- normalized artifact tags with exact filtering and audited replacement;
- idempotent artifact tombstones that retain committed versions and block every content path;
- public-link delivery and version-scoped account-required browser sessions;
- single-use private-content bootstraps and host-only, HttpOnly content cookies;
- authenticated browser sessions for current or earlier exact versions;
- persistence of committed versions and in-progress uploads across a full server restart;
- a stateless external-storage process backed by Postgres and S3-compatible storage;
- explicit, advisory-locked Postgres migrations that serving processes only validate;
- cross-process publication, browser sessions, managed keys, and staged uploads;
- replacement of every application process without losing committed state;
- installation isolation when several installations use one Postgres database and bucket;
- logical Postgres and object-storage backup and restore with stable IDs and bytes;
- a bounded two-process Postgres and S3-compatible performance baseline using the real file-first client.

## Remaining implementation

Packaging is now in progress. The direct local archive, shared lifecycle CLI,
and production OCI image now exist. The remaining executable scope is in
[`spec/phase-6-packaging.md`](./spec/phase-6-packaging.md). It defines a native
local package that does not require Docker, one optional OCI image, Compact
Compose and External-storage Compose, a Helm chart, recovery, release evidence,
and the tests that make those targets supportable. The next packaging target is
Compact Compose.

After that foundation passes, the remaining work is:

1. The `publish-artifact` and optional `operate-artifact-server` Agent Skills.
2. SPA fallback routing, ownership changes, expired-staging cleanup, permanent
   deletion, direct signed uploads, and optional private Git history.
3. Cloudflare Workers, D1, and R2 adapters and installer.
4. AWS, GCP, and Azure installers plus native GCS and Azure Blob adapters.
5. The Plannotator connection and review bridge after its separate integration
   contract passes.

## Install the direct local package

The direct local release is a self-contained Node package. It includes compiled
JavaScript and all production dependencies. It does not include Artifact Server
source code, TypeScript, pnpm, test tools, or a container. Node.js 24.12 or newer
is the only runtime prerequisite after the archive is downloaded.

Build and unpack the package:

```sh
pnpm package:local
tar -xzf release/artifact-server-*-node.tar.gz
./artifactserver/bin/artifactserver --version
./artifactserver/bin/artifactserver start --data .artifact-server --port 8787
```

Move the extracted `artifactserver` directory anywhere user-owned. Add its
`bin` directory to `PATH` if the shorter `artifactserver` command is preferred.
The executable directory and persistent data directory are separate: replacing
the executable directory must not replace or remove local data.

The package is built without native Node extensions, so the same archive can be
used with supported Node installations on macOS, Linux, and Windows. The
archive contains both the POSIX `artifactserver` launcher and
`artifactserver.cmd` for Windows.

`pnpm test:local-package` builds the archive without network access, extracts it
twice into clean directories, and runs the packaged executable through publish,
open, program-directory replacement, restart, stopped-data backup, and clean
restore. It records the archive checksum and runtime proof in `evidence/`.

## Build and verify the OCI image

The optional container image contains the same compiled CLI and production
dependencies as the direct package. It supports Linux AMD64 and ARM64. It is
not the default way to run Artifact Server on a laptop.

Build the multi-architecture OCI archive:

```sh
pnpm package:oci
```

The command writes `release/artifact-server-<version>.oci.tar` and a JSON
manifest containing the archive checksum, image-index digest, per-platform
manifest and config digests, source revision, and attestation summary. The
build pins Node, the Dockerfile frontend, and the SBOM scanner by digest. Each
platform receives an SPDX software inventory and SLSA build provenance. The
manifest and image labels also report whether the source tree was clean.

Run the full image gate:

```sh
pnpm test:oci-image
```

The gate loads the exact archive and executes both architectures. It then runs
compact mode with a real Docker volume and external-storage mode with pinned
Postgres and MinIO. Both modes publish and read a file, stop cleanly, replace
the application container, preserve the published bytes and IDs, and emit a
credential-free support manifest. Server containers use a fixed non-root user,
a read-only root filesystem, and a writable temporary filesystem. Only compact
mode receives a writable durable data volume.

This local build does not sign the image. Signing requires the release registry
and release identity and remains a release-pipeline gate. Compose and Helm files
will use the published image digest, never a floating tag.

## Run from the source checkout

Requirements: Node.js 24.12 or newer, pnpm 10.34.3, and Ruby for validating the conformance ledger.

```sh
pnpm install
pnpm start -- --data .artifact-server --port 8787
```

The server creates separate random API and browser-bootstrap tokens in
`.artifact-server/local-api-token` and `.artifact-server/local-browser-token`,
prints the local URLs at startup, and keeps both files with mode `0600`. Open the
printed browser-login URL to create or resume the local administrator session.

One installation is one closed group. After the first administrator exists,
administrators admit members through `POST /api/v1/members`. There is no public
self-sign-up. Administrators manage human-owned or service-owned credentials
through `/api/v1/api-keys`; each key has explicit capabilities and a required
future expiration and can be rotated or revoked.

### Optional WorkOS browser login

WorkOS is only an interactive identity provider. Artifact Server still owns its
member list, authorization decisions, application sessions, and API keys. Copy
`.env.example` into a secret local environment file or secret manager. Set the
application origin, bootstrap administrator email, client ID, and either the
WorkOS API-key value or its `_FILE` path before starting the server. Use a
dedicated Artifact Server WorkOS environment, configure the exact
`/auth/callback` redirect, and disable AuthKit self-sign-up. Never reuse a
Plannotator Workspaces staging or production environment.

The first successful WorkOS login is accepted only when its verified email is
the configured bootstrap administrator email. Later logins require a member
already admitted to this Artifact Server. Provider access and refresh tokens are
not stored by Artifact Server.

## Publishing input contract

Public clients publish an actual file or a finished directory. They do not put
HTML, CSS, JavaScript, or other source text in JSON or MCP arguments. A single
`index.html`, image, video, PDF, archive, or other file uses the same verified
upload flow as a directory. The client chooses the simplest supported transport
and hides upload sessions, fingerprints, and manifests from the user.

Start the server, then publish a file or finished directory. Local publishing
uses `.artifact-server/local-api-token` automatically:

```sh
artifactserver publish ./report.pdf
artifactserver publish ./dist --public --name "Product prototype" --tag prototype
```

To publish to a team server, set `ARTIFACT_SERVER_URL` and
`ARTIFACT_SERVER_API_TOKEN`, or use `--server` and `--token-file`. To publish a
new immutable version, pass both `--artifact` and `--expected-version`. The
command returns JSON containing the artifact ID, version ID, and browser links.

The former JSON routes that accepted base64-wrapped file contents have been
removed. `POST /api/v1/artifacts` and
`POST /api/v1/artifacts/{artifactId}/versions` now return `405` with directions
to the file-upload operation.

The response contains a stable artifact link and an immutable version link.
For an account-required artifact, create a private browser bootstrap with an
authenticated `POST` to
`/api/v1/artifacts/{artifactId}/content-sessions`, then open the returned
`bootstrapUrl`. The content host exchanges it once and redirects to the clean
version URL. The resulting cookie can read only that immutable version.

Authenticated management routes are available beneath
`/api/v1/artifacts/{artifactId}`. They return the current artifact record,
canonical manifests, and saved-version history; compare any two saved versions;
move the current pointer back to an existing version; and change the artifact's
access setting or complete tag set. The artifact list accepts an exact `tag`
filter in addition to bounded cursors. The API also lists active artifacts, lists
an artifact's attributed action history, and tombstones an artifact without
removing its committed versions. Restore, access changes, and deletion require
an idempotency key and the current version ID observed by the caller; tag
replacement follows the same rule.

## File-upload protocol

The CLI hides these details. Other clients use the same staged-upload contract
instead of placing file contents inside JSON or MCP messages:

1. `POST /api/v1/uploads` with the entry path and each file's path, media type, size, and SHA-256 fingerprint.
2. `PUT` each file's raw bytes to the opaque upload address returned by the server.
3. `POST /api/v1/uploads/{uploadId}/commit` with an idempotency key and either a new-artifact or new-version target.

The upload record survives restart. The commit is rejected until every declared file matches its size and fingerprint. A successful commit creates one canonical manifest and one immutable version containing every file. Root-relative asset requests remain on that version's unique content hostname.

## Run with external storage

The external-storage runtime runs the same HTTP product behavior with no committed artifact data
on application-process disk. Each process uses Postgres for records and one
S3-compatible bucket for staged and immutable bytes. Local mode remains the
default and still uses SQLite plus local files.

Set the external-storage values documented in `.env.example` and create the
configured bucket. Inspect and apply the database migration before serving:

```sh
pnpm build
node dist/cli/main.js migrate status
node dist/cli/main.js migrate apply
node dist/cli/main.js config check --mode external-storage
node dist/cli/main.js start-external-storage --host 0.0.0.0 --port 8787
```

Every replica for one installation must use the same installation ID, database,
bucket, API token, and authentication configuration. Different installations
may share a database and bucket because every table query and object key is
installation-scoped. Each supported secret accepts either its named environment
variable or the same name with `_FILE` pointing to a mounted secret file.
Configuring both forms is an error. The server does not print credential values.

`migrate apply` runs Postgres migrations under a database advisory lock.
Serving processes never apply migrations; they fail startup when the schema is
missing, pending, divergent, or newer than the application. Startup also checks
both providers before it prints the ready URL. Bad database or object-store
credentials fail startup. Use normal `pg_dump`/`psql` operations plus a complete
logical copy of the bucket for backup and restore; both halves are required.

## Operator lifecycle commands

The same commands are used by direct packages, containers, Compose, and
Kubernetes. `artifactserver init` creates one compact installation and prints
its browser bootstrap credential once. `start-compact` requires that initialized
directory and never prints a credential.

```sh
artifactserver init --admin-email admin@example.com --data /srv/artifact-server
artifactserver config check --mode compact --data /srv/artifact-server
artifactserver start-compact --data /srv/artifact-server --host 0.0.0.0
artifactserver support manifest --mode compact --data /srv/artifact-server
artifactserver integrity check --mode compact --data /srv/artifact-server
```

`config check` parses the exact configuration, probes required providers, and
prints only safe source labels such as `environment`, `file`, or
`generated_file`. `support manifest` adds build, schema, adapter, migration, and
provider status. `integrity check` reads but never repairs records or bytes; it
returns exit code `2` when it finds corruption. External-storage integrity uses
the same manifest, pointer, size, and SHA-256 checks over Postgres and S3.

On `SIGTERM`, deployed processes first return `503` with lifecycle state
`draining`, wait for the configured routing-withdrawal interval, stop accepting
connections, finish accepted requests until the deadline, and only then close
storage and telemetry resources. Configure the bounded intervals with
`ARTIFACT_SERVER_READINESS_WITHDRAWAL_MS` and
`ARTIFACT_SERVER_SHUTDOWN_DEADLINE_MS`.

## Verification

```sh
pnpm verify:iteration
```

`pnpm verify:iteration` is the command every implementation iteration finishes with. It runs Oxlint with type-aware checking and all anti-slop rules, TypeScript, real runtime and smoke tests, coverage diagnostics, the production build, the ledger validator, the test-ID mapper, and the bounded local performance baseline.

Remote storage changes additionally finish with:

```sh
pnpm verify:object-storage
```

That command requires Docker. It starts a digest-pinned MinIO container and
executes the S3-compatible adapter's dedicated conformance and coverage gate.
It deletes and replaces the provider container over the same durable volume as
part of the test. This provider proof does not make Docker a local-product
runtime requirement.

External-storage runtime changes also finish with:

```sh
pnpm verify:external-storage-runtime
```

That Docker-backed gate starts digest-pinned Postgres and MinIO providers and
runs multiple compiled server processes. It verifies explicit migration separation,
cross-process reads and write conflicts, identity and API-key behavior, staged
uploads, restart, installation isolation, logical backup and restore, and
provider-credential failures. It is a subprocess behavior gate; the local
in-process suite remains the source-coverage diagnostic.

Deployed local and external-storage processes write sampled one-line JSON request logs and
return a server-generated `X-Request-Id`. Server failures and requests taking at
least one second are always logged. Set
`ARTIFACT_SERVER_REQUEST_LOG_SAMPLE_RATE` from `0` through `1` to change the
normal-request sample from its one-percent default. Every request records
bounded route-pattern metrics and Effect spans. Set standard
`OTEL_EXPORTER_OTLP_*` and `OTEL_*_EXPORTER=otlp` variables to send logs,
metrics, and traces to any OTLP/HTTP collector. `/health` reports only process
liveness. `/ready` reports configuration, migration, database, and
object-storage readiness; a failed dependency returns 503 without making
`/health` fail. Telemetry excludes bearer values, cookies, query strings, file
contents, raw artifact IDs, and raw paths.

Performance-sensitive external-storage-runtime changes additionally finish with:

```sh
pnpm verify:external-storage-performance
```

That bounded diagnostic reuses the same pinned disposable providers, starts two
compiled processes, publishes through the real file-first client, reads across
processes, and replaces one process. It writes
`evidence/external-storage-performance-baseline.json`. It is a same-environment regression
baseline, not a cloud-capacity claim.

Tests use temporary real SQLite databases, real disk blobs, and a real HTTP server. Module mocking is forbidden. Coverage is reported as a diagnostic for unexercised code; conformance behavior and hostile tests are the release proof.

`pnpm smoke` is a small correctness and gross-regression check. `pnpm perf:baseline` records local publish latency, read latency, throughput, event-loop delay, memory change, storage use, and restart time in `evidence/local-performance-baseline.json`. It is intentionally bounded and is not a stress test. See [`performance/README.md`](./performance/README.md).

The individual `pnpm check`, `pnpm smoke`, and `pnpm perf:baseline` commands remain available for focused work, but they do not replace the complete iteration gate.

The readable proposal and executable checklist are in [`spec/`](./spec/):

- [`artifact-server-product-spec.html`](./spec/artifact-server-product-spec.html)
- [`conformance.yml`](./spec/conformance.yml)
- [`artifact-server-mcp-baseline.md`](./spec/artifact-server-mcp-baseline.md)
- [`plannotator-artifact-server-integration-spec.md`](./spec/plannotator-artifact-server-integration-spec.md)

## Code boundaries

```text
src/core              product records, errors, and provider ports
src/manifest          portable path validation and canonical manifests
src/comparison        pure canonical-manifest comparison rules
src/application       Effect services for identity, authorization, publication, management, comparison, and content access
src/storage           SQLite, Postgres, local-file, and S3-compatible adapters
src/http              HTTP authentication, publication, links, and delivery
src/local             local adapters, Effect layers, and composition root
src/external-storage  stateless Postgres and object-storage composition root
src/observability     structured logs, bounded metrics, Effect spans, and OTLP layers
src/cli               local and external-storage process entry point
tests/conformance     observable product and hostile behavior
```

Concrete storage and transport code depends on the core. The core does not depend on SQLite, disk, Hono, MCP, Cloudflare, or another deployment provider.

One managed Effect runtime owns the application services and installation
resources. Hono is an inbound adapter over those services; future MCP and CLI
entry points use the same operations and failure values. See
[`Decision 0001`](./spec/decisions/0001-effect-application-core.md) for the
migration boundary and deliberate exclusions. See
[`Decision 0002`](./spec/decisions/0002-shared-identity-and-private-content.md)
for the provider-neutral principal and private-content session model.
See [`Decision 0003`](./spec/decisions/0003-artifact-lifecycle-and-audit.md) for
the list, tombstone, action-history, and shared-identity boundary.
See [`Decision 0004`](./spec/decisions/0004-installation-identity-and-login.md)
for installation membership, browser sessions, managed API keys, and the WorkOS
adapter boundary.
See [`Decision 0005`](./spec/decisions/0005-effect-native-object-storage.md) for
the Effect-owned object-storage boundary, direct-provider strategy, and Phase
3A acceptance scope.
See [`Decision 0006`](./spec/decisions/0006-postgres-external-storage-runtime.md) for the
Postgres transaction, migration, process, and external-provider boundary.
See [`Decision 0007`](./spec/decisions/0007-file-and-directory-publishing.md) for
the public file and directory input contract and the removal of raw-content
publishing from HTTP and MCP.
See [`Decision 0008`](./spec/decisions/0008-effect-observability.md) for request
correlation, structured logs, bounded metrics, OTLP export, and readiness.
