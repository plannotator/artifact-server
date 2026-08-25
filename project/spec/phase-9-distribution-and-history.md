# Phase 9: cloud distribution, Agent Skills, and optional Git history

Status: partially implemented; client distribution, optional Git, server-operation skill routing, and full cloud release gates remain open

This phase turns the working Artifact Server backend into a product that agents
can use and teams can install in their chosen environment. It covers four
tracks:

1. Cloudflare-native deployment.
2. AWS and GCP installers, with Azure using Helm on AKS.
3. Agent Skills for publishing and operation.
4. Optional private Git handoff.

The tracks share product contracts, but they do not ship as one release.
Cloudflare adds a new runtime and new storage adapters. The direct-cloud
installers reuse the existing external-storage runtime. Git history is an
optional background copy. The unified skill exposes each route when the commands
that route describes are stable.

## Decisions

### Keep one product core

The artifact, project, version, authorization, HTTP, MCP, manifest, comparison,
and audit behavior does not change by deployment. Provider code implements the
existing repository, blob, staging, identity, background-work, and telemetry
ports. Provider SDK types do not enter application or protocol types.

### Keep infrastructure tools outside the server runtime

Alchemy and Pulumi belong to deployment packages. They are not production
dependencies of the direct local package, server image, HTTP process, or MCP
server.

Operators use each deployment tool directly. Cloudflare uses the pinned
Alchemy project. AWS and GCP use pinned Pulumi projects. Kubernetes, including AKS,
uses Helm, one-server installs use Compose, and local use runs the direct
package. Artifact Server supplies shared configuration, output, evidence, and
product-probe contracts; it does not hide infrastructure plans behind an
`artifactserver deploy` wrapper.

The exact handoff is
[`cloud-deployment-contract.md`](./cloud-deployment-contract.md).

### Ship one default managed-container path for AWS and GCP

The first official cloud installer does not create a Kubernetes cluster by
default:

| Cloud | Default application runtime | Records | Files |
| --- | --- | --- | --- |
| AWS | ECS Fargate | RDS PostgreSQL | S3 |
| GCP | Cloud Run | Cloud SQL for PostgreSQL | Google Cloud Storage |

Teams that already use Kubernetes install the existing Helm chart on EKS, GKE,
or AKS. Artifact Server does not ship a separate Azure installer. The preview
Azure Blob adapter can be configured for an AKS deployment but is not called
supported until a live Azure storage qualification passes. Creating and owning
a managed Kubernetes cluster is outside these packages.

### Ship one Cloudflare installation before shared hosted tenancy

The first Cloudflare package creates one Artifact Server installation in one
Cloudflare account. It proves the Worker, D1, R2, domains, WorkOS authorization,
backup, restore, and upgrade contracts without adding an installation-routing
control plane.

The shared artifactserver.com service is a later Cloudflare topology. It may
host many installations only after trusted installation routing and the tested
second-D1 or external-Postgres design pass `DEP-013` and `GATE-003`.

### Keep Git optional and non-authoritative

Artifact Server always commits the version record and immutable file bytes
first. Git receives a private background copy. Git cannot supply browser bytes,
authorize a request, change an artifact, or block publication.

### Keep publishing and operation in separate skill references

The `artifact-server` skill is one portable entrypoint. Routine artifact work
uses ordinary user permissions and routes through the MCP connection or
Artifact Server CLI. Local-file operations use the CLI because only a process
on the user's computer can read those files.

Explicit server-operation work loads a separate internal reference and uses
separately acquired administrator and infrastructure access. Routine artifact
requests do not load this reference or gain its permissions.

## Deployment lifecycle surface

Operators use the native lifecycle commands:

```text
Cloudflare:     alchemy plan | deploy | destroy
AWS/GCP:       pulumi preview | up | destroy
Kubernetes:    helm upgrade --install | rollback | uninstall
One server:    docker compose config | up | down
```

The package contract is:

- native preview performs no writes and shows resource, network, data, and
  cost-relevant changes;
- apply uses pinned package, provider, and image versions;
- an upgrade backs up durable state, applies compatible migrations, rolls the
  application, and runs health and product probes.
- rollback restores the previous application image only when its declared
  schema range accepts the current database. It never attempts an unsafe
  database downgrade.
- destroy preserves durable data by default. Permanent deletion requires a
  separate explicit option, a fresh backup result, and confirmation naming the
  installation.
- each lifecycle run writes redacted, machine-readable evidence and updates the
  installation support manifest.

Cloud credentials come from the provider's normal local login, CI identity, or
workload identity. Artifact Server does not copy long-lived cloud credentials
into its database, configuration files, generated project, support manifest, or
logs.

## Track A: Agent Skills

### A1. Ship authenticated CLI profiles and local-file publishing

MCP and the CLI expose overlapping artifact operations through the same
application services. Locality selects the adapter: the CLI reads files on the
user's computer; MCP or the CLI can be used when the operation needs only
server data. A remote MCP server never receives or dereferences a client
filesystem path.

The supported remote interactive setup is:

```text
artifactserver auth login https://team.example.com
artifactserver auth status
artifactserver auth logout
```

When browser authorization is available, login opens it and stores the
renewable credential in the operating-system credential store. Local mode uses
private user-only Artifact Server state without browser login or a visible
secret. A self-hosted server without browser authorization uses an
administrator-issued scoped key in the same secure profile boundary. CI uses a
service credential supplied by its secret manager.

The primary file operation is one command:

```text
artifactserver publish <path> --project <project>
```

The CLI validates and hashes one actual file or finished directory, follows the
server's upload plan, retries safe transfer failures, commits the version, and
returns the artifact and exact version links. Create, upload, and commit may be
separate internal requests, but the user and agent see one action. Any
short-lived upload address is bound to the declared upload and file and remains
an internal, redacted transfer detail. It is not an MCP bearer workaround.

Clients without local filesystem and process access can manage existing
artifacts but cannot publish a file that exists only on the user's computer.
The skill states this instead of pretending that a remote MCP server can read
the path.

### A2. Ship `artifact-server`

Location: `skills/artifact-server/`

Implemented in the repository. Public distribution and supported-client
release evidence remain gated until `plannotator/artifact-server` is published.
Format, local installer, repository-gate, and independent forward-test results
are recorded in `project/evidence/artifact-server-skill.json`.

The skill covers:

- choose the target from an explicit address or link, conversation state,
  project configuration, then the user's default;
- ask when the target remains ambiguous;
- use the CLI when a source or destination path is local, and use MCP or the
  CLI for server-only operations;
- call `artifact_capabilities` before choosing a server-supported upload path;
- publish or update one file or one finished directory;
- list projects and artifacts, open an artifact, change sharing, compare
  versions, restore a version, and manage tags;
- return the server, project, artifact ID, exact version ID, and browser link;
- route explicit installation, infrastructure, backup, restore, and repair work
  to the server-operation reference without loading it for routine artifact work.

The main `SKILL.md` stays short. Upload recovery, target selection, old-server
compatibility, and client-specific notes live in one-level-deep references.
The skill invokes the supported CLI rather than reimplementing file inspection,
authentication, hashing, streaming, or retry behavior in scripts. It never
writes credentials into a project.

### A3. Enable the server-operation route after deployment commands stabilize

Location: `skills/artifact-server/references/server-operations.md`

The server-operation reference covers local packages, Compact Compose, External-storage
Compose, Helm, Cloudflare, AWS, and GCP. AKS uses the Kubernetes reference. It
loads only the reference for the selected target. It always:

1. inspects the installed CLI and target;
2. validates current access and configuration;
3. produces a plan;
4. asks before a material infrastructure or data change;
5. applies through Compose, Helm, Alchemy, or Pulumi directly;
6. runs readiness, integrity, and product probes;
7. reports the evidence path and support manifest.

### Agent Skill release gate

- Validate the skill folder and each routed reference with the current Agent Skills reference validator.
- Test realistic prompts that must select each route and similar prompts that
  must not activate the skill.
- Run CLI-routed local-file publishing and MCP-routed server operations end to
  end in Codex and Claude Code against local and remote installations.
- Test browser login, renewal, logout, local automatic authentication,
  administrator-issued key fallback, CI service credentials, missing files,
  symlinks, changed bytes, expired upload instructions, exact retry after a
  lost response, altered retry, stale server versions, ambiguous targets,
  revoked access, and interrupted uploads.
- Confirm that no credential, temporary upload address, or local path enters
  model context, project files, process arguments, logs, traces, or results.
- Test server-operation plan, refusal, apply, failed health verification, and recovery
  on every advertised deployment.
- Version the skill with the server release and publish its compatibility
  range.

This track closes `CLI-001`, `CLI-002`, `SKL-001` through `SKL-006`, and
contributes to `MCP-019`.

## Track B: Cloudflare-native deployment

### Runtime shape

The first package provisions:

- one Worker script with a control-host route table for the application API,
  browser login, and `/mcp`;
- a separate content-host route table on a separate registrable content domain
  for public and account-required artifact responses;
- one D1 database for records, identities, sessions, upload state, actions, and
  migrations;
- one R2 bucket for staging and immutable content-addressed files;
- scheduled work for expired staging cleanup and retryable background jobs;
- WorkOS configuration for hosted browser and MCP authorization;
- Cloudflare logs, metrics, traces, alerts, and redacted support metadata;
- optional Cloudflare Artifacts bindings only when private Git history is
  enabled and the provider gate has passed.

The two host surfaces share the compiled application package, but their route
tables are separate. The content host does not mount management, login,
API-key, project-management, or MCP routes.

### New provider adapters

| Adapter | Required behavior |
| --- | --- |
| D1 repositories | Implement the same project, artifact, identity, session, upload, idempotency, action, and migration contracts as SQLite and Postgres. Use D1 transactions or transactional batches for state changes. |
| R2 blob and staging stores | Stream verified bytes, enforce installation-scoped keys, reject replacement of immutable fingerprints, and avoid the AWS SDK in the Worker bundle. |
| Worker runtime | Build one Effect runtime per isolate and reuse it across requests without storing caller identity in global state. |
| WorkOS verifier | Use Worker-compatible fetch and Web Crypto paths. Enforce exact issuer, resource-bound audience, expiry, subject, and installation membership. |
| Background work | Make cleanup and optional-history retries idempotent across Cron retries and concurrent Worker execution. |
| Telemetry | Export bounded OTLP signals or documented Cloudflare-native signals without authorization values, content, or raw artifact identifiers. |

### Alchemy package

Alchemy is the Cloudflare infrastructure adapter because it has typed Workers,
D1, R2, domain, secret, rollout, and state-store resources and follows Effect
patterns. It remains pre-stable, so the package must:

- pin one exact Alchemy version and Cloudflare compatibility date;
- keep Alchemy types inside `deploy/cloudflare`;
- generate a reviewable deployment project;
- exercise plan, deploy, gradual rollout, rollback, and destroy against a real
  Cloudflare account;
- record Alchemy and compatibility versions in the support manifest;
- decide and document where Alchemy state lives before release;
- decide whether Alchemy telemetry is acceptable, disabled, or replaced with
  an Artifact Server-owned state-store layer;
- keep a replacement path to the Cloudflare API or another infrastructure tool
  without changing Artifact Server product code.

The first release uses the customer or Artifact Server Cloudflare account as
the state boundary. Local Alchemy state is for individual development only, not
the supported team or CI deployment path.

### Cloudflare release gate

Run the complete product and hostile suite against real D1 and R2. Also prove:

- clean install, repeat install, preview, upgrade, compatible rollback, state
  recovery, backup, restore, and safe destroy;
- separate application and content domains, wildcard routing, TLS, cookies,
  redirects, hostile Host and Origin rejection, and cache separation;
- WorkOS browser and MCP login, refresh, revoke, reconnect, wrong audience, and
  cross-installation denial;
- upload behavior at measured Worker and R2 limits, interrupted upload cleanup,
  concurrent publication, and bounded memory;
- D1 contention, database growth, read replication behavior, backup, restore,
  and the measured threshold that triggers the second-database decision;
- public-cache purge, private no-store behavior, R2 outage, D1 outage, and
  partial deployment failure;
- cost and latency baselines at the same 1, 10, 25, 50, and 100-user workload
  used for the server runtime;
- core release succeeds with Cloudflare Artifacts disabled or unavailable.

This track closes `DEP-007`, `DEP-013`, `GATE-002`, `GATE-003`, and the
Cloudflare parts of `DEP-001`, `DEP-011`, `DEP-012`, and `GATE-009`.

## Track C: AWS and GCP installers

### Pulumi package shape

Use direct Pulumi TypeScript projects with separately pinned provider packages:

```text
src/deployment
deploy/pulumi/aws
deploy/pulumi/gcp
```

`src/deployment` defines shared TypeScript types and validation for Artifact Server
deployment inputs, outputs, evidence, naming, tags, secret handling, image
digests, health probes, and safe deletion. It is a library imported by the
two Pulumi projects, not a second command runner. Provider packages map that
contract to native resources and operators use `pulumi preview`, `pulumi up`,
and `pulumi destroy`.

Pulumi Cloud is optional. The supported customer-owned state path uses an
existing encrypted, versioned S3 or GCS backend in the customer's
cloud. The main stack does not create the store that contains its own state.
The operator selects it with `pulumi login`, chooses a secrets provider, uses
the cloud's standard credential chain, and records only the redacted backend
address. Each provider must test update locking, interrupted checkpoints, and
state recovery. A team may explicitly choose Pulumi Cloud instead.

### Provider scope

| Concern | AWS | GCP |
| --- | --- | --- |
| Runtime | ECS Fargate | Cloud Run |
| Database | RDS PostgreSQL | Cloud SQL for PostgreSQL |
| Files | Native S3 adapter | Native GCS adapter |
| Workload identity | IAM task role | Service account |
| Secrets | Secrets Manager or SSM | Secret Manager |
| HTTPS and wildcard content | Route 53, ACM, and provider ingress/CDN | Cloud DNS, Certificate Manager, and external HTTPS load balancer |
| Logs and OTLP | CloudWatch plus OTLP option | Cloud Logging plus OTLP option |
| State backend | S3 | GCS |

The provider package grants the application only the database, object, secret,
and telemetry permissions it needs. The application container uses no static
cloud access key. Exact shared inputs, provider-specific network inputs,
runtime configuration, outputs, and secret rules are defined in
[`cloud-deployment-contract.md`](./cloud-deployment-contract.md).

### Kubernetes option

For an existing EKS, GKE, AKS, or other Kubernetes cluster, use the released
Helm chart. The direct cloud packages do not create or modify a cluster and do
not wrap Helm. The operator supplies the chart with the existing Postgres,
object storage, workload identity, secret, DNS, TLS, and ingress values used by
that cluster.

Do not advertise installer-managed cluster creation until that exact option has
its own create, upgrade, node-loss, control-plane, backup, restore, cost, and
destroy evidence.

### Cross-cloud release gate

Each provider passes independently:

- credential preflight and least-privilege failure;
- plan with no writes;
- clean create and idempotent apply;
- publication, private and public delivery, MCP, projects, versions, tags,
  comparisons, and concurrent replicas;
- application upgrade, compatible rollback, migration failure, and provider
  state recovery;
- database backup, object backup, coordinated restore, and preservation of all
  installation, project, artifact, and version IDs;
- private-network and public-ingress configurations;
- workload-identity rotation and secret rotation;
- database, object store, DNS, and application outage behavior;
- safe destroy that removes the qualification installation without introducing
  physical deletion of committed artifacts as an application feature;
- bounded performance and cost evidence;
- generated SBOM, provenance, signatures, pinned provider packages, and a
  complete support manifest.

AWS ships first because the S3 adapter already has real provider evidence. GCP
ships after the native GCS adapter passes the storage contract. Azure users use
the independently qualified Helm path on AKS. The Azure Blob adapter remains
preview until it passes the storage contract against real Azure. Success on one
provider does not qualify another.

This track closes `DEP-008` through `DEP-012`, `GATE-007`, `REL-004`, and the
provider-specific parts of `DEP-001`, `DEP-014`, `DEP-016`, and `GATE-009`.

## Track D: optional private Git handoff

Implementation status (August 23, 2026): the first slice has a Node
configuration, durable provider-identity, read-only REST availability, and
HTTP/MCP discovery foundation. It defaults to `off`, keeps optional Git out of
readiness, rejects malformed or direct-secret configuration without disclosing
credentials, prevents silent account/namespace changes, and classifies live
provider availability without creating repositories. Cloudflare binding
composition, the project switch, mirror provider calls, and all conformance
evidence remain open.

### Core model

Add a history outbox to the authoritative database. Deployment configuration
makes a provider available; it never selects data. Every project's durable Git
history switch defaults to off. When the provider is non-off and a project is
enabled, the version transaction records one
pending history job only after all primary bytes are durable. While either is
off, publication records no mirror job; later project enablement discovers
unmapped versions through reconciliation. A worker claims the job, copies the
exact manifest, writes one commit, and records the provider, repository
identifier, commit identifier, copied-byte count, attempt count, and result.

The mapping is unique by installation, project, artifact, and version. A retry
returns the existing commit mapping or safely creates the same logical commit.
Provider failure changes only history status. It cannot change publication,
the current-version pointer, browser delivery, comparison, or access.

The installation configuration is explicit and off by default. The initial
accepted values are `off` and `cloudflare-artifacts`; there is no `auto` value.
An administrator requests a repository/version/operation/byte planning
estimate before enabling one project. The estimate is computed on demand and
is not persisted as a receipt. There is no installation-wide mode or automatic
enablement for future projects. The project switch uses the normal
authorization rules, and setting it to its current value is a no-op over HTTP
or MCP.
Bounded reconciliation then enqueues every unmapped version in the selected
project oldest-first per artifact. Disabling a project or provider stops
applicable mirror work without deleting repositories or durable state, and
re-enabling the same project and provider resumes. Replacing a provider,
account, or namespace after repositories exist requires a separate migration
and is not inferred from a configuration edit.

### Repository layout

Use one private repository per artifact, including single-document artifacts,
matching the current product specification. Projects remain organizational
containers; a project checkout command aggregates independent repositories as
sibling folders instead of creating a project repository. Each commit contains:

- the version's copied files selected by deterministic per-file and per-version
  limits snapshotted on the history job;
- `.artifactserver/version.json` with installation, project, artifact, version,
  manifest fingerprint, entry path, creation time, and copied commit metadata;
- manifest entries for large or excluded files with path, media type, size, and
  SHA-256 fingerprint, but not their bytes.

Commit metadata contains Artifact Server identities, not untrusted commit
messages supplied by artifact content. Repositories and credentials remain
private. Public artifact access never exposes a Git URL or commit identifier.
An optional logical copied-byte budget reserves capacity atomically before a
provider write. Reaching it pauses mirror work in `budget-limited` without
changing publication or readiness.

### Provider order

1. **Off:** the default on every deployment. It loads no Git implementation,
   binding, or credential and makes no provider request.
2. **Cloudflare Artifacts:** the first managed adapter and the only non-off
   value in the first Git handoff slice. Cloudflare deployments use the Worker
   binding; other runtimes use the REST control plane. Both write commits over
   Git smart HTTP. Every installation environment uses one exclusive persisted
   account/namespace identity. The adapter has no namespace-delete or
   account-wide delete operation. Ship and advertise it only after the bounded
   live provider gate.
3. **Local disk:** a future offline adapter and conformance reference. Decide
   its embedded-versus-system-Git mechanics when it enters scope; its name is
   not accepted merely because the design is recorded here.
4. **code.storage and private Git remote:** future managed and
   administrator-supplied adapters. Re-probe their current APIs, authentication,
   limits, pricing, and recovery behavior before freezing either contract.

The provider interface exposes repository creation, exact-version commit,
mapping lookup, health, and deletion. It does not expose arbitrary Git hosting,
branches, pull requests, user pushes, or source repository management.

### Git release gate

- Run with history disabled, enabled, misconfigured, unavailable, slow, and
  restored from backup.
- Configure the provider with projects present and prove it copies nothing.
  Estimate and enable one project without touching another; prove that existing
  and future projects remain off until each is explicitly enabled.
- Interrupt bounded project backfill and resume it without duplicate or missing
  commits while new publishes run.
- Disable one project and the provider without deleting provider data or
  durable jobs, then re-enable the same project and provider and resume. Reject
  a provider-location replacement until an explicit migration has been
  performed.
- Plan an installation-wide purge without provider writes, require exact
  installation confirmation to apply it, and resume partial deletion without
  touching primary artifact data or the provider namespace.
- Prove publication returns before or independently of history completion.
- Inject a failure before and after every outbox and provider step.
- Retry concurrently and preserve one version-to-commit mapping.
- Test per-file and per-version copied/excluded bytes, job-snapshotted limits,
  and atomic logical-budget races; verify the manifest representation and
  `budget-limited` recovery.
- Verify public links, content sessions, unauthorized MCP requests, logs, and
  errors never expose Git credentials, remotes, earlier versions, or commit
  identifiers.
- Back up and restore outbox state, mappings, and provider repositories without
  making Git part of primary artifact recovery.
- Measure repository count, copy time, storage growth, worker memory, provider
  limits, and deletion behavior.
- Run Node REST and the remote Workers binding only in a dedicated
  `artifact-server-test-` namespace with explicit opt-in, a separate token,
  unique run prefixes, hard operation/storage bounds, and durable
  run-manifest-only cleanup. Prove another namespace is untouched.
- Prove every deployment remains supported with history disabled.

This track closes `GIT-001` through `GIT-014` and `GATE-004`.

## Build order

1. Add authenticated CLI profiles, finish the local-file publishing command,
   and ship `artifact-server` with locality-based routing.
2. Freeze the cloud configuration, output, evidence, and storage-provider
   contracts. Do not add a deployment wrapper.
3. Build the one-installation Cloudflare runtime with Git disabled.
4. Add explicit off-by-default Git configuration, the persisted per-project
   switch, on-demand estimate and budget accounting, the history outbox,
   project backfill/reconciliation, and separate provider/project capability
   states.
5. Add Cloudflare Artifacts as the first managed provider and pass its binding,
   REST, smart-HTTP, token, project-switch, estimate, budget, namespace, bounded live
   cleanup, backfill, disable, deletion, limit, and recovery probes before
   advertising it.
6. Build the AWS installer.
7. Add the GCS adapter and GCP installer.
8. Keep the Azure Blob adapter preview and document AKS through Helm.
9. Enable the `artifact-server` server-operation route after all operations it documents are stable.
10. Design the shared artifactserver.com Cloudflare control plane only after
    the one-installation target and D1 growth gate are complete.

Every step ends with the normal and hostile tests, a bounded performance run,
an updated support manifest, and conformance evidence. A provider or skill is
not advertised until its own gate passes.

## Current external constraints

- Alchemy currently exposes typed Cloudflare Workers, D1, R2, domains,
  rollouts, and remote state, but its current release line is pre-stable. Keep
  it pinned and isolated behind the Cloudflare deployment package.
- Alchemy has new AWS support, but it does not provide the same mature,
  supported AWS and GCP path. Pulumi remains the direct-cloud installer
  baseline. Reconsider only when one framework can pass both provider
  gates without weakening customer-owned state or lifecycle recovery.
- Pulumi supports customer-owned S3 and GCS state backends and
  provider-backed secrets encryption. The official packages use the Pulumi CLI
  directly. Automation API is not part of the initial deployment surface.
- Cloudflare Artifacts access is not universal. Its current documented limit is
  10 GB per repository and its published pricing requires Workers Paid, whose
  account-level minimum is $5 per month. Artifacts bills aggregate repository
  operations and stored bytes, with no per-repository fee. Artifact Server
  cannot require it for any deployment release.
- Agent Skills use the open folder format with `SKILL.md` and optional
  `scripts`, `references`, and `assets`. `allowed-tools` remains experimental,
  so security cannot depend on a client enforcing that field.

References:

- [Alchemy Workers and bindings](https://alchemy.run/cloudflare/compute/workers/)
- [Alchemy state store](https://alchemy.run/state-store/)
- [Alchemy privacy and telemetry](https://alchemy.run/privacy/)
- [Pulumi state backends](https://www.pulumi.com/docs/iac/concepts/state-and-backends/)
- [Pulumi secrets](https://www.pulumi.com/docs/iac/concepts/secrets/)
- [Cloudflare Artifacts](https://developers.cloudflare.com/artifacts/)
- [Cloudflare Artifacts limits](https://developers.cloudflare.com/artifacts/platform/limits/)
- [Cloudflare Artifacts pricing](https://developers.cloudflare.com/artifacts/platform/pricing/)
- [Cloudflare Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/)
- [Agent Skills specification](https://agentskills.io/specification)
