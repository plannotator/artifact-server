# ADR 0014: local MCP uses a stdio-to-loopback bridge

Status: accepted

## Context

Local users need a zero-copy MCP setup, while the application already owns a
modern authenticated `/mcp` endpoint and one SQLite/local-file runtime. Starting
a second product runtime inside every coding client's stdio process would create
multiple database owners, duplicate lifecycle behavior, and make returned
browser links depend on the client process staying alive.

The existing MCP registry, HTTP authentication adapter, local server, and
client-facing publishing paths were reviewed. Reusing the HTTP endpoint keeps
all product and authorization behavior on the established path. A new adapter
is still required because local AI clients commonly install stdio commands.

## Decision

`artifactserver mcp` is a transport-only bridge. It serves stdio with the
official SDK and forwards requests to the per-user service's authenticated
loopback `/mcp` endpoint. The per-user service is started once, owns SQLite and
local files, and advertises its non-secret loopback address through a user-only
service record.

The bridge obtains the existing local credential from private per-user state.
The credential never becomes a command argument, client configuration field,
stdout value, ordinary log field, or diagnostic value.

## Consequences

- HTTP and stdio share one MCP registry and one product implementation.
- Multiple AI clients can use one local database owner safely.
- Browser links remain live when one AI client closes.
- The bridge adds one loopback hop, which is bounded and measured by the MCP
  smoke and performance checks.
- The per-user service needs an explicit non-secret discovery record and stale
  state diagnostics.
- Remote deployments continue to use Streamable HTTP directly; the stdio bridge
  is a local onboarding adapter, not a second deployed MCP architecture.
