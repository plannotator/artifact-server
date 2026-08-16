# Phase 8: project-scoped artifacts

Status: implemented; local and external-storage behavior verified

## Purpose

Add the accepted hierarchy to the working product:

```text
Artifact Server installation
└── Project
    └── Artifact
        └── Immutable version
```

This is a tenancy and organization change inside Artifact Server. It must not
change file bytes, version identity, browser isolation, deployment profiles, or
the rule that one installation represents one person, team, or company.

## Product boundary

This phase adds projects. It does not add:

- organizations or an organization switcher inside one installation;
- a separate Artifact Store or Namespace object;
- project-specific members, roles, or access-control lists;
- destructive deletion of a nonempty project; or
- the Plannotator connection itself.

Every new installation has one default project. Direct local commands use it
when the user does not name another project. Team deployments can create,
rename, list, and archive projects.

## Domain contract

Add one `Project` record with a stable ID, installation ID, name, creation time,
and optional archive time. Names are labels, not security boundaries, and do
not need to be unique. IDs remain stable when a project is renamed.

Every artifact records one project ID. Every operation that creates, lists,
reads, changes, compares, restores, deletes, audits, backs up, or restores an
artifact resolves that artifact through its installation and project. The
service must return the same not-found result for a missing artifact and an
artifact in another project or installation.

Project archive is reversible. An archived project rejects new artifacts and
new versions. Existing versions, public links, account-required reads,
comparisons, action history, backups, and restores remain available. Restore
means restoring an artifact version, not unarchiving the project. Project
unarchive is a separate project operation.

## Storage and migration contract

SQLite and Postgres receive the same logical schema change:

1. create the projects table with installation-scoped identity;
2. create exactly one default project for each existing installation;
3. add project identity to artifacts and every security-sensitive record or
   enforce it through a foreign-key path that cannot cross projects;
4. move every existing artifact and related record into the default project;
5. add composite foreign keys and indexes that make cross-project references
   invalid; and
6. advance the schema version only after the complete migration succeeds.

The migration preserves installation IDs, artifact IDs, version IDs, content
tokens, manifests, fingerprints, action IDs, tags, access settings,
links, and file bytes. It is transactional and repeat-safe. A failed or
interrupted migration cannot leave a partially project-scoped database.

Blob storage does not move. Files remain under the existing installation
boundary in the local filesystem, S3, or R2. Project is record and policy
scope, not a bucket-per-project layout.

## Application and authorization contract

Add one project service for create, list, get, rename, archive, and unarchive.
Artifact services accept a resolved project identity instead of trusting a raw
client value. The authorization service first verifies installation identity,
then verifies that the project belongs to that installation, then evaluates the
membership or capability rule.

The same application services must be used by HTTP, MCP, CLI, lifecycle tools,
backup, restore, integrity checks, and the later Plannotator integration. No
entry point may perform its own weaker project check.

API keys continue to belong to an installation. A key with artifact access can
act in any project in that installation, subject to its existing capabilities.
This phase does not add per-project credentials or project access-control lists.

## HTTP, MCP, and CLI contract

The HTTP API exposes project creation, listing, reading, rename, archive, and
unarchive. Artifact list and publish operations take project context. Existing
artifact and version IDs remain stable. Browser content links remain stable and
resolve the owning project from the committed version record.

MCP discovery explains the hierarchy in plain language. MCP exposes project
listing and project management, and every publish or list call returns the
selected project ID with the artifact and version IDs. When one default project
is the only project, an agent may omit the project and the server selects that
default. When several active projects exist, an omitted project on a create or
list operation returns a short error that names the available projects instead
of guessing.

`artifactserver publish` accepts an explicit `--project <id>` option. When the
caller omits it, the server selects the only active project. Local first-run use
therefore continues to work without a project setup step. Persisting a preferred
project in client connection state is a separate usability improvement, not a
requirement of this phase.

## Backup, restore, and observability contract

Backups include projects, project archive state, and artifact project IDs.
Restore preserves every project and reference. A
restore into a nonempty installation must reject project, artifact, or version
identity conflicts instead of merging them silently.

Integrity checks verify that every artifact and security-sensitive child record
resolves to one project in the same installation. Project operation traces and
artifact action records include the stable project ID as structured context.
Aggregate HTTP metrics and sampled request logs keep bounded route, method,
protocol, and status attributes; project names and IDs do not become unbounded
metric labels.

## Implementation order

1. Add project domain types, IDs, errors, services, and repository contracts.
2. Add SQLite migration and repository behavior, including populated-database
   migration tests.
3. Thread resolved project identity through publishing, staged uploads,
   idempotency, content sessions, management, comparison, and audit.
4. Add project HTTP routes and update the file-first client and CLI project
   option.
5. Add MCP project discovery and tools through the same application services.
6. Add the equivalent Postgres migration and external-storage repository
   behavior.
7. Update backup, restore, integrity, support, and transfer surfaces.
8. Run the complete local, external-storage, package, Compose, Kubernetes, and
   bounded capacity gates.

Each step keeps the repository buildable and tested. HTTP and MCP are not
updated before the application and repository checks exist.

## Required proof

The phase is complete only when:

- a new local and external-storage installation has one stable default project;
- populated SQLite and Postgres installations migrate without changed IDs,
  links, records, or bytes;
- two projects can contain artifacts with isolated lists, uploads, reads,
  comparisons, mutations, idempotency keys, sessions, and audit records;
- every hostile cross-project and cross-installation test returns no existence
  signal;
- project archive and unarchive follow the stated lifecycle;
- local publish remains zero-setup;
- HTTP, MCP, and CLI produce the same authorization result;
- backup and restore preserve project identity;
- the bounded 1, 10, 25, 50, and 100-user capacity run shows no new gross
  regression; and
- `pnpm verify:iteration` passes without weakened lint, type, conformance, or
  runtime tests.

The controlling requirements are `PRJ-001` through `PRJ-004` in
`spec/conformance.yml`. The accepted product decision is ADR 0015.

## Implementation result

The application, SQLite, Postgres, HTTP, MCP, CLI, file-first client, integrity,
backup, restore, and migration paths now use the project model. Populated
SQLite and Postgres upgrades, hostile project isolation, archive and unarchive,
local packaging, both Compose profiles, external-storage performance, bounded
capacity, and live Kubernetes/Helm gates passed on August 14, 2026.

The final gap audit also proves that an exact idempotent publish retry survives
project archive, unscoped service keys cannot enumerate projects, Postgres
rejects a current-version pointer to another artifact or project, integrity
checks cover project-owned action, retry, upload, and content-session records,
the real CLI selects an explicit project, and an external-storage backup keeps
the stable ID and archive state of a named project.

The conformance ledger deliberately records `PRJ-001` through `PRJ-004` as
`behavior_verified`, not `verified`. The implementation is complete, but the
ledger will not claim every deployment as release-verified until each required
project acceptance test has deployment-specific evidence.
