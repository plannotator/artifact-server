# CI performance profile — 2026-08-27

## Scope and method

This profile describes the `CI` workflow at `c210384`. Measurements come from
GitHub Actions, not local estimates. For each successful Linux job, the duration
of a command is the interval between its root `pnpm` start marker and the next
root command marker in the job log. That includes child commands such as web
builds and Vitest runs. The final `test:oidc` interval ends at the GitHub step's
recorded completion time.

The four successful samples are:

| Run | Event | SHA | Workflow wall-clock | Linux job | macOS job | Rounded runner-minutes |
| --- | --- | --- | ---: | ---: | ---: | ---: |
| [33010555757](https://github.com/plannotator/artifact-server/actions/runs/33010555757) | `push` | `63a02e0` | 49m 18s | 42m 39s | 4m 57s | 48 |
| [33008510703](https://github.com/plannotator/artifact-server/actions/runs/33008510703) | `push` | `653c4b1` | 30m 22s | 30m 17s | 4m 54s | 36 |
| [33006405756](https://github.com/plannotator/artifact-server/actions/runs/33006405756) | `pull_request` | `653c4b1` | 40m 32s | 40m 27s | 5m 11s | 47 |
| [33001885362](https://github.com/plannotator/artifact-server/actions/runs/33001885362) | `push` | `9c4e45b` | 38m 58s | 38m 52s | 5m 50s | 45 |

The 30-minute run is a real successful sample, but it is materially faster than
the other three. The other successful runs establish the observed 39–49 minute
workflow range. Rounded runner-minutes round each job independently because that
is how GitHub bills jobs. The organization billing API could not provide actual
charged usage: the active `gh` token has `repo` and `workflow`, but not
`admin:org`.

## Complete iteration-gate step profile

`verify:iteration` expands to the leaf commands below. Wrapper times for
`check`, `verify:object-storage`, and `verify:helm` are represented by their
children so work is not counted twice.

“Typical diff” means a change to application core, HTTP behavior, web UI, or a
shared contract. “Scoped” means the check is valuable but only for a narrower
path family. “Low” means ordinary product changes do not alter its input, even
though a packaging or operations change can still make it fail.

| Leaf command | 33010555757 | 33008510703 | 33006405756 | 33001885362 | What it proves | Infrastructure | Release evidence | Typical diff |
| --- | ---: | ---: | ---: | ---: | --- | --- | --- | --- |
| `lint` | 16s | 9s | 16s | 11s | Root TypeScript/JavaScript lint, type-aware Oxlint, anti-slop policy | Node, pnpm | None | High |
| `typecheck` | 11s | 6s | 11s | Root, web, and Pi extension TypeScript contracts | Node, pnpm | None | High |
| `build` | 6s | 3s | 5s | Production web bundle and compiled CLI/server | Node, pnpm | None | High |
| `verify:site` | 19s | 12s | 18s | Astro/Nimbus docs types, lint, build, Markdown alternates, `llms.txt` surfaces | Node, pnpm; `.nimbus/routes.json` | None | Scoped: site/docs |
| `test` | 6m 19s | 4m 11s | 6m 09s | Root Vitest behavior, conformance, HTTP, CLI, storage, lifecycle, client, and tooling suites | Node, pnpm, Ruby not used; temporary SQLite/disk and real loopback HTTP | `project/evidence/local-foundation.json` | High |
| `conformance:validate` | 1s | 1s | 2s | Ledger schema, statuses, dependency and evidence contracts | Ruby | Validates existing evidence rather than creating it | High for spec/evidence; low otherwise |
| `conformance:tests` | 1s | <1s | 1s | Acceptance IDs exist exactly once and test titles match the ledger | Ruby | Release-critical index validation | High for tests/spec; low otherwise |
| `check:cloudflare` | 1m 35s | 1m 05s | 1m 32s | Cloudflare/Alchemy types and plans plus real local workerd/D1/R2 application paths | Node, pnpm, workerd; web build; loopback network | None currently | High for `src/**`, web, or Cloudflare deployment |
| `test:web` | 2m 51s | 2m 16s | 2m 51s | Chromium Review workflows over real local application services and HTTP boundaries | Chromium, Playwright, Node, temporary SQLite/disk, loopback network; web build | `project/evidence/browser.json` plus Playwright report/traces | High |
| `test:aws-pulumi` | 10s | 6s | 10s | AWS configuration, resource graph, shared cloud contract, hostile configurations | Node, pnpm; Pulumi mocks, no live AWS | `project/evidence/aws-pulumi.json` | Scoped: AWS and shared deployment contract |
| `test:gcp-pulumi` | 9s | 5s | 9s | GCP configuration, resource graph, shared cloud contract, hostile configurations | Node, pnpm; Pulumi mocks, no live GCP | `project/evidence/gcp-pulumi.json` | Scoped: GCP and shared deployment contract |
| `test:storage-s3` | 1m 33s | 54s | 1m 34s | S3 adapter behavior, restart and failure paths against pinned MinIO | Docker, network/image pull, MinIO, temporary volume, coverage | `project/evidence/s3-minio.json` | High for storage/publication; scoped otherwise |
| `test:storage-native-cloud` | 1m 47s | 1m 01s | 1m 43s | GCS and Azure Blob adapter contracts against pinned emulators | Docker, network/image pulls, fake-gcs-server, Azurite, coverage | `project/evidence/native-cloud-storage.json` | High for storage/publication; scoped otherwise |
| `test:external-storage-runtime` | 56s | 38s | 55s | Compiled multi-process Postgres/S3 runtime, migrations, readiness, backup behavior, and observability | Docker, Postgres, MinIO, temporary volumes/network, web/server build, coverage | `project/evidence/observability.json`, `project/evidence/external-storage-runtime.json` | High for core/storage/runtime |
| `test:coverage` | 6m 35s | 4m 13s | 6m 20s | Re-runs the root Vitest suite with V8 coverage diagnostics | Node, pnpm, temporary SQLite/disk and loopback HTTP | Coverage directory only; ignored and not release evidence | High, but behavior duplicates `test` |
| `test:local-package` | 39s | 24s | 38s | Portable local archive, offline production install, CLI lifecycle and metadata | Node, pnpm store, tar, temporary disk; root build | `project/evidence/local-package.json` and package-build metadata | High for CLI/package; scoped otherwise |
| `perf:baseline` | 6s | 3s | 5s | Bounded local publish/read/compare/MCP/file-client/restart diagnostics | Node with GC, SQLite, temporary disk, loopback HTTP | `project/evidence/local-performance-baseline.json` | High for core performance; unlikely for docs/deploy-only |
| `perf:capacity` | 55s | 37s | 51s | Compiled server at 1/10/25/50/100 browse and publish concurrency | Node child processes, root build, temporary disk, loopback HTTP | `project/evidence/local-capacity-baseline.json` | High for core performance; unlikely for docs/deploy-only |
| `test:compact-compose` | 5m 47s | 4m 34s | 5m 42s | Multi-platform attested OCI image and compact Compose install, persistence, recovery, exact revision | Docker/Compose, containerd image store, Buildx container driver, network/image pulls, root and in-image builds | `project/evidence/oci-image.json`, `project/evidence/compact-compose.json` | High for core/image/Compose; low for docs-only |
| `test:external-storage-compose` | 1m 57s | 1m 20s | 1m 39s | Same OCI image in external-storage Compose with Postgres/MinIO, restart and failure recovery | Docker/Compose, containerd, attestation BuildKit, Postgres, MinIO, network, build | `project/evidence/oci-image.json`, `project/evidence/external-storage-compose.json` | High for core/image/external Compose; low for docs-only |
| `test:helm-static` | 2s | 1s | 2s | Strict chart lint/render across Kubernetes versions and hostile values; chart package | Helm and network only on cold tool install; `kind` is downloaded but not used here | Packaged chart, no JSON evidence | Scoped: Helm chart |
| `test:helm` | 6m 22s | 5m 31s | 5m 47s | Attested OCI image deployed to a real `kind` cluster with external providers, migrations and failures | Docker, containerd, Buildx, Helm, kind/Kubernetes, Postgres, MinIO, network, build | `project/evidence/oci-image.json`, `project/evidence/helm-kubernetes.json` | High for core/image/Kubernetes; low for docs-only |
| `test:oidc` | 55s | 33s | 47s | Generic OIDC browser login and hostile token/configuration behavior against pinned Keycloak | Docker, Keycloak, network/image pull, root build, loopback HTTP | `project/evidence/oidc-keycloak.json` | High for auth/runtime; scoped otherwise |

### Wrapper totals

| Direct `verify:iteration` command | 33010555757 | 33008510703 | 33006405756 | 33001885362 |
| --- | ---: | ---: | ---: | ---: |
| `check` | 8m 46s | 5m 47s | 8m 33s | 7m 40s |
| `test:web` | 2m 51s | 2m 16s | 2m 51s | 2m 36s |
| `test:aws-pulumi` | 10s | 6s | 10s | 8s |
| `test:gcp-pulumi` | 9s | 5s | 9s | 7s |
| `verify:object-storage` | 3m 20s | 1m 56s | 3m 18s | 2m 41s |
| `test:external-storage-runtime` | 56s | 38s | 55s | 49s |
| `test:coverage` | 6m 35s | 4m 13s | 6m 20s | 5m 31s |
| `test:local-package` | 39s | 24s | 38s | 33s |
| `perf:baseline` | 6s | 3s | 5s | 5s |
| `perf:capacity` | 55s | 37s | 51s | 49s |
| `test:compact-compose` | 5m 47s | 4m 34s | 5m 42s | 5m 14s |
| `test:external-storage-compose` | 1m 57s | 1m 20s | 1m 39s | 1m 42s |
| `verify:helm` | 6m 24s | 5m 33s | 5m 50s | 6m 40s |
| `test:oidc` | 55s | 33s | 47s | 47s |

## Dependency and repeated-work analysis

The serial gate benefits accidentally from warm files and Docker layers, but it
rebuilds the same inputs many times:

- The root `build` runs once in `check`, then again in `test:web`,
  `test:external-storage-runtime`, `perf:capacity`, each Compose script, Helm,
  and OIDC. `test:local-package` invokes `package:local`, which builds again.
- Every root build first runs `@artifact-server/web build`. Cloudflare's
  `pretest` builds the web package separately. Each OCI build then runs the
  production build again inside the BuildKit context.
- `test` and `test:coverage` run substantially the same root Vitest corpus.
  Their 4–6.5 minute durations make this the largest pure duplication. Coverage
  is diagnostic and does not need to delay PR feedback.
- Compact Compose, external-storage Compose, and Helm each create the same
  multi-platform OCI archive with provenance and SBOM attestations. In the
  serial job, BuildKit layers make the second and third builds cheaper. In
  separate jobs they would each pay a cold build unless one image archive is
  produced once and shared, or a GitHub Actions BuildKit cache is exported.
- The compiled `dist/**` tree, including `dist/web/**`, is a deterministic build
  outputs suitable for one build job and an immutable artifact. Tests that
  only consume those outputs can download them. Tests that intentionally prove
  packaging still need to validate their own package boundary.
- The evidence JSON files use stable repository paths. A fan-out must upload
  them per job and merge them without allowing jobs to overwrite one another.

The special Linux setup is narrower than the current workflow suggests:

- Chromium installation is needed only by Playwright browser jobs.
- Ruby is needed only by `conformance:validate` and `conformance:tests`.
- The containerd image store and attestation-capable BuildKit are needed by the
  three OCI consumers: compact Compose, external-storage Compose, and Helm.
  MinIO, native-cloud emulators, Postgres runtime, and Keycloak need ordinary
  Docker only.
- Disk reclamation principally protects the repeated multi-architecture OCI
  builds and their container images. Non-Docker PR jobs do not need it.

## Failure and flake history

The last 30 `CI` runs contained 14 completed failures:

| Class | Runs | Count | Assessment |
| --- | --- | ---: | --- |
| Playwright navigation/layout race | `33042793024`, `33016884615`, `33010543271`, `32992050720`, `32914448866` | 5 | Test flake, not product failure. Three failed while reading page state during navigation; two compared header bounding boxes across a re-render. The same suites passed on adjacent runs/SHAs. `811a817` replaced one-shot reads with navigation waits and `expect.poll`. |
| Deterministic lint defect | `32890650276`, `32889719826`, `32889295511`, `32885120768`, `32884815294`, `32884444760`, `32876796000`, `32876585693` | 8 | Real change defect. `scripts/render-social-cards.mjs` violated the no-await-in-loop rule on both Linux and macOS. These runs failed correctly and quickly. |
| GitHub scheduling/run failure before execution | `32985026317` | 1 | Infrastructure/control-plane failure. Both jobs remained queued with no steps or logs; the run later completed as failure. No repository check executed. |

No unit, conformance, storage, packaging, or deployment behavior regression was
observed among these failures. The concentration is operationally important:
five expensive Linux runs reached Playwright after 9–12 minutes and then failed
for a race. `838d194` is the same repository de-flake style for an adjacent
reduced-motion race: poll the eventual observable state, do not add sleeps.

## Cache analysis

### Current cache

Only the pnpm store is cached, through `actions/setup-node`. In the three most
recent successful Linux samples it restored the same 538,819,595-byte archive
(about 514 MiB). Download/extraction occupied 22–34 seconds of the Node setup
step; the subsequent frozen install took 15–19 seconds. The cache is effective,
but each fanned-out job would independently download this large archive.

There is no Playwright browser cache, Docker/BuildKit cache export, compiled
build artifact, or TypeScript incremental cache.

### Candidates

| Candidate | Expected value | Caveat / decision |
| --- | --- | --- |
| Playwright Chromium directory keyed by OS and Playwright version | Avoid the repeated browser download; current install step is 23–49s | `--with-deps` must still install OS packages; a stale browser cache must fail closed and be version-keyed |
| One uploaded `dist/**` + `apps/web/dist/**` artifact | Removes repeated 3–6s builds and gives downstream jobs identical bytes | Small timing win by itself; important as a correctness anchor for consumers |
| One attested OCI archive plus manifest | Avoids three multi-platform builds, the largest reusable work | Artifact is large; upload/download time and GitHub artifact quota must be measured. Consumers must verify manifest/revision before use |
| BuildKit `type=gha` cache | Lets independent OCI jobs reuse layers | Cache scope/versioning and untrusted PR writes must prevent poisoning; still rebuilds/exports three archives |
| `apps/site/.nimbus` | Low value: `lint.json` and `routes.json` are already tracked | Site verification is only 12–19s and must still rebuild outputs; do not add complexity |
| TypeScript `.tsbuildinfo` | Low value: root typecheck is 6–11s and configs do not enable incremental compilation | A CI-only incremental config and exact invalidation would cost more complexity than it saves now |
| pnpm store per concern | Already effective | Fan-out multiplies the 514 MiB restore. Measure total minutes and bandwidth; jobs may be faster with normal fetch on high fan-out, but do not assume |

## Runner and queue analysis

### Standard and larger Linux runners

The repository has no self-hosted or configured larger runner. The owning
organization reports the GitHub Enterprise plan, so larger runners are
available if an organization owner configures one. Current GitHub pricing is
$0.006/minute for standard Linux 2-core, $0.012 for Linux 4-core, $0.022 for
Linux 8-core, and $0.042 for Linux 16-core. Larger runners are always billed and
cannot consume included minutes. Source:
<https://docs.github.com/en/enterprise-cloud@latest/billing/reference/actions-runner-pricing>.

The history proves two jobs can start concurrently within seconds on an
uncontended PR. It does not prove that six or more jobs will always start
without organization-wide queueing, so the trial must measure queue delay as
well as execution time. Larger runners are not the first choice: the workload
contains serial integration startup and I/O in addition to CPU work, while
ordinary matrix fan-out can attack wall-clock without paid runner setup.

The existing `concurrency` expression also matters. PR updates cancel their
older run. `main` runs do not cancel in progress and share one concurrency key,
which caused visible queue delay in the 49-minute sample. A full main/nightly
gate should preserve serialization where shared release evidence matters, but
PR jobs can fan out inside a single run.

### macOS necessity

The macOS job is not a Ruby portability test. Ruby is present only because
`pnpm check` includes the two conformance ledger commands. The actual portable
coverage comes from running the normal Node/filesystem/build corpus on Darwin:

- linked-source tests explicitly handle macOS temporary-directory symlinks;
- CLI registration and browser-opening code has real `darwin` branches;
- credential-store selection has a real macOS path;
- local package and path behavior run on a case-preserving APFS environment.

The macOS job consistently finishes in about five minutes and therefore does
not set current PR wall-clock. Keeping one macOS PR gate is defensible. It is
also redundant for deterministic lint, site, conformance, Cloudflare, and most
pure TypeScript tests. A later optimization can narrow it to the portability
suite, but removing it would reduce platform coverage and is not required to
reach the 12-minute target.

## Profile conclusion

The measured critical path is created by serialization, not a single runaway
test. The practical PR floor on standard runners is the slowest of three useful
parallel concerns: root tests (4–6.5m), Playwright (2–3m), and setup/install
(about 1–2m). A fast PR tier should fit below 12 minutes without paid hardware.

The expensive release-only work is OCI/Compose/Helm (roughly 11–15m after
layer reuse), duplicate coverage (4–6.5m), storage/runtime Docker checks
(roughly 4–5m), and bounded performance (under 1m). Moving those to a full
GitHub gate on `main`, schedule, dispatch, and optionally `merge_group` preserves
the release evidence while taking them off the PR critical path.
