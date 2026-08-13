# Phase 5: MCP control plane

Status: local behavior verified

## Outcome

Artifact Server now serves a modern, stateless MCP endpoint at `POST /mcp`.
It uses the official split TypeScript SDK version 2 and protocol revision
`2026-07-28`. MCP is a protocol adapter over the existing application services;
it does not contain a second artifact, permission, upload, version, or
comparison implementation.

## Agent contract

- `server/discover` returns the protocol versions and concise operating
  instructions on every connection.
- `tools/list` exposes small, typed, fully described operations with exact
  read-only, idempotent, open-world, and destructive annotations.
- `artifact_capabilities` reports the current deployment mode, publishing
  workflow, file-count and upload-plan limits, comparison bound, and sharing
  modes.
- `artifact_get` returns the current artifact, complete canonical manifest,
  current immutable version, and browser links in one call.
- MCP never accepts inline HTML, source strings, base64 data, or a client
  filesystem path.
- `artifact_create_upload` returns one plan for actual file bytes.
- The client uploads those bytes to the returned HTTP URLs and calls
  `artifact_commit_upload` with a stable idempotency key.
- Updating an artifact requires the exact current version the agent read.
- `artifact_open` returns the correct current or exact-version browser URL. The
  MCP server never tries to open a browser on a remote server machine.

## Implemented tools

```text
artifact_capabilities
artifact_list
artifact_get
artifact_open
artifact_version_list
artifact_diff
artifact_create_upload
artifact_commit_upload
artifact_set_visibility
artifact_set_tags
artifact_restore_version
artifact_delete
```

The first resource template returns the complete canonical manifest for one
immutable version:

```text
artifact://artifacts/{artifactId}/versions/{versionId}/manifest
```

## Transport and authentication

- The modern route accepts `POST` only. `GET` and `DELETE` return 405.
- A fresh MCP server is created for every HTTP request.
- There is no `initialize`, MCP session identifier, sticky routing, replay
  stream, or HTTP+SSE legacy route.
- `subscriptions/listen` rejects without opening an event stream.
- Host and any present Origin are validated before MCP dispatch.
- Bearer authentication completes before MCP dispatch.
- Local and private installations accept Artifact Server API keys.
- The verified credential is converted once to the existing provider-neutral
  principal. Tools call the same authorization layer as the HTTP API.
- API-key-only mode intentionally publishes no OAuth metadata and no browser
  OAuth challenge.

## Local publishing

Local MCP uses the same loopback HTTP endpoint as a deployed installation. The
bundled publishing CLI and the future `publish-artifact` skill read the local
path, compute the manifest, and upload the bytes. This is safer and simpler
than a separate local-path MCP tool and preserves one server contract across
local and remote deployments.

## Verified locally

- modern discovery, required envelope and HTTP headers, cache hints, and
  `resultType`;
- a pinned modern connection, tool listing, and tool call through the official
  TypeScript SDK v2 client;
- bearer missing/invalid rejection and hostile-Origin rejection;
- POST-only behavior, no session ID, modern-only legacy rejection, and bounded
  subscription refusal;
- exact file upload, a second complete multi-file site with a 1.1 MB asset,
  immutable commit, lost-response replay, manifest-resource read, version list,
  text and file comparison, tag and visibility changes, stale-write rejection,
  restore, deletion with retained-version proof, and private browser-open
  bootstrap;
- a read-only external principal cannot publish;
- a principal from another installation cannot list artifacts;
- an identity-store outage returns OAuth `server_error` instead of being
  misreported as an invalid credential;
- strict TypeScript and Oxlint/anti-slop checks.
- bounded modern discovery and `artifact_list` latency in the reusable local
  performance baseline.

The tests use a real SQLite/local-files runtime and HTTP server. They do not
mock the MCP SDK, application services, upload path, repository, or file store.
The external-storage integration also starts two independent compiled processes over one
Postgres/S3 installation, publishes through one process, then discovers and
lists the artifact through MCP on the other.

## Deliberately deferred

- Hosted WorkOS MCP OAuth and RFC 9728 metadata remain a separate activation
  phase because they require a real WorkOS environment and real-client proof.
- Codex, Claude Code, claude.ai, and Cursor compatibility runs remain release
  gates, including fresh and stale credential state.
- The external-storage Postgres/S3 MCP matrix must run before claiming the MCP behavior on
  one-server or replicated deployments.
- Legacy MCP compatibility is disabled until a named required client proves it
  needs the isolated SDK compatibility path.
- Stdio is not required for local use because every local client can connect to
  loopback HTTP; add it only for a demonstrated client requirement.
- Prompts, Tasks, MRTR, Roots, Sampling, Logging, change subscriptions, and
  progress streams are outside this phase.
