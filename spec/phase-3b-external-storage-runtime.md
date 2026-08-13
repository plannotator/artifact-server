# Phase 3B: external-storage runtime acceptance plan

This file is the implementation checklist for Decision 0006. The conformance ledger remains authoritative for product requirements.

## Persistence

- [x] Postgres has provider-specific, numbered migrations.
- [x] Artifact, version, manifest, tags, actions, idempotency, staged upload, private-content session, membership, browser session, login attempt, and API-key records are installation-scoped.
- [x] Postgres implements every persistence operation currently required by the application layer.
- [x] Expected concurrency conflicts remain typed product failures.
- [x] Database connections, URLs, and credentials are acquired and released by one composition root.

## Runtime

- [x] External-storage configuration is parsed once at startup.
- [x] The external-storage runtime selects Postgres plus S3-compatible storage without changing application services.
- [x] Local SQLite plus local files remains the default local runtime.
- [x] Health does not report ready before migrations and provider checks finish.
- [x] Shutdown drains HTTP and disposes the database pool and S3 client.

## Real integration proof

- [x] Pinned Postgres and MinIO containers start with isolated test-only credentials and volumes.
- [x] Two independent application processes use the same installation.
- [x] Cross-process read, publish race, identity, managed-key, staged-upload, and restart tests pass through HTTP.
- [x] A second installation cannot read the first installation's database records or object keys.
- [x] Logical database and S3 object backups restore into clean storage with identical stable IDs and bytes.
- [x] Failed credentials and unavailable providers fail closed.

## Gates

- [x] External-storage runtime integration has its own required real-provider behavior matrix. Line coverage is measured by in-process tests, not inferred from uninstrumented child processes.
- [x] `pnpm verify:external-storage-runtime` passes.
- [x] `pnpm verify:object-storage` still passes.
- [x] `pnpm smoke` passes.
- [x] `pnpm verify:iteration` passes.
- [x] `pnpm audit --prod` reports no known production vulnerability.
- [x] Conformance status changes only where the recorded evidence proves the complete requirement.

## Evidence

- `evidence/external-storage-runtime.json`: nine real-provider tests, including compiled child processes and in-process coverage against the same Postgres and MinIO providers.
- `evidence/s3-minio.json`: the dedicated immutable and staged S3-compatible storage contract.
- `evidence/local-foundation.json`: the unchanged local SQLite and filesystem behavior suite.

These results complete Phase 3B. They do not mark a Kubernetes or cloud target
supported and do not satisfy requirements that apply to D1, native cloud blob
drivers, deployment automation, or partial-restore integrity scanning.
