# Artifact Server

Artifact Server stores finished browser files as immutable versions and serves each version from its own hostname.

This repository contains the local publication foundation. It is not the complete local product yet. The current implementation proves:

- a token-protected HTTP publishing endpoint;
- small single-file publication through the inline API;
- complete multi-file site publication through durable staged uploads;
- expiring upload records and opaque, streaming file-upload locations;
- size and SHA-256 verification before a staged upload can commit;
- canonical SHA-256 manifests;
- immutable, content-addressed local blob storage;
- one SQLite transaction for artifact, version, manifest, action, and idempotency records;
- stable artifact links and unique `*.localhost` version hosts;
- intentional version publication with stale-write protection;
- idempotent retries;
- provider-neutral principals with ownership and explicit capability policy;
- authenticated artifact metadata, saved-version history, and canonical manifests;
- manifest-based file comparisons with unambiguous rename detection;
- bounded line comparisons for text and metadata-only binary comparisons;
- pointer-only restore of an existing immutable version;
- atomic changes between account-required and public-link access;
- public-link delivery and version-scoped account-required browser sessions;
- single-use private-content bootstraps and host-only, HttpOnly content cookies;
- authenticated browser sessions for current or earlier exact versions;
- persistence of committed versions and in-progress uploads across a full server restart.

Human browser login, API-key management, SPA routing, deletion, ownership changes, MCP, Agent Skills, optional Git, expired-staging cleanup, and non-local deployments remain to be implemented in the order defined by the specification.

## Run locally

Requirements: Node.js 24.12 or newer, pnpm 10.34.3, and Ruby for validating the conformance ledger.

```sh
pnpm install
pnpm start -- --data .artifact-server --port 8787
```

The server creates a random local API token in `.artifact-server/local-api-token`, prints it at startup, and keeps it with mode `0600`.

Publish a public HTML file through the current inline API:

```sh
TOKEN="$(tr -d '\n' < .artifact-server/local-api-token)"

curl --fail-with-body http://localhost:8787/api/v1/artifacts \
  --request POST \
  --header "Authorization: Bearer $TOKEN" \
  --header "Content-Type: application/json" \
  --header "Idempotency-Key: example-publish-0001" \
  --data '{
    "name": "Hello",
    "accessSetting": "public_link",
    "file": {
      "path": "index.html",
      "mediaType": "text/html; charset=utf-8",
      "contentBase64": "PGgxPkhlbGxvPC9oMT4="
    }
  }'
```

The response contains a stable artifact link and an immutable version link.
For an account-required artifact, create a private browser bootstrap with an
authenticated `POST` to
`/api/v1/artifacts/{artifactId}/content-sessions`, then open the returned
`bootstrapUrl`. The content host exchanges it once and redirects to the clean
version URL. The resulting cookie can read only that immutable version.

Authenticated management routes are available beneath
`/api/v1/artifacts/{artifactId}`. They return the current artifact record,
canonical manifests, and saved-version history; compare any two saved versions;
move the current pointer back to an existing version; and change the artifact's
access setting. Restore and access changes require an idempotency key and the
current version ID observed by the caller.

## Publish a complete site

Complete sites use the staged-upload contract instead of placing every file inside one JSON request:

1. `POST /api/v1/uploads` with the entry path and each file's path, media type, size, and SHA-256 fingerprint.
2. `PUT` each file's raw bytes to the opaque upload address returned by the server.
3. `POST /api/v1/uploads/{uploadId}/commit` with an idempotency key and either a new-artifact or new-version target.

The upload record survives restart. The commit is rejected until every declared file matches its size and fingerprint. A successful commit creates one canonical manifest and one immutable version containing every file. Root-relative asset requests remain on that version's unique content hostname.

## Verification

```sh
pnpm verify:iteration
```

`pnpm verify:iteration` is the command every implementation iteration finishes with. It runs Oxlint with type-aware checking and all anti-slop rules, TypeScript, real runtime and smoke tests, coverage diagnostics, the production build, the ledger validator, the test-ID mapper, and the bounded local performance baseline.

Tests use temporary real SQLite databases, real disk blobs, and a real HTTP server. Module mocking is forbidden. Coverage is reported as a diagnostic for unexercised code; conformance behavior and hostile tests are the release proof.

`pnpm smoke` is a small correctness and gross-regression check. `pnpm perf:baseline` records local publish latency, read latency, throughput, event-loop delay, memory change, storage use, and restart time in `evidence/local-performance-baseline.json`. It is intentionally bounded and is not a stress test. See [`performance/README.md`](./performance/README.md).

The individual `pnpm check`, `pnpm smoke`, and `pnpm perf:baseline` commands remain available for focused work, but they do not replace the complete iteration gate.

The readable proposal and executable checklist are in [`spec/`](./spec/):

- [`artifact-server-product-spec.html`](./spec/artifact-server-product-spec.html)
- [`conformance.yml`](./spec/conformance.yml)
- [`artifact-server-mcp-baseline.md`](./spec/artifact-server-mcp-baseline.md)
- [`plannotator-artifact-server-integration-spec.md`](./spec/plannotator-artifact-server-integration-spec.md)

## Code boundaries

```text
src/core          product records, errors, and provider ports
src/manifest      portable path validation and canonical manifests
src/comparison    pure canonical-manifest comparison rules
src/application   Effect services for identity, authorization, publication, management, comparison, and content access
src/storage       SQLite, local staging, and immutable-blob adapters
src/http          HTTP authentication, publication, links, and delivery
src/local         local adapters, Effect layers, and composition root
src/cli           local process entry point
tests/conformance observable product and hostile behavior
```

Concrete storage and transport code depends on the core. The core does not depend on SQLite, disk, Hono, MCP, Cloudflare, or another deployment provider.

One managed Effect runtime owns the application services and installation
resources. Hono is an inbound adapter over those services; future MCP and CLI
entry points use the same operations and failure values. See
[`Decision 0001`](./spec/decisions/0001-effect-application-core.md) for the
migration boundary and deliberate exclusions. See
[`Decision 0002`](./spec/decisions/0002-shared-identity-and-private-content.md)
for the provider-neutral principal and private-content session model.
