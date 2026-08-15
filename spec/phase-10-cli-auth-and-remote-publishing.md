# Phase 10: CLI authentication and remote publishing

Status: implemented locally; hosted provider activation remains gated

## Outcome

One installed `artifactserver` program can publish a local file or finished
directory to the local server or an exact remote Artifact Server without a
credential in the command, project, shell history, or output.

The user-facing commands are:

```text
artifactserver auth login https://team.example.com
artifactserver auth status
artifactserver auth logout
artifactserver publish ./dist --profile team --project prj_example
```

`publish` keeps its existing explicit `--server`, environment-token, and
token-file paths for CI and recovery. A saved profile is the normal interactive
remote path. Local publication continues to read the private local credential
from the selected local data directory without creating a remote profile.

## Profile model

The non-secret profile index is user-local state. Each profile records:

- a stable ID and human name;
- the exact normalized HTTP or HTTPS server origin;
- the authenticated Artifact Server principal and installation IDs;
- whether the credential is an OAuth grant or an Artifact Server API key;
- when the profile was created and last verified.

The origin has no path, query, fragment, embedded credentials, or implicit
cross-origin fallback. Profile names are unique. An origin and principal pair
identifies one profile. Project configuration may contain a profile name or
origin, but never a credential.

Remote secrets are stored under an opaque profile credential ID in the
operating-system credential store:

- macOS Keychain through `security`;
- Linux Secret Service through `secret-tool`;
- Windows Credential Manager through the native credential APIs invoked by
  PowerShell;
- an explicit credential-helper process for enterprise integration and tests.

Secrets go to helpers on standard input, not in process arguments. The profile
index contains no access token, refresh token, API key, authorization code,
client secret, or PKCE verifier. Artifact Server does not silently fall back to
plain-text remote credential storage when the operating-system store is
unavailable.

## Login modes

### Browser-authorized remote server

The CLI treats the remote HTTP API as its own OAuth protected resource. It
discovers the server's RFC 9728 metadata for the exact `<origin>/api` resource,
discovers the advertised authorization server, and performs an authorization
code flow with S256 PKCE in the system browser. The callback listener binds
only to a loopback IP and closes after one valid response.

The authorization server may identify the public CLI through a Client ID
Metadata Document or use Dynamic Client Registration during the compatibility
period. The CLI stores the returned access token, refresh token, client
registration, and discovery binding together in the operating-system
credential store. A refresh is attempted before a remote operation when the
access token is no longer accepted. Refresh never opens a browser; an invalid
grant tells the user to run `auth login` again.

The API resource and MCP resource are separate audiences. A CLI token issued
for `<origin>/api` is never accepted merely because a token for
`<origin>/mcp` would be valid, and the CLI never copies an MCP client's grant.

### Self-hosted remote server without browser authorization

`artifactserver auth login <origin> --api-key-stdin` reads one
administrator-issued scoped key from standard input, verifies it through the
server's session inspection endpoint, and stores it in the same secure profile
boundary. The command requires piped standard input and never accepts a key as
a command argument.

### Local and unattended use

Loopback publication with `--data` uses the existing private local credential
file. It does not create a profile or open a browser. CI supplies a scoped
service credential through `ARTIFACT_SERVER_API_TOKEN` or `--token-file`; the
CLI does not copy that credential into an interactive profile.

## Status and logout

`auth status` lists only profile name, origin, principal ID, installation ID,
credential kind, and verification state. It verifies the selected credential
against `GET /api/v1/session`, refreshing an OAuth grant when possible. It
never prints or decodes credential claims as proof of server acceptance.

`auth logout` removes both the operating-system credential and non-secret
profile record. OAuth grant revocation is attempted when the authorization
server advertises a revocation endpoint. Local deletion still completes when a
remote revoke endpoint is unavailable; the command reports that remote
revocation could not be confirmed.

## Publication path

Credential resolution order is explicit and fail-closed:

1. `ARTIFACT_SERVER_API_TOKEN` or `--token-file` with an explicit server;
2. `--profile <name>`;
3. an exact `--server <origin>` with exactly one saved matching profile;
4. the private local credential when a loopback server was selected;
5. the saved default profile when no server or profile was selected, otherwise
   the default local loopback server when no remote profile exists.

An ambiguous or missing selection is an error. The resolved bearer is passed
to the existing file publication client as a redacted value. File preparation,
upload-plan validation, concurrent streaming, idempotent commit, and result
decoding remain in that client. Output contains the project, artifact, exact
version, and canonical browser links; it does not contain upload URLs, local
paths, credentials, or retry state.

## Implementation boundaries

- `cli-profile-store` owns only non-secret profile metadata and atomic files.
- `system-credential-store` owns operating-system secret persistence.
- `cli-oauth-client` owns discovery, PKCE, callback, refresh, and revoke.
- `cli-auth-commands` composes login, status, and logout.
- `publish-command` resolves a credential, then calls the existing
  `file-publication-client`.
- HTTP, MCP, and CLI continue to reach the same application services and
  provider-neutral principal.

## Verification

The phase is complete only when these observable paths pass:

- real CLI processes log in with a scoped API key through standard input,
  report status without the key, publish a real file and directory to a real
  remote server, survive a server restart, and log out;
- two exact origins cannot use each other's profile credential;
- a real loopback OAuth test server proves discovery, browser redirect, state,
  S256 PKCE, code exchange, refresh, issuer binding, and logout revocation;
- malformed metadata, hostile callbacks, wrong state, wrong issuer, expired or
  revoked credentials, missing credential stores, and ambiguous profiles fail
  without leaking secrets;
- local publication and explicit CI credentials remain compatible;
- the compiled direct-local package includes and runs the same commands;
- lint, type checking, the complete test suite, bounded smoke and performance
  checks, and the conformance ledger pass.

Provider-specific hosted WorkOS activation remains gated on the separate
WorkOS staging and named-client matrix. Passing this phase proves the portable
CLI contract; it does not claim that an unconfigured deployment advertises
browser OAuth.

## Standards basis

- [OAuth 2.0 for Native Apps (RFC 8252)](https://www.rfc-editor.org/rfc/rfc8252)
  defines system-browser authorization, loopback callbacks, and PKCE for an
  installed CLI.
- [OAuth 2.0 Protected Resource Metadata (RFC 9728)](https://www.rfc-editor.org/rfc/rfc9728)
  defines how the CLI discovers the authorization server for the exact API
  resource.
- [WorkOS AuthKit CLI authorization](https://workos.com/docs/authkit/cli-auth)
  documents the hosted authorization-code and PKCE path that must pass staging
  before it is enabled for a hosted Artifact Server.
