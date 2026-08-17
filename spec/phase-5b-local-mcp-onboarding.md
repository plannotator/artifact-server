# Phase 5b: local MCP onboarding

Status: implemented locally; current-client host qualification remains open

## Outcome

A person installs Artifact Server, runs `artifactserver connect`, selects a
supported AI client only when the command finds more than one, and starts using
Artifact Server without copying a token, reading startup logs, opening a
browser, or running Docker.

The local path consists of three processes with one product implementation:

```text
AI client
  -> artifactserver mcp (stdio transport bridge)
  -> per-user Artifact Server service (loopback POST /mcp)
  -> existing authentication, authorization, artifact, version, and storage services
```

The bridge does not define tools or write the database. It forwards MCP to the
same authenticated HTTP endpoint used by every deployment. Its private local
credential is read from the per-user data directory and is never printed,
placed in client configuration, passed as a process argument, or returned in a
diagnostic report.

## Commands

### `artifactserver mcp`

- Serves MCP on stdin/stdout using the official TypeScript SDK version 2.
- Writes only MCP protocol messages to stdout; diagnostics go to stderr.
- Starts or locates the per-user loopback service.
- Connects to the loopback `/mcp` endpoint with the private local credential.
- Pins the downstream loopback connection to revision `2026-07-28`.
- Accepts modern stdio clients and the SDK's stateless 2025-era compatibility
  handshake. Both reach the same modern downstream connection and product
  implementation; neither creates an application session.
- Proxies the remote catalog and calls without duplicating tool definitions.
- Shuts down only the stdio bridge when the client closes. The per-user service
  remains available to other registered clients and browser links.

### `artifactserver connect [client]`

- Detects supported installed clients: Codex, Claude Code, Cursor, and VS Code.
- Selects the only detected client automatically. If more than one is found,
  it lists the choices and exits without changing state unless `client` was
  supplied.
- Starts or locates the per-user service.
- Registers one user-scoped stdio command that invokes this exact installed
  Artifact Server release with the absolute per-user data directory and no
  credential argument.
- Verifies the complete stdio bridge with a modern `server/discover` and
  `tools/list` exchange before reporting success.
- Never prints or stores the private local credential in the target client's
  configuration.

Codex and Claude Code use their native MCP configuration commands. Cursor and
VS Code use their documented user-level JSON files because their command-line
interfaces do not provide a complete add-and-remove lifecycle.

### `artifactserver disconnect [client]`

- Uses the same selection rule as `connect` when the client is omitted.
- Removes only Artifact Server's managed user-level registration.
- Preserves other MCP servers and the per-user Artifact Server data.
- Is idempotent when the managed registration is absent.

### `artifactserver doctor [client]`

- Does not start or change the service or client configuration.
- Reports the selected data directory, service-record state, loopback health,
  modern MCP discovery, and each requested client's registration state.
- Reports safe remediation commands.
- Never includes credential values or credential-bearing URLs.
- Exits unsuccessfully when any requested check is unhealthy.

## Per-user service

The onboarding data directory defaults to `~/.artifact-server`. The existing
`start --data` behavior remains available for explicit project-local or test
servers.

The managed service binds to `127.0.0.1` on an operating-system-assigned port.
After it is listening, it atomically writes a user-only service record containing
only schema version, process ID, loopback origin, data directory, product
version, and start time. The record contains no credential. A stale or malformed
record is never trusted as a live service.

Only the service owns SQLite and local blob storage. Every stdio bridge reaches
that process over the existing authenticated HTTP boundary, so multiple clients
do not create multiple processes that manage the same database lifecycle.

## Client configuration

The managed server name is `artifact-server`.

- Codex: `codex mcp add artifact-server -- <artifactserver> mcp --data <dir>`
- Claude Code: `claude mcp add --transport stdio --scope user artifact-server -- <artifactserver> mcp --data <dir>`
- Cursor: preserve the user JSON document and manage only
  `mcpServers.artifact-server`.
- VS Code: preserve the user JSON document and manage only
  `servers.artifact-server`.

Configuration writes are atomic. Existing entries with the same name that do
not match Artifact Server's managed shape are reported as conflicts and are not
silently overwritten.

## Credential output change

`artifactserver start` continues to create user-only local API and browser
bootstrap credentials because the existing HTTP boundaries require them. It no
longer prints either value or a URL containing either value. Startup output is
limited to the local application address and data directory.

## Verification

The implementation is not complete until tests prove:

1. one packaged command starts the managed service, performs modern discovery,
   lists and calls tools through both modern and stateless 2025-era stdio, then
   reconnects after the bridge exits;
2. all four client adapters preserve unrelated configuration and contain no
   credential;
3. Codex and Claude Code command adapters are exercised through isolated client
   homes or faithful executable seams without touching the developer's actual
   configuration;
4. ambiguous, missing, conflicting, malformed, stale, and unreachable states
   fail with useful, credential-free diagnostics;
5. `start`, `connect`, `disconnect`, `doctor`, service logs, process arguments,
   client files, and test reports contain no local credential; and
6. the existing modern HTTP MCP, local package, performance, Compose, and Helm
   gates remain green.

Real current Codex, Claude Code, Cursor, and VS Code host runs remain the
cross-client release proof in `MCP-019`; adapter and protocol tests do not
pretend to prove host behavior that was not actually exercised.
