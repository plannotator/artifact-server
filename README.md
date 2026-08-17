# Artifact Server

Artifact Server stores finished browser files as immutable versions and serves each version from its own hostname.

This repository contains the local publication foundation and the first external-storage runtime. It is not the complete product yet. Current tests exercise the following implementation; they do not, by themselves, prove every acceptance sentence or deployment in the conformance ledger:

- a file-first CLI with exact-origin profiles, operating-system credential
  storage, a portable browser OAuth client flow, scoped-key fallback, and
  verified HTTP uploads; WorkOS hosted MCP is qualified in staging for Codex
  and Claude Code while the remaining remote-client release matrix stays gated;
- a primary MCP 2026-07-28 endpoint, a stateless 2025-era compatibility path
  for current clients, and credential-free local registration adapters for
  Codex, Claude Code, Cursor, and VS Code;
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
- provider-neutral principals with installation membership and explicit capability policy;
- installation-owned members with explicit administrator admission and deactivation;
- opaque browser sessions with host-only cookies and same-origin mutation checks;
- managed human and service API keys with capabilities, expiry, rotation, and revocation;
- a responsive management application for projects, artifacts, immutable
  versions, comparisons, restores, action history, members, and API keys;
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
- explicit static-site and single-page-application routing with exact-path-first fallback;
- safe `GET`, `HEAD`, conditional, and single-range content delivery;
- bounded cleanup of expired uncommitted uploads without committed-blob garbage collection;
- single-use private-content bootstraps and host-only, HttpOnly content cookies;
- authenticated browser sessions for current or earlier exact versions;
- persistence of committed versions and in-progress uploads across a full server restart;
- a stateless external-storage process backed by Postgres and S3-compatible storage;
- explicit, advisory-locked Postgres migrations that serving processes only validate;
- cross-process publication, browser sessions, managed keys, and staged uploads;
- replacement of every application process without losing committed state;
- installation isolation when several installations use one Postgres database and bucket;
- logical Postgres and object-storage backup and restore with stable IDs and bytes;
- a bounded two-process Postgres and S3-compatible performance baseline using the real file-first client;
- External-storage Compose with mounted secrets, no application-data volume,
  two tested replicas, safe cross-replica conflicts, and complete container
  replacement through the production image;
- an application-only Helm chart for Kubernetes 1.34 through 1.36 with two
  stateless replicas, blocking migrations, restricted Pod security, private
  Service routing, disruption controls, and existing-secret references; and
- a real three-node Kubernetes release gate against Postgres and S3-compatible
  storage, including rollout, pod loss, provider outage, node drain, private
  delivery, uninstall, and reinstall.

## Current implementation

The backend foundation, management application, direct local archive, lifecycle
CLI, production OCI image, Compact Compose, External-storage Compose, and Helm
chart exist and pass package-specific gates. No deployment yet passes the full
ledger release gate.

Project-scoped artifacts are now implemented:

```text
Artifact Server installation
└── Project
    └── Artifact
        └── Immutable version
```

One installation represents one person, team, or company. A new installation
creates one default project. There is no organization switcher or separate
Artifact Store object. The accepted decision and migration constraints are in
[`0015-project-scoped-artifacts.md`](./spec/decisions/0015-project-scoped-artifacts.md).
The implementation contract and proof gates are in
[`phase-8-project-scoped-artifacts.md`](./spec/phase-8-project-scoped-artifacts.md).
The local SQLite and external Postgres/S3-compatible paths have project behavior
and populated-database migration tests. Package, Compose, external-storage,
bounded-capacity, and live Kubernetes/Helm iteration gates have passed. The
`PRJ-001` through `PRJ-004` acceptance IDs remain `implementing`: the attached
tests do not cover the full team-installation, HTTP/MCP, archive-invariant, and
SQLite/Postgres interruption matrices named by those requirements.

The remaining product work is:

1. Release validation for the implemented locality-aware `publish-artifact`
   Agent Skill in current supported clients.
2. Finish the technical release proof for the optional one-installation
   Cloudflare package. Quotas, abuse operations, malware handling, and
   regulated-enterprise controls belong to an optional artifactserver.com
   service policy and are not core OSS first-release work.
3. Optional private Git history, including local and Cloudflare providers.
4. The AWS and GCP Pulumi projects and native S3 and GCS adapters are
   implemented and have selected live qualification evidence. Their complete
   ledger lifecycle gates remain open. The Azure Blob adapter is preview-only
   until it passes a live Azure qualification.
5. The optional `operate-artifact-server` skill after its deployment commands
   are stable.
6. Direct Plannotator project pairing and the review bridge after the separate
   integration contract passes.

Phase 11 has selected recovery and live-cloud evidence for Cloudflare, AWS, and
GCP, and the temporary qualification resources were removed after those runs.
The phase is not complete by its own acceptance gate: `CNT-008` and `OPS-006`
remain `implementing`, `PUB-009-F` is not proved, and the complete package-path
matrix is absent. Committed-blob garbage collection and permanent deletion are
not part of the initial product.

The architecture, provider boundaries, implementation order, and release gates
for the cloud, skill, and Git tracks are in
[`phase-9-distribution-and-history.md`](./spec/phase-9-distribution-and-history.md).
The bounded first assignment for a parallel Cloudflare contributor is in
[`cloudflare-developer-onboarding.md`](./spec/cloudflare-developer-onboarding.md).
The implemented CLI authentication and remote-publication contract is in
[`phase-10-cli-auth-and-remote-publishing.md`](./spec/phase-10-cli-auth-and-remote-publishing.md).

## Install the Agent Skill

After the `plannotator/artifact-server` repository is published, install the
portable publishing skill with:

```sh
npx skills add plannotator/artifact-server
```

During private development, install it from an existing checkout instead:

```sh
npx skills add /absolute/path/to/artifact-server
```

The skill lives in [`skills/publish-artifact`](./skills/publish-artifact). It
uses `artifactserver publish` for files on the user's machine and the connected
Artifact Server MCP for work that needs only server data. It does not install,
deploy, upgrade, back up, restore, or repair a server.

## Install the direct local package

The direct local release is a self-contained Node package. It includes the
compiled management application, server JavaScript, and all production
dependencies. It does not include Artifact Server source code, TypeScript,
pnpm, test tools, or a container. Node.js 24.12 or newer is the only runtime
prerequisite after the archive is downloaded.

Build and unpack the package:

```sh
pnpm package:local
tar -xzf release/artifact-server-*-node.tar.gz
./artifactserver/bin/artifactserver --version
./artifactserver/bin/artifactserver connect
```

Move the extracted `artifactserver` directory anywhere user-owned. Add its
`bin` directory to `PATH` if the shorter `artifactserver` command is preferred.
The executable directory and persistent data directory are separate: replacing
the executable directory must not replace or remove local data.

Open the local management application:

```sh
artifactserver open
```

The command starts or reuses the managed loopback service and opens a private,
single-use login URL in the system browser. It does not print or store the
browser credential in shell history. After login, manage projects, artifacts,
versions, members, and API keys from the application.

Direct local and Compose processes remove expired uploads that were never
committed. They run one bounded pass at startup and every 15 minutes. Operators
can run the same operation directly:

```sh
artifactserver maintenance cleanup-staging --once --mode compact --limit 100
```

The defaults are a 100-upload batch, four concurrent removals, a 15-minute
interval, and a five-minute delay after upload expiry. These can be changed
with `ARTIFACT_SERVER_STAGING_CLEANUP_BATCH_SIZE`,
`ARTIFACT_SERVER_STAGING_CLEANUP_CONCURRENCY`,
`ARTIFACT_SERVER_STAGING_CLEANUP_INTERVAL_MS`, and
`ARTIFACT_SERVER_STAGING_CLEANUP_SETTLE_DELAY_MS`. Setting
`ARTIFACT_SERVER_STAGING_CLEANUP_SCHEDULE=external` disables the process loop
when a deployment scheduler owns it. Cleanup never selects committed versions
or content-addressed blobs.

The package is built without native Node extensions, so the same archive can be
used with supported Node installations on macOS, Linux, and Windows. The
archive contains both the POSIX `artifactserver` launcher and
`artifactserver.cmd` for Windows.

`pnpm test:local-package` builds the archive without network access, extracts it
twice into clean directories, and runs the packaged executable through MCP
connect, discovery, doctor, disconnect, publish, open, program-directory
replacement, restart, stopped-data backup, and clean restore. It records the
archive checksum and runtime proof in `evidence/`.

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
use the published image digest, never a floating tag.

## Run Compact Compose

Compact Compose runs one Artifact Server container with SQLite and file storage
in one persistent Docker volume. It is the shortest one-server team candidate.
Its package gate passes, but the complete one-server conformance ledger does
not. It does not claim failover or support more than one application process.

Copy [`packaging/compose`](./packaging/compose) to the server, copy
`.env.example` to `.env`, and set the published immutable image digest. Then
initialize and start the installation:

```sh
docker compose run --rm --no-deps artifact-server \
  init --admin-email admin@example.com \
  --data /var/lib/artifact-server/data
docker compose up --detach --wait
```

The initialization command prints the browser bootstrap credential once. The
server uses the same volume on restart and container replacement.

Create a stopped-volume backup and restore it into a clean Compose project:

```sh
./compact-backup.sh /srv/backups/artifact-server/2026-08-14
export COMPOSE_PROJECT_NAME=artifact-server-restored
./compact-restore.sh /srv/backups/artifact-server/2026-08-14
docker compose up --detach --wait
```

The backup includes the complete data directory, a SHA-256 checksum, and a
support manifest. Restore refuses a running or nonempty target, incomplete or
corrupt backup, unsafe archive path, link, or special filesystem entry. It runs
the Artifact Server integrity check before the operator can start the restored
service. A failed restore leaves a durable marker that prevents the server from
starting with partial state.

The default stack binds to loopback and needs no proxy. Access from another
device requires an HTTPS application origin, a separate registrable wildcard
content domain, and a trusted reverse proxy. The package does not install a
proxy, issue certificates, change firewall rules, or create a public tunnel.
See [`packaging/compose/README.md`](./packaging/compose/README.md) for the exact
install, network, backup, restore, and failure contracts.

Run the real Compose release gate with:

```sh
pnpm verify:compact-compose
```

The gate rebuilds and loads the production OCI archive, executes Docker
Compose, publishes a file and complete site, restarts and replaces the
container, backs up and restores into a clean volume, compares complete stored
state and bytes, and runs the hostile configurations. It is also part of
`pnpm verify:iteration`.

## Run External-storage Compose

External-storage Compose runs two disposable Artifact Server containers against
an existing Postgres database and object store. It mounts credentials from
files and has no application-data volume. See
[`packaging/compose/README.md`](./packaging/compose/README.md) for provider,
secret, proxy, upgrade, and failure requirements.

Run its production-image gate with:

```sh
pnpm verify:external-storage-compose
```

## Run on Kubernetes

The application-only Helm chart requires existing Postgres, object storage,
DNS, TLS, and cluster ingress. It supports Kubernetes 1.34, 1.35, and 1.36 with
Helm 4.2. The source chart requires an immutable image digest for release use.

See [`packaging/helm/artifact-server/README.md`](./packaging/helm/artifact-server/README.md)
for required values, existing Secret keys, routing choices, workload identity,
connection budgeting, and install commands.

Run the static compatibility gate and the real three-node cluster gate with:

```sh
pnpm verify:helm-static
pnpm verify:helm
```

The cluster gate uses the production image, real Postgres and S3-compatible
storage, two worker nodes, public and account-required artifacts, rolling
replacement, provider outage, node drain, uninstall, and reinstall. It is part
of `pnpm verify:iteration`.

Use this Helm path for an existing EKS, GKE, AKS, or other Kubernetes cluster.
The chart does not create the cluster, database, object store, DNS, certificate,
or ingress. The direct AWS and GCP deployment projects are separate turnkey
options for teams that do not already operate Kubernetes. Azure uses this Helm
path on AKS; Artifact Server does not ship a separate Azure installer.

## Deploy the default AWS stack

The direct Pulumi project in [`deploy/pulumi/aws`](./deploy/pulumi/aws) creates
ECS Fargate, RDS PostgreSQL, S3, Secrets Manager, workload identity, networking,
DNS, TLS, CloudWatch logs, and autoscaling. It does not create EKS.

Follow its README for state, configuration, preview, deployment, verification,
and safe deletion requirements. The resource graph and public stack have run in
a real AWS account. Checked-in reports record publication, MCP discovery,
horizontal scaling, bounded reads, S3 outage and recovery, state recovery, a
clean database/object restore summary, destroy, image upgrade/rollback,
credential rotation, task replacement, and role-based publication. They do not
prove the complete `DEP-008`, `GATE-007`, or product-conformance matrix. The
private-ingress variant also requires its own live qualification.

## Deploy the GCP stack

The direct project in [`deploy/pulumi/gcp`](./deploy/pulumi/gcp) creates the
documented managed runtime, private PostgreSQL database, native object store,
workload identity, secrets, network, DNS, TLS, logs, and support outputs.
Checked-in reports record selected public-path product probes, bounded
concurrency, upgrade, rollback, credential rotation, checkpoint recovery,
backup/restore summary, and safe destroy in a disposable project. They do not
prove the complete `DEP-009`, `GATE-007`, or product-conformance matrix. The
direct GCP project advertises public ingress only; private GCP teams use the
tested Helm path on GKE. Follow the project README for prerequisites.

Azure teams use the Helm chart on AKS. The native Azure Blob adapter is
available as preview configuration for that path, but it is not a deployment
installer or a supported storage claim until a live Azure contract test passes.

## Run from the source checkout

Requirements: Node.js 24.12 or newer, pnpm 10.34.3, and Ruby for validating the conformance ledger.

```sh
pnpm install
pnpm dev
```

This command builds the management shell once, then runs the backend on port
8787 and the Vite development server on port 5173. In another terminal, run:

```sh
node --import tsx src/cli/main.ts open --data .artifact-server
```

The command signs the browser into the backend shell. The session also works
through the Vite proxy at `http://127.0.0.1:5173`.

For a production-style source run, use `pnpm build` followed by
`pnpm start -- --data .artifact-server --port 8787`, then open
`http://localhost:8787`.

The local server creates separate random API and browser-bootstrap credentials in
`.artifact-server/local-api-token` and `.artifact-server/local-browser-token`
and keeps both files with mode `0600`. It prints neither credential and does not
print a URL containing one.

Hosted deployments serve the same application at their configured HTTPS
application origin. Users sign in through WorkOS. Artifact content remains on
the separate wildcard content domain.

## Connect a local AI client

Run:

```sh
artifactserver connect
```

If exactly one supported client is installed, Artifact Server connects it. If
several are installed, name one explicitly: `codex`, `claude`, `cursor`, or
`vscode`. For example:

```sh
artifactserver connect codex
```

The command starts one private loopback service when needed, installs a
user-scoped stdio MCP entry, and verifies modern discovery and the complete tool
list. It does not print, copy, or place a credential in the client
configuration. Use `artifactserver doctor codex` to inspect the connection and
`artifactserver disconnect codex` to remove only Artifact Server's managed
entry. Disconnecting preserves artifacts and saved versions.

`artifactserver mcp` is the stdio transport used by local AI clients. It is not
a second application runtime: it forwards to the one per-user loopback service,
which owns SQLite and local files. Remote deployments connect their AI clients
directly to the deployment's `/mcp` URL instead.

The repository tests the packaged bridge and every configuration adapter. The
real-current-client matrix remains a release gate; a client is not advertised
as release-verified until that exact host has passed connect, use, upgrade,
disconnect, and stale-state recovery.

One installation is one closed group. After the first administrator exists,
administrators admit members through `POST /api/v1/members`. There is no public
self-sign-up. Administrators manage human-owned or service-owned credentials
through `/api/v1/api-keys`; each key has explicit capabilities and a required
future expiration and can be rotated or revoked.

### Optional hosted WorkOS authentication

WorkOS owns browser authorization for hosted MCP and interactive application
login. Artifact Server still owns its member list, authorization decisions,
application sessions, and API keys. Copy `.env.example` into a secret local
environment file or secret manager. Set the application origin, bootstrap
administrator email, client ID, exact AuthKit issuer, and either the WorkOS
API-key value or its `_FILE` path before starting the server.

Use a dedicated Artifact Server WorkOS environment. Configure the exact
`/auth/callback` redirect. Enable CIMD, retain DCR for current-client
compatibility, and configure the exact application origin plus `/mcp` as the
default Resource Indicator. Disable public AuthKit self-sign-up. Never reuse a
Plannotator Workspaces staging or production environment. Staging and
production use different WorkOS environments, issuers, MCP resources, clients,
grants, and qualification evidence.

Artifact Server publishes protected-resource metadata and validates each MCP
access token for the exact issuer and `/mcp` audience. The client owns browser
approval and access-token refresh. WorkOS owns the provider grant and can revoke
one user's authorization for one client. Artifact Server never stores the
provider access token or refresh token.

The first successful WorkOS login is accepted only when its verified email is
the configured bootstrap administrator email. Later logins require a member
already admitted to this Artifact Server.

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

For a team server that advertises browser authorization, sign in once and then
publish through the saved profile:

```sh
artifactserver auth login https://artifacts.example.com --name team
artifactserver auth status team
artifactserver publish ./dist --profile team
```

The login opens the system browser, completes PKCE authorization, verifies the
credential against that exact Artifact Server, and stores the reusable grant in
the operating-system credential store. The profile file contains only the
server origin and non-secret account identifiers. `auth logout team` attempts
remote grant revocation, deletes the operating-system credential, and then
removes the profile. If secure deletion fails, the recoverable profile is kept.

For a self-hosted server without browser authorization, an administrator can
issue a scoped API key. Pipe it to the same profile boundary:

```sh
printf '%s\n' "$ARTIFACT_SERVER_API_TOKEN" |
  artifactserver auth login https://artifacts.example.com \
    --api-key-stdin --name team
```

The key is read from standard input and is never accepted as a command
argument. CI can continue to set `ARTIFACT_SERVER_URL` and
`ARTIFACT_SERVER_API_TOKEN`, or use `--server` and `--token-file`, without
creating an interactive profile.

To publish a new immutable version, pass both `--artifact` and
`--expected-version`. The command returns JSON containing the project,
artifact, exact version, and browser links.

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

`pnpm verify:iteration` is the command every implementation iteration finishes
with. It runs Oxlint with type-aware checking and all anti-slop rules,
TypeScript, real runtime and smoke tests, coverage diagnostics, the production
build, the ledger validator, the test-ID mapper, bounded local performance, the
production-image Compose packages, and the real Kubernetes Helm gate.

Remote storage changes additionally finish with:

```sh
pnpm verify:object-storage
```

That command requires Docker. It starts a digest-pinned MinIO container and
executes the S3-compatible adapter's dedicated conformance and coverage gate.
It deletes and replaces the provider container over the same durable volume as
part of the test. This provider proof does not make Docker a local-product
runtime requirement.

An opt-in AWS S3 probe is available when the AWS CLI is authenticated:

```sh
pnpm verify:aws-s3
```

It creates one uniquely named private bucket, blocks public access, enables
default encryption, runs multipart, concurrent, staged, and hostile adapter
operations through the AWS SDK credential chain, then removes every object,
incomplete multipart upload, and the bucket. It is not part of the normal
iteration gate and does not provision a database, role, network, or server.

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

External-storage Compose packaging changes additionally finish with:

```sh
pnpm verify:external-storage-compose
```

That gate builds and loads the production OCI archive, starts two application
containers against independently managed test providers, races a version
write, replaces both containers, compares exact stored state and bytes, inspects
the container mounts, and runs unavailable-provider and configuration failures.
It is part of `verify:iteration`.

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

`pnpm smoke` is a small correctness and gross-regression check. `pnpm perf:baseline` records the combined local client/server path in `evidence/local-performance-baseline.json`. `pnpm perf:capacity` separately measures the compiled server at 1, 10, 25, 50, and 100 concurrent browse and publish workflows in `evidence/local-capacity-baseline.json`. Both commands are bounded development-machine diagnostics, not cloud-capacity claims. See [`performance/README.md`](./performance/README.md).

The individual `pnpm check`, `pnpm smoke`, `pnpm perf:baseline`, and `pnpm perf:capacity` commands remain available for focused work, but they do not replace the complete iteration gate.

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
See [`ADR 0016`](./spec/decisions/0016-cli-and-mcp-share-product-capabilities.md)
for the intentional MCP and CLI overlap, local-file boundary, secure CLI
profiles, and Agent Skill routing rule.
