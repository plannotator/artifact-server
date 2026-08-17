# Welcome to the Artifact Server Cloudflare track

You own the first Cloudflare-native Artifact Server deployment. This work can
run in parallel with the AWS and GCP track because Cloudflare uses a
different runtime, database, file store, and infrastructure package. Both
tracks must implement the same product and deployment contracts.

Artifact Server stores finished websites and ordinary files. Each artifact
belongs to a project and keeps one stable identity. Publishing creates a new
immutable version. People and agents can open, list, compare, restore, tag, and
share those artifacts through the browser, HTTP API, CLI, or MCP. Artifact
Server serves finished files. It does not build source code or run an
artifact-specific backend.

## Your assignment

Build one complete Artifact Server installation in one Cloudflare account:

- one Worker application;
- D1 for records and migrations;
- R2 for staged uploads and immutable file bytes;
- separate application and content domains;
- WorkOS browser login and MCP authorization;
- scheduled cleanup and retry work;
- Cloudflare-native or OTLP-compatible operational signals; and
- a direct, pinned Alchemy project in `deploy/cloudflare`.

The first release is one installation for one person, team, or company. It
supports projects inside that installation. It is not the shared,
multi-installation artifactserver.com control plane.

Private Git history and Cloudflare Artifacts are not part of this assignment.
The Cloudflare release must work when optional Git history is absent or
unavailable.

## What already works

The repository already has the product behavior you must preserve:

- projects, artifacts, immutable versions, tags, comparison, restore, and
  sharing;
- HTTP, CLI, and modern stateless MCP operations;
- local and remote authentication foundations;
- SQLite and Postgres repositories;
- local disk and S3-compatible file storage;
- local packages, OCI images, Compose, and Helm;
- backup, restore, integrity checks, observability, smoke tests, and bounded
  performance tests; and
- a conformance ledger that distinguishes specified behavior from verified
  behavior.

Do not redesign these product rules for Cloudflare. Add Cloudflare adapters
behind the existing boundaries.

## Start here

Read these files in order:

1. [`../README.md`](../README.md)
2. [`artifact-server-product-spec.md`](./artifact-server-product-spec.md)
3. [`cloud-deployment-contract.md`](./cloud-deployment-contract.md)
4. [`phase-9-distribution-and-history.md`](./phase-9-distribution-and-history.md),
   especially **Track B: Cloudflare-native deployment**
5. [`conformance.yml`](./conformance.yml), especially `DEP-001`, `DEP-003`,
   `DEP-007`, `DEP-011`, `DEP-012`, `DEP-013`, `GATE-002`, `GATE-003`, and
   `GATE-009`
6. [`decisions/0001-effect-application-core.md`](./decisions/0001-effect-application-core.md)
7. [`decisions/0017-native-cloud-projects-and-storage-provider-boundary.md`](./decisions/0017-native-cloud-projects-and-storage-provider-boundary.md)

The repository uses Node.js 24, pnpm 10, strict TypeScript, Oxlint, and Effect
v4. Read `AGENTS.md` before changing code. Read `node_modules/effect/AGENTS.md`
before writing Effect code.

Run this before making changes:

```sh
corepack enable
pnpm install --frozen-lockfile
pnpm check
```

The complete pre-merge gate is `pnpm verify:iteration`. It requires Docker and
the repository's disposable Kubernetes test tools.

## Parallel responsibilities

The main development track owns:

- executable shared cloud input and output schemas;
- secret-output checks and common deployment evidence;
- `src/storage/object-storage-provider.ts`;
- the AWS Pulumi project; and
- the GCP Pulumi project, native GCS adapter, and preview Azure Blob adapter.

The Cloudflare track owns:

- `deploy/cloudflare`;
- the Worker entry point and Cloudflare runtime composition;
- D1 repositories and D1 migrations;
- the R2 blob and staging provider;
- Cloudflare routes, domains, schedules, and provider observability; and
- Cloudflare-specific tests and evidence.

Do not copy the shared cloud schemas into the Cloudflare package. The first
Cloudflare probe may begin from the written contract, but it must consume the
shared executable schema as soon as that package lands.

Changes to artifact behavior, HTTP routes, MCP tools, authorization policy,
shared storage ports, database concepts, or conformance wording require
coordination before implementation. Keep Alchemy and Cloudflare SDK types out
of application, HTTP, MCP, and artifact-model modules.

## Build order

### 1. Prove the Alchemy boundary

Create `deploy/cloudflare` as an isolated package. Pin the exact Alchemy
version and Cloudflare compatibility date. Prove, without deploying production
Artifact Server code, that the package can:

- produce a reviewable plan without provider writes;
- create a named development Worker, D1 database, and R2 bucket;
- use Cloudflare-backed Alchemy state for shared development and CI;
- emit the required secret-free deployment outputs;
- repeat the deployment without drift; and
- destroy compute while retaining durable data by default.

Use a dedicated development stage and resource prefix. Do not use a
Plannotator production or staging environment. Do not change DNS or create
billable resources outside the approved account and region.

### 2. Add the Worker runtime

Adapt the web-standard HTTP application to a Cloudflare Worker. Create one
Effect runtime per isolate and reuse it across requests. Never store caller
identity, authorization, or request state in module globals. Keep application
and content-host route tables separate.

### 3. Add R2 storage

Implement `ObjectStorageProviderFactory` with a typed R2 binding. Run the same
blob and staging contract used by S3. The adapter must stream bytes, verify
size and SHA-256, preserve immutable content-addressed objects, isolate the
installation prefix, reject hostile identifiers, fail closed, and clean up
interrupted uploads.

### 4. Add D1 repositories and migrations

Implement project, artifact, version, identity, session, staged-upload,
idempotency, action, and migration behavior with D1-native queries and
transactional batches. Do not translate Postgres SQL mechanically. Preserve
atomic publication, compare-and-swap version changes, retry safety, project
isolation, and stable IDs through backup and restore.

### 5. Add identity, scheduled work, and telemetry

Use Worker-compatible Web Crypto and fetch paths for WorkOS verification.
Enforce exact issuer, resource-bound audience, expiry, subject, and installation
membership. Scheduled cleanup and retry work must be safe under duplicate and
concurrent Cron delivery. Logs, metrics, and traces must not contain tokens,
cookies, file contents, raw artifact IDs, or raw unbounded paths.

### 6. Qualify the real deployment

Run the product and hostile suites against real D1 and R2. Prove installation,
repeat installation, upgrade, compatible rollback, state recovery, coordinated
backup and restore, provider outages, partial deployment failure, secret
rotation, and safe destroy. Physical deletion of committed artifacts is not
part of the initial product.

Run the same bounded 1, 10, 25, 50, and 100-user workloads used by the server
runtime. Record latency, throughput, memory, D1 contention and growth, Worker
and R2 limits, and estimated provider cost. Local emulators do not qualify the
Cloudflare release.

## First handoff checkpoint

The first review should contain only the Alchemy foundation:

1. the isolated `deploy/cloudflare` package;
2. exact dependency and compatibility-date pins;
3. validated shared inputs and secret-free outputs;
4. Worker, D1, R2, domain, and state-store resource definitions;
5. plan and configuration tests that make no cloud changes;
6. a deliberate real-account probe script with cleanup and evidence; and
7. a short record of Alchemy limitations, replacement boundaries, telemetry,
   and state recovery behavior found during implementation.

Do not combine the first checkpoint with D1 repositories, WorkOS, optional Git,
or the shared hosted control plane. The Alchemy foundation must be reviewable
and replaceable before product behavior is added.

## Definition of done

The Cloudflare target is complete only when:

- every required shared input and output matches
  `cloud-deployment-contract.md`;
- normal and hostile Cloudflare conformance tests pass against real services;
- application and content domains are isolated and use the correct cache and
  cookie behavior;
- D1 and R2 backup and restore preserve installation, project, artifact, and
  version IDs and exact file bytes;
- WorkOS browser and MCP authorization pass fresh, refresh, revoke, reconnect,
  wrong-audience, and cross-installation tests;
- bounded capacity and cost evidence has no unexplained warning;
- optional Git history is disabled and cannot affect the release;
- support data contains versions and resource identifiers but no secrets; and
- the evidence is recorded in `spec/conformance.yml` without claiming untested
  deployments.
