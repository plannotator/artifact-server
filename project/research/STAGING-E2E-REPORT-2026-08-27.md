# Local and Cloudflare staging release qualification

Date: August 27, 2026

Source: `c210384`

Result: Passed the executed scope, with remaining manual scope listed below.

## Outcome

Artifact Server completed a real local-owner pass and a real private-team Cloudflare pass. The Cloudflare run used the existing staging installation at `https://staging.artifactserver.com`, WorkOS browser sign-in, D1, R2, the wildcard `agentartifacts.org` content domain, and live Pi, OpenCode, Claude Code, and MCP mailbox clients.

The run found two product or harness defects. Both are fixed in the current working tree:

1. The API-key form did not offer `comment:write`, so a key created for a live agent could not reply to comments without using another surface.
2. The coordinated recovery harness still expected an old D1 schema and did not provide the private-team OIDC variables required by a restored application.

The run also exposed an operational caveat: after the staging Worker was deliberately deleted, a normal Alchemy deploy reported no change and did not recreate the missing Worker or custom domain. `alchemy deploy --force` restored both. Staging is healthy after that forced deployment.

## What passed

### Local owner

- Started the real development application and API.
- Established the local-owner browser session.
- Published and reviewed a multi-file HTML artifact.
- Exercised Pi 0.84.2, OpenCode 1.18.23, Claude Code 2.1.247, and the MCP mailbox against localhost.
- Sent comments, received replies, resolved threads, and observed addressed dispatches.
- Exercised the primary one-click send-all path with Pi.

### Cloudflare staging

- Signed in through the real WorkOS staging provider.
- Published a four-file HTML artifact through the staging API.
- Opened its exact full-screen Review link.
- Loaded relative CSS, JavaScript, and SVG content from the isolated version host.
- Confirmed unauthenticated private raw content returns `401`.
- Exercised annotate and interact modes, focus mode, and exact-version-first sharing.
- Exercised live Pi, OpenCode, Claude channel, and MCP mailbox delivery through D1.
- Confirmed mailbox rendering names `comment_reply` and `comment_resolve`.
- Confirmed deleting a D1 comment held by a live dispatch returns `409 DISPATCH_STATE_CONFLICT`.
- Confirmed the MCP endpoint exposes 33 tools and Review exposes seven WebMCP tools.

### Coordinated recovery

The fresh recovery drill copied the staging D1 database and all 12 R2 objects into isolated recovery resources, started the restored application, and compared the source and restored state.

- D1 schema version: 9
- Foreign-key violations: 0
- Source and restored identity digest: equal
- Source and restored state digest: equal
- Source and restored object inventory digest: equal
- R2 bytes and metadata: exact for all 12 objects
- Restored health and readiness: `200`
- Dispatch, agent, thread, reply, member, key, session, and Git-history tables were included

The isolated recovery resources were deleted after the comparison. The original staging D1 database and R2 bucket were not replaced or mutated by the drill. See [`cloudflare-staging-recovery-2026-08-27.json`](../evidence/cloudflare-staging-recovery-2026-08-27.json).

### Cloudflare Artifacts Git history

A bounded follow-on run used the dedicated, initially empty `artifact-server-test-qualification` namespace. Both the REST adapter and remote Workers binding passed repository creation, deterministic commits, exact-version reads, short-lived repository credentials, smart HTTP, and deletion.

The complete Node product path then reported the provider available, estimated one saved version, enabled Git history for the default project, backfilled version 1, mirrored a newly published version 2, and produced a fresh read-only clone with two commits, two exact-version tags, and byte-identical files. Disabling the project removed clone access without deleting history. Deleting the artifact removed its derived repository. The namespace contained zero repositories after cleanup.

This run copied 530 fixture bytes and did not perform load or quota-pressure testing. See [`cloudflare-artifacts-live-qualification.json`](../evidence/cloudflare-artifacts-live-qualification.json).

## What remains unqualified

This pass does not prove every release claim. The following work remains separate:

- WorkOS refresh, revocation, and named-client lifecycle behavior.
- Cloudflare Artifacts load, quota-pressure, sustained-outage, retention, and regional behavior. The bounded normal integration is qualified; this run deliberately did not approach account limits.
- The exact OpenCode race where its target session is deleted between claim and host admission. The live attempt delivered before deletion; the automated hostile-path proof remains green.
- Image and video preview behavior in this run.
- Manual checklist rows that were not exercised and are still blank in the product-description repository.

## Evidence posture

The machine-readable summary is [`cloudflare-staging-e2e-2026-08-27.json`](../evidence/cloudflare-staging-e2e-2026-08-27.json). It contains resource names, product record IDs, results, and remaining scope, but no credentials or bootstrap tokens.

This report records observations from one release-qualification run. It does not change a document from drafted to verified unless that document's complete P1 and P2 checklist is satisfied or each failure is recorded in triage.
