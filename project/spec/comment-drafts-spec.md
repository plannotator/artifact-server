# Comment drafts

Status: design for owner review — not implemented.
Owner direction (August 26, 2026): "scope out durable comments and draft,
I thought we already had that?" — half true. Comments and replies are
durable rows in all three backends, and dispatch work state survives
restarts. Drafts do not exist: composer text is React state, and a reload,
navigation, or crash discards it.

## 1. Design position

Drafts are server-side rows, not browser storage. The review application
deliberately keeps only UI preferences (theme, panel width) in
localStorage; comment text is content, and content in browser storage
leaks on shared machines and dies with the browser profile. Server-side
drafts are also what "durable" actually means: they survive reload and
server restart and follow the author across devices.

## 2. Model

One draft per author per composer context, upserted in place:

```
comment_drafts
  id TEXT PRIMARY KEY                  -- "cdr_" + UUID
  installation_id TEXT NOT NULL
  project_id TEXT NOT NULL
  artifact_id TEXT NOT NULL
  version_id TEXT                      -- NULL for artifact-level composers
  thread_id TEXT                       -- NULL = new-thread draft; set = reply draft
  principal_id TEXT NOT NULL
  body TEXT NOT NULL                   -- 1..8 KiB, same bound as comments
  path TEXT                           -- anchor context the composer held
  updated_at TEXT NOT NULL
  UNIQUE (installation_id, principal_id, artifact_id, thread_id, version_id)
```

All three backends, each by its own migration mechanics. Rows older than
30 days are deleted lazily on the author's next draft read — same
no-background-jobs posture as everything else.

## 3. API

| Route | Contract |
| --- | --- |
| `PUT /api/v1/projects/:projectId/artifacts/:artifactId/comments/draft` | Body `{body, threadId?, versionId?, path?}` → 204. Upsert by context. Empty `body` deletes. |
| `GET  …/comments/draft?threadId=&versionId=` | `{draft}` or `{draft: null}`. The author's own draft only. |
| `DELETE …/comments/draft?threadId=&versionId=` | 204, idempotent. |

Auth: any principal that can comment can draft; a draft is visible to its
author alone — never in comment listings, never to other members, never
over MCP. CMT-012 HTTP/MCP parity deliberately does not apply: drafts are
composer state for humans, agents compose in their own context. Record
that exemption in the ledger entry.

Posting the comment deletes the matching draft in the same transaction as
the create — a successful post can never leave a stale draft behind.

## 4. Web application

- Composers (new thread and reply) autosave the draft debounced (~1 s
  idle), restore silently on mount, and show a quiet "Draft" marker when
  restored, with a discard control.
- No autosave of empty text; clearing the field issues the delete.
- Failures are silent (drafting must never interrupt composing); the next
  successful autosave heals.

## 5. Conformance sketch (IDs reserved; ledger entries land with the build)

| ID | Behavior |
| --- | --- |
| DRF-001 | A draft autosaved in the composer survives page reload and server restart, restores into the same composer context, and is gone after the comment posts. |
| DRF-002 | Drafts are invisible outside their author: another member's listing and composer show nothing, MCP comment surfaces never return them, and a draft for one thread never restores into another. |

## 6. Cost

Moderate: one table across three backends, three small routes, composer
wiring in the review app, two conformance tests. No MCP work, no bridge
work.
