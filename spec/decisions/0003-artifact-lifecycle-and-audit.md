# Decision 0003: Complete the standalone artifact lifecycle before shared identity

Status: accepted for the local foundation

## Decision

The next implementation slice completes the standalone artifact lifecycle:

- list active artifacts with bounded keyset pagination;
- delete an artifact by creating a tombstone;
- retain every committed version and immutable blob after deletion;
- stop stable, exact-version, application, and previously authorized content
  access after deletion; and
- expose the artifact's immutable mutation history to principals that may manage
  that artifact.

The application service owns authorization and pagination contracts. SQLite owns
the atomic state transition. HTTP is only an adapter over those operations.

## Deletion contract

Deletion requires the artifact's current version ID and an idempotency key. The
repository performs these operations in one transaction:

1. confirm that the artifact is active and still has the expected current
   version;
2. set `deleted_at` without changing the current version or any version row;
3. insert an attributed `delete` action;
4. insert the idempotency result; and
5. return the persisted tombstone.

If the action or idempotency insert fails, the tombstone does not commit. An
exact retry returns the original tombstone. Reusing the key with different input
fails. A later delete with another key sees no active artifact.

The first release does not delete individual committed versions. It also does
not garbage-collect their blobs. A separate permanent-deletion policy must be
specified before physical removal exists.

## Listing contract

Artifact and action lists use opaque keyset cursors ordered by creation time and
ID. A page has a strict maximum size. The application asks authorization for the
principal's readable scope before querying persistence:

- admitted humans and principals with installation-wide read or management
  capability can list every active standalone artifact;
- a service principal with owned-artifact management capability can list only
  artifacts it owns; and
- an unscoped service principal is denied.

Deleted artifacts do not appear in normal lists. The deletion response is the
administrative tombstone record.

## Action history

Action history is management data, not ordinary artifact content. Only the
artifact owner, an installation administrator, or an explicitly capable service
principal can read it. Each record exposes its stable action ID, artifact and
version IDs, action kind, effective principal, human authorizer when present,
idempotency key, and creation time.

This is the artifact mutation history. Future installation-level actions such
as identity-provider connection changes may use a broader audit stream, but
they must preserve the same attribution fields and transactional rule.

## Identity boundary

This slice does not add human account storage, invitations, browser login, or
managed API-key issuance. Those capabilities require a real admitted-user
source. Creating a second local user directory only for API keys would conflict
with the shared identity design.

The configured local token remains the bootstrap credential for laptop mode.
Shared-server API keys, expiration, rotation, and revocation remain a later
identity-provider slice and must still map to the existing provider-neutral
`Principal` and authorization service.

## Verification

The slice is accepted only when real HTTP, SQLite, disk, and restart tests prove:

- bounded listing and cursor continuation without duplicates;
- exact idempotency and optimistic concurrency for deletion;
- deletion stops public, private-session, exact-version, and management access;
- committed versions and their blobs remain after tombstoning;
- no individual-version deletion route exists;
- deletion cannot commit when its action record cannot commit;
- action history is attributed, ordered, bounded, and management-only; and
- the complete iteration verification and performance gates pass.
