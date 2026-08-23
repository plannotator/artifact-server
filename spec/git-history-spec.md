# Optional Git handoff and version history

**Status:** Accepted ([ADR 0026](./decisions/0026-cloudflare-artifacts-configurable-git-handoff.md)); implementation underway — Node configuration, durable provider identity, a read-only REST availability probe, HTTP/MCP discovery, and the simple per-project enablement slice implement parts of `GIT-010`, `GIT-012`, `GIT-013`, and `GIT-014`; all acceptance evidence remains empty until the complete requirement behaviors pass (August 23, 2026)
**Date:** August 23, 2026
**Owner:** Artifact Server product engineering
**Companion documents:** [Product specification](./artifact-server-product-spec.md) ("Versions, comparisons, and optional Git"), [Phase 9 Track D](./phase-9-distribution-and-history.md), [Conformance ledger](./conformance.yml), [ADR 0026](./decisions/0026-cloudflare-artifacts-configurable-git-handoff.md)

## 1. What this adds and why

An operator may explicitly make a Git handoff provider available in deployment
configuration. It is off by default. The first managed provider is Cloudflare
Artifacts; it is never selected automatically and Artifact Server remains a
complete product on accounts and deployments where the provider is absent.
Provider availability is not consent to copy data. Every project has one
persisted Git history setting that starts disabled. A project administrator may
enable one project after reviewing an on-demand planning estimate. There is no
installation policy, inheritance, or mode that automatically enables future
projects. Only explicitly enabled projects are copied.

For an enabled project, every saved version of every artifact is
asynchronously copied into a private Git repository — one repository per
artifact — that a member can clone with a short-lived read token. Enabling a
project with existing versions schedules a bounded, resumable backfill of its
prior versions, oldest first per artifact, so a clone never silently presents
a forward-only history. Repositories are created lazily by their first history
job; selecting a provider or enabling an empty project creates none.

Git here is a **mirror, never truth**. The authoritative database and blob store remain the only source of publication, currency, comparison, and delivery; Git receives a private copy only after the primary version is durable, and a Git failure of any kind changes nothing but history status (`GIT-002`, `GIT-003`). Comparisons continue to use primary version manifests, never Git. History disabled is a first-class state on every deployment: the product starts, publishes, opens, and compares identically with the feature off, and the off state adds no Git dependency of any kind (`GIT-001`).

This spec elaborates [Phase 9 Track D](./phase-9-distribution-and-history.md) — the outbox model, per-artifact repositories, commit layout, provider interface, configuration transitions, and release gate. The day-one accepted configuration values are `off` and `cloudflare-artifacts`. `local`, `code-storage`, and `private-remote` are planned adapters, not accepted runtime values or advertised features until their own evidence exists.

## 2. Vocabulary

| Term | Meaning |
| --- | --- |
| Mirror | The optional private Git copy of an artifact's version history. Derived, deletable, reconstructible; never consulted by publication, delivery, or comparison. |
| Provider availability | Deployment configuration that makes one provider adapter usable. It never selects projects or creates repositories by itself. |
| Project setting | One durable on/off value deciding whether one project's versions are mirrored. Every project starts disabled. |
| Estimate | An on-demand, read-only planning summary shown before enabling one project. It is guidance over current inventory, not an invoice, account-usage reading, or durable authorization token. |
| History job | One outbox row: mirror one version, or delete one artifact's repository. Normal publishes in an effectively enabled project write it in the version transaction; project reconciliation writes an equivalent idempotent job for an older unmapped version. |
| Mapping | The durable record that one saved version corresponds to at most one Git commit (`GIT-002`). Unique per (installation, project, artifact, version). |
| Coordinates | The persisted identity of one artifact's repository: provider, repository name, remote URL, default branch. Persisted at creation because for some providers the `create` response is the only source of the remote URL. |
| Pointer entry | The manifest metadata (path, media type, size, SHA-256) recorded in the commit for a file whose bytes stay only in primary blob storage (`GIT-004`). |
| Copy limits | Operator-set per-file and per-version copied-byte bounds. A file or the deterministic excess over the version bound becomes a pointer entry instead of copied bytes (`GIT-004`). |
| Logical copied bytes | The conservative sum of file sizes copied into mapped commits, counting the bytes again for every version. It does not attempt to predict Git compression or provider deduplication. |
| Copy budget | An optional operator-set ceiling on logical copied bytes. Crossing it pauses new mirror writes in `budget-limited`; it never changes primary data or readiness. |
| Clone token | A read-scoped, expiring credential (≤ 1 hour) that lets an authorized member clone one artifact's repository. |
| Provider | One adapter behind the portable five-operation interface: repository creation, exact-version commit, mapping lookup, health, deletion. Clone access is a separate optional capability. |

## 3. Invariants

1. **Optional, private, explicit, and off by default** (`GIT-001`). There is no `auto` provider. Missing or wrong Git configuration cannot prevent starting, publishing, opening, or comparing. With the provider `off`, no Git library, binding, credential, or network dependency is loaded or used.
2. **Availability and selection are separate** (`GIT-012`). Configuring a provider creates no repository and copies no version. Every project defaults disabled. Enabling requires project-management authority, a visible planning estimate, explicit confirmation, and matching HTTP/MCP behavior. Writing the same on/off value again is naturally idempotent. No setting enables future projects.
3. **Mirror only, after durability** (`GIT-002`). For an effectively enabled
   project, the history job is queued in publish step 6 inside the version
   transaction after primary bytes are durable; the worker cannot see it until
   the version transaction commits. Backfill jobs target already committed
   versions. The browser link works before or independently of the recorded Git
   commit.
4. **At most one commit per saved version** (`GIT-002`). Retries and concurrent workers converge on one mapping; they never create conflicting mappings or change the primary version.
5. **Failure is contained** (`GIT-003`). A provider outage, misconfiguration, or push failure changes only history status and is retried separately. It never blocks, deletes, rolls back, or makes unavailable a saved version, and never corrupts committed database or blob records.
6. **Large files are represented, not copied** (`GIT-004`). Bytes above the per-file limit, the deterministic excess over the per-version limit, or provider-safe bounds stay in primary blob storage; the commit records their path, media type, size, and SHA-256. Excluded bytes are never silently omitted without that metadata.
7. **Public access never reaches Git** (`GIT-005`). A public link opens only the artifact's current content path. Git protocols, repository paths, commit identifiers, and earlier versions are unreachable from any public or unauthenticated session. History is strictly more than the current version, so public-link possession never qualifies for any history operation.
8. **Git is excluded from primary recovery.** Backup and restore of artifacts never depend on repositories; provider identity, project settings, outbox state, coordinates, mappings, and budget accounting are backed up as ordinary database rows, and a lost repository is rebuildable from primary storage. Estimates are derived and are not backed up.
9. **Project enablement produces complete history** (`GIT-008`). After an administrator enables a project, reconciliation inserts missing jobs idempotently for every existing version in that project. It works in bounded pages, runs behind foreground requests, and resumes after a crash.
10. **Disablement is reversible, not destructive** (`GIT-009`). Disabling one project or the provider stops the applicable claims and new mirror jobs but preserves repositories, coordinates, jobs, and mappings. Re-enabling the same project and provider resumes and reconciles. Remote deletion requires artifact deletion or an explicit purge operation.
11. **State is observable without becoming readiness** (`GIT-010`). Authenticated capability discovery separates provider state from project state and reports `budget-limited` when applicable. No optional Git state makes `/ready` fail, and no status contains a credential or credential-bearing URL.
12. **Permanent removal is explicit and resumable** (`GIT-011`). Disabling never deletes. Installation-wide remote deletion requires a separately invoked operator command with a read-only plan and installation-ID confirmation; partial deletion resumes safely and never touches primary artifact data or the provider namespace.
13. **Namespace identity is exclusive and immutable** (`GIT-013`). One installation environment uses one dedicated, persisted Cloudflare namespace identity. Requests, projects, artifacts, paths, and hostnames cannot select it. Once coordinates exist, a namespace change is `migration-required`. The adapter has no namespace-delete or account-wide delete operation.
14. **Cost is bounded before and during copying** (`GIT-014`). Project enablement requires an on-demand planning estimate and explicit confirmation. Per-file and per-version limits reduce copies to pointers, an optional logical copied-byte budget atomically reserves capacity, and reaching it pauses provider writes in `budget-limited` without changing primary behavior.

## 4. Repository model

One private repository per artifact, including when the artifact contains only
one document (ADR 0026 preserves ADR 0022's repository model). The artifact is
the independently versioned, shared, cloned, authorized, and deleted object; a
project is an organizational container. This boundary lets an artifact
tombstone delete exactly one repository, with no history rewrite and zero blast
radius to any other artifact. Cloudflare charges aggregate operations and
stored bytes rather than a per-repository fee, so a project repository would
not improve the dominant cost and would make lifecycle behavior worse.

- **Name:** the artifact identifier verbatim — `art_<uuid>` (the `art_` prefix is already part of the identifier). Lowercase hex, hyphens, and one underscore satisfy every supported provider's repository-name charset. The live provider harness may prepend its trusted run prefix; production requests cannot supply a prefix.
- **Branch:** `main` only. No other branches ever exist.
- **Tags:** one lightweight tag `v/<versionId>` (e.g. `v/ver_2f6c…`) per mapped commit.
- **No `current` ref.** Currency is the API's authority (the conditional current-version pointer); restore-to-earlier-version makes currency non-monotonic, so a `current` ref would need force-updates and could contradict the database. A clone answers "what is current" only through the API, never through Git.

### Commit contents

Each commit's tree holds exactly:

- the version's files at or below the copy limit, at their manifest paths;
- `.artifactserver/version.json` — installation ID, project ID, artifact ID, version ID, version number, manifest digest, entry path, version `createdAt`, and the publishing principal ID. Artifact Server identities only; no value supplied by artifact content ever appears in commit metadata, messages, or this file beyond the manifest paths themselves;
- `.artifactserver/pointers.json` — one pointer entry per excluded file: path, media type, size, SHA-256. No bytes (`GIT-004`).

Copy selection is deterministic: inspect manifest entries in canonical path
order, copy a file only when it is at or below the per-file limit and its bytes
fit within the remaining per-version limit, and write every other file as a
pointer entry. Provider-safe bounds may only make this stricter — on Workers,
where pushes are assembled in memory, more than 500 copied files also degrades
the deterministic excess to pointer entries rather than failing the job. The
default 50 MiB per-version limit is the Worker memory-safety boundary; it is not
a Cloudflare repository limit.

### Commit identity

- **Parent:** the mapped commit of the artifact's previous version (the first version has no parent). Versions are serialized per artifact by the existing `expectedCurrentVersionId` discipline, so the parent is always known.
- **Author and committer:** one fixed deterministic identity ("Artifact Server"); the publishing principal is recorded in `version.json`, not in Git author fields.
- **Timestamps:** the version's `createdAt` for both author and committer dates.
- **Message:** a fixed template over Artifact Server identifiers only (version number and version ID).

Deterministic identity, timestamp, parent, and tree mean a retried job recreates the same logical commit, which is what makes retry adoption (section 5) sound.

### Project checkout ergonomics

Per-artifact repositories do not require users to clone them one by one. The
member CLI exposes both:

```text
artifactserver history clone --project prj_<id> --artifact art_<id> [directory]
artifactserver history checkout-project --project prj_<id> [directory]
```

The project command pages through the project's provisioned repositories,
requests one short-lived read token at a time, and clones them into disambiguated
sibling directories with bounded concurrency. It writes
`.artifactserver/project.json` with project and artifact identifiers so an
agent can correlate local folders with the API. It does not create a canonical
project repository, Git submodules, a shared branch, or a new source of truth.
An unprovisioned artifact is reported in the final summary and does not make
another artifact's clone fail.

## 5. Outbox and mirror worker

### Outbox

When the provider is non-`off` and the project is effectively enabled, the
publish transaction (product spec, storage commit step 6) inserts one
`mirror-version` history job in the same transaction that creates the version.
If the transaction aborts, no job exists; if it commits, the job is durable
before any worker sees it (`GIT-002`). A provider health failure does not stop
job insertion; the job waits for recovery. While the provider or project is
disabled, publishing inserts no mirror job. Later re-enable finds those
unmapped versions through the same bounded reconciliation used for backfill
(`GIT-001`, `GIT-008`, `GIT-012`).

Storage sketch (SQLite dialect; Postgres and D1 mirror it, following each backend's existing migration mechanics):

```sql
CREATE TABLE git_history_provider_identity ( -- no credentials
  installation_id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  account_id TEXT NOT NULL,
  namespace TEXT NOT NULL,
  activated_at TEXT NOT NULL,
  UNIQUE (provider, account_id, namespace)
) STRICT;

CREATE TABLE git_history_project_settings (
  project_id TEXT PRIMARY KEY,
  installation_id TEXT NOT NULL,
  enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
  updated_by_principal_id TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;

CREATE TABLE git_history_repositories (   -- coordinates, one row per artifact
  artifact_id TEXT PRIMARY KEY,
  installation_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  repository_name TEXT NOT NULL,
  remote_url TEXT NOT NULL,               -- persisted from the provider create response
  default_branch TEXT NOT NULL,           -- always 'main'
  status TEXT NOT NULL CHECK (status IN ('provisioned','deleting','deleted')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;

CREATE TABLE git_history_jobs (
  id TEXT PRIMARY KEY,
  installation_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  artifact_id TEXT NOT NULL,
  version_id TEXT,                        -- null for delete-repository jobs
  kind TEXT NOT NULL CHECK (kind IN ('mirror-version','delete-repository')),
  file_copy_limit_bytes INTEGER,
  version_copy_limit_bytes INTEGER,
  maximum_copied_files INTEGER,
  copy_policy_digest TEXT,
  state TEXT NOT NULL CHECK (state IN ('queued','claimed','done','failed')),
  attempts INTEGER NOT NULL DEFAULT 0,
  lease_expires_at TEXT,
  last_error TEXT,                        -- classification only; never a credential or URL with one
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;

CREATE TABLE git_history_mappings (
  installation_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  artifact_id TEXT NOT NULL,
  version_id TEXT NOT NULL,
  repository_name TEXT NOT NULL,
  commit_id TEXT NOT NULL,
  attempts INTEGER NOT NULL,
  copied_bytes INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('recorded','deleted')),
  created_at TEXT NOT NULL,
  PRIMARY KEY (installation_id, project_id, artifact_id, version_id)
) STRICT;

CREATE TABLE git_history_budget_reservations (
  job_id TEXT PRIMARY KEY,
  installation_id TEXT NOT NULL,
  logical_bytes INTEGER NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('reserved','committed','released')),
  updated_at TEXT NOT NULL
) STRICT;
```

This is a contract sketch, not permission to duplicate persistence logic. The
SQLite, Postgres, and D1 repositories implement the same product operations
behind one port and preserve the repository's existing migration, backup, and
restore rules.

### Worker

A worker claims jobs **first in, first out per artifact** under a lease: at most one claimed job per artifact at any time, so the per-artifact repository has exactly one writer, matching the product's per-artifact version serialization. Job order per artifact equals version order. A claim is eligible only while its project is effectively enabled and the configured provider identity matches the persisted identity.

Every mirror job snapshots the copy limits and provider-safe file-count bound
that produced it. Retries use that snapshot even if deployment configuration
changes, preserving the deterministic tree and commit identity. A newly
reconciled version uses the current limits. Delete jobs leave the copy-policy
columns null.

Before any provider write, the worker calculates the deterministic copied-byte
count and atomically reserves it against the optional installation budget. The
check uses committed plus in-flight reserved bytes, so concurrent workers
cannot overshoot. If the next reservation does not fit, the job remains queued
and its project reports `budget-limited`; primary publication and readiness are
unchanged. A successful mapping converts the reservation to committed logical
bytes. A definitively abandoned job releases it, and confirmed repository
deletion releases the committed bytes recorded by that repository's mappings.

The first `mirror-version` job for an artifact creates the repository lazily
(idempotent; a name collision means an earlier attempt succeeded, and the
worker adopts the existing repository) and persists its coordinates before the
first commit. Coordinates must be persisted at creation: for some providers the
`create` response is the only source of the remote URL.

**Retry idempotency** (`GIT-002-F`):

1. A mapping row for this version already exists → the job is done; record nothing new.
2. The push is rejected as non-fast-forward → fetch the branch tip, read its `.artifactserver/version.json`; if the tip is this version, adopt its commit ID as the mapping. Otherwise fail the attempt and retry (the per-artifact single-writer rule makes any other tip a transient anomaly, not a merge problem).
3. Any other failure → increment `attempts`, back off with jitter, retry. Failure changes only history status; the version, its currency, and its delivery are untouched (`GIT-003`).

The mapping insert is unconditional on conflict-do-nothing semantics under its primary key, so two racing retries converge on one row.

### Provider port

The application-facing interface is exactly Track D's five operations; it exposes nothing resembling Git hosting.

```ts
export interface GitRepositoryCoordinates {
  readonly provider: GitHistoryProviderName;   // "cloudflare-artifacts" in the first shipped slice
  readonly repositoryName: string;             // the artifact id
  readonly remoteUrl: string;
  readonly defaultBranch: "main";
}

export interface GitHistoryProvider {
  readonly name: GitHistoryProviderName;
  /** Idempotent: a repository that already exists under this name is adopted, not an error. */
  createRepository(artifactId: string): Promise<GitRepositoryCoordinates>;
  /** Write one version as one commit (tree per section 4); returns the commit id. */
  commitVersion(request: CommitVersionRequest): Promise<{ readonly commitId: string }>;
  /** Read the mapped commit for a version from the repository itself (retry adoption, reconciliation). */
  lookupCommit(coordinates: GitRepositoryCoordinates, versionId: string): Promise<{ readonly commitId: string } | null>;
  health(): Promise<{ readonly healthy: boolean; readonly detail: string }>;
  /** Idempotent: an absent repository deletes successfully. */
  deleteRepository(coordinates: GitRepositoryCoordinates): Promise<void>;
}
```

Read-credential issuance for the clone surface (section 7) is a separate, optional companion port (`GitCloneAccessProvider.issueReadCredential(coordinates, ttlSeconds)`), so the mirror port stays exactly the five operations Track D fixes. A provider that cannot mint bounded read credentials simply does not implement it.

**Write credentials exist only inside the mirror worker.** Every provider adapter mints its push credential at **one single mint site** whose function signature requires explicit scope and TTL arguments — there is no default-parameter path. This guards a known provider footgun: Cloudflare's bare `createToken()` defaults to write scope and a 24-hour lifetime. Write credentials are minted per push, scoped to the one repository, with the shortest TTL the push needs.

## 6. Deletion

Artifact deletion already tombstones the artifact and stops all application
and origin access. Whenever persisted history coordinates exist, the tombstone
transaction also enqueues one `delete-repository` job even if the provider or
project is currently off. The job remains queued until provider access is
restored; project disablement does not prevent deletion work for an already
deleted artifact. An explicit purge can complete the same removal before the
provider is disabled permanently.

- The worker calls provider `deleteRepository`, marks the artifact's mappings `deleted`, and clears coordinates (`status = 'deleted'`).
- The job is retried until the provider confirms deletion. Deletion failure is invisible to the artifact deletion itself, which completed when the tombstone committed.
- Reconciliation is driven only by persisted Artifact Server coordinates and jobs. The product never sweeps the Cloudflare account or namespace. Atomic tombstone/job insertion, deterministic names, and idempotent repository creation let a crash resume without an account-wide list-and-delete operation.
- **Residual exposure window:** a clone token issued just before deletion keeps working until it expires. That window is exactly the read-token TTL, which is why clone tokens cap at one hour (section 7). No credential outliving the repository is ever minted.

Per-version deletion from history does not exist; committed versions are immutable and deletion is artifact-level only (section 11).

### 6.1 Installation-wide purge

Permanent removal is an operator action, not a side effect of configuration:

```text
artifactserver history purge --plan
artifactserver history purge --apply --confirm-installation ins_<id>
```

`--plan` reads only persisted repository coordinates and reports the provider,
installation ID, persisted account/namespace identity, repository count,
logical copied bytes, and already-deleted count. It makes no provider request
and reveals no remote credential. `--apply` requires the same non-off provider,
location identity, and credential family that owns the persisted coordinates,
plus an exact installation-ID confirmation. It deletes repositories in bounded
pages through the ordinary idempotent `deleteRepository` operation and marks
coordinates and mappings deleted only after the provider confirms absence.

The command is resumable: a partial failure exits nonzero with stable counts,
and the same invocation continues remaining repositories. It never deletes the
Cloudflare namespace, primary artifacts, versions, blobs, action records, or
backups. It is not exposed through HTTP, MCP, or the member web application.

## 7. Clone credential surface

One route plus one MCP tool.

| Surface | Contract |
| --- | --- |
| `POST /api/v1/projects/:projectId/artifacts/:artifactId/history/clone-token` | `201 { remote, defaultBranch, token, expiresAt }`. Token is read-scoped to exactly this artifact's repository, TTL ≤ 1 hour (requestable shorter, never longer). |
| MCP tool `artifact_history_clone_token` | Same inputs, same authorization, same shape — the HTTP/MCP parity rule applies. |

**Authorization, evaluated in order, entirely before any provider call:**

1. The caller is authenticated to the installation.
2. A service principal's key carries the read capability (`artifact:read`); a direct human member qualifies as a member.
3. The artifact exists in this project, is not tombstoned, and history is enabled and provisioned for it.
4. The caller's authority is **account-required read** — the same authority that may list versions. Public-link possession never qualifies (`GIT-005`): a public link opens only the current version, and history is strictly more than the current version.

Failures before step 3 disclose nothing about history existence; step-3 failures answer with the same not-found/unavailable shape whether history is off, unprovisioned, or the artifact is absent.

Day-one clone support:

| Provider | `remote` | `token` |
| --- | --- | --- |
| `cloudflare-artifacts` | smart-HTTP remote persisted from repository creation | explicit `read` token for exactly one repository, 15-minute default and 1-hour maximum |

Planned providers do not appear in capability discovery and are rejected as
configuration values until their provider conformance evidence is attached.

## 8. Providers

The provider contract is portable; the launch order is intentionally
Cloudflare-first. This is prioritization, not authority: no provider is allowed
to change the core version model or failure boundary.

### 8.1 `cloudflare-artifacts` — first shipped provider

- **Availability:** Cloudflare currently documents Artifacts as a beta that may
  require account access. The adapter ships in the first Git handoff slice but
  is off by default everywhere. Configuring it makes it available but enables
  no project. Absence of access produces `degraded` or `misconfigured`, never a
  product startup or publication failure (`GIT-003`, `GIT-007`, `GIT-012`).
- **Namespace:** one stable, pre-created, exclusive namespace per Artifact
  Server installation environment. The operator selects its jurisdiction when
  provisioning it. Artifact Server persists the account/namespace identity,
  creates and deletes repositories inside it, and never deletes or changes the
  namespace. Production, development, and the live test suite use different
  namespaces. A user's existing `workspaces` namespace is therefore outside
  this installation's route and cleanup boundary (`GIT-013`).
- **Control plane:** the Cloudflare runtime receives an `ARTIFACTS` Workers
  binding. Node runtimes use the documented REST API with an account ID,
  namespace, and secret-file API token. Runtime composition chooses the
  already-configured control plane; there is no `auto` provider selection. The
  adapter constructs one namespace-specific base URL at startup and its port
  exposes neither namespace deletion nor account-wide deletion.
- **Git data plane:** commits and clones use Git smart HTTP. Write credentials
  are minted for one repository and one push with explicit `write` scope and
  TTL. Clone credentials use explicit `read` scope and TTL. The adapter never
  relies on Cloudflare's wider default token scope or lifetime.
- **Documented limits as of August 23, 2026:** 10 GB per repository, 1 TB per
  account before an approved increase, 2,000 control-plane requests per 10
  seconds per namespace, and 2,000 Git requests per 10 seconds per repository.
  The service documents unlimited repositories and namespaces. Provider probes
  remain authoritative because beta behavior can change.
- **Documented pricing as of August 23, 2026:** Workers Paid only; the first
  10,000 operations and 1 GB-month are included, followed by $0.15 per 1,000
  operations and $0.50 per GB-month. Workers Paid has a $5 account-level monthly
  minimum. Storage is calculated across all repositories, and Cloudflare
  documents no per-repository fee, so one repository per artifact does not add
  a recurring repository charge. Provider cost is why project selection is
  explicit, estimated, and bounded and why large files become pointer entries.
- **Limit handling:** Artifact Server never attempts to solve a provider limit
  by changing primary bytes or IDs. Files above the configured copy bound stay
  in primary storage with pointer metadata. A repository at a hard provider
  limit becomes `degraded`; saved versions remain complete and available in
  primary storage.

Sources: [Cloudflare Artifacts](https://developers.cloudflare.com/artifacts/),
[authentication](https://developers.cloudflare.com/artifacts/guides/authentication/),
[Workers binding](https://developers.cloudflare.com/artifacts/api/workers-binding/),
[REST API](https://developers.cloudflare.com/artifacts/api/rest-api/),
[Git protocol](https://developers.cloudflare.com/artifacts/api/git-protocol/),
[limits](https://developers.cloudflare.com/artifacts/platform/limits/), and
[Artifacts pricing](https://developers.cloudflare.com/artifacts/platform/pricing/).
The account-level minimum comes from
[Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/).

#### Live Cloudflare qualification without account interference

Most conformance tests are hermetic: they use real application services, a
temporary database, temporary blob storage, real temporary Git repositories,
and a local real HTTP boundary, with no module mocks. A small end-to-end suite
is the only test allowed to use a person's Cloudflare account.

The live suite requires all of the following before it makes a provider call:

1. explicit opt-in through the test command;
2. a dedicated, stable namespace whose name starts with
   `artifact-server-test-` and is not configured by any development or
   production installation;
3. a separate revocable Artifacts Read/Edit token supplied through a secret
   file;
4. a generated run prefix used for every repository name, plus hard maximums
   of 8 repositories, 200 provider operations, and 16 MiB of copied bytes per
   control-plane run; and
5. a durable local run manifest written before and after each repository
   creation, containing only the namespace identity, run ID, repository names,
   and cleanup state — never the credential.

Cleanup deletes only repository names recorded in that run manifest through
the ordinary per-repository delete operation. It never lists-and-sweeps the
account, deletes a namespace, or touches a repository from another run. If
teardown fails, the command exits nonzero and prints the recovery-manifest path;
`pnpm cleanup:cloudflare-artifacts --manifest <path>` resumes only those
deletions. The same bounded scenario runs once through Node REST and once
through the Workers binding with remote execution enabled. Namespace isolation
also separates control-plane rate limits, but billing and account storage limits
remain account-wide and are called out in the test output (`GIT-013`,
`GATE-004`).

### 8.2 Planned adapters

`local`, `code-storage`, and `private-remote` remain valid future adapter
designs. They do not enlarge the first slice, do not appear in installer
choices, and do not count as supported because their names appear in a spec.
Each must receive a fresh provider probe and pass the same conformance ladder
before its configuration value is accepted (`GIT-006`).

## 9. Configuration

Provider infrastructure is installation-wide, operator-owned configuration and
takes effect on process restart or a new deployment. Project selection is
durable product state. This separation is intentional: credentials and hard
limits stay outside the application, while an installation administrator can
control which team data is copied without redeploying the server.

| Variable | Default | Rule |
| --- | --- | --- |
| `ARTIFACT_SERVER_GIT_HISTORY_PROVIDER` | `off` | First-slice values are `off` and `cloudflare-artifacts`. There is no `auto`. |
| `ARTIFACT_SERVER_GIT_HISTORY_COPY_LIMIT_BYTES` | `10485760` (10 MiB) | Per-file bound. Larger files become pointer entries. Must be a non-negative integer. |
| `ARTIFACT_SERVER_GIT_HISTORY_VERSION_COPY_LIMIT_BYTES` | `52428800` (50 MiB) | Per-version copied-byte bound. Deterministic excess becomes pointer entries. Must be a non-negative integer and cannot exceed the runtime's provider-safe bound. |
| `ARTIFACT_SERVER_GIT_HISTORY_STORAGE_BUDGET_BYTES` | unset | Optional ceiling on committed plus reserved logical copied bytes. Unset means no application-level budget; provider limits still apply. Must be a non-negative integer when set. |
| `ARTIFACT_SERVER_CLOUDFLARE_ARTIFACTS_NAMESPACE` | — | Required whenever the provider is enabled. Must name the pre-created, exclusive namespace configured for this installation environment. |
| `ARTIFACT_SERVER_CLOUDFLARE_ARTIFACTS_ACCOUNT_ID` | — | Required as part of the persisted provider-location identity. The REST composition also uses it in the base URL; the Cloudflare package supplies it as nonsecret binding metadata. |
| `ARTIFACT_SERVER_CLOUDFLARE_ARTIFACTS_API_TOKEN_FILE` | — | Required for REST and read through the repository's secret-file convention. The token is limited to Artifacts Read and Artifacts Edit on the configured account; it receives no DNS, R2, Workers, or unrelated account permission. A raw token environment variable is not accepted. |

The Cloudflare deployment package binds the namespace as `ARTIFACTS` and does
not accept the REST credential family. Node packages require the REST account
ID, namespace, and token file. A namespace, account, budget, or limit supplied
by an artifact, project, hostname, or request is never used to select or bound
provider storage.

On first provider activation, Artifact Server performs one read-only namespace
check and then atomically persists the nonsecret
`{provider, accountId, namespace}` identity only when that check succeeds.
Every later check reads and compares the persisted identity before making a
provider call. A mismatch reports `migration-required`; it never probes or
adopts the new namespace and never writes through both identities. A location
already claimed by another installation reports `misconfigured`. Changing a
copy limit affects only future
unmapped commits and estimates; immutable mapped commits are never rewritten.
Lowering the budget below already committed logical bytes immediately reports
`budget-limited` and permits deletion but no new mirror writes.

### 9.1 Validation and runtime states

- With `off` or with the variable absent, provider-specific values are ignored
  with a secret-safe warning. No binding, Git implementation, or credential is
  loaded and no provider request is made.
- With a complete Cloudflare configuration, the server starts normally and the
  provider moves from `checking` to `available`. It creates no repository and
  schedules no copy merely because the check succeeds.
- The Node REST availability check performs `GET` on exactly the configured,
  namespace-scoped Cloudflare REST base path with a three-second deadline. A
  successful Cloudflare envelope is `available`; authentication, authorization,
  missing-namespace, and other non-retriable 4xx responses are `misconfigured`;
  transport failures, timeouts, rate limits, 5xx responses, oversized bodies,
  and malformed success envelopes are `degraded`. The check is read-only and
  never lists, creates, changes, or deletes a repository.
- An unknown provider, missing companion value, unreadable token file, absent
  binding, failed access probe, or provider outage does not fail application
  startup or readiness. Git handoff reports `misconfigured` or `degraded`,
  provider calls stop or retry with backoff, and primary behavior continues.
- Error details name missing variable names or stable provider error codes but
  never tokens, credential-bearing URLs, or raw provider responses.

Authenticated session capability discovery and `artifact_capabilities` report
installation-level provider availability:

```json
{
  "gitHistory": {
    "provider": null,
    "providerState": "disabled | checking | available | degraded | misconfigured | migration-required",
    "limits": {
      "fileCopyBytes": 10485760,
      "versionCopyBytes": 52428800,
      "storageBudgetBytes": null,
      "logicalCopiedBytes": 0,
      "logicalReservedBytes": 0
    }
  }
}
```

`provider` is `cloudflare-artifacts` when explicitly selected, including while
degraded. Project Git history reads add this bounded projection:

```json
{
  "gitHistory": {
    "enabled": false,
    "state": "disabled | waiting | backfilling | ready | degraded | budget-limited"
  }
}
```

`waiting` means the project setting is enabled but the provider is off,
checking, or cannot
currently claim work. Artifact reads add `cloneAccess: true` only when that
artifact's repository is provisioned and the caller may request a token. These
fields contain no coordinates, commit IDs, raw queue contents, or secrets. The
optional provider never participates in `/ready`.

### 9.2 Estimates and administrator surfaces

Generating an estimate reads only authoritative manifests, existing mappings,
coordinates, the project setting, and configured limits. It makes no Cloudflare
request, persists no estimate receipt, and creates no repository or history
job. It returns:

```json
{
  "projectId": "prj_<id>",
  "repositories": 0,
  "versions": 0,
  "operations": 0,
  "estimatedCopiedBytes": 0,
  "estimatedPointerBytes": 0,
  "notice": "Planning estimate from current saved versions and configured copy limits. It excludes future activity, retries, clone traffic, Git compression, and other account usage; it is not an invoice."
}
```

`repositories` counts artifacts that would need lazy repository creation;
`versions` counts unmapped versions; and `operations` equals missing repository
creates plus unmapped version pushes. Clone/pull use, health checks, retries,
cleanup, and future publishes are explicitly excluded. Byte counts are a
conservative planning summary using the current per-file and per-version copy
limits; the worker remains the authority for exact deterministic selection.
The UI shows the notice next to the confirmation action.

An estimate requires a structurally valid configured provider. It may run while
provider availability is still checking or transiently degraded because it
reads only Artifact Server state; later mirror work waits for provider
availability. Off, misconfigured, and migration-required providers fail closed.
It is an on-demand preview, not a durable token or authorization grant.
Enabling carries an explicit `confirmEstimate: true`; the server applies the
current project setting, and the later reconciler always reads the actual
current inventory.

The browser calls the following HTTP operations; MCP exposes the same
application operations and result shapes:

| Intent | HTTP | MCP |
| --- | --- | --- |
| Read one project setting | `GET /api/v1/projects/:projectId/git-history` | `project_git_history_status` |
| Estimate one project | `POST /api/v1/projects/:projectId/git-history/estimate` | `project_git_history_estimate` |
| Enable or disable one project | `PUT /api/v1/projects/:projectId/git-history` | `project_set_git_history` |

The write body is either `{ "enabled": false }` or
`{ "enabled": true, "confirmEstimate": true }`. `PUT` plus the stored target
value makes retries naturally idempotent; there are no revision numbers,
estimate IDs, installation modes, or separate action ledger. The setting row
records the last effective principal and update time. Estimate and write
operations require project-management authority. Public links, content
sessions, ordinary members, and artifact-only service principals cannot use
them.

The Projects screen shows provider state and one Git history on/off control per
project. With the provider off or misconfigured, it explains that deployment
configuration is required and offers no enable action. Enable first loads a
fresh estimate, names the project, and requires confirmation. Disable states
that repositories and history are preserved and that permanent removal is an
operator purge, not a toggle. There is no installation-wide mode or inheritance
UI. Members see status but not enable/disable controls. `budget-limited`
explains that primary publishing still works.

### 9.3 Enable, disable, and backfill

Every existing or new project begins with Git history disabled. Enabling one
project requires the estimate confirmation described above. A bounded
reconciler then inserts missing
`mirror-version` jobs for that project using the same uniqueness key and worker
path as a normal publish. It processes versions oldest-first per artifact, is
safe to run concurrently with publishing, yields between pages, and resumes
after a crash. Project state remains `backfilling` until there are no unmapped
non-deleted versions or active mirror jobs for it.

Disabling a project stops new mirror-job insertion and new mirror claims for
that project but preserves its jobs, coordinates, mappings, repositories, and
budget accounting. Artifact deletion jobs remain eligible because they reduce
exposure and storage. Versions published while a project is disabled are found
by reconciliation after re-enable. Disabling never deletes remote data.

Changing back to `off` stops new `mirror-version` job insertion, provider calls,
and worker claims. It preserves existing jobs, coordinates, mappings, and
remote repositories and does not change project settings. An artifact deletion
still records a durable
`delete-repository` job when coordinates exist, but that job cannot call the
provider until it is re-enabled or an explicit purge runs. Versions published
in enabled projects while the provider is off are discovered by reconciliation
after re-enable. Merely changing `off` to `cloudflare-artifacts` verifies the
provider and resumes already-enabled project work; it does not enable another
project. Disabling is never interpreted as permission to delete remote data;
repository purge is a separate destructive operator workflow.

Changing directly between two non-`off` provider identities or changing the
account/namespace identity after coordinates exist is not supported in the
first slice. The server reports `migration-required`, makes no provider calls,
and continues all primary behavior. A future provider-migration command must
be specified and proved before that transition is allowed (`GIT-009`,
`GIT-013`).

## 10. Security

- **`GIT-005` probe posture:** from a public or unauthenticated session, every Git protocol path, repository path, commit identifier, and earlier version is unreachable — the probes of `GIT-005-F` receive no access, no existence disclosure, and no distinguishable timing between "no history" and "no permission" at the clone route. Public links, content sessions, unauthorized MCP requests, logs, and errors never expose Git credentials, remotes, earlier versions, or commit identifiers.
- **Credentials never appear in logs or errors.** The existing secret-safety patterns apply: job `last_error` stores a classification, not a raw provider response; remote URLs are logged without embedded credentials; tokens, JWTs, and signing keys never reach any log, error message, or client shape other than the clone-token response itself.
- **Untrusted content never becomes commit metadata.** Commit author, committer, message, and `version.json` are built exclusively from Artifact Server identities and identifiers (section 4). Artifact file contents influence only tree blobs and manifest paths.
- **Provider tokens never substitute for our authorization.** Possessing a clone token grants exactly one repository's read access for its TTL; every issuance re-runs the full section-7 ladder, and no Artifact Server surface accepts a provider token as authentication.
- **Write scope is caged:** write credentials exist only inside the mirror worker, minted per push at the single mint site with explicit scope and TTL (section 5).
- **Namespace isolation is routing defense, not credential isolation.** Cloudflare Artifacts Read/Edit API tokens are account-scoped. The separate namespace prevents naming, cleanup, and rate-limit collisions but cannot stop a stolen control-plane token from reaching other Artifacts namespaces in the account. Use a dedicated revocable token where Cloudflare account controls permit it, keep it in a secret file, and treat account credential protection as part of the deployment threat model (`GIT-013`).

## 11. Non-goals

- User pushes, branches, pull requests, or Git hosting of any kind — the provider interface cannot express them.
- Project- or installation-level canonical repositories, Git submodules, or a shared project branch. The bounded project checkout command in section 4 is a client aggregation over independent artifact repositories.
- A `current` ref (section 4).
- Serving artifact bytes from Git; Git never supplies files used to render an artifact.
- Git-based comparisons; comparison stays on primary manifests (`DIF` requirements).
- Public or anonymous history access, in any form (`GIT-005`).
- Per-version deletion from history; deletion is artifact-level only (section 6).
- Git LFS; the pointer-entry mechanism is this product's large-file representation.

## 12. Conformance and release gate

This spec keeps `GIT-001` through `GIT-007` and adds the configuration,
lifecycle, selection, isolation, and cost contracts `GIT-008` through
`GIT-014`:

| Requirement | Satisfied by |
| --- | --- |
| `GIT-001` | Sections 3.1, 9 (off by default, explicit provider, no `auto`, no Git dependency or request when off) |
| `GIT-002` | Sections 3.2–3.3, 5 (outbox in publish step 6, one mapping per version, retry convergence) |
| `GIT-003` | Sections 3.4, 5, 8.1, 9 (failure changes only history status, separate retry, degrade-not-error) |
| `GIT-004` | Sections 2, 4, 9 (per-file and per-version copy limits; pointer entries with path/media type/size/SHA-256) |
| `GIT-005` | Sections 3.6, 7, 10 (public access never reaches Git; probe suite posture) |
| `GIT-006` | Section 8 (only implemented and independently qualified providers become accepted configuration values) |
| `GIT-007` | Section 8.1 (Cloudflare Artifacts ships as the first managed adapter but remains optional and verified before reliance) |
| `GIT-008` | Sections 3.9, 9.3 (bounded, resumable, idempotent backfill when enabling an existing project) |
| `GIT-009` | Sections 3.10, 9.3 (project/provider disable preserves data, same-provider re-enable resumes, provider replacement requires migration) |
| `GIT-010` | Sections 3.11, 9.1 (separate provider/project capability states, no secrets, optional provider excluded from readiness) |
| `GIT-011` | Sections 3.12, 6.1 (explicit plan/apply purge, confirmation, resumability, no primary or namespace deletion) |
| `GIT-012` | Sections 1–3, 9.2–9.3 (provider availability is separate from one off-by-default project setting; estimate confirmation, authorization, natural idempotency, and HTTP/MCP parity) |
| `GIT-013` | Sections 3.13, 6, 8.1, 9, 10 (exclusive immutable namespace identity, namespace-scoped adapter, account-safe cleanup, bounded live suite) |
| `GIT-014` | Sections 2–5, 8.1, 9 (estimate, deterministic copy bounds, atomic logical budget, `budget-limited`) |
| `GATE-004` | This section (the probe, documented limits, and fallback behavior) |

**Acceptance ladder** (restating `GATE-004` and the Track D release gate as the order of proof):

1. With the variable absent and with `off`, prove identical primary behavior,
   no provider load or request, and a `disabled` capability shape.
2. Configure Cloudflare Artifacts with projects present. Prove the provider
   becomes `available` but no project changes, repository is created, job is
   queued, or byte is copied until a project setting is explicitly changed.
3. Estimate and enable one existing project. Prove the current-inventory
   planning summary, explicit confirmation, authorization, natural
   idempotency, HTTP/MCP parity, foreground readiness, bounded backfill, crash
   resume, and complete
   ordered history while concurrent new publishes continue. Prove another
   project remains untouched.
4. Create another project after enablement and prove it starts disabled. A
   repeated write of the same value leaves one setting and causes no extra
   provider work.
5. Disable one project during backfill and disable the provider while idle.
   Prove applicable calls stop, deletion work remains durable, remote data is
   not deleted, the core stays available, and same-project/same-provider
   re-enable resumes without duplicate commits.
6. Supply incomplete, invalid, inaccessible, slow, and unavailable Cloudflare
   configurations. Prove stable states and errors with no secret disclosure and
   no effect on `/ready`, publish, open, or compare.
7. Prove publication returns before or independently of history completion.
8. Inject a failure before and after every outbox, budget, and provider step; no
   injection changes primary records. Retry concurrently and prove exactly one
   version-to-commit mapping survives.
9. Publish above and below per-file and per-version copy limits and verify the
   deterministic copied-file and pointer representation. Race workers at the
   logical budget, prove they cannot overshoot, then prove `budget-limited`,
   budget increase, repository deletion, and resume without changing a saved
   version.
10. Run the `GIT-005` probe suite: public and unauthorized sessions receive no
   Git access or existence disclosure; logs and errors expose no credentials,
   remotes, commit IDs, or earlier versions.
11. Back up and restore provider identity, project settings, outbox, mappings,
    coordinates, and budget accounting, then rebuild a missing remote repository
    from primary storage without making Git part of primary recovery.
12. Run the bounded live suite through Node REST and the remote Workers binding
    in a dedicated `artifact-server-test-` namespace. Prove run-manifest-only
    cleanup and cleanup recovery, and record current access, pricing, limits,
    token behavior, Git compatibility, retention, jurisdiction, outage,
    deletion, and cost evidence. Prove the namespace configured for another
    project is untouched and absence of beta access leaves Artifact Server
    complete (`GIT-013`, `GATE-004`).
13. Plan an installation-wide purge with zero provider writes, reject a wrong
    installation confirmation and mismatched provider, then interrupt and
    resume apply until all repositories are absent while primary artifacts and
    the namespace remain untouched.

A provider is not advertised for a deployment until it passes this ladder (`GIT-006-F`).

## 13. Implementation slices

Implement in this order; each slice keeps the server runnable with the provider
off and lands its own normal and hostile tests.

1. **Configuration, identity, and discovery.** Add the provider union, Node REST
   secret configuration, Cloudflare binding composition, persisted provider
   identity, copy and budget limits, separate provider/project states, session
   capability, and MCP capability. Prove absent/`off` loads and calls nothing,
   configuring a provider enables no project, every malformed family degrades
   safely, and optional Git never joins readiness.
2. **Project setting and estimate.** Add SQLite, Postgres, and D1 persistence
   for one off-by-default project setting and an on-demand planning query. Add
   read, estimate, and set application operations with matching browser, HTTP,
   and MCP surfaces. Prove defaults, explicit confirmation, authorization,
   natural idempotency, new-project defaults, backup, and restore with real
   stores.
3. **Durable mirror core.** Add migrations for repository coordinates, jobs,
   mappings, and reservations; narrow application ports; conditional
   publish/delete job insertion; leasing; deterministic commit composition;
   atomic budget reservation; bounded project reconciliation; and
   backup/restore coverage. Prove crash and retry convergence using real
   temporary stores and real Git repositories without module mocks.
4. **Cloudflare Artifacts adapter.** Implement the Workers binding and REST
   control planes plus smart-HTTP commit writes. Enforce explicit token scope
   and TTL, a fixed namespace-specific route, secret-safe errors, copy limits,
   per-artifact serialization, provider backoff, and per-repository deletion.
   Build the bounded run-manifest live harness, then run the common suite against
   its dedicated namespace through both control planes.
5. **Member and operator surfaces.** Add the authenticated clone-token HTTP
   route and matching MCP tool, the single-artifact and project checkout CLI
   commands, and the operator-only purge plan/apply and live-cleanup commands.
   Exercise member, service-capability, public-link, wrong-project,
   unprovisioned-artifact, bounded concurrency, token-expiry, confirmation,
   interruption, and resume cases.
6. **Release proof.** Run the full transition matrix, repository-limit and cost
   baseline, provider outage and recovery, backup/rebuild, credential-leak
   scan, Cloudflare Worker runtime test, Node REST test, smoke test, and
   `pnpm verify:iteration`. Attach evidence to `GIT-001` through `GIT-014` and
   `GATE-004` before the provider appears in supported-installation docs.

## 14. Deferred decisions

These do not block the Cloudflare-first slice:

1. **Additional adapters.** The local implementation mechanism and fresh
   code.storage/private-remote API contracts are decided when those adapters
   enter scope, not guessed into the launch interface.
2. **Cloudflare-enhanced workflows.** Fork workspaces, push events, and
   build-on-push may become capability-detected additions after the portable
   read-only handoff passes its release gate.
3. **Provider migration.** Copying mappings between providers needs a separate
   recovery and cost specification before Artifact Server permits a non-`off`
   provider change. Purging one provider is specified in section 6.1, but it is
   not a migration.
