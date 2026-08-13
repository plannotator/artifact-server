# Phase 6: local, container, Compose, and Kubernetes packaging

Status: proposed

This phase turns the working local and shared runtimes into installable,
upgradable, recoverable release packages. It does not change artifact, version,
HTTP, MCP, authentication, or authorization behavior.

## Decision

Local use does not require Docker. The default local installation runs the
Artifact Server CLI directly on the host as one process with SQLite and files in one data
directory. It binds to loopback and uses `*.localhost` content addresses.

Artifact Server also publishes one Linux OCI image for `amd64` and `arm64`.
That image is for people who prefer a local container and for server or
Kubernetes deployments. The image is not the default local runtime.

There are two storage profiles. A storage profile describes where state lives;
it does not require a specific package:

| Profile | Process and storage | Used by | Limit |
| --- | --- | --- | --- |
| Compact | One process, SQLite, and one persistent data directory | Direct local installs, optional local containers, and compact Compose on one server | One application process. No high-availability claim. |
| Shared | One or more stateless processes, Postgres, and object storage reached through a supported adapter | Shared Compose, Kubernetes, and managed-cloud packages | The database and object store must exist before Artifact Server starts. |

The official Compose package uses the compact profile by default. The shared
Compose profile connects the same image to operator-provided Postgres and
object storage. The official Helm chart uses only the shared profile.

The packages will not bundle a production object-storage server. Storage is
replaceable through a narrow adapter contract. The first shared package includes
the S3 adapter used for AWS S3 and Cloudflare R2. Another S3-compatible service
is supported only after it passes the same contract tests; an S3-compatible
label by itself is not a support guarantee. Native Google Cloud Storage and
Azure Blob adapters ship with their cloud packages. A new provider can be added
without changing artifact or version behavior.

MinIO remains a pinned integration-test provider, not a supported production
dependency. The former MinIO open-source server repository was archived in
April 2026. Its likely replacements either add substantial operational work or
are not mature enough to become an invisible Artifact Server dependency.

## What this phase ships

| Release item | Contents |
| --- | --- |
| Local package | The compiled Artifact Server CLI and its production runtime dependencies. It runs directly on the host without Docker and keeps SQLite, files, and local secrets in one user-owned data directory. |
| Runtime image | Compiled JavaScript, production dependencies, the Artifact Server CLI, a fixed non-root user, health support, and no source tree or development tools. |
| Compose package | A compact `compose.yaml`, a shared `compose.shared.yaml` override, secret-file examples, persistent-volume declarations, and operating instructions. |
| Helm chart | Artifact Server Deployment, Service, migration Job, probes, disruption controls, optional Ingress templates, secret references, and a chart test. |
| Operator commands | Configuration validation, migration status and apply, support manifest, integrity check, backup verification, and compact-to-shared transfer. |
| Release evidence | Image, Compose, and Kubernetes conformance reports, bounded performance reports, an SBOM, provenance, and signatures. |

The low-level Docker and Helm surfaces ship first. The common Artifact Server
deployment command wraps those exact surfaces after they are stable. It must
not introduce a second deployment implementation.

## Required runtime changes

Packaging cannot safely wrap the current development commands without these
changes:

| Command | Required behavior |
| --- | --- |
| `artifactserver start` | Run the default direct local mode on loopback with SQLite and one local data directory. It may print the newly generated local bootstrap link. Docker is not required. |
| `artifactserver start-compact` | Bind to the configured interface, use a generated stable installation ID, use the configured application and content origins, require an initialized data directory, and never print a credential or login link. |
| `artifactserver start-shared` | Keep the current Postgres and object-storage composition, but validate rather than apply migrations before serving. |
| `artifactserver init` | Create the compact data directory, installation identity, and initial secret files with restrictive permissions. Return the bootstrap credential once to the invoking terminal, never to later server logs. |
| `artifactserver config check` | Parse the exact runtime configuration, inspect required paths and providers, print only redacted results, and exit without serving. |
| `artifactserver migrate status` | Report the database schema and application compatibility without changing it. |
| `artifactserver migrate apply` | Apply shared Postgres migrations under the existing advisory lock and exit. |
| `artifactserver support manifest` | Emit the product, image, schema, provider, installation, and configuration-health versions without secrets. |
| `artifactserver integrity check` | Verify committed manifests, pointers, records, and referenced bytes without repairing them. |
| `artifactserver transfer export` and `import` | Move one compact installation to empty shared providers while preserving identity. |

The command names are one CLI surface for people, automation, and the future
operator skill. Compose and Helm run these commands directly instead of adding
package-specific scripts with different behavior.

## Image contract

The production image must:

- start the compiled CLI without `tsx`, TypeScript, or development packages;
- run as a fixed non-root user and group;
- work with a read-only root filesystem and a writable temporary directory;
- store compact-profile state only below `/var/lib/artifact-server`;
- store no shared-profile state on the container filesystem;
- accept `SIGTERM`, stop reporting ready, drain accepted requests, close
  providers, and exit before the configured termination deadline;
- expose the product version, schema version, image revision, runtime version,
  deployment mode, and configured adapter names through a secret-free support
  manifest; and
- be released by immutable digest for Linux `amd64` and `arm64`.

The image tag is a convenience. Compose files, Helm values, tests, and support
records pin the digest.

## Compose contract

### Compact Compose

The default Compose package runs one Artifact Server container and one named or
bind-mounted data volume. The volume contains the SQLite database, immutable
files, staged uploads, generated installation secrets, and optional local Git
history when that feature is enabled.

This is the shortest supported private-team installation. It may serve many
signed-in users, but it runs one application process and does not claim
failover. Restarting or replacing the container must preserve the data volume.
The package must refuse to start when the data path is missing, ephemeral, or
not writable by the fixed runtime user.

### Shared Compose profile

Compact Compose and shared Compose package the same application image. Their
state model is different:

| | Compact Compose | Shared Compose |
| --- | --- | --- |
| Application processes | Exactly one | One or more |
| Records | SQLite in the persistent data directory | Existing Postgres |
| Artifact bytes | The same persistent data directory | Existing object storage through a supported adapter |
| Backup unit | Stop the process and copy the complete data directory | Back up Postgres and object storage as one coordinated installation |
| Intended use | The shortest one-server team install | A server that already has shared providers or a step toward Kubernetes |

`compose.shared.yaml` is a Compose override file. It changes the runtime command
and provider configuration; it does not start Postgres or an object-storage
server. It accepts existing provider addresses and mounted credentials. Calling
it an override describes how the Compose files are combined, not a third
deployment model.

Disposable Postgres and MinIO Compose files remain under test tooling. They are
not presented as the production install.

### Network boundary

Compose exposes one private HTTP port. Direct local use, or an optional local
container reached only from the same computer, needs no reverse proxy, DNS
setup, wildcard certificate, or Caddy. It uses loopback and `*.localhost`.

A one-server deployment reached from another device needs a trusted TLS reverse
proxy plus two DNS names:

- the application origin, such as `https://artifacts.example.com`; and
- a separate registrable content domain with wildcard DNS and a wildcard
  certificate, such as `*.content.example.net`.

The proxy sends both names to the Artifact Server service and preserves the
validated host. Artifact Server trusts forwarded host and protocol values only
from configured proxies. The package does not change firewalls, create public
tunnels, issue private-network certificates, or make a public link reachable
from the internet. A public link only removes the Artifact Server login check.

The first package documents and tests Caddy as the reference reverse proxy for
that one-server case. Caddy is needed only when the installation has no existing
proxy or ingress that can provide the same host routing, TLS, streaming,
forwarded-header, upload-limit, and timeout behavior. An installation may use
Nginx, Traefik, HAProxy, a company gateway, or another conforming proxy instead.

Kubernetes uses its configured Ingress or Gateway. Cloudflare and managed-cloud
packages use their provider edge. Those deployments do not run Caddy. Public
wildcard certificates require DNS-challenge access. A private-network
installation may use an administrator-supplied wildcard certificate or a
private certificate authority trusted by every client device; Artifact Server
does not distribute that trust root.

## Kubernetes contract

The Helm chart deploys Artifact Server only. Postgres, object storage, DNS,
certificates, and an ingress controller are prerequisites. The chart accepts
references to existing Kubernetes Secrets. It does not accept durable
credentials as ordinary values.

The default workload has:

- two stateless replicas;
- a RollingUpdate Deployment with no planned unavailable replica;
- a PodDisruptionBudget that keeps one replica available;
- preferred topology spread across nodes;
- a startup probe on `/health`, a liveness probe on `/health`, and a readiness
  probe on `/ready`;
- a non-root, read-only security context with privilege escalation disabled,
  Linux capabilities dropped, and the default seccomp profile;
- no service-account token mount unless a configured feature requires one;
- configurable resource requests based on the measured container baseline;
- a finite termination grace period that is longer than the application drain
  deadline; and
- no artifact data, database, upload staging, or Git repository on pod-local
  storage.

Ingress templates cover the application host and wildcard content host. They
are disabled unless the operator supplies hosts and TLS secret references.
A namespace NetworkPolicy template is enabled when the cluster supports it. It
allows ingress only from the named ingress namespace and egress only to DNS,
Postgres, object storage, the configured login provider, and the OTLP endpoint.
Operators can disable or extend it explicitly for clusters whose networking
model differs. Autoscaling remains disabled until measured capacity and
provider connection limits define safe thresholds.

## Configuration and secrets

All packages use the same validated configuration model. Configuration values
may come from environment variables. Credentials also support the conventional
`*_FILE` form so Compose and Kubernetes can mount secret files without placing
secret values in generated configuration or command history.

Static object-storage credentials are optional when the selected provider can
use its SDK's trusted workload-identity chain. Artifact Server never accepts a
caller-selected identity or provider endpoint. The support manifest names the
credential source category but never the credential.

Startup rejects:

- a missing installation ID;
- an application origin or content domain that violates the browser-isolation
  contract;
- an incomplete database or object-storage configuration;
- a credential that is present in both direct and file form;
- an unreadable secret file;
- a schema newer or older than the serving process allows; and
- a shared process configured to use container-local durable storage.

Configuration changes require a process restart. No package claims dynamic
configuration reload in this phase.

## Migrations and upgrades

Compact mode runs SQLite migrations before it opens the HTTP listener because
one process owns the database.

Shared mode separates migration from serving:

1. `artifactserver migrate status` reports the current and required schema.
2. `artifactserver migrate apply` acquires the existing Postgres advisory lock
   and applies each migration exactly once.
3. Shared serving processes use migration validation and do not alter the
   schema.
4. The Helm chart runs `migrate apply` in a blocking pre-install and pre-upgrade
   Job. A failed Job fails the release. Hook cleanup is explicit.
5. New migrations remain compatible with the previously supported application
   version during a rolling update. Destructive contraction happens only after
   the compatibility window.

Application rollback is supported only while the prior image is compatible
with the current schema. There is no automatic down-migration. Every release
must document whether recovery means image rollback or migration roll-forward,
and test that path before publication.

## Shutdown and readiness

On `SIGTERM`, the process performs this sequence:

1. Mark readiness as `draining` so the proxy or Service stops sending new work.
2. Wait for endpoint removal to propagate for a bounded interval.
3. Stop accepting new connections and finish accepted requests until the drain
   deadline.
4. Cancel remaining work, close Postgres and object-storage clients, flush
   telemetry, and exit.

`/health` remains a process-liveness check. `/ready` reports `503` while
starting, migrating, missing a dependency, or draining. A shutdown test must
prove that a rolling replacement does not return a successful publish before
its durable commit and then lose that version.

## Backup, restore, and moving between profiles

Packaging does not make an installation team-ready by itself. Each profile must
pass its recovery gate.

### Compact recovery

The first supported compact backup is deliberately simple and consistent:

1. stop the one application process;
2. copy the complete persistent data directory to a new backup location;
3. create a checksum and support manifest;
4. restart the application; and
5. verify the backup by restoring it into an empty data directory and running
   the integrity check.

An online SQLite backup can replace the stop-and-copy procedure only after it
has equivalent crash and restore evidence.

### Shared recovery

The first supported shared procedure favors correctness over online backup:

1. stop every Artifact Server process for the installation;
2. create a transaction-consistent logical Postgres backup and copy the complete
   installation prefix from object storage;
3. create and verify one manifest that identifies both backup halves; and
4. restart the application only after verification succeeds.

Committed-object reclamation remains disabled. A later online procedure may
avoid downtime only after a durable maintenance barrier and point-in-time
provider tests prove that the database and object backup describe one valid
installation state.

Restore writes objects into an empty target, restores the database while the
application is stopped, runs the integrity check, and starts serving only after
all required IDs, pointers, records, and bytes match.

Kubernetes does not pretend Helm backs up external state. The operator uses the
supported Postgres and object-storage backup mechanisms, while Artifact Server
produces and validates the support and integrity manifests.

### Compact-to-shared transfer

Moving from one-server compact mode to Postgres and object storage is an
explicit export and import, not a change of environment variables. The transfer
must preserve the installation ID, artifact IDs, version IDs, action IDs,
manifests, current pointers, access settings, audit attribution, and exact
bytes. The source becomes read-only during the final export. The target cannot
report ready until import and integrity verification complete.

This transfer is required before Artifact Server can claim that a one-server
installation can grow into the Kubernetes package without product-visible
changes.

## Supply-chain contract

Every release publishes:

- an immutable multi-architecture image and digest;
- an OCI Helm chart pinned to that image digest;
- an SPDX or CycloneDX SBOM for the image;
- build provenance tied to the source revision;
- a keyless or organization-controlled signature for the image and chart; and
- a support matrix naming the supported Node, Postgres, Kubernetes, Helm,
  browser, and architecture ranges.

Generated Compose and Helm files never use `latest`. Development dependencies,
test credentials, repository files, and build caches must not appear in the
runtime image.

## Verification matrix

### Image

- Build and run both architectures.
- Prove the image runs as non-root with a read-only root filesystem.
- Prove compact data survives container replacement.
- Prove shared mode writes no durable pod or container-local state.
- Send `SIGTERM` during idle, read, upload, and commit work and verify the
  declared outcomes.
- Scan the final filesystem and dependency graph, then verify the SBOM,
  provenance, and signature.

### Compose

- Install compact mode from an empty directory using only the published
  procedure.
- Publish a file and complete site, restart, upgrade, back up, restore into a
  clean directory, and compare every required ID and byte.
- Fail closed for an ephemeral data path, bad permissions, missing secrets,
  invalid DNS configuration, and an unavailable login provider.
- Run shared Compose against real Postgres and S3-compatible providers and
  prove cross-process reads and publish conflicts remain correct.

### Kubernetes

- Render, lint, install, test, upgrade, and uninstall the chart in a disposable
  cluster.
- Use at least two replicas against real Postgres and S3-compatible providers.
- Publish and read while pods roll, delete every original pod, and preserve all
  committed data.
- Prove migration serialization, old/new compatibility, failed migration,
  readiness withdrawal, graceful drain, provider outage, node drain, and
  PodDisruptionBudget behavior.
- Run the bounded shared performance workload through the Service and record
  container, provider, and rollout measurements separately.

Timing thresholds remain regression warnings on developer and CI machines.
Correctness, durability, isolation, migration, security, and recovery failures
fail the packaging gate.

## Failure traps that the package must test

- **SQLite on unsuitable network storage:** compact mode requires a filesystem
  with reliable local locking and atomic rename behavior. NFS-like storage is
  unsupported until its exact mount and failure behavior passes the SQLite and
  blob tests.
- **Database connection multiplication:** each replica has a bounded pool. The
  chart validates that replicas, pool size, and the migration Job fit the
  declared Postgres connection budget.
- **Object lifecycle rules:** a provider rule cannot expire or rewrite the
  committed-object prefix. Cleanup is limited to separately identified,
  expired, uncommitted staging data.
- **Reverse-proxy limits:** upload body limits, buffering, idle timeouts, host
  forwarding, and TLS termination must preserve streaming and the two-domain
  browser boundary.
- **Private certificate trust:** a certificate that clients do not trust is a
  failed installation. The installer reports the certificate and DNS
  prerequisites; it does not bypass browser warnings or install a trust root on
  user devices.
- **Secret updates:** secret and configuration checksums trigger controlled pod
  replacement. A changed mounted secret cannot leave an old process serving
  indefinitely with a different credential.
- **Schema rollback:** rolling an image back does not roll the database back.
  Unsupported image and schema pairs fail readiness rather than attempting a
  partial serve.
- **Destructive package commands:** normal upgrade and removal preserve durable
  data. Volume deletion, bucket deletion, database deletion, and destructive
  restore require a separate explicit operation that names the target and
  refuses a broad or unresolved path.
- **Object-provider drift:** S3-compatible is a tested contract, not a label.
  Multipart upload, abort, read-after-write, metadata, listing, pagination,
  authentication, restart, and failure behavior must pass before a provider is
  documented as supported.

## Implementation order

1. Add the runtime lifecycle commands and behavior: migration apply and
   validate, configuration check, secret files, support manifest, integrity
   check, readiness drain, and version injection.
2. Build and verify the OCI image against the existing local, shared, MCP,
   observability, smoke, and bounded performance suites.
3. Ship the compact Compose package and complete its install, restart, upgrade,
   backup, restore, and hostile-configuration evidence.
4. Ship the shared Compose overlay and run the existing multi-process Postgres
   and S3 suite through containers.
5. Ship the Helm chart and pass the multi-replica migration, rollout, failure,
   recovery, observability, and performance gates in a disposable cluster.
6. Add compact-to-shared export and import, then prove one installation can move
   from the Compose package to the Helm package without changing IDs or bytes.
7. Publish signed release artifacts and add the common CLI wrapper around the
   verified Compose and Helm operations.

Every step ends with the normal lint, type, build, conformance, smoke, real
provider, and bounded performance gates. A packaging test must execute the
released image or chart. An in-process substitute is not evidence for this
phase.

## Not included

- Cloudflare Workers, D1, R2, Alchemy, Pulumi, or cloud-account provisioning.
- A bundled production Postgres or object-storage service.
- An ingress controller, DNS server, certificate authority, public tunnel, or
  firewall automation.
- Horizontal autoscaling, multi-region failover, or a capacity claim.
- A Kubernetes operator or custom resource.
- The choice and implementation of a new self-hosted browser identity provider,
  optional Git history, comments, annotations, or Plannotator review features.
- Provider-native GCS and Azure Blob drivers. They remain later deployment
  adapters and must pass the storage contract before support.

## Decisions required before implementation closes

1. Choose the release registry and signing identity.
2. Choose the minimum supported Postgres, Kubernetes, and Helm versions from
   compatibility tests.
3. Prove the Caddy two-domain TLS configuration on a private network and a
   public server, then record the requirements for equivalent proxies.
4. Define the minimum S3-compatible operation and consistency matrix required
   for a provider to be supported.
5. Choose the self-hosted browser-login baseline when WorkOS is not configured.
6. Define recovery-point and recovery-time targets after the backup procedures
   have measured evidence.
