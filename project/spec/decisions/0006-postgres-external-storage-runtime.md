# Decision 0006: Postgres-backed external-storage runtime

Status: accepted for Phase 3B

## Decision

Artifact Server will keep two explicit runtime compositions:

- Local mode uses one process, SQLite, and local files.
- External-storage mode uses stateless application processes, Postgres, and one configured object-storage driver.

External-storage mode will use the existing application services and product ports. It will not add a second set of product rules. Postgres receives its own migrations, indexes, queries, and transaction behavior. S3-compatible storage continues to implement the existing immutable blob and staging ports.

The Postgres adapter is scoped by a trusted installation ID supplied when the server starts. Every table and every query carries that scope. Request input cannot choose a database, installation ID, bucket, or object prefix.

The first external-storage composition uses:

- `@effect/sql-pg` at the Postgres boundary;
- the official AWS SDK at the S3-compatible boundary;
- one Postgres connection pool per process;
- one S3 client per process;
- database migrations before the process reports ready;
- no committed data on application-process disk.

Local SQLite behavior remains unchanged. Postgres code does not pass through SQLite, and SQLite migrations are never run against Postgres.

## Transaction rules

- A publish, restore, access change, tag change, deletion, staged-upload commit, login-state exchange, member deactivation, or key rotation is atomic in Postgres.
- Row locks serialize changes to one artifact, login attempt, member, bootstrap, staged upload, or API key.
- An idempotency record and the state it describes commit in the same transaction.
- Blob upload may finish before the database transaction. A database failure may leave an unreferenced immutable blob, but it cannot leave a committed version pointing at missing bytes.
- Committed-blob deletion remains disabled.

## Startup and failure behavior

- Multiple processes may start together. Migrations are serialized by Postgres and are safe to run repeatedly.
- A process fails startup when it cannot connect, migrate, or verify required storage configuration.
- Losing one application process does not lose committed data.
- Losing Postgres prevents mutations from reporting success.
- Losing object storage prevents publication or delivery from reporting success.

## Phase 3B proof

Phase 3B is complete only when a pinned local integration environment proves:

1. Two application processes share one Postgres database and one MinIO bucket.
2. Either process can read data written through the other.
3. Concurrent publication through different processes produces one winner and one conflict.
4. Browser membership, sessions, and managed API keys work across processes.
5. Staged uploads may be created, uploaded, and committed through different processes.
6. Replacing both application processes preserves IDs, current pointers, records, and bytes.
7. A clean logical Postgres and object-store backup can restore those same IDs and bytes into clean storage.
8. Cross-installation database rows and object keys remain inaccessible.
9. The existing local SQLite suite still passes unchanged.

## Not proved by Phase 3B

This phase does not mark Kubernetes, AWS, Cloudflare, GCP, or the private-team release supported. Azure uses the Kubernetes path on AKS. It does not prove native AWS S3 or Cloudflare R2 behavior. Those targets must run their own provider and deployment checks after the external-storage runtime exists.

## Alternatives considered

### One SQL abstraction shared by SQLite and Postgres

Rejected. It would hide provider-specific locking, migrations, indexes, and failure behavior. The product contract is shared; the SQL is not.

### One Postgres row containing serialized SQLite state

Rejected. It would technically store data in Postgres while retaining a single-writer bottleneck and weak query behavior.

### Provider SDK types in application services

Rejected. Application services continue to depend on Artifact Server ports. Provider clients remain inside adapters and composition roots.
