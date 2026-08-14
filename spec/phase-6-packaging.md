# Phase 6: local, container, Compose, and Kubernetes packaging

Status: implementing

This phase turns the working local and external-storage runtimes into installable,
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
| External storage | One or more stateless processes, Postgres, and object storage reached through a supported adapter | External-storage Compose, Kubernetes, and managed-cloud packages | The database and object store must exist before Artifact Server starts. |

The official Compose package uses the compact profile by default.
External-storage Compose connects the same image to operator-provided Postgres
and object storage. The official Helm chart uses only the external-storage
profile.

The packages will not bundle a production object-storage server. Storage is
replaceable through a narrow adapter contract. The first external-storage package includes
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
| Compose package | A Compact Compose `compose.yaml`, an External-storage Compose `compose.external-storage.yaml` override, secret-file examples, persistent-volume declarations, and operating instructions. |
| Helm chart | Artifact Server Deployment, Service, migration Job, probes, disruption controls, optional Ingress templates, secret references, and a chart test. |
| Operator commands | Configuration validation, migration status and apply, support manifest, integrity check, backup verification, and compact-to-external-storage transfer. |
| Release evidence | Image, Compose, and Kubernetes conformance reports, bounded performance reports, an SBOM, provenance, and signatures. |

The low-level Docker and Helm surfaces ship first. The common Artifact Server
deployment command wraps those exact surfaces after they are stable. It must
not introduce a second deployment implementation.

### Direct local package contract

The direct local release is one compressed archive containing compiled
JavaScript, the `artifactserver` launcher, and its complete production
dependency tree. Extracting it does not contact a package registry. Running it
requires only a supported Node installation; it does not require Docker, pnpm,
TypeScript, a source checkout, or an external service.

The build uses the pinned lockfile and an already populated pnpm content store
with network access disabled. Release automation must populate that store from
the pinned lockfile before invoking the package build. The archive itself is
complete and requires no package-manager operation when it is extracted or run.

The archive contains no native Node extensions. The same package can therefore
run on supported Node installations on macOS, Linux, and Windows. It includes a
POSIX launcher and a Windows command launcher. Platform-specific installers or
a bundled Node runtime may be added later as conveniences, but they must wrap
this same compiled CLI and do not define another runtime.

The extracted program directory is replaceable. The persistent data directory
is separate and is never inside the program directory. A package test must
extract the release into a clean directory, run its real launcher, publish and
open a file, stop and replace the extracted program directory, restart against
the same data, restore a stopped copy of that data into an empty directory, and
verify the original artifact ID, version ID, current pointer, and bytes. This
replacement test proves package/data separation; compatibility between two
different released schema versions remains part of the later upgrade gate.

## Required runtime changes

Packaging cannot safely wrap the current development commands without these
changes:

| Command | Required behavior |
| --- | --- |
| `artifactserver start` | Run the default direct local mode on loopback with SQLite and one local data directory. It may print the newly generated local bootstrap link. Docker is not required. |
| `artifactserver start-compact` | Bind to the configured interface, use a generated stable installation ID, use the configured application and content origins, require an initialized data directory, and never print a credential or login link. |
| `artifactserver start-external-storage` | Keep the current Postgres and object-storage composition, but validate rather than apply migrations before serving. |
| `artifactserver init` | Create the compact data directory, installation identity, and initial secret files with restrictive permissions. Return the bootstrap credential once to the invoking terminal, never to later server logs. |
| `artifactserver config check` | Parse the exact runtime configuration, inspect required paths and providers, print only redacted results, and exit without serving. |
| `artifactserver migrate status` | Report the database schema and application compatibility without changing it. |
| `artifactserver migrate apply` | Apply external-storage Postgres migrations under the existing advisory lock and exit. |
| `artifactserver support manifest` | Emit the product, image, schema, provider, installation, and configuration-health versions without secrets. |
| `artifactserver integrity check` | Verify committed manifests, pointers, records, and referenced bytes without repairing them. |
| `artifactserver transfer export` and `import` | Move one compact installation to empty external providers while preserving identity. |

The command names are one CLI surface for people, automation, and the future
operator skill. Compose and Helm run these commands directly instead of adding
package-specific scripts with different behavior.

## Image contract

The production image must:

- start the compiled CLI without `tsx`, TypeScript, or development packages;
- run as a fixed non-root user and group;
- work with a read-only root filesystem and a writable temporary directory;
- store compact-profile state only below `/var/lib/artifact-server`;
- store no external-storage-profile state on the container filesystem;
- accept `SIGTERM`, stop reporting ready, drain accepted requests, close
  providers, and exit before the configured termination deadline;
- expose the product version, schema version, image revision, runtime version,
  deployment mode, and configured adapter names through a secret-free support
  manifest; and
- be released by immutable digest for Linux `amd64` and `arm64`.

The image tag is a convenience. Compose files, Helm values, tests, and support
records pin the digest.

The implemented image builder writes a multi-architecture OCI archive and a
checksum manifest. Node, the Dockerfile frontend, and the SBOM scanner are
pinned by digest or exact version. Each platform has an SPDX software inventory
and SLSA build provenance. The local image gate loads that exact archive and
runs AMD64 and ARM64. It then exercises compact and external-storage serving,
publication, immutable reads, clean shutdown, container replacement, provider
diagnostics, non-root execution, read-only root filesystems, and declared
durable storage. Registry signing remains part of the release-pipeline step
because it requires the release registry and release identity.

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

### External-storage Compose

Compact Compose and External-storage Compose package the same application image. Their
state model is different:

| | Compact Compose | External-storage Compose |
| --- | --- | --- |
| Application processes | Exactly one | One or more |
| Records | SQLite in the persistent data directory | Existing Postgres |
| Artifact bytes | The same persistent data directory | Existing object storage through a supported adapter |
| Backup unit | Stop the process and copy the complete data directory | Back up Postgres and object storage as one coordinated installation |
| Intended use | The shortest one-server team install | A server that already has external providers or a step toward Kubernetes |

`compose.external-storage.yaml` is a Compose override file. It changes the
runtime command and provider configuration; it does not start Postgres or an
object-storage server. It accepts existing provider addresses and mounted
credentials. Calling it an override describes how the Compose files are
combined, not a third deployment model.

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
are disabled unless the operator supplies TLS secret references. Clusters that
use Gateway API or a managed provider edge route the private Service and leave
the Ingress template disabled.

NetworkPolicy is disabled by default and accepts explicit native rules when an
operator enables it. Standard Kubernetes NetworkPolicy cannot allow managed
Postgres, S3, R2, WorkOS, or OTLP services by DNS name. The chart therefore does
not invent changing IP ranges or ship a policy that silently blocks required
dependencies. A provider installer can generate exact rules when it owns the
network addresses. Autoscaling remains disabled until measured capacity and
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
- an external-storage process configured to use container-local durable storage.

Configuration changes require a process restart. No package claims dynamic
configuration reload in this phase.

## Migrations and upgrades

Compact mode runs SQLite migrations before it opens the HTTP listener because
one process owns the database.

External-storage mode separates migration from serving:

1. `artifactserver migrate status` reports the current and required schema.
2. `artifactserver migrate apply` acquires the existing Postgres advisory lock
   and applies each migration exactly once.
3. External-storage serving processes use migration validation and do not alter the
   schema.
4. The Helm chart runs `migrate apply` in a blocking pre-install and pre-upgrade
   Job. A failed Job fails the release. Successful hooks are removed; a failed
   hook remains for diagnosis and is removed before the next attempt.
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

Restore writes a durable incomplete marker before extraction. Runtime startup
must refuse that data directory until restore finishes and its integrity check
removes the marker.

An online SQLite backup can replace the stop-and-copy procedure only after it
has equivalent crash and restore evidence.

### External-storage recovery

The first supported external-storage procedure favors correctness over online backup:

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

### Compact-to-external-storage transfer

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
- Prove external-storage mode writes no durable pod or container-local state.
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
- Run External-storage Compose against real Postgres and S3-compatible providers and
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
- Run the bounded external-storage performance workload through the Service and record
  container, provider, and rollout measurements separately.

Timing thresholds remain regression warnings on developer and CI machines.
Correctness, durability, isolation, migration, security, and recovery failures
fail the packaging gate.

## Failure traps that the package must test

- **SQLite on unsuitable network storage:** compact mode requires a filesystem
  with reliable local locking and atomic rename behavior. NFS-like storage is
  unsupported until its exact mount and failure behavior passes the SQLite and
  blob tests.
- **Database connection multiplication:** each serving replica uses a bounded
  ten-connection pool and the migration Job uses one connection. The chart
  validates that the replica count and migration Job fit the declared Postgres
  connection budget.
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

1. **Complete.** Build the direct local package from compiled JavaScript and production
   dependencies, then prove clean extraction, offline execution, program
   replacement, restart, stopped-data backup, and restore through the packaged
   executable.
2. **Complete for the pre-image surface.** Add the remaining runtime lifecycle commands and behavior: migration apply and
   validate, configuration check, secret files, support manifest, integrity
   check, readiness drain, and version injection.
3. **Complete for the image foundation.** Build a digest-addressed AMD64 and ARM64
   OCI archive with SPDX and SLSA attestations. Load the exact archive and prove
   both architectures, non-root and read-only operation, compact and
   external-storage publication, clean shutdown, replacement, durable bytes,
   secret-free diagnostics, and a bounded container baseline. Release-registry
   signing remains in step 8.
4. **Complete for the first-release foundation.** Ship the Compact Compose
   package and prove install, restart, same-image replacement, backup, clean
   restore, exact state comparison, and hostile configuration against the
   production image. Cross-version upgrade and rollback remain a release gate
   when two released images exist.
5. **Complete.** Ship External-storage Compose and run the multi-process Postgres
   and S3 suite through the production image. The package now proves two
   replicas, cross-replica conflict control, complete application replacement,
   secret-file configuration, no local durable mounts, provider failures, and
   a bounded read baseline.
6. **Complete.** Ship the Helm chart and pass the multi-replica migration,
   rollout, failure, recovery, observability, and performance gates in a
   disposable cluster.
7. **Next.** Add compact-to-external-storage export and import, then prove one installation can move
   from the Compose package to the Helm package without changing IDs or bytes.
8. Publish signed release artifacts and add the common CLI wrapper around the
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
2. Prove the Caddy two-domain TLS configuration on a private network and a
   public server, then record the requirements for equivalent proxies.
3. Define the minimum S3-compatible operation and consistency matrix required
   for a provider to be supported.
4. Choose the self-hosted browser-login baseline when WorkOS is not configured.
5. Define recovery-point and recovery-time targets after the backup procedures
   have measured evidence.
6. Choose and publish the source and binary distribution license before a
   public release. The repository does not yet contain a license file.
