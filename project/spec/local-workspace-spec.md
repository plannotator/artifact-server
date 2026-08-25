# Local workspace features

**Status:** Accepted; implementation underway — `LNK-001` through `LNK-008` are implemented across the local application, SQLite/Postgres/D1 storage, HTTP, MCP, CLI, and web surfaces and have normal and hostile acceptance-ID tests, but remain `implementing` for the explicit proof gaps recorded in the ledger. `PRV-001` through `PRV-005` are implemented with local HTTP and browser proof. `KAN-001` through `KAN-007`, `EDT-001` through `EDT-003`, and `OPN-001`/`OPN-002` remain specified and unimplemented (August 23, 2026)
**Date:** August 19, 2026
**Owner:** Artifact Server product engineering
**Companion documents:** [Product specification](./artifact-server-product-spec.md), [Artifact comments](./artifact-comments-spec.md) (the storage and parity precedent this spec follows), [Image and video previews](./media-preview-spec.md), [Conformance ledger](./conformance.yml), [ADR 0023](./decisions/0023-linked-artifacts-are-captured-snapshots.md), [ADR 0024](./decisions/0024-kanban-is-first-class-records.md)

## 1. What this adds and why

The v0 Artifact Server (the July 2026 `@plannotator/artifact-server` 0.1.0) was a single-user local workspace. Five of its features did not survive the rewrite into the current multi-deployment product, and each one still matters to the person running Artifact Server on their own machine next to their agents:

1. **Linked artifacts** — index a file where it already lives on disk instead of copying it in, notice when something else edits it, and recover when it moves.
2. **A Kanban board** — a small four-column work tracker per project, usable by people and agents through the same surfaces as everything else.
3. **In-place text editing** — fix a Markdown or text artifact in the browser without a round trip through the CLI.
4. **Open in app** — open a linked file in the user's own editor or file manager from the artifact page.
5. **Broader previews** — see images, video, audio, and PDFs inside the review screen, not only HTML.

v0 could take shortcuts the current product cannot: it had one user, one machine, one mutable copy of each artifact, and no version history. This spec revives the five features **without weakening any current invariant** — versions stay immutable, every mutation stays attributed and idempotent, untrusted paths never select raw storage, and features that only make sense when the server and the browser share a machine are hard-gated to the local deployment.

Two of the five require real architectural decisions, recorded as ADRs:

- Linked files meet immutable versions → **ADR 0023: linked artifacts serve live locally and snapshot for everything shared.** The file stays where it is on disk and the server references it in place. The local authenticated member sees the live file; a snapshot (captured version) exists only where a state must hold still — sharing, comments, and history. Nothing happens to any file by default: a file becomes an artifact only when a caller explicitly links it through the protocol surface.
- The Kanban board meets immutable versions → **ADR 0024: the board is first-class records, not an artifact.** v0's board-as-artifact was elegant because v0 artifacts were mutable; ours are not, so the board follows the comments precedent: repository port, three backends, action records, idempotency, HTTP/MCP/web parity.

## 2. Vocabulary

| Term | Meaning |
| --- | --- |
| Source binding | Artifact-level metadata naming one canonicalized absolute file path on the server's machine, plus its last observed fingerprint and freshness. Only linked artifacts have one. |
| Fingerprint | `device:inode:size:mtimeNs:ctimeNs` of the source file — a cheap identity-and-change check that never reads file bytes. |
| Freshness | The binding's observed relation to the artifact's last captured version: `in-sync`, `modified`, `missing`, or `unreadable`. Derived, lazily refreshed, ambient state — never a barrier to the live view. |
| Live view | The local authenticated member's default reading of a linked artifact: the file's current bytes streamed from disk through the verified-descriptor path, served `no-store` on a per-artifact live origin. |
| Capture | An attributed publish — explicit, or implicit when a shared or commentable state is needed — that reads the source file's current bytes and saves them as a new immutable version through the normal publish pipeline. |
| Relink | Re-pointing a source binding at a moved file, guarded by the expected content fingerprint, preserving the artifact ID, versions, and comments. |
| Link root | An administrator-configured directory subtree inside which source paths must resolve. |
| Board | One Kanban board per project: four fixed columns and its cards. |
| Card | One work item: title, description, column, position, labels, assignee, paused flag, artifact attachments, revision. |
| Edit commit | A publish that creates a new version by copying the base version's manifest with exactly one text entry replaced by newly uploaded bytes. |

## 3. Deployment gating

Two of the five features read or execute against the server machine's filesystem outside the data directory. They are meaningful and safe only where the server is the user's own machine.

| Feature | local | single_server | kubernetes / cloudflare / aws / gcp |
| --- | --- | --- | --- |
| Linked artifacts | Available when enabled | Absent | Absent (impossible on Workers; pointless and dangerous on shared remotes) |
| Open in app | Available when linked artifacts are enabled | Absent | Absent |
| Kanban board | Available | Available | Available |
| In-place text editing | Available | Available | Available |
| Broader previews | Available | Available | Available |

Gating rules:

- **Capability discovery is the source of truth.** `artifact_capabilities` (MCP) and the equivalent HTTP capability shape advertise `linkedArtifacts` and `openInApp` only on a local deployment with the feature enabled. The web application renders no linked-file or open-in affordance when the capability is absent.
- **Absent surfaces answer a stable shape, not a mystery.** On any deployment where the capability is off or unsupported, its HTTP routes answer `501` with the stable error code `capability-unavailable`, and its MCP tools return the same coded error. Deployment type is not a secret; this response discloses nothing about artifacts or paths.
- **Configuration:** `ARTIFACT_SERVER_LINKED_FILES` = `off` (default) | `on`. Setting `on` outside the local runtime fails startup with a message naming the variable, matching the loader's all-or-nothing discipline. `ARTIFACT_SERVER_LINK_ROOTS` = colon-separated absolute directories (default: the server process user's home directory). `ARTIFACT_SERVER_OPEN_IN` = `on` (default) | `off`, effective only where linked artifacts are on.

## 4. Linked artifacts

### 4.1 The decision: live locally, snapshot for everything shared (ADR 0023)

A linked artifact is a **reference to a file that stays put on disk**, wrapped in an ordinary artifact — same ID shape, same immutable versions, same access settings, same comments. Two delivery paths coexist, and who you are decides which one you get:

- **The local authenticated member sees the live file.** On the local deployment, an admitted member reading a linked artifact gets the file's current bytes streamed from disk through the v0-proven verified path: open with `O_NOFOLLOW`, verify the fingerprint on the open descriptor, stream from **that same descriptor**. Drift relative to the last capture is ambient state — a badge, a field — never a barrier or an interstitial. Live responses are served `Cache-Control: no-store` on a per-artifact live origin (section 4.4). In v1 the live view opens as a top-level document in its own tab: the content-session cookie is `SameSite=Strict` and content responses forbid framing, so the review screen cannot embed the live origin without weakening that posture. Embedding the live view is deliberately withheld until it is decided as its own security change; the review screen stays version-pinned with the drift state shown beside it.
- **A snapshot exists only where a state must hold still.** Sharing (a public link, or any reader who is not a local authenticated member), comments (a thread anchors to one exact captured version — section 4.5), version history, and comparisons all operate on captured immutable versions. Capture streams the source bytes through the normal publish pipeline (staging, hash verification, canonical manifest, one-transaction version commit, idempotency key, current-version compare-and-swap, action record) — attributable, auditable, conflict-safe.
- **Remote, shared, and anonymous viewers never see live disk bytes.** Every argument for immutable delivery stands unchanged for them: version-scoped content origins, hash-verified bytes, cacheability, revocability. The live view is a strictly local, strictly authenticated privilege; everyone else reads the last captured version exactly like any other artifact.
- **External change is drift, not mutation.** When the source file changes on disk, no version changes. The live view simply shows the new bytes; the binding's freshness becomes `modified`, telling the member (and any agent) that what's shared or commented lags what's on disk.

Rejected alternatives are recorded in ADR 0023: serving live disk bytes to shared or anonymous viewers (breaks immutable delivery, caching, revocability, and the hash-verification contract), copy-import-only semantics with no live view (makes a link feel like an import and shows local members stale bytes of their own file), and auto-publishing on observed change (turns reads into writes, has no responsible principal, and floods history on rapid saves).

### 4.2 Mechanics (carried over from v0 where they were right)

- **Canonicalization:** the path is `realpath`-resolved at link time; the target must be a regular file (`lstat`, no symlink, no device, no socket, no directory).
- **Fingerprint:** `device:inode:size:mtimeNs:ctimeNs`, stored with the binding. Fingerprinting never reads bytes.
- **Lazy refresh:** reading a linked artifact's metadata cheaply `lstat`s the source. A missing or unreadable file flips freshness; a changed fingerprint marks `modified`. Refresh is read-only with respect to versions and never blocks the read on hashing. Because the fingerprint includes device and inode identity, a source that goes missing and is later restored recovers to `modified`, never silently back to `in-sync`; only a capture re-establishes `in-sync`.
- **Live streaming safety:** the live view opens the source with `O_NOFOLLOW`, verifies the fingerprint on the open descriptor, and streams from **that same descriptor** — the v0 discipline, so a symlink swap or path race can never redirect the stream. A source that is missing or unreadable degrades the live view to the last captured version with the freshness state shown; it never errors the artifact.
- **Capture safety:** capture uses the same verified-descriptor path and additionally hashes what it streams, re-verifying the fingerprint after reading; a mismatch aborts the capture with a retryable drift error. No time-of-check/time-of-use window.
- **Relink:** `PUT` of a new source path, accepted only when the new file's content hash equals the expected hash the client names (normally the current version's entry hash). Artifact ID, versions, comments, and attachments are untouched.
- **First version at link time:** linking performs an immediate initial capture, so a linked artifact is never versionless and its delivery path is identical to a published artifact from the first second.

### 4.3 Authorization and path safety

Linking is the one place the product accepts a filesystem path from a caller, so the rules are strict:

1. **Local deployment only, feature enabled, loopback origin** — the request must arrive on the loopback application origin of a local deployment with `ARTIFACT_SERVER_LINKED_FILES=on`.
2. **Admitted human member or a service key holding the link capability.** The existing capability model applies; there is no anonymous or public-link path to any binding operation.
3. **Link roots:** the canonicalized path must resolve inside a configured link root. The default root is the server process user's home directory; an administrator can narrow or widen it.
4. **Self-protection:** the data directory, the SQLite database and its `-wal`/`-shm` companions, and anything below them are always rejected, regardless of roots.
5. **Paths never select storage.** The binding path is used only by the link, refresh, capture, relink, and open-in code paths, all of which operate on the canonicalized, root-checked, fingerprint-verified binding. Manifest paths, request paths, and delivery are completely unchanged — resolution stays manifest-only.
6. **Disclosure:** the absolute source path appears only in authenticated application-origin metadata on the local deployment. It never appears on the content origin, in public-link responses, or in logs.
7. **Live-view authorization:** the live view is available exactly to admitted members authenticated on the local deployment, delivered through the same bootstrap-token-and-content-cookie exchange as an account-required version, bound to the artifact's live origin. Public-link possession, anonymous requests, and every non-local deployment never reach a live byte — they receive the last captured version through the ordinary version delivery path (`LNK-007`).

### 4.4 Surfaces — protocol first

Linking is **API-first**: the canonical way a file becomes an artifact is an explicit protocol call — the MCP tool or the HTTP endpoint below, mirroring v0's `artifact_link` — typically issued by an agent. Nothing is ever linked implicitly: no directory scanning, no watching, no UI-driven bulk import. The web application's link affordance is a secondary convenience over the same endpoint, optional in v1, and every rule of section 4.3 applies identically regardless of which surface makes the call. The CLI gains `artifactserver link <path> --project <project>` over the same endpoint. MCP accepts the link path only on the local deployment, consistent with the product rule that a remote MCP server never accepts an arbitrary client filesystem path.

| Surface | Contract |
| --- | --- |
| `POST /api/v1/projects/:projectId/artifacts/link` | `{ path, name?, idempotencyKey }` → creates the artifact, performs the initial capture, returns the artifact with its binding. |
| `POST /api/v1/projects/:projectId/artifacts/:artifactId/capture` | `{ expectedCurrentVersionId, idempotencyKey }` → new version from current source bytes; conflict shape matches publish. Capturing an `in-sync` binding is an idempotent no-op that returns the current version regardless of the expected version named — the no-op writes nothing, so there is nothing for the compare-and-swap to protect. |
| `PUT /api/v1/projects/:projectId/artifacts/:artifactId/source` | `{ path, expectedSha256 }` → relink. |
| Live view | A per-artifact live origin (unique `*.localhost` host, like version origins but artifact-scoped) streams the source's current bytes to authenticated local members with `Cache-Control: no-store`. Captured-version routes keep their immutable caching untouched. |
| Artifact read shape | Gains optional `sourceBinding: { status, path, lastVerifiedAt }` on the local deployment for authenticated readers. |
| MCP | `artifact_link`, `artifact_capture`, `artifact_relink` — local deployment only; same authorization and shapes. `artifact_link` is the canonical linking surface. |

A note on the live origin and service workers: a live origin is per-artifact, not per-version, so a service worker installed by the live document persists across live reloads of the same artifact. That is within one trust boundary — the member's own file on the member's own machine — and the live origin still shares nothing with the application origin, any version origin, or any other artifact.

### 4.5 Comments on a linked artifact

A comment must anchor to bytes that hold still, so a thread on a linked artifact always names a captured version:

- If the binding is `in-sync`, the thread anchors to the current version — nothing new is captured.
- If the binding is `modified` (the live bytes have drifted past the last capture), creating a thread **implicitly captures first**: the server performs a normal capture attributed to the commenting principal, then creates the thread on the resulting version, in the same request. The client sends one create-thread call; the response names the version the thread landed on.
- If the implicit capture aborts on a drift race (section 4.2), the whole request fails with the retryable drift error and no thread is created — a thread never anchors to bytes that were not durably captured.
- The comment surfaces show which version a thread anchors to, exactly as they do for ordinary artifacts. Commenting happens on the version-pinned review screen; after an implicit capture the client follows the response to the version the thread landed on. The live document itself (its own tab in v1, section 4.1) carries no comment presentation.

## 5. Kanban board

### 5.1 The decision: first-class records (ADR 0024)

The board is mutable, collaborative, fine-grained state. In v0 it lived inside a mutable artifact; in this product an artifact write is an immutable version, so board-as-artifact would either flood version history (every drag a publish) or require a version-exempt artifact kind (a second artifact semantics through every layer). Comments already solved this exact problem — mutable, project-scoped, attributed records behind a repository port on all three backends — and the board copies that answer.

### 5.2 Model

One board per project, created on first use. Columns are fixed: `backlog`, `in_progress`, `review`, `done` — no column management in v1.

```ts
export interface KanbanCardRecord {
  readonly id: string;                     // "card_" + UUID; client-suppliable for idempotent create
  readonly installationId: string;
  readonly projectId: string;
  readonly columnId: "backlog" | "in_progress" | "review" | "done";
  readonly position: number;               // dense, unique per column
  readonly title: string;                  // 1..200 characters after trim
  readonly description: string;            // 0..20000 characters
  readonly labels: readonly string[];      // ≤ 8, each ≤ 32 chars, case-insensitively unique
  readonly assignee: string | null;        // ≤ 80 characters, free text
  readonly paused: boolean;                // true only while columnId = "in_progress"
  readonly artifactIds: readonly string[]; // ≤ 50, unique, same project
  readonly revision: number;               // per-card optimistic concurrency
  readonly author: CommentAuthor;          // same attribution shape as comments
  readonly createdAt: string;
  readonly updatedAt: string;
}
```

Rules, all enforced in one repository transaction per mutation:

- **Concurrency:** every update and delete names `expectedRevision`; a mismatch is a conflict that returns the current card. Edits to different cards never conflict. (v0's separate board-level revision is dropped: with per-card revisions and server-assigned dense positions there is nothing left for it to protect.)
- **Ordering:** a move names the target column and an optional `beforeCardId`; the server assigns dense positions and repairs gaps. Clients never write raw positions.
- **Attachments** reference artifacts by ID within the same project. A tombstoned or missing artifact leaves the card valid; readers receive the ID with an `available: false` marker and the web application renders a missing-attachment state. Deleting a card never touches artifacts.
- **Idempotency:** create accepts a client-supplied card ID; replaying the same create with identical fields returns the original card; the same ID with different fields is a conflict. Updates and deletes are idempotent under `expectedRevision`.
- **Attribution:** every mutation records the acting principal in the card and appends an action record, exactly like comment mutations.

### 5.3 Access

Reading the board requires artifact-read authority on the project. Mutating it requires an admitted human member or a service key holding the board-write capability (a new capability, granted like comment-write). All operations are project- and installation-scoped; cross-project identifiers answer not-found without disclosure.

### 5.4 Surfaces

| Surface | Contract |
| --- | --- |
| `GET /api/v1/projects/:projectId/kanban` | The board: columns, cards in position order, attachment availability. Supports the same `since` polling discipline as comments. |
| `POST /api/v1/projects/:projectId/kanban/cards` | Create (`201`, or `200` replay on idempotent retry). |
| `PATCH /api/v1/projects/:projectId/kanban/cards/:cardId` | Edit, move (`columnId` + `beforeCardId`), pause, assign, attach — all under `expectedRevision`. |
| `DELETE /api/v1/projects/:projectId/kanban/cards/:cardId?expectedRevision=N` | Delete. |
| MCP | `kanban_get_board`, `kanban_create_card`, `kanban_update_card`, `kanban_delete_card` — same authorization, same shapes, actionable error results carrying the current `{ id, revision }` on conflict. |
| Web application | Four-column board with drag-and-drop and keyboard movement, optimistic reorder reconciled by the guarded `PATCH`, card inspector, per-artifact badge showing non-done cards that attach the open artifact. The v0 interaction design (dnd-kit sensors, collapsed Done column, missing-attachment state, stale-revision "reload card") is the reference. |

Deployments: all six. The board is ordinary database state and works identically everywhere.

## 6. In-place text editing

An edit **is** a publish. There is no mutable write path; the editor produces a new immutable version.

- **Scope:** manifest entries whose media type is `text/*` or `application/json`, at most 2 MiB. Everything else is not editable in v1.
- **Flow:** the web application uploads the edited bytes through the existing staging-upload mechanism, then calls the edit commit: `POST /api/v1/projects/:projectId/artifacts/:artifactId/edits` with `{ baseVersionId, path, uploadId, idempotencyKey, expectedCurrentVersionId }`. The server copies the base version's canonical manifest, replaces exactly the named entry with the verified uploaded bytes, and commits a new version through the normal one-transaction publish path with a publish action record marked as an edit.
- **Conflict:** if the current version moved after the editor loaded, the commit conflicts and returns the actual current version; the editor offers reload-and-reapply or copy-my-changes. It never silently overwrites.
- **Byte fidelity:** the editor preserves the file's UTF-8 BOM and its CRLF/LF line-ending convention on save (v0's `decodeTextDocument`/`encodeEditedMarkdown` behavior is the reference); a file with mixed or CR-only endings prompts before normalizing. Untouched lines round-trip byte-identically.
- **MCP:** none in v1. MCP arguments never carry file contents (product rule); agents edit by publishing through the CLI.

Deployments: all six.

## 7. Open in app

Opens a **linked** artifact's source file in an application on the user's machine. Only meaningful where the server and the browser are the same machine, so it inherits the linked-artifacts gate entirely.

- **Catalog:** a fixed server-side list of known applications (file manager, common editors, terminals), filtered to what is actually installed. The client can only choose from the advertised catalog by ID.
- **Launch:** always an argv array — application binary plus the verified source path as a single argument. Never a shell string, never client-supplied arguments.
- **Authorization ladder, in order:** local deployment with linked artifacts and open-in enabled; loopback application origin; authenticated admitted member; the artifact is a linked artifact whose binding freshness is `available` (in-sync or modified — not missing/unreadable); the launched path is the binding's canonicalized, root-checked source path, resolved server-side. The client never supplies a path.
- **Surface:** `GET /api/v1/open-in/apps` (catalog) and `POST /api/v1/open-in` `{ artifactId, appId }` → `204`, or `403` when any ladder step fails. No MCP tool: an agent on the same machine opens files directly.

## 8. Broader previews

The first broader-preview slice is specified in [Image and video previews](./media-preview-spec.md). The Artifact Server review interface presents one exact-version image or video with native browser elements, manifest file selection, focus viewing, explicit terminal states, and ranged video seeking.

The authenticated version-file route remains download-only. Native media uses a separate application-origin route that returns the manifest media type only to authenticated same-origin `image` or `video` subresource requests and rejects top-level document navigation. This corrects the earlier assumption that a browser subresource could render the version-file route despite its `application/octet-stream` and `attachment` response. `CMT-013` remains unchanged.

Audio, PDF, and preformatted text presentation are follow-on preview slices, not part of `PRV-001` through `PRV-005`. Everything without an implemented browser-native presentation uses a typed fallback and never renders inline. Comments on non-HTML files keep the existing whole-file anchor. Deployments: all six.

## 9. Security summary

- Linked paths are the only client-supplied filesystem input in the product; they are canonicalized, root-checked, self-protection-checked, fingerprint-verified, and used exclusively by binding operations. Delivery, manifests, and storage resolution are untouched (`LNK-006`).
- Live disk bytes reach exactly one audience: admitted members authenticated on the local deployment, over the artifact's live origin, streamed from a fingerprint-verified descriptor and served `no-store`. Every other reader — public link, anonymous, non-member, every non-local deployment — receives only hash-verified immutable version blobs (`LNK-001`, `LNK-007`, ADR 0023).
- Open-in launches only catalog applications with server-resolved verified paths via argv arrays; no client path, no shell, no non-local deployment (`OPN-002`).
- Board and edit mutations carry the full existing discipline: project scoping, capability checks, idempotency, per-record optimistic concurrency, action records (`KAN-003`, `KAN-006`, `EDT-001`).
- Capability-gated features answer the stable `capability-unavailable` shape where absent; the UI hides what discovery does not advertise (`LNK-001`, `OPN-001`).
- Nothing in this spec adds a content-origin endpoint, weakens the two-origin boundary, or lets artifact JavaScript reach any of the new routes.

## 10. Storage sketch

Linked bindings are one nullable group on the artifact record (SQLite shown; Postgres and D1 mirror it through each backend's migration mechanics):

```sql
ALTER TABLE artifacts ADD COLUMN source_path TEXT;          -- canonical absolute path
ALTER TABLE artifacts ADD COLUMN source_fingerprint TEXT;   -- device:inode:size:mtimeNs:ctimeNs
ALTER TABLE artifacts ADD COLUMN source_status TEXT
  CHECK (source_status IN ('in-sync','modified','missing','unreadable'));
-- all three NULL for ordinary artifacts; path and fingerprint NOT NULL together
```

The board is one table:

```sql
CREATE TABLE kanban_cards (
  id TEXT PRIMARY KEY,
  installation_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  column_id TEXT NOT NULL CHECK (column_id IN ('backlog','in_progress','review','done')),
  position INTEGER NOT NULL,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  labels TEXT NOT NULL DEFAULT '[]',       -- JSON array, validated in the service
  assignee TEXT,
  paused INTEGER NOT NULL DEFAULT 0,
  artifact_ids TEXT NOT NULL DEFAULT '[]', -- JSON array of same-project artifact IDs
  revision INTEGER NOT NULL DEFAULT 1,
  author_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (project_id, column_id, position)
) STRICT;
```

Edits reuse existing tables entirely (staging uploads, versions, manifest entries, actions); open-in and previews add no storage.

## 11. Non-goals

- **Automatic capture on file change** (a filesystem watcher publishing versions). v1 is lazy drift detection plus explicit capture; a debounced, attributed watch mode may layer on later as its own decision.
- **Linking directories.** v1 links single regular files only.
- **Linked artifacts anywhere but the local deployment** — including bind-mounted directories under compact Compose. If demand appears, that is a separate gate with its own container-boundary analysis.
- **Column management, swimlanes, board-level webhooks, or cross-project boards.** Four fixed columns.
- **A WYSIWYG or multi-file editor.** One text entry per edit commit.
- **Custom media viewers, transcoding, thumbnails, or annotations positioned inside video/PDF content.** Browser-native rendering only; comments on non-HTML media anchor to the file.
- **An MCP editing tool** (MCP arguments never carry file contents).

## 12. Conformance requirements to add

New ledger modules `local-workspace` (LNK, OPN) and `kanban` (KAN); EDT belongs to `publishing`, PRV to `web-application`. All entries start `specified` with empty evidence.

| ID | One line |
| --- | --- |
| `LNK-001` | Linked artifacts are off by default, local-deployment-only, capability-advertised, protocol-first, and reference the file in place. |
| `LNK-002` | Linking creates an ordinary artifact with an initial captured version through the normal publish pipeline. |
| `LNK-003` | External modification, removal, and unreadability surface as binding freshness without touching versions. |
| `LNK-004` | Capture publishes the source's current bytes as a new version with descriptor-verified fingerprint checks and publish-grade conflict behavior. |
| `LNK-005` | Relink re-points the binding under an expected content hash, preserving artifact identity, versions, and comments. |
| `LNK-006` | Link paths are canonicalized, root-checked, self-protection-checked, member-authorized, and never select storage or appear publicly. |
| `LNK-007` | The live view serves current disk bytes no-store to local authenticated members only; every other reader receives captured immutable versions. |
| `LNK-008` | A comment thread on a linked artifact anchors to a captured version, capturing implicitly and attributably when the binding has drifted. |
| `KAN-001` | Each project has one four-fixed-column board created on first use. |
| `KAN-002` | Cards enforce documented bounds on title, description, labels, assignee, paused, and attachments. |
| `KAN-003` | Card mutations use per-card revisions: cross-card edits merge, same-card conflicts return the current card. |
| `KAN-004` | Ordering is server-assigned dense positions; moves name a column and an optional before-card. |
| `KAN-005` | Attachments reference same-project artifacts by ID and survive artifact deletion as explicit missing attachments. |
| `KAN-006` | Board reads require artifact-read authority; mutations require a human member or board-write capability; everything is project-scoped and action-recorded. |
| `KAN-007` | HTTP, MCP, and the web application expose the same board operations with idempotent creates and since-polling. |
| `EDT-001` | An edit commit publishes a new immutable version replacing exactly one text entry, with idempotency, current-version compare-and-swap, and an action record. |
| `EDT-002` | The editor preserves BOM and line endings and resolves stale saves as explicit conflicts, never silent overwrites. |
| `EDT-003` | Editing is bounded to text media types and sizes, verified like any publish, and absent from MCP. |
| `OPN-001` | Open-in launches only catalog applications on verified linked sources, argv-only, on the local deployment over loopback. |
| `OPN-002` | Client-supplied paths, non-linked artifacts, unavailable sources, non-local deployments, and non-loopback origins are all refused. |
| `PRV-001` | The review interface presents an exact-version image with browser-native decoding, contained layout, focus viewing, and no DOM insertion for SVG. |
| `PRV-002` | The review interface presents an exact-version video with native controls, no autoplay, metadata-only preload, and working ranged seeking. |
| `PRV-003` | Authenticated media delivery is same-origin, media-destination-only, correctly typed, range-capable, and cannot become an application-origin document. |
| `PRV-004` | Manifest file selection is URL-addressable, version-pinned, back/forward aware, and protected from stale preview responses. |
| `PRV-005` | Unsupported types, codecs, corrupt media, and delivery failures settle into an honest typed fallback without sniffing, conversion, or an infinite loading state. |

## 13. Sequencing and effort

Recommended build order, matching dependency direction:

1. **Previews** (`PRV`) — days; web-only over existing routes.
2. **Editing** (`EDT`) — under a week; reuses staging uploads and the publish transaction.
3. **Kanban** (`KAN`) — one to two weeks; the pattern is a copy of comments (port, three backends, HTTP+MCP, action records) plus the board UI, for which the v0 interaction design is the reference.
4. **Linked artifacts** (`LNK`) — one and a half to two and a half weeks; the deepest slice: binding storage, capture path, drift refresh, CLI/MCP/HTTP surfaces, and the section 4.3 security ladder with hostile tests.
5. **Open-in** (`OPN`) — days, strictly after `LNK`.

## 14. Open questions

1. **Watch mode.** Is lazy drift + explicit capture enough for the agent workflows you care about, or is a debounced auto-capture (attributed to the linking principal) needed early? Recommendation: ship lazy first; measure how often people click capture.
2. **Compose linked files.** Should compact Compose (one server, Docker) ever support linked files over a bind mount? Currently a non-goal; revisit only on demand.
3. **Label vocabulary.** v0 suggested six fixed labels (research/design/implementation/validation/documentation/operations). Keep as suggestions, make configurable per installation, or drop suggestions entirely? Recommendation: keep the six as non-enforced suggestions.
4. **Source-path visibility.** The spec shows the absolute source path to authenticated members on the local deployment. Confirm this is acceptable (it is the user's own machine) or restrict to a masked basename.

### Recorded for v2: git-aware capture

Linked files often live inside a git working tree, where a branch switch rewrites mtimes without meaningfully changing content — fingerprint drift without substance. v2 should make capture content-aware: a capture (explicit or implicit) whose bytes hash-match the last captured version records no new version and simply refreshes the stored fingerprint, so branch-switch churn produces neither drift noise nor version noise. Optionally, when the source sits inside a git repository, a capture may record the repository's commit SHA alongside the version as provenance metadata. Neither behavior is v1; both are recorded here so the v1 binding storage leaves room for them.
