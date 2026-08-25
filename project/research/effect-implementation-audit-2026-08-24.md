# Effect implementation quality audit

**Date:** August 24, 2026
**Scope:** Effect usage in the application core, runtime composition, adapters,
configuration, scheduling, caching, observability, and representative tests
**Result:** No critical correctness issue found. One medium-priority runtime
boundary issue remains. The Git monitor ownership and time-based verification
findings were resolved on August 25, 2026.

## Executive assessment

Artifact Server has a strong Effect application core. Product operations use
`Context.Service`, named `Effect.fn` workflows, narrow ports, typed failures,
managed layers, and redacted secrets consistently. The HTTP, MCP, and CLI
adapters reuse the same application services. Expected product failures stay
in the typed error channel and are translated at protocol boundaries. Tests use
real services and storage rather than module mocks.

The remaining quality debt is outside the application services.
External-storage mode creates a private Postgres `ManagedRuntime` in addition
to the installation runtime. This weakens the single-runtime ownership and
observability model recorded in the repository's Effect decisions.

These findings do not currently block local release behavior. The Postgres
runtime issue should be resolved before treating Effect tracing and cancellation
as complete in external-storage deployments.

## Findings

### EFQ-001 — P2 — Postgres runs in a second managed runtime

**Evidence**

- [Decision 0001](../spec/decisions/0001-effect-application-core.md) says one
  `ManagedRuntime` is created for each installation and owns installation
  resources.
- [`PostgresDatabase.inspect`](../../src/storage/postgres-database.ts) creates a
  private `ManagedRuntime` over `PgClient.layer`.
- [`createExternalStorageRuntime`](../../src/external-storage/create-external-storage-runtime.ts)
  later creates a second `ManagedRuntime` for application services and
  telemetry.
- Postgres repository operations enter the private runtime through
  `PostgresDatabase.run`, return promises, and are wrapped back into Effect by
  the application adapter layer.

**Impact**

- SQL work is not a child of the calling application fiber.
- Application interruption and fiber-local context do not cross the promise
  bridge into the SQL runtime.
- SQL spans and logs do not inherit the installation's configured telemetry
  context, so an application operation cannot provide one continuous trace
  through its database work.
- Resource cleanup is explicit and currently safe, but ownership is manually
  bridged between two runtimes instead of expressed by one scope.

No current data-integrity failure was observed, and the external-storage suite
already exercises real Postgres behavior. This is an architecture,
cancellation, and observability issue rather than evidence of corrupt writes.

**Triage**

1. Provide `PgClient.layer` to the installation runtime and acquire the pool in
   that runtime's scope.
2. Let Postgres adapters return Effect programs at the provider boundary instead
   of executing them through `PostgresDatabase.run` and rewrapping promises.
3. Keep a small, separately scoped runtime only for standalone operator commands
   that inspect or migrate Postgres without starting an installation.
4. Prove that an interrupted application operation interrupts its database
   work, SQL telemetry remains under the application span, and runtime disposal
   closes the pool once.

If the two-runtime design is intentionally retained, update Decision 0001 and
document the resulting cancellation and telemetry boundary explicitly.

### EFQ-002 — P2 — The Git capability monitor bypasses the installation runtime

**Status: Resolved August 25, 2026.** The monitor now forks and interrupts
through the installation `ManagedRuntime`, matching staging cleanup. Runtime
shutdown continues to close the monitor before disposal.

**Evidence**

- [`startGitHistoryCapabilityMonitor`](../../src/git-history/git-history-capability-monitor.ts)
  starts its loop with the global `Effect.runFork` and stops it with the global
  `Effect.runPromise`.
- Local and external-storage composition create the monitor after the
  installation runtime is ready, then close its fiber manually before disposing
  that runtime.
- [`startStagingCleanupSchedule`](../../src/lifecycle/staging-cleanup.ts) already
  demonstrates the intended pattern by using `runtime.runFork` and
  `runtime.runPromise`.
- [Decision 0008](../spec/decisions/0008-effect-observability.md) establishes one
  Effect-native logging, tracing, and metrics boundary.

**Impact**

- Monitor warnings use the default Effect runtime rather than the configured
  silent, structured, or OTLP logging layer.
- The monitor does not inherit installation tracing, metrics, or runtime
  services.
- Its lifetime is correct only while every construction, shutdown, and future
  restart path remembers the manual close hook.

Normal shutdown and construction-failure paths do close the fiber today, so no
active leak was reproduced.

**Triage**

1. Make the monitor a scoped Effect resource or layer owned by the installation
   runtime.
2. At minimum, fork and interrupt through `ApplicationRuntime`, matching staging
   cleanup.
3. Route state updates through an Effect concurrency primitive such as `Ref` or
   `SubscriptionRef` if consumers later need reactive updates; the current
   synchronous reader is sufficient for polling reads.
4. Verify that monitor warnings use the configured logger and that disposing the
   installation interrupts the monitor exactly once.

### EFQ-003 — P3 — Recurring provider monitoring lacks deterministic time proof

**Status: Resolved August 25, 2026.** A focused `TestClock` test proves the
initial pass, outage degradation, recovery, and that no later check runs after
shutdown.

**Evidence**

- The monitor repeats a refresh on a jittered five-minute `Schedule`.
- Existing conformance tests prove the initial `checking` to `available`
  transition, identity activation, secret-safe projection, and provider response
  classification.
- No focused test advances Effect time through a later tick, outage, recovery,
  or post-close interval.
- `GIT-010` in the conformance ledger already records sustained provider
  qualification as unproved.

**Impact**

A future scheduling or lifecycle regression could leave provider capability
stale after startup while the initial-check tests continue to pass.

**Triage**

After EFQ-002 makes the monitor an owned Effect resource, use `TestClock` to
prove:

1. the first pass runs immediately;
2. a later pass changes `available` to `degraded` or `misconfigured`;
3. a later successful pass recovers to `available`;
4. migration-required identity prevents a provider call; and
5. scope closure prevents every later scheduled call.

This is not a local first-release blocker because optional Git history is
explicitly deferred. It is a gate for claiming sustained Cloudflare Artifacts
provider qualification.

## Reviewed patterns that are acceptable

- **Application services:** Sixteen application services use `Context.Service`.
  Application operations are predominantly named with `Effect.fn` and compose
  with `Effect.gen`.
- **Errors:** Expected failures use the pinned Effect release's
  `Schema.TaggedError` API and stay independent of HTTP status codes.
- **Secrets:** Configuration and identity adapters use `Redacted` for API tokens,
  client secrets, bootstrap credentials, and database URLs.
- **Configuration:** Cleanup policy uses `Config` and an explicit
  `ConfigProvider`. Other Node configuration is decoded once from an injected
  environment record at the composition boundary.
- **HTTP clients:** The Cloudflare health probe's direct `fetch` is an acceptable
  provider-adapter choice: it is abortable, time-bounded, namespace-scoped,
  response-size-bounded, and schema-decoded.
- **Schema libraries:** Continued Zod use at existing HTTP and persistence
  boundaries is an explicit Decision 0001 migration choice, not an Effect
  quality defect.
- **Authentication cache:** The small custom cache exactly implements the
  product's success-only, bounded-staleness, absolute-expiry, immediate-eviction
  contract, and `AUTH-022` covers the critical behavior. Replacing it with
  `effect/Cache` would be optional unless measured contention justifies
  same-key lookup deduplication.
- **Layer composition:** `Layer.mergeAll` and `Layer.provideMerge` are confined
  to named composition roots with deliberate service exposure. No accidental
  mega-layer cycle was found.
- **Tests:** Real HTTP, SQLite, filesystem, Postgres, and object-storage seams are
  used. No module mocks were found. Standard Vitest remains appropriate for
  process and HTTP integration tests; `TestClock` is specifically needed for the
  recurring monitor gap above.

## Verification performed

| Check | Result |
| --- | --- |
| `pnpm lint` | Pass |
| `pnpm typecheck` | Pass |
| Focused conformance run | 8 files, 29 tests passed |

The focused run covered publishing runtime behavior, authorization policy,
installation identity and authentication caching, OIDC validation, staged
upload lifecycle, private-content lifecycle, Git configuration/discovery, and
Cloudflare provider-health classification.

Run the complete `pnpm verify:iteration` gate after implementation changes.
Run the external-storage runtime gate when EFQ-001 is addressed.

## Recommended order

1. Keep EFQ-001 documented while correctness tests continue to pass.
2. Plan the Postgres runtime consolidation as a bounded refactor when continuous
   SQL tracing or cancellation becomes a release requirement.
3. Run the full external-storage correctness and performance gates with that
   future refactor.
