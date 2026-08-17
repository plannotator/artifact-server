# Conformance and release-status audit — 2026-08-16

Baseline: `2c8c1a5d34e8d26a2b21eb3dd15a4765d385fc93`

Audit branch: `audit/conformance-release-status`

This audit reconciles the executable ledger, acceptance-test names, checked-in
JSON reports, phase headers, README, and product proposal. It does not add
product behavior.

## Ledger result

| Status | Before | After | Change |
| --- | ---: | ---: | ---: |
| `specified` | 108 | 100 | -8 |
| `implementing` | 15 | 26 | +11 |
| `behavior_verified` | 69 | 61 | -8 |
| `verified` | 0 | 0 | 0 |
| `blocked` | 0 | 0 | 0 |
| `not_applicable` | 0 | 5 | +5 |
| **Total** | **192** | **192** | **0** |

No applicable requirement is fully verified. The 187 applicable requirements
remain open at `specified`, `implementing`, or `behavior_verified`.

## Deployment-proof coverage

Coverage means that both the behavior and failure IDs have passing evidence for
that deployment. The denominator fell where hosted-service policy candidates
were marked not applicable to the core OSS release.

| Deployment | Before | After | Change |
| --- | ---: | ---: | ---: |
| local | 53/123 (43.09%) | 38/122 (31.15%) | -15 proved; -1 applicable |
| single server | 7/165 (4.24%) | 7/164 (4.27%) | 0 proved; -1 applicable |
| Kubernetes | 2/166 (1.20%) | 2/165 (1.21%) | 0 proved; -1 applicable |
| Cloudflare | 4/171 (2.34%) | 1/166 (0.60%) | -3 proved; -5 applicable |
| AWS | 4/166 (2.41%) | 1/165 (0.61%) | -3 proved; -1 applicable |
| GCP | 4/166 (2.41%) | 1/165 (0.61%) | -3 proved; -1 applicable |

## Ledger representation defect

All 384 acceptance descriptions used YAML flow mappings without quoted values.
Commas in 233 records across 155 requirements were parsed as unexpected mapping
keys, silently truncating the executable description. For example, criteria
after the first comma in project, publishing, and content requirements were not
part of `description` at runtime.

Every description is now quoted. The validator rejects acceptance mappings
with keys other than `id` and `description`; it also rejects passing reports
that record failure, deployment-target mismatches, and lower statuses that
retain passing behavior evidence. Malformed acceptance records fell from 233 to
0.

## Promotions

| Requirement | Change | Evidence |
| --- | --- | --- |
| `ART-001` | `specified` → `behavior_verified` | `ART-001-B` passes in `evidence/local-foundation.json`; two intentional versions retain one artifact ID. No `ART-001-F` or all-deployment proof is claimed. |
| `DEP-014` | `specified` → `behavior_verified` | `DEP-014-B` passes in `evidence/cloudflare-phase11-content.json`; the live application and isolated content hosts had valid TLS. No hostile `DEP-014-F` or other-deployment proof is claimed. |
| `MAN-005` | `specified` → `implementing` | `MAN-005-F` passes locally, so `specified` was too low. The behavior test across every supported storage system remains absent. |

## Downgrades

| Requirement | Change | Exact missing proof |
| --- | --- | --- |
| `PRJ-001` | `behavior_verified` → `implementing` | Current test covers a default project, second project, and foreign-project rejection, not a team installation or forbidden organization/Artifact Store/Namespace surfaces. |
| `PRJ-002` | `behavior_verified` → `implementing` | Selected HTTP operations pass; the complete HTTP/MCP and key, idempotency, session, search, audit, backup, and restore isolation matrix does not. |
| `PRJ-003` | `behavior_verified` → `implementing` | Archive write rejection and retained public reads pass; membership, no-ACL, comparison, and all immutable-record invariants do not. |
| `PRJ-004` | `behavior_verified` → `implementing` | The acceptance-ID test is SQLite-only; it does not combine SQLite/Postgres preservation with interrupted, partial, repeated, and rolled-back migrations. |
| `MAN-001` | `behavior_verified` → `implementing` | Digest/path-order checks do not compare canonical manifest bytes or cover the complete missing-field and nondeterministic-ordering failures. |
| `MAN-002` | `behavior_verified` → `implementing` | Served bytes and selected headers pass; every committed manifest-entry field and `MAN-002-F` do not. |
| `CLI-001` | `behavior_verified` → `implementing` | Remote PKCE, refresh, status, and revoke pass; local automatic authentication, CI credentials, and all named leak surfaces are not one complete acceptance run. |
| `CNT-008` | `behavior_verified` → `implementing` | Local/live probes cover range, conditional, and HEAD behavior, not the full media type, `nosniff`, disposition, unsupported-method, misleading-extension, and active-unknown-file fixture. |
| `MCP-009` | `behavior_verified` → `implementing` | Read-only listing, publication denial, and one foreign list denial pass; the complete browser/HTTP/MCP matrix and every mutation denial do not. |
| `OPS-006` | `behavior_verified` → `implementing` | Cleanup selection failure evidence exists; no `OPS-006-B` run combines publication, a concurrent publish race, restore, restart, and time beyond staging expiry. |

The audit also removed unsupported failure-test proof without changing the
behavior-verified status of `ART-002`, `ART-007`, `PUB-009`, `DIF-001`,
`AUTH-004`, and `AUTH-014`. The corresponding behavior evidence remains. Test
and report titles no longer claim `AUTH-013-F`, `CNT-001-B`, `DEP-008-B/F`, or
`DEP-009-B/F` from probes that cover only a narrower route, fixture, capacity
plan, or mocked infrastructure graph. The executable test mapping therefore
changed from 133 to 107 acceptance IDs; this is removal of overclaims, not loss
of test behavior.

## Product-policy de-scope

`HOST-001`, `HOST-002`, `HOST-003`, `GATE-008`, and `GATE-009` are retained for
traceability with `not_applicable` rationales. Hosted quotas and spend controls,
malware/copyright/appeal operations, reputation handling, support tiers, legal
hold, regulated-enterprise controls, and universal cost envelopes are optional
artifactserver.com operator policy. They do not gate the simple OSS first
release and must not cause speculative product features.

`REL-003`, the README, and both product-spec forms now distinguish the optional
Cloudflare technical package from a future hosted-service operating policy.
Core isolation, authorization, bounded input, audit, and recovery requirements
remain in scope.

## Claims left open and genuine gaps

- `CNT-001` remains `specified`: the checked-in SPA fixture is not the required
  plain HTML, multi-page, compiled React, Vue, and Svelte matrix.
- `PUB-009` has behavior-only proof on local, Cloudflare, AWS, and GCP. No run
  proves the concurrent-commit protection in `PUB-009-F`.
- `ART-002-F`, `ART-007-F`, `DIF-001-F`, `AUTH-004-F`, and `AUTH-014-F` each
  name a broader hostile matrix than the current tagged test.
- `DEP-008`, `DEP-009`, and `GATE-007` remain open. Pulumi mock tests prove
  configuration and resource graphs, while selected live reports prove some
  lifecycle probes; neither is the complete signed create/upgrade/rollback,
  state, recovery, backup/restore, deletion, network-variant, and full product
  conformance required by the ledger.
- `evidence/gcp-minimum-recovery.json` explicitly records
  `applicationLevelRestoredStack: not_run`. The later Phase 11 GCP summary says
  the restored application passed integrity, but no detailed application-level
  report is linked. This remains an evidence-provenance gap.
- Phase 11 is not complete by its own gate. `CNT-008` and `OPS-006` remain
  `implementing`, `PUB-009-F` is absent, and the complete direct-package,
  Compact Compose, External-storage Compose, and Kubernetes acceptance matrix
  is not attached to the phase IDs.
- No deployment is support-qualified by the ledger. Package-specific gates can
  pass while the full deployment denominator remains largely unproved.
- The final local capacity run passed but reached 753.58 MiB peak RSS at the
  100-user workload. The report correctly warns against deriving a smaller
  production process size without provider-specific measurement.

## Verification commands and results

| Command | Result |
| --- | --- |
| `pnpm install --frozen-lockfile` | Pass; 1,027 packages installed from the pinned lockfile. |
| `docker info --format '{{.ServerVersion}}'` | Pass; Docker server 29.5.3. |
| `ruby scripts/validate-conformance.rb spec/conformance.yml --report` | Pass; 192 requirements, 384 acceptance tests, 6 deployments; counts and coverage match the tables above. |
| `pnpm conformance:tests` | Pass; 107 acceptance IDs have exactly one implementation-test mapping. |
| `pnpm verify:iteration` | Pass, exit 0. It ran lint, typecheck, 108 local tests, build, conformance checks, Cloudflare package checks, 4 browser tests, AWS/GCP Pulumi tests, S3 and native-cloud storage integrations, 13 external-storage runtime tests, coverage, local package, performance and capacity baselines, 3 Compact Compose tests, 2 External-storage Compose tests, Helm static lint, and 2 live disposable-cluster Helm tests. |
| `pnpm test:aws-pulumi` | Pass after claim-title correction; 4 tests. |
| `pnpm test:gcp-pulumi` | Pass after claim-title correction; 3 tests. |
| `pnpm check` | Pass on the final title/status changes; lint, typecheck, 108 tests, build, conformance validation/mapping, and 22 Cloudflare package tests. |
| `git diff --check` | Pass. |

The canonical run refreshed its generated local, storage, package, Compose,
performance, capacity, and Helm evidence reports. Ledger timestamps now name
the refreshed reports rather than older overwritten runs.
