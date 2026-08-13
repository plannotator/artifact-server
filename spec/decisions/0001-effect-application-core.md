# Decision 0001: Use Effect in the application core

Status: accepted for the local foundation

## Decision

Artifact Server uses Effect for application services, expected failures,
dependency composition, and owned resource lifetimes.

HTTP remains a Hono adapter. SQLite and the local filesystem remain concrete
outbound adapters. Zod remains at the existing HTTP and persistence boundaries
until replacing a particular parser produces a clear domain-type benefit.

One `ManagedRuntime` is created for each Artifact Server installation. HTTP,
MCP, CLI, and later Plannotator entry points run the same application effects
through that runtime. Disposing the runtime releases installation resources.

The repository pins one exact Effect v4 release-candidate version. Upgrades are
intentional changes that must pass the complete iteration verification gate.

## Initial migration boundary

The first migration covers the complete publishing capability:

- inline publication;
- staged upload creation, file verification, and commit;
- idempotent publication and optimistic version conflicts;
- application-owned ports for publication persistence, blob storage, staging,
  time, and identifiers;
- translation from typed application failures to existing HTTP responses; and
- SQLite resource cleanup through the managed runtime.

Content delivery remains on the existing repository and blob adapters during
this migration. It already has a narrow read-only path and does not justify
changing the HTTP transport, storage implementation, and application runtime in
one step.

## Adapter reuse audit

The following implementations were reviewed and remain in use:

- `SqliteArtifactRepository` for installation metadata and transactions;
- `LocalBlobStore` for immutable content-addressed files;
- `LocalStagingStore` for uncommitted uploads;
- `SystemClock` and `SystemIdGenerator` for local runtime capabilities; and
- `createHttpApp` as the Hono inbound adapter.

The migration adds an Effect adapter layer around these implementations. It
does not create alternative repositories or storage implementations. The layer
classifies thrown adapter failures before they enter the application error
channel.

## Error boundary

Expected product failures are distinct tagged values without HTTP status
codes. Application service signatures name the failures they can produce.
Inbound adapters map those tags to protocol-specific responses. Unexpected
adapter failures become typed storage or repository failures with a safe
operation name and an unexposed cause.

Defects remain defects. Examples include an impossible manifest/source mismatch
created by trusted application code and corrupted state returned after a
successful transaction.

## Deliberate exclusions

This decision does not:

- replace Hono with Effect HTTP;
- replace every Zod schema at once;
- replace SQLite with Effect SQL;
- change persisted records, public JSON, URLs, status codes, or cache behavior;
- add retries around non-idempotent writes; or
- use Effect's built-in MCP HTTP transport as the Cloudflare baseline.

The primary MCP route must remain stateless and horizontally scalable. Its
transport will be selected separately while its tool handlers use the same
Effect application services.

## Verification

The migration is accepted only when:

- all existing conformance and hostile-path tests pass unchanged at the public
  boundary;
- direct application tests assert typed failures instead of rejected promises;
- TypeScript and Oxlint pass without weakened rules;
- build and coverage gates pass; and
- the bounded local smoke and performance workloads show no critical regression.
