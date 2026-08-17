# Phase 5: MCP control plane

Status: core local protocol behavior verified; complete cross-interface authorization proof and hosted release qualification remain open

## Outcome

Artifact Server now serves one stateless MCP endpoint at `POST /mcp`. Its
primary path uses the official split TypeScript SDK version 2 and protocol
revision `2026-07-28`. The same SDK entry accepts stateless 2025-era requests
from current clients that have not adopted the modern revision. MCP is a
protocol adapter over the existing application services; it does not contain a
second artifact, permission, upload, version, or comparison implementation.

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
artifact://projects/{projectId}/artifacts/{artifactId}/versions/{versionId}/manifest
```

## Transport and authentication

- The endpoint accepts `POST` only. `GET` and `DELETE` return 405.
- A fresh MCP server is created for every HTTP request.
- Modern requests use `server/discover` and no initialization handshake.
- A 2025-era `initialize` request is handled by the SDK's stateless
  compatibility path. It creates no MCP session identifier and adds no sticky
  routing, replay stream, GET stream, or DELETE session operation.
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
bundled publishing CLI reads the local path, computes the manifest, and uploads
the bytes. The future `publish-artifact` skill invokes that CLI when a local
file is involved. This is safer and simpler than a separate local-path MCP tool
and preserves one server contract across local and remote deployments.

## Verified locally

- modern discovery, required envelope and HTTP headers, cache hints, and
  `resultType`;
- a pinned modern connection, tool listing, and tool call through the official
  TypeScript SDK v2 client;
- bearer missing/invalid rejection and hostile-Origin rejection;
- POST-only behavior, no session ID, exact `2025-06-18` initialization, an
  official 2025-era client tool call, and bounded subscription refusal;
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

These results do not complete `MCP-009`. The acceptance sentence requires the
complete HTTP and MCP authorization matrix and every named mutation denial;
the current acceptance-ID test covers read-only listing, publication denial,
and one foreign-installation listing denial.

## Hosted qualification status

- Live WorkOS staging discovery, browser approval, exact resource-bound token
  use, five-minute token refresh, per-user DCR and CIMD grant revocation, and
  reauthorization pass on the isolated Cloudflare Worker.
- Codex CLI `0.147.0` passes a real tool call through DCR and the stateless
  `2025-06-18` compatibility path.
- Claude Code `2.1.233` passes a real tool call through CIMD.
- Cursor Agent `3.15.6` completed DCR and listed the authenticated tool surface
  that existed during qualification. The current server exposes 17 tools after
  the later removal of artifact ownership transfer. A
  model-driven tool call remains separate because Cursor Agent also requires a
  Cursor product login.
- Visual Studio Code and claude.ai qualification is deferred and is not a
  first-release gate. Codex and Claude Code are the qualified hosted clients.
- Secret-free live evidence is recorded in
  `evidence/workos-mcp-live-qualification.json`.

## Deliberately deferred

- The external-storage Postgres/S3 MCP matrix must run before claiming the MCP behavior on
  one-server or replicated deployments.
- Stateless 2025-era compatibility is enabled because Codex CLI `0.147.0`
  requested revision `2025-06-18` in the August 16, 2026 hosted qualification.
  It remains isolated inside the official SDK entry and does not add sessions.
- Stdio is shipped for credential-free local onboarding and forwards to the one
  managed loopback service; it is not a second application runtime.
- Prompts, Tasks, MRTR, Roots, Sampling, Logging, change subscriptions, and
  progress streams are outside this phase.
