# Artifact comments

**Status:** Accepted; implemented — CMT-001 through CMT-015 are behavior-verified on the local deployment. CMT-014 (review-viewer containment) and CMT-015 (artifact-first viewer shell) use the durable Playwright report at `project/evidence/browser.json`; broader deployment release gates remain separate (August 23, 2026)
**Date:** August 17, 2026
**Owner:** Artifact Server product engineering
**Companion documents:** [Product specification](./artifact-server-product-spec.md), [Plannotator and Artifact Server integration](./plannotator-artifact-server-integration-spec.md), [Conformance ledger](./conformance.yml)

## 1. What this changes and why

Artifact Server gains first-class comment threads on artifact versions: create, reply, resolve, reopen, edit, delete, list, and poll, through the HTTP API, MCP, and the web application.

This reverses a written product decision. Today the product specification lists comments, annotations, and review workflow under "what stays outside it" (`artifact-server-product-spec.md:25`, `:231`, `:241`, `:490`) and the conformance ledger records the exclusion as `SCP-003` and the ownership split as `PLN-003`. The reason to change it: a comment on a published artifact belongs next to the immutable version it was made on, and Artifact Server's users and agents need to leave and answer feedback without a second product.

Workspaces is not part of this work. The only tie is deliberate: the data model and vocabulary below copy the Workspaces comment model (`annotations` / `annotation_replies`) so the two products describe a comment the same way. No Workspaces integration, client, or migration is designed, assumed, or required here.

The changes that go with this spec when it is approved:

| Where | Change |
| --- | --- |
| `project/spec/decisions/0019-artifact-comments.md` | New ADR: Artifact Server stores comment threads on its own artifact versions, using the Workspaces comment vocabulary. |
| `project/spec/artifact-server-product-spec.md` | Row 25 drops "comments, annotations, review workflow"; the Plannotator section (`:231`, `:241`) no longer claims Artifact Server stores no comment record; `:490` out-of-scope list drops comments and replies. |
| `project/spec/conformance.yml` | `SCP-003` narrows to "notifications, workspace collaboration, workspace membership"; `PLN-003` drops the claim that Artifact Server stores no comment or reply; new `CMT-001…CMT-012` (section 11); `PLN-009/010` (review bridge) unchanged and remain the reference for in-page anchoring. |
| `project/spec/artifact-server-mcp-baseline.md` | Seven new tools (section 8). |

What does not change: Artifact Server adds no organization, no workspace, no notification, and no live push. Nothing in Workspaces changes.

## 2. Vocabulary (deliberately borrowed from Workspaces)

| Term | Meaning here | Workspaces equivalent |
| --- | --- | --- |
| Comment thread | One root comment on one exact artifact version, optionally on one file inside it, with a client-owned anchor. Has a state. | `annotations` row |
| Reply | One follow-up on a thread. One level; no reply to a reply. No state, no anchor. | `annotation_replies` row |
| State | `open` or `resolved`. Reopen is the same operation as resolve with the other value. | `state` |
| Anchor | Opaque JSON the client owns; the server validates only size and, when present, that a top-level `point` has `x` and `y` in 0..1. | `anchor_json` |
| Author | The principal that made the write, denormalized as `principalId`, `principalKind`, `displayName`, `authorizedByPrincipalId`. | `author`, `author_name`, `agent_id`, `agent_name`, `author_via` |

The MCP argument names below mirror the Workspaces `workspaces.*_annotation` tools where a field means the same thing (`body`, `anchor`, `state`, `resolved`), and Artifact Server names where the concept is Artifact Server's (`artifactId`, `versionId`, `projectId`, `idempotencyKey`).

## 3. Model

Two records. Both are project-scoped and installation-scoped like everything else in `src/core/model.ts`.

```ts
/** One root comment on one exact saved version. */
export interface CommentThreadRecord {
  readonly id: string;                       // "cmt_" + UUID
  readonly installationId: string;
  readonly projectId: string;
  readonly artifactId: string;
  readonly versionId: string;                // always an exact version, never "current"
  readonly path: string | null;              // manifest entry path inside the version; null = the whole version
  readonly anchor: unknown | null;           // opaque JSON, ≤ 16 KiB serialized
  readonly body: string;                     // 1..8 192 characters after trim
  readonly state: "open" | "resolved";
  readonly author: CommentAuthor;
  readonly resolvedAt: string | null;
  readonly resolvedBy: CommentAuthor | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly replyCount: number;               // derived on read
}

/** One follow-up inside a thread. */
export interface CommentReplyRecord {
  readonly id: string;                       // "rpl_" + UUID
  readonly threadId: string;
  readonly projectId: string;
  readonly body: string;                     // 1..8 192 characters
  readonly author: CommentAuthor;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface CommentAuthor {
  readonly principalId: string;              // member_…, service:key_…, local-api-token
  readonly principalKind: "human" | "service";
  readonly displayName: string;              // captured at write time, never re-read
  readonly authorizedByPrincipalId: string | null;
}
```

Invariants the repository enforces in one transaction:

1. `versionId` must be a saved version of `artifactId` in `projectId`; the artifact must not be tombstoned. Deleting an artifact (tombstone) hides its threads from listing; it does not delete them (same retention posture as versions).
2. `path`, when present, must be an entry path in that version's manifest (`manifest_entries (version_id, path)`). Because versions are immutable this check is exact and permanent; a comment can never point at a file that later disappears.
3. A reply can be added only while the thread is `open`; the check and the insert happen in the same transaction so a concurrent resolve cannot slip a reply into a resolved thread.
4. Deleting a thread deletes its replies in the same transaction.
5. `installationId` and `projectId` come from the trusted request context, never from the body.

Anchor rule, copied from Workspaces `refineAnchorPointContract` so the two clients can share renderers: the server never interprets the anchor except that if a top-level `point` object exists it must have numeric `x` and `y` in `[0, 1]`. Everything else (`kind: "page"`, `htmlAnchor`, `startMeta`/`endMeta`, future `pdfPage`, `timestamp`) is client vocabulary. Early clients emit `{kind:"page"}` (whole file); the in-page anchoring slice adds the Workspaces `htmlAnchor` / `startMeta` shapes.

Author display name: `Principal` in `src/core/identity.ts` has no name today, and member listing is administrator-only, so a reader cannot resolve `member_…` ids. `Principal` gains `displayName: string`, populated where principals are built: `humanPrincipal(member)` uses `member.displayName`; managed API keys use the key's `name` (or the bound member's name for member-bound keys); the deployment token uses `"Deployment token"`; the local principal uses `"Local"`; the MCP adapter and CLI profile schemas add the field as optional and default it. The comment row copies the value at write time (Workspaces `author_name` semantics), so renames do not rewrite history.

## 4. Storage

One new port in `src/core/ports.ts`:

```ts
export interface CommentRepository {
  createThread(command: CreateCommentThread): Promise<CommentThreadRecord>;
  findThread(projectId: string, artifactId: string, threadId: string): Promise<CommentThreadRecord | null>;
  listThreads(command: ListCommentThreads): Promise<CommentThreadPage>;   // keyset on (createdAt, id); filters: versionId?, state? (since? filters updatedAt, inclusive)
  updateThread(command: UpdateCommentThread): Promise<CommentThreadRecord>;   // body and/or anchor and/or state
  deleteThread(command: DeleteCommentThread): Promise<CommentThreadDeletion>;
  createReply(command: CreateCommentReply): Promise<CommentReplyRecord>;
  listReplies(threadId: string): Promise<readonly CommentReplyRecord[]>;    // threads are small; no paging on replies
  updateReply(command: UpdateCommentReply): Promise<CommentReplyRecord>;
  deleteReply(command: DeleteCommentReply): Promise<void>;
  findIdempotentThread(projectId: string, idempotencyKey: string): Promise<CommentThreadRecord | null>;
  findIdempotentReply(projectId: string, idempotencyKey: string): Promise<CommentReplyRecord | null>;
}
```

`IdGenerator` gains `commentThreadId()` and `commentReplyId()`.

Three implementations, one per existing SQL backend, each behind the same conformance tests:

| Backend | File | Migration |
| --- | --- | --- |
| SQLite (local, compact Compose) | `src/storage/sqlite-artifact-repository.ts` (or a sibling `sqlite-comment-repository.ts` sharing the `DatabaseSync`) | `requiredSqliteSchemaVersion` 4 → 5 |
| Postgres (single server, Kubernetes, AWS, GCP) | `src/storage/postgres-comment-repository.ts` | `requiredPostgresSchemaVersion` 3 → 4 |
| D1 (Cloudflare) | `deploy/cloudflare/src/d1-comment-repository.ts` | next entry in `d1-migrations.ts` |

Tables (SQLite dialect; Postgres and D1 are the same shape):

```sql
CREATE TABLE comment_threads (
  id TEXT PRIMARY KEY,
  installation_id TEXT NOT NULL,
  project_id TEXT NOT NULL REFERENCES projects(id),
  artifact_id TEXT NOT NULL REFERENCES artifacts(id),
  version_id TEXT NOT NULL REFERENCES versions(id),
  path TEXT,
  anchor_json TEXT,
  body TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('open', 'resolved')),
  author_principal_id TEXT NOT NULL,
  author_principal_kind TEXT NOT NULL CHECK (author_principal_kind IN ('human', 'service')),
  author_display_name TEXT NOT NULL,
  author_authorized_by_principal_id TEXT,
  resolved_at TEXT,
  resolved_by_principal_id TEXT,
  resolved_by_display_name TEXT,
  idempotency_key TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (project_id, idempotency_key)
) STRICT;

CREATE TABLE comment_replies (
  id TEXT PRIMARY KEY,
  thread_id TEXT NOT NULL REFERENCES comment_threads(id) ON DELETE CASCADE,
  project_id TEXT NOT NULL REFERENCES projects(id),
  body TEXT NOT NULL,
  author_principal_id TEXT NOT NULL,
  author_principal_kind TEXT NOT NULL CHECK (author_principal_kind IN ('human', 'service')),
  author_display_name TEXT NOT NULL,
  author_authorized_by_principal_id TEXT,
  idempotency_key TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (project_id, idempotency_key)
) STRICT;

CREATE INDEX comment_threads_artifact_created ON comment_threads (artifact_id, created_at DESC, id DESC);
CREATE INDEX comment_threads_version_created  ON comment_threads (version_id, created_at DESC, id DESC);
CREATE INDEX comment_threads_updated          ON comment_threads (artifact_id, updated_at);
CREATE INDEX comment_replies_thread_created   ON comment_replies (thread_id, created_at, id);
```

Idempotency: creates carry a required `Idempotency-Key` (16..200 characters, the existing `parseIdempotencyKey`). The key is stored on the row; a replay with the same key in the same project returns the original row with `replayed: true`. This is the same duplicate-post guard Artifact Server already applies to publishes and management mutations. Updates, resolves, and deletes are idempotent by nature and take no key.

Audit: every comment mutation appends to the existing `actions` ledger (`AUD-001`) with new `ArtifactActionKind` values `comment_create`, `comment_reply`, `comment_update`, `comment_resolve`, `comment_reopen`, `comment_delete`. The ledger already has `artifact_id`, `version_id`, `principal_id`, `authorized_by_principal_id`, and `idempotency_key`, so no schema change there; `idempotency_key` for non-create comment actions is `comment:<threadId>:<updatedAt>`. The actions route stays as it is (management-gated, no new filter); the web `ActionHistory` gains labels for the six new kinds.

Backups: the two tables live in the same database as artifacts; every existing backup and restore path covers them with no new step. Nothing is stored in blob storage.

## 5. Access

Reuses `AuthorizationService` (`src/application/authorization.ts`) with three additions. No per-artifact ACL, no per-project member list (`SCP-008` still holds).

| Operation | Rule | New code |
| --- | --- | --- |
| List and read threads and replies | Same as reading artifact history: `requireArtifactRead` (direct human member, or key with `artifact:read` / `artifact:manage:any`). Public-link viewers never see comments; comments are never served from the content origin. | none |
| Create thread, reply, resolve, reopen | Any direct human member, or a service principal with the new capability `comment:write`. | `principalCapabilities.writeComments = "comment:write"`, `requireCommentWrite` |
| Edit body or anchor (thread or reply) | Only the author: `principal.id === author.principalId`. Administrators cannot edit other people's comments. | `requireCommentAuthor(principal, author)` |
| Delete (thread or reply) | The author, or a human administrator, or a service principal with `artifact:manage:any`. | `requireCommentAuthorOrAdministration(principal, author)` |
| Every operation | Installation must match; project must resolve; archived projects reject writes (`ProjectArchived`) and allow reads. Cross-project ids fail as not-found without disclosure. | existing |

Owner's rule (August 17, 2026): you can edit only what you wrote; an administrator can delete anyone's comment but cannot rewrite it. Nobody except the author can change the words attributed to that author. This is stricter than Workspaces (edit-gated, no author gate) on purpose: Artifact Server has per-person accounts, an audit ledger, and agents posting under service principals, so an agent or coworker must not be able to alter a person's note. Deleting a thread by an administrator also deletes its replies (section 3, invariant 4) and records `comment_delete` with the administrator as principal.

Author identity for a service principal is the key's `principalId` (`service:key_…`), so a rotated key is a different author; that is acceptable and matches how the action ledger already attributes keys.

## 6. Application service

`src/application/artifact-comments.ts`, `ArtifactCommentService`, built with `Context.Service` and `Layer.effect` like `ArtifactManagementService`; depends on `AuthorizationService`, `ProjectManagementService`, an `ArtifactCommentRepository` (Effect-wrapped view of the port, same wrapping pattern as `ArtifactManagementRepository`), and `ApplicationClock`. Operations:

```
createThread({principal, projectId, artifactId, versionId, path, anchor, body, idempotencyKey})
listThreads({principal, projectId, artifactId, versionId?, state?, since?, cursor, limit})   // limit 1..100
getThread({principal, projectId, artifactId, threadId})                                     // thread + replies
updateThread({principal, projectId, artifactId, threadId, body?, anchor?, state?})
deleteThread({principal, projectId, artifactId, threadId})
createReply({principal, projectId, artifactId, threadId, body, idempotencyKey})
updateReply({principal, projectId, artifactId, threadId, replyId, body})
deleteReply({principal, projectId, artifactId, threadId, replyId})
```

Order inside every operation: resolve project → authorize → load artifact (not tombstoned) → load version (exact) → validate input → repository transaction → action record. Same order as `ArtifactManagementService.getArtifact`, so failure precedence (project not found before artifact not found before authorization) matches the rest of the API.

New errors in `src/core/errors.ts`:

| Code | HTTP | When |
| --- | --- | --- |
| `COMMENT_NOT_FOUND` | 404 | Thread or reply does not exist in the resolved project and artifact. |
| `COMMENT_RESOLVED` | 409 | Reply attempted on a resolved thread. Mirrors Workspaces `annotation_resolved`. |
| `INVALID_COMMENT` | 422 | Body empty or > 8 192 characters; anchor > 16 KiB or fails the point rule; `path` not in the version manifest. |
| `IDEMPOTENCY_CONFLICT` | 409 | Existing code; same key with different input. |

Limits live in `src/core/publishing-limits.ts` next to the existing ones: `maximumCommentBodyCharacters = 8_192`, `maximumCommentAnchorBytes = 16_384`, `maximumCommentPageSize = 100`.

## 7. HTTP API

All under `/api/v1`, all `account_required` in effect (bearer or session), all accept `?projectId=` like the artifact routes, JSON bodies through `boundedJsonBody`.

| Method and path | Body / query | Returns |
| --- | --- | --- |
| `GET /artifacts/:artifactId/comments` | `?versionId=` `?state=open\|resolved` `?since=<ISO>` `?cursor=` `?limit=` | `{items: Thread[], nextCursor}`; each `Thread` includes `replyCount` and `links.version` (the exact-version browser link) |
| `POST /artifacts/:artifactId/versions/:versionId/comments` | header `Idempotency-Key`; `{path?, anchor?, body}` | `201 {thread, replayed}` |
| `GET /artifacts/:artifactId/comments/:threadId` | | `{thread, replies: Reply[]}` |
| `PATCH /artifacts/:artifactId/comments/:threadId` | `{body?, anchor?, state?}` (at least one) | `{thread}` |
| `DELETE /artifacts/:artifactId/comments/:threadId` | | `204` |
| `POST /artifacts/:artifactId/comments/:threadId/replies` | header `Idempotency-Key`; `{body}` | `201 {reply, replayed}` |
| `PATCH /artifacts/:artifactId/comments/:threadId/replies/:replyId` | `{body}` | `{reply}` |
| `DELETE /artifacts/:artifactId/comments/:threadId/replies/:replyId` | | `204` |

Wire shape for a thread (camelCase, same conventions as `versionResponse`):

```json
{
  "id": "cmt_…", "artifactId": "art_…", "versionId": "ver_…", "projectId": "prj_…",
  "path": "index.html", "anchor": {"kind": "element", "htmlAnchor": {"selector": "…", "text": "…", "point": {"x": 0.42, "y": 0.13}}},
  "body": "This chart's axis label is wrong.",
  "state": "open",
  "author": {"principalId": "member_…", "principalKind": "human", "displayName": "Michael Ramos", "authorizedByPrincipalId": null},
  "resolvedAt": null, "resolvedBy": null,
  "replyCount": 2,
  "createdAt": "2026-08-17T18:04:11.000Z", "updatedAt": "2026-08-17T18:09:40.000Z",
  "links": {"self": "/api/v1/artifacts/art_…/comments/cmt_…", "version": "/api/v1/artifacts/art_…/versions/ver_…"}
}
```

`?since=` filters on `updatedAt` so a poller sees resolves and edits, not only new threads. Replies bump the parent thread's `updatedAt` for the same reason. The service normalizes `since` to the stored millisecond ISO form, so a second-precision instant names the second it opens rather than the instant after it. Delivery is at least once, not exactly once: the filter is inclusive (`updatedAt >= since`), and the keyset runs on `(createdAt, id)`, so an edit made to an already-paged thread during a pass belongs to the next pass. A poller therefore advances `since` to the time its pass **started**, not to the newest `updatedAt` it saw, and tolerates repeats.

### Version file read for the review viewer

One additional authenticated app-origin route supports the in-page review viewer (section 9a):

| Method and path | Query | Returns |
| --- | --- | --- |
| `GET /artifacts/:artifactId/versions/:versionId/file` | `?projectId=` `?path=<manifest path>` | The stored bytes of that manifest entry. |

Authorization is `requireArtifactRead` (same as reading history). The response is deliberately non-renderable on the app origin: `Content-Type: application/octet-stream`, `X-Content-Type-Options: nosniff`, `Content-Disposition: attachment`. Because the route names one immutable version, it serves a strong `ETag` (the entry's SHA-256), answers `If-None-Match` with `304`, supports single byte ranges, and uses `Cache-Control: private, max-age=31536000, immutable` so only the signed-in browser caches the bytes. Navigating to it downloads; only `fetch()` from the signed-in app can use it. It never serves on the content domain and changes nothing about content sessions (`AUTH-015`, `PLN-008` untouched).

## 8. MCP tools

Follow the existing `noun_verb` naming in `src/mcp/artifact-mcp-server.ts` (`artifact_list`, `artifact_set_tags`, …). Seven tools; annotations use the existing `readOnlyAnnotations` and `idempotentWriteAnnotations` objects.

| Tool | Input | Output |
| --- | --- | --- |
| `comment_list` | `{artifactId, projectId?, versionId?, state?, since?, cursor?, limit?}` | `{items, nextCursor}` (threads without replies) |
| `comment_get` | `{artifactId, threadId, projectId?}` | `{thread, replies}` |
| `comment_create` | `{artifactId, versionId, projectId?, path?, anchor?, body, idempotencyKey}` | `{thread, replayed}` |
| `comment_reply` | `{artifactId, threadId, projectId?, body, idempotencyKey}` | `{reply, replayed}` |
| `comment_resolve` | `{artifactId, threadId, projectId?, resolved: boolean}` (`false` reopens) | `{thread}` |
| `comment_update` | `{artifactId, threadId, projectId?, replyId?, body?, anchor?}` (`replyId` targets a reply; `anchor` only valid without `replyId`) | `{thread}` or `{reply}` |
| `comment_delete` | `{artifactId, threadId, projectId?, replyId?}` | `{deleted: true}` |

`artifact_capabilities` gains `comments: {maximumBodyCharacters, maximumAnchorBytes, anchorRule: "opaque; top-level point.x and point.y must be 0..1"}` so an agent can read the limits before writing.

The artifact route of the `artifact-server` Agent Skill gets one paragraph: after publishing, call `comment_list` on the previous version to see whether reviewers left open threads, and reply or resolve as appropriate. No auto-reply behavior.

## 9. Web application

Two surfaces.

**Comments tab** in `apps/web/src/review/review-comments.tsx`, inside the canonical Review inspector:

- Thread list across all versions, newest activity first, filter by state and by version, with a "review this version" link per thread.
- Thread detail: body, author, anchor summary, replies, reply box, resolve/reopen button, edit (author only) and delete (author or admin).
- Version cards show open-thread count.

**Review view**, a new app route (added to the server shell-route allowlist) that shows one exact HTML version with Plannotator-grade in-page commenting: crosshair pinpoint mode, hover outline box with the element-label pill, click to pin, numbered speech-bubble markers at the anchored elements, text-selection highlights, a compose popover at the pin, and a synced thread panel beside the page. Selecting a pin focuses its thread; resolving hides or dims its marker. Non-HTML entries (images, PDFs) fall back to the Comments tab with whole-file anchors.

The review route owns the viewport instead of rendering inside the management
application shell. One compact viewer bar identifies the artifact and exact
version and exposes back, comments, version navigation, linked-source state,
sharing, and focus controls. The artifact is the only open surface by default.
Comments and version navigation open deliberately, dock beside the artifact on
wide screens, and overlay it on narrow screens. Focus mode removes both the bar
and side surfaces while keeping an explicit visible control that restores them.
The state is URL-backed as `view=focus`. A publication review link names the
project, artifact, and exact version and opens directly in this mode, so refresh,
browser history, team sign-in, and shared review handoffs preserve the same saved
version and commenting surface.
The first shell slice adds no product-specific keyboard shortcuts; normal
browser focus and button semantics remain intact.

### Review route resolution

The project, artifact, and version named in a Review URL are authoritative. The
application resolves the artifact and version through their direct API routes;
the paginated catalog is navigation context only. A target that is not in the
loaded catalog may be shown as a pinned selected row after it resolves. An
unknown, deleted, cross-project, or mismatched target produces an explicit
unavailable state. It never selects the first catalog row or the current version
as a substitute.

### Exact-version sharing

Share receives the resolved selected version, not only the artifact's current
state. Its primary action copies the server-issued exact Review URL with
`view=focus`; the browser adds a selected manifest path when it is not the entry
path. The stable moving artifact link is labeled **Latest**, and the immutable
content-origin link is labeled **Raw**. Agent prompts lead with the same exact
Review URL. Share remains unavailable until the selected version resolves.

### Complete Review conversations

Review displays every reply under its root comment without a second expansion
step. An authorized reviewer can create replies on open threads, edit their own
replies, and delete replies allowed by the existing authorship and artifact
management rules. Reload and incremental polling refresh both thread summaries
and reply bodies, so Review never shows a reply count without the corresponding
conversation.

`apps/web/src/api/client.ts` gains the eight comment calls plus the file read, with zod schemas mirroring section 7.

## 9a. Review viewer architecture

The in-page experience reuses Plannotator's own HTML annotation machinery (`@plannotator/ui@0.30.0`, `components/html-viewer`: `HtmlViewer`, `bridge-script`, `srcdoc`, `useHtmlAnnotation` — a props-driven host surface since 0.29.0). Its security model transplants unchanged: the artifact document is rendered from a **`srcdoc` iframe with `sandbox="allow-scripts"` and no `allow-same-origin`** — an opaque origin holding no credential and no reachable API — with the annotation bridge script and CSS spliced into `<head>` and every bridge message source-checked and shape-validated on both sides. The page DOM is never mutated; hover and pins are fixed-position overlay layers.

The frame chain solves the app-shell CSP problem without weakening it:

```
app shell (strict CSP, unchanged)
└── iframe /review-frame          same origin; its own document CSP permits the inline
    │                             bridge and artifact styles/scripts inside its subtree
    └── iframe srcdoc, sandbox="allow-scripts"   the artifact + bridge (opaque origin)
```

- `/review-frame` is a second Vite entry in `apps/web`, served by both the Node asset handler and the Cloudflare worker with its own headers: a content-permissive CSP (inline scripts and styles allowed, wide `img-src`/`font-src`/`media-src` — the content domain serves artifacts with no CSP at all today, so this grants the sandbox nothing new) and `frame-ancestors 'self'`. The app shell's own strict CSP is untouched; `default-src 'self'` already permits framing a same-origin document.
- The app fetches HTML over the section-7 file route and hands the bytes to `/review-frame` by `postMessage`; `/review-frame` renders `HtmlViewer`, which builds the injected `srcdoc`.
- Public current versions use their immutable version origin as the injected base. Private and historical versions use a short-lived preview lease. The lease token is an opaque content-host label, is bound to one exact immutable version and principal, permits only `GET` and `HEAD`, and can return only paths in that version's manifest. The base includes the selected HTML entry's directory so both relative and root-relative references stay on the leased version origin.
- Preview leases are persisted as exact-version content sessions but are resolved by their own host-label route. They are never set as cookies, never appear in the Review URL, do not authorize application APIs or another version, expire after the bounded preview lifetime, and return private `no-store` responses. The raw exact-version bootstrap and host-only `SameSite=Strict` content cookie remain unchanged for top-level raw navigation.
- Host↔frame protocol (versioned, source-checked both ways): parent → frame `init {html, theme tokens, annotations, readOnly}`, `annotations-changed`, `focus {threadId}`; frame → parent `ready`, `draft {anchor, originalText, targets}`, `submit {anchor, body, targets}`, `select {threadId}`, `resize`. The frame never sees a credential; every comment API call happens in the app document.
- Anchors ride the bridge's fail-closed `HtmlElementAnchor` builder unchanged and are stored in the Workspaces wire shape (`originalText`, `htmlAnchor`, `htmlAdditionalTargets`, top-level `point` 0..1), so the server's opaque-anchor rule needs nothing new.
- What this does not touch: raw content sessions stay `SameSite=Strict`, host-only, and top-level only; preview leases create no cookie; content responses gain no application credential; `SEC-001`'s hostile-artifact posture is preserved because artifact JavaScript executes only inside the opaque-origin sandbox and the lease can read only the exact bytes already being reviewed.

## 10. What is out, and how it is sliced

Not in this spec at all: reactions, edit history, `@mentions`, notifications, email, Slack, live push or WebSockets, nested threads, per-artifact permissions, agent auto-replies, activation of threads for agents.

Slicing is decided iteratively by the implementer, each slice verifiable end to end and green under `pnpm verify:iteration` before the next starts. The natural order, subject to change as the work reveals more:

1. Model, `CommentRepository` on SQLite, `ArtifactCommentService`, HTTP routes, conformance tests `CMT-001…011` on SQLite. Whole-file anchors only.
2. MCP tools and `artifact_capabilities` update; the Agent Skill paragraph; `CMT-012`.
3. Postgres and D1 repositories through the existing external-storage and Cloudflare harnesses.
4. Web application Comments tab (section 9).
5. In-page anchoring: rendering and placing anchors on the served content (click an element, select text). This is the "review bridge" already specified as `PLN-009/010`; it needs an isolated review origin, no reusable credential in the page, and hostile-JavaScript tests (`SEC-001`). It sits on top of this model without changing it: it starts emitting and rendering `htmlAnchor` / `startMeta` anchors instead of `{kind:"page"}`.

Later candidates: PDF page and region anchors, video timestamps (Plannotator's `{kind:'video', timestamp}`), a cross-artifact `GET /api/v1/comments?state=open` inbox.

## 11. Conformance requirements to add

Module `artifact-comments` (new entry in `allowed_modules`). Deployments `*all`.

| ID | Kind | Behavior (short) | Failure test |
| --- | --- | --- | --- |
| CMT-001 | behavior | A comment thread is created on one exact saved version and continues to reference that version after later publishes and restores. | Publishing v2 and restoring v1 change nothing on a thread made on v1; a thread on a nonexistent version is rejected. |
| CMT-002 | behavior | A thread may name one manifest entry path inside its version; the path is validated against that version's manifest. | Unknown path → `INVALID_COMMENT`; no thread created. |
| CMT-003 | behavior | Anchors are opaque up to 16 KiB; a top-level `point` must have `x` and `y` in 0..1. | Oversize anchor and out-of-range point are rejected; the anchor is otherwise stored byte-for-byte. |
| CMT-004 | behavior | Replies are one level and only on open threads. | Reply on resolved thread → `COMMENT_RESOLVED`; concurrent resolve-and-reply never leaves a reply on a resolved thread. |
| CMT-005 | behavior | Resolve and reopen are the same `PATCH {state}`; both record who and when. | Invalid state value rejected; a resolved thread lists as resolved from every backend. |
| CMT-006 | security | Reading comments requires artifact read authority; comments never appear on the content origin or through a public link. | Public-link viewer and anonymous request get 401/403; content-domain routes never return comment data. |
| CMT-007 | security | Creating threads, replies, resolves, and reopens requires a direct human member or `comment:write`. | A key with only `artifact:read` is denied. |
| CMT-008 | security | Only the author can edit a thread or reply; the author, a human administrator, or `artifact:manage:any` can delete one. | Another member's edit and delete are denied; an administrator's edit of someone else's comment is denied while the administrator's delete succeeds and is recorded. |
| CMT-009 | security | Every comment operation is project-scoped; a cross-project or cross-installation id fails as not-found without disclosure. | Same ids under a different `projectId` → 404. |
| CMT-010 | behavior | Creates are idempotent by `Idempotency-Key`; replay returns the original with `replayed: true`. | Same key with a different body → `IDEMPOTENCY_CONFLICT`; no duplicate row. |
| CMT-011 | behavior | Every comment mutation appends an attributed action record with the thread's artifact and version. | A mutation cannot commit without an action record (same transaction). |
| CMT-012 | behavior | The HTTP API, MCP tools, and web application expose the same operations with the same authorization; `?since=` and cursor paging return every change at least once for a poller that resumes from the time its previous pass started. | MCP and HTTP produce identical results for the same principal; a poll resuming from the previous pass start misses no update. |
| CMT-013 | security | The version file route serves exact manifest-entry bytes to artifact-read principals with non-renderable headers on the app origin, and never on the content domain. | Anonymous, public-link, and read-incapable-key requests are denied; the response cannot render as a document on the app origin; unknown paths 404 without disclosure. |
| CMT-014 | security | The review viewer executes artifact HTML only inside an opaque-origin sandboxed document that holds no credential; comment writes happen only in the signed-in app document. | Hostile artifact JavaScript cannot reach the app origin, the comment API, cookies, or storage from inside the viewer. |
| CMT-015 | behavior | Review routes use the dedicated artifact-first viewport shell, with comments and version navigation closed by default, compact version and linked-source context, responsive on-demand surfaces, sharing, and reversible focus mode. | Management chrome or a permanently open side surface cannot displace the artifact, narrow screens cannot make a docked panel crush the artifact, and focus mode cannot leave the viewer without a visible way back. |

`SCP-003` is edited to keep notifications and workspace collaboration excluded. `PLN-003` moves comments and replies to Artifact Server's column and its acceptance tests are rewritten. `AUD-001` gains the six comment action kinds in its behavior test.

Tests are named by requirement ID as the ledger requires (`tests/conformance/cmt-001-exact-version-thread.test.ts` and so on), run against the SQLite repository directly and through the HTTP app; the Postgres and D1 repositories run the same repository suite through the existing external-storage and Cloudflare test harnesses. New requirements enter the ledger as `specified` with empty evidence; statuses move only on real recorded runs (the validator rejects hand-written evidence). `CMT-014`'s hostile-artifact proof lives in the Playwright browser suite, which cannot carry ledger IDs, so `CMT-014` stays `specified` until the evidence tooling covers browser runs.

## 12. Acceptance walk-through (what "done" looks like for the API and MCP)

From Claude Code with the Artifact Server MCP server:

1. `artifact_create_upload` + `artifact_commit_upload` publish `report.html` → `art_1`, `ver_1`.
2. `comment_create {artifactId: art_1, versionId: ver_1, path: "report.html", body: "Axis label wrong"}` → `cmt_1`, `replayed: false`. Same call again with the same key → `replayed: true`, same id.
3. A second member (browser, Comments tab) replies "Fixed in next publish". Agent `comment_list {since: <t>}` sees the thread with `replyCount: 1`.
4. Agent publishes `ver_2`. `comment_get cmt_1` still says `versionId: ver_1`; the thread's version link opens v1.
5. Agent `comment_resolve {resolved: true}`. Member's reply attempt now returns `COMMENT_RESOLVED`. Member reopens from the UI; reply succeeds.
6. A key with only `artifact:read` gets `AUTHORIZATION_DENIED` on `comment_create`. A public-link visitor sees the page and no comments. The second member cannot edit the agent's thread body; an administrator cannot edit it either but can delete it.
7. `GET /api/v1/artifacts/art_1/actions?kind=comment_create` shows the create with the agent's principal and the human authorizer.

All of that runs on SQLite locally and on the compact Compose image without new configuration.

## 13. Confidence notes: verified against code vs. assumed

Verified in the current checkout (`main` at `4c72ff4`):

- `Principal` has no display name (`src/core/identity.ts:37-44`); members list is administrator-only (`installation-access.ts:537-542`); so denormalizing `displayName` on the row and adding it to `Principal` is required, not optional. Principal is serialized in `src/mcp/create-mcp-http-adapter.ts:35-48` and `src/cli/cli-profile-credential.ts:53-66`; both need the optional field.
- Authorization policy is one service with named requirements (`authorization.ts`); adding two requirements and one capability fits the pattern; capabilities are a closed set in `identity.ts:23-30`.
- Repository ports are Promise-based interfaces in `src/core/ports.ts`; the application wraps them in Effect (`artifact-management.ts:112-170`); three backends exist (`sqlite-artifact-repository.ts`, `postgres-artifact-repository.ts`, `deploy/cloudflare/src/d1-artifact-repository.ts`) with schema versions 4 / 3 / migrations list. `manifest_entries (version_id, path)` is the primary key, so path validation is a point lookup.
- The `actions` table already carries `version_id`, `principal_id`, `authorized_by_principal_id`, `idempotency_key` (`sqlite-artifact-repository.ts:1969-1979`), so comment audit rows fit without a schema change; `ArtifactActionKind` is a closed set in `model.ts:10-16` that the web UI labels.
- HTTP mutations use `Idempotency-Key` header + zod bodies + `runHttpApplicationEffect` (`create-http-app.ts:1094-1179`); MCP tools use `noun_verb` names, `idempotencyKeySchema` 16..200, and `toolResult` (`artifact-mcp-server.ts:769-800`).
- Archived projects reject new work through `resolveActiveProject` (`project-management.ts:160-170`); tombstoned artifacts are hidden by `findArtifact` and visible through `findArtifactForAdministration`.
- The web app has a canonical Review inspector with comments and versions (`apps/web/src/review/review-app.tsx`), while untrusted content stays in the isolated Review frame. Comment writes therefore remain in the trusted application and in-page anchoring remains its own slice.
- Conformance IDs, statuses, modules, and required source sections are enforced by `project/spec/conformance.yml` structure; `SCP-003` and `PLN-003` are the two entries that contradict this spec.

Assumed, to confirm during implementation:

- `node_modules/effect/AGENTS.md` conventions for the new service (must be read completely before writing the service; the shape above copies `ArtifactManagementService`).
- Whether D1's transaction primitive (`batch`) is enough for the resolve-versus-reply race in CMT-004 without an extra state check on the reply insert (`INSERT … SELECT … WHERE state = 'open'` works on all three backends and is the plan).
- The web UI's `ActionHistory` will need a label per new action kind; trivial but not yet checked line by line.

## 14. Decisions recorded (owner, August 17, 2026)

1. Workspaces integration is out of scope for this work. The value taken from Workspaces is the shared data model and vocabulary only.
2. Permissions: any member (or `comment:write` key) can create, reply, resolve, and reopen. Only the author can edit their own comment or reply. Administrators can delete any comment but cannot edit anyone else's.
3. Slicing is the implementer's call, made iteratively (section 10). Implementation has not started.
