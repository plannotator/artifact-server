# Phase 4: File-first publishing client

Status: complete

## Outcome

One command publishes either one ordinary file or one finished directory:

```text
artifactserver publish ./report.pdf
artifactserver publish ./dist
```

The command returns the artifact ID, saved version ID, and browser links as
JSON. It works against a local installation by default and against a team
installation when the caller supplies that installation's URL and credential.

## Product boundary

- The input is a filesystem file or directory owned by the client.
- A directory must contain its entry file. The default is `index.html`; callers
  can name a different entry file explicitly.
- The client rejects symbolic links, special files, unsafe paths, `.git`
  metadata, empty directories, and directories with more than 10,000 files
  before creating an upload.
- The client calculates sizes and SHA-256 fingerprints, requests an upload
  plan, streams each file, then commits the upload.
- File bytes never appear as base64 or source strings in JSON or MCP.
- A remote server never reads a path or URL supplied by the client.
- New artifacts default to account-required access. Public access is explicit.
- Publishing a new version requires both the artifact ID and the exact current
  version ID.

## Implementation shape

The reusable Node client is independent of Commander. It accepts a typed
command, performs guarded local filesystem reads, and uses Effect's filesystem
and HTTP services for streaming and requests. The CLI supplies the Node
filesystem layer and fetch HTTP layer at the outer boundary.

```text
filesystem path
    -> inspect and hash regular files
    -> POST /api/v1/uploads
    -> PUT each server-issued upload URL
    -> POST the server-issued commit URL
    -> artifact, version, and browser links
```

The previous JSON routes that accepted base64 file contents are removed from
the public HTTP surface. Application-level publication operations remain
internal because the staged-upload service commits through them.

## Acceptance

- [x] A real local server process accepts one ordinary file through the CLI.
- [x] A real local server process accepts one finished multi-file directory
      through the same CLI command.
- [x] The published bytes open through the returned version link.
- [x] The CLI can publish a second immutable version using optimistic
      concurrency.
- [x] The CLI rejects a missing entry file, symbolic link, special file, and
      unsafe path without creating a server-side artifact. The server rejects
      client paths and remote source URLs.
- [x] The old JSON publication routes reject raw and base64 content and direct
      callers to the file-upload operation.
- [x] Credentials never appear in normal output, errors, or recorded evidence.
- [x] Client tests cover deterministic path preparation and media-type choices.
- [x] Process-level tests cover the real filesystem, HTTP server, upload store,
      repository, and browser-content path without module mocks.
- [x] Conformance IDs `PUB-002`, `PUB-011`, and `SCP-007` have behavioral and
      hostile evidence.
- [x] Oxlint, TypeScript, unit/integration tests, build, conformance checks,
      the coverage report, smoke tests, and the bounded performance baseline
      complete successfully.
