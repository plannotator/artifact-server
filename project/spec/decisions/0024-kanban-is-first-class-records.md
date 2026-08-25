# 0024: The Kanban board is first-class records

**Status:** Proposed
**Date:** August 19, 2026

## Decision

Each project's Kanban board is stored as ordinary database records — one
`kanban_cards` table behind a repository port on all three backends —
following the artifact-comments precedent exactly: project scoping,
capability-checked writes, per-record optimistic concurrency, idempotent
creates, action records, and HTTP/MCP/web parity. It is **not** stored as an
artifact.

## Recorded decisions

### Why not board-as-an-artifact (v0's design)

v0 stored the board as a managed artifact (`.plannotator/kanban.json`) and it
was elegant *because v0 artifacts were mutable*: a board write was a cheap
SHA-guarded overwrite. In this product an artifact write is an immutable
version, so the same design becomes one of two bad shapes:

- **Versioned board:** every drag is a publish — version lists polluted,
  current-version pointer churn, meaningless comparisons, and a violation of
  the rule that API/MCP arguments never carry raw file contents.
- **Version-exempt system artifact:** a second artifact kind with different
  immutability, delivery, and audit semantics threaded through every backend,
  origin, and surface — enormous blast radius for one small feature.

Mutable, collaborative, fine-grained state already has a solved pattern in
this codebase: comments. The board copies it.

### What carries over from v0 unchanged

Four fixed columns (`backlog`, `in_progress`, `review`, `done`); card bounds
(title ≤ 200, description ≤ 20 000, ≤ 8 labels of ≤ 32 chars, assignee ≤ 80,
≤ 50 attachments); `paused` only in `in_progress`; per-card `revision` so
edits to different cards merge while same-card edits conflict; client-supplied
card IDs for idempotent creates; move-by-`beforeCardId` with server-assigned
dense positions; attachments that survive artifact deletion as explicit
missing attachments; the collapsed-Done, drag-and-drop, card-inspector
interaction design as the web reference.

### What is dropped

The board-level revision (per-card revisions plus server-assigned positions
leave it nothing to protect) and the deterministic board-artifact UUID (there
is no board artifact).

## Rejected alternatives

Recorded above: versioned board artifact, version-exempt system artifact.
Also rejected: per-installation (cross-project) boards — the project is the
collaboration boundary everywhere else in the product, and a cross-project
board would need its own authorization story.
