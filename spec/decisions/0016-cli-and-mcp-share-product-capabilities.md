# ADR 0016: CLI and MCP share product capabilities

Status: accepted

## Context

Artifact Server has three ways to call product operations: HTTP, MCP, and the
command-line program. They must not become three different products. Listing,
opening, publishing, comparing, restoring, tagging, sharing, and deleting an
artifact require the same application rules and authorization regardless of
the adapter that receives the request.

The adapters do not have the same access to files. A command-line program on a
user's computer can read a path on that computer. A remote MCP server cannot.
Putting a path string in an MCP tool argument does not transfer the file, and
putting large file bytes or base64 in MCP arguments conflicts with the accepted
file-first publishing contract.

## Decision

### One product service, overlapping adapters

MCP and the CLI intentionally overlap. They adapt the same application
services, return the same product identities, and enforce the same policy. An
operation is not reimplemented inside an MCP tool or CLI command.

The adapter is selected by where the required bytes exist:

- Use the CLI when an operation must read or write a file on the user's
  computer.
- Use MCP or the CLI for operations that only need server data.
- A remote MCP server never claims that it can read an arbitrary path on the
  user's computer.
- The local stdio bridge from ADR 0014 remains a transport adapter. It does not
  become a second application runtime or a hidden file-transfer protocol.

### The CLI owns local-file publishing

The primary local-file operation is:

```text
artifactserver publish <path> --project <project> --json
```

The CLI reads and validates the selected file or finished directory, hashes its
files, follows the server's upload plan, retries safe transfer failures, commits
the version, and returns a structured result. Create, upload, and commit may be
separate internal requests. They remain one user-visible action.

Temporary upload addresses or credentials are transfer details. They are
short-lived, scoped to declared files, redacted, and handled inside the client.
They are not copied from an MCP client, exposed to the model, stored in a
project, or presented as a step the user must perform.

### The CLI keeps its own authenticated profiles

Remote interactive setup uses:

```text
artifactserver auth login https://team.example.com
artifactserver auth status
artifactserver auth logout
```

When the server advertises browser authorization, `auth login` opens it and the
CLI stores the resulting renewable credential in the operating-system
credential store. Profiles are keyed by the exact server origin and account.
The CLI renews credentials without asking the user to copy tokens.

A local installation obtains its private local credential from user-only
Artifact Server state without browser login or visible secrets. A self-hosted
server without compatible browser authorization uses an administrator-issued,
scoped API key stored in the same secure profile boundary. CI and unattended
automation use scoped service credentials supplied by their secret manager.

`artifactserver connect` continues to register an MCP connection in an AI
client. It is not renamed or overloaded as CLI login.

### The publishing skill routes by locality

`publish-artifact` decides which adapter to use:

- A local source or destination path uses the CLI.
- Server-only work may use the connected MCP server or the CLI.
- If a remote-only agent cannot access the requested local file, the skill says
  so and asks for a reachable execution path. It does not invent a server path.

The user asks for the product operation. The skill handles adapter selection.

## Consequences

- MCP and CLI capability overlap is deliberate and documented.
- Local file publishing becomes a release-critical CLI path rather than an MCP
  credential workaround.
- Product logic, authorization, idempotency, and audit behavior remain in one
  application layer.
- Cloud agents without a local process cannot publish a file that exists only
  on a user's computer.
- CLI authentication, secure credential storage, renewal, logout, structured
  output, interrupted-upload recovery, and secret-redaction tests are required
  before the publishing skill ships.

## References

- [MCP tools use JSON Schema arguments](https://modelcontextprotocol.io/specification/2026-07-28/server/tools).
- [Google Drive's remote MCP server exposes Drive operations](https://developers.google.com/workspace/drive/api/reference/mcp).
- [Google Drive uploads use simple, multipart, or resumable HTTP upload](https://developers.google.com/workspace/drive/api/guides/manage-uploads).
- [GitHub CLI stores login credentials in the system credential store](https://cli.github.com/manual/gh_auth_login).
- [AWS CLI caches SSO credentials after browser authorization](https://docs.aws.amazon.com/cli/latest/userguide/cli-configure-sso-tutorial.html).
