# 0031: Upload grants for MCP file uploads

**Status:** Proposed
**Date:** October 12, 2026

Would amend PUB-001-F and the MCP upload wording. API keys, browser sessions,
the HTTP upload plan, and the commit step keep their behavior.

## Decision

`artifact_create_upload` returns an **upload grant** with its upload plan: a
short-lived bearer credential that authorizes only the file uploads of that
one upload. The agent sends it as `Authorization: Bearer` on each file `PUT`
and then commits through MCP as before.

| Request with the grant | Result |
| --- | --- |
| `PUT /api/v1/uploads/{id}/files/{token}` of its own upload, while open | the declared bytes are stored |
| the same route after commit or expiry | the upload's own `UPLOAD_CLOSED` or `UPLOAD_EXPIRED` error |
| any other upload, route, method, or project | `401 AUTHENTICATION_REQUIRED` |

## Why

The upload plan told the agent to send the file bytes "using the same bearer
credential" as MCP. The agent never holds that credential. An MCP client
keeps its OAuth tokens to itself, and the bundled skill forbids exposing the
MCP bearer credential to the model. The upload routes also accept only
Artifact Server API keys: 0028 keeps OAuth off `/api/` on purpose. So an MCP
client signed in through OAuth could create an upload but never send its
files, and publishing through MCP worked only when the model happened to know
an API key.

An upload grant gives the agent a credential it may hold: narrow, short-lived,
and useless for anything but the bytes the upload already declared.

## Recorded decisions

### One grant per upload

The grant is `as_upg_` followed by 32 random bytes in base64url. Every file of
an upload shares it. A grant per file would add nothing, because each file is
already bound to its declared size and SHA-256 fingerprint. The server stores
only the SHA-256 digest of the grant, in a nullable column on the staged
upload. No new server secret is needed.

### In the header, not the URL

The grant travels in the `Authorization` header. Proxies and access logs
record URLs, so the upload URL stays free of credentials, and clients keep the
request shape they already use.

### One route, one upload

The `/api/` authentication step accepts a grant only for `PUT` on the file
route. Anywhere else it answers `401 AUTHENTICATION_REQUIRED`, as for an
invalid API key, so no handler that expects a principal ever sees a grant. The file route compares the grant with
the stored digest in constant time and checks the `projectId` in the URL
against the upload's project. A wrong grant, an unknown upload, the wrong
project, and an upload without a grant all answer the same 401, whose status
and body do not say whether the upload exists.

### Checked when issued and at commit

Permission is checked when the grant is issued, because `artifact_create_upload`
runs the full publication check, and again at commit, because
`artifact_commit_upload` runs it on the live MCP credential. The grant itself
lets only the declared bytes in, like a presigned URL. A member deactivated
during an upload can still store those bytes until the upload expires, at most
one hour later, but cannot publish them. Expiry cleanup removes them.

### Lifetime follows the upload

The grant expires with its upload and stops working once the upload is
committed. There is no separate lifetime setting.

### Only MCP plans carry a grant

`POST /api/v1/uploads` issues no grant: HTTP and CLI callers already hold a
credential that `/api/` accepts. An API key still authorizes the file `PUT`
for clients that have one. Uploads created before an upgrade have no grant and
keep working with API keys until they expire.

### The plan names the grant

Each planned file's `authorization.credential` changes from
`reuse_the_mcp_bearer_credential` to `upload_grant`, and the plan gains
`uploadGrant: {scheme, token, expiresAt}` once per upload. The old value named
a credential the agent is never given, so the change fixes a contract that
could not be followed.

## Requirements

- **PUB-014:** an MCP upload plan carries an upload grant that authorizes only
  that upload's file uploads, so a client without an Artifact Server API key
  can publish through MCP.
- **PUB-001-F** gains one exception: a holder of the upload's grant may append
  its declared files.

## Rejected alternatives

### Accept the MCP OAuth token on the upload route

It reuses a token issued for the MCP resource on a different resource, which
breaks the audience binding 0028 relies on. It also does not help the agent,
which never holds that token.

### OAuth on the whole HTTP API

0028 excludes it. MCP clients would still need a second token for a second
resource, and the agent would still not hold it.

### A signed, stateless grant

An HMAC over the upload id and expiry needs no column but needs a new server
secret that every deployment must generate, store, and rotate. A stored digest
follows the pattern API keys, browser sessions, and content bootstraps already
use.
