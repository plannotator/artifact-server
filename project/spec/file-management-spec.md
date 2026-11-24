# File management: folders, linked project folders, overview, and trash

**Status:** Accepted (November 24, 2026); implementation tracked in Backlog ARTSV-5. Owner decisions are recorded in section 16.
**Date:** November 24, 2026
**Owner:** Artifact Server product engineering (fork-local; not proposed upstream)
**Companion documents:** [Local workspace features](./local-workspace-spec.md) (the closest precedent and the linked-artifact contract this spec builds on), [Phase 8: project-scoped artifacts](./phase-8-project-scoped-artifacts.md), [Image and video previews](./media-preview-spec.md), [Single application administration](./single-application-administration-spec.md), [Dashboard insights](./dashboard-insights-spec.md) (the fork-local, SQLite-first precedent), [Optional Git handoff](./git-history-spec.md), [Conformance ledger](./conformance.yml), [ADR 0023](./decisions/0023-linked-artifacts-are-captured-snapshots.md), [ADR 0029](./decisions/0029-folders-are-first-class-placement-records.md), [ADR 0030](./decisions/0030-trash-is-a-recoverable-tombstone.md), [ADR 0031](./decisions/0031-linked-folders-index-automatically-and-capture-explicitly.md)

Conventions in this document:

- A claim about current behavior cites the file and line it was verified against, as `path:line`.
- **[Assumption]** marks something this spec relies on but did not verify in code, or a product choice made on the owner's behalf that the owner should confirm. Section 16 collects the choices that need an answer.

## 1. What this adds and why

Today Artifact Server is where agents publish finished reports, and where people review and comment on them. The owner wants it to be where **every file a project produces** lives and is managed — HTML, Markdown, PDF, images, video, audio, code, data — not only agent-published HTML. Versioning already exists. What is missing is management:

1. **Folders and organization** — folders inside a project; move and rename files and folders; move across projects; select many items and act on them at once.
2. **Linked project folders** — point at a local project's output directory; new and changed files there appear automatically, and one action captures them as immutable versions. This builds on Linked artifacts (`LNK-001`..`LNK-008`).
3. **File overview and trash** — one overview of every file across projects, filterable by type, tag, project, folder, and time; deleting sends to a trash that can be recovered or purged.

The current model has none of this:

- An artifact record has a project, a name, tags, an access setting, and a tombstone time, and no placement inside a project (`src/core/model.ts:72-82`). Listing is always for one project, filtered by tags, comment presence, and a name search (`src/core/ports.ts:188-198`).
- An artifact's name is set at publish time; no operation renames it (`src/application/artifact-management.ts:205-232` lists every management operation: change access, change tags, delete, get, list, restore version).
- Delete is a one-way tombstone. It stops all access, keeps every version and blob, and has no undo (ADR 0003; `src/storage/sqlite-artifact-repository.ts:1686-1744`). Permanent deletion was explicitly deferred (`project/spec/phase-11-content-and-lifecycle-closure.md:29-39`).
- A linked artifact is a single file, linked only by an explicit call. The current contract rules out directory scanning and watching: "no directory scanning, no watching, no UI-driven bulk import" (`project/spec/local-workspace-spec.md:95`; non-goals at `:249-250`; ADR 0023 "Protocol-first linking").

This spec adds the three capability areas **without weakening any current invariant**:

- Version bytes, version IDs, manifests, and content tokens never change.
- Every mutation is attributed, idempotent, guarded by optimistic concurrency, and recorded as an action.
- Untrusted paths and names never select a storage location.
- Anything that reads the server machine's filesystem stays local-only.

Three decisions need ADRs:

- **ADR 0029 — Folders are first-class placement records.** A folder is a record with a stable ID and a parent. An artifact points at at most one folder. Placement is mutable metadata outside the version, so moving or renaming never creates a version and never changes an ID or a link.
- **ADR 0030 — Trash is a recoverable tombstone.** Delete keeps its current meaning (stop all access, keep all bytes) and becomes reversible. Purge is a separate, irreversible step that ends recoverability. Purge does **not** reclaim blob bytes in this spec, because committed-blob collection stays disabled (`ART-007`, `OPS-006`, `OPS-007`).
- **ADR 0031 — Linked folders index automatically and capture explicitly.** This amends ADR 0023. A linked folder is scanned and watched, and observation writes only an *inventory* of what is on disk. It never writes artifacts, versions, or actions. Turning inventory into versions is always one explicit, attributed capture action.

## 2. Vocabulary

| Term | Meaning |
| --- | --- |
| File | In product copy, one artifact as seen in the overview. A multi-file artifact (a site) is one file of kind `site`. The domain keeps the word *artifact*; *file* is presentation vocabulary only. |
| Folder | A first-class record (`fld_<uuid>`) inside one project, with a name, an optional parent folder, and a revision. Folders hold artifacts and other folders. |
| Project root | The implicit top of a project's folder tree. It is not a record. An artifact or folder with no parent sits at the root. |
| Placement | The pair `(projectId, folderId \| null)` that says where an artifact appears. Placement is artifact metadata, not version content. |
| Move | Changing an artifact's or folder's placement. *Cross-project move* changes the project as well. |
| Rename | Changing an artifact's or folder's name label. IDs never change. |
| Trash | The set of tombstoned, still-recoverable artifacts and folders. *Trashing* is the existing delete. |
| Recover | Returning a trashed artifact or folder to service with the same IDs. The name is chosen to avoid confusion with the existing *restore*, which makes an earlier version current (`POST /api/v1/artifacts/:artifactId/restore`, `src/http/create-http-app.ts:2074-2075`). |
| Purge | Irreversibly ending recoverability for a trashed item. In this spec purge removes no blob bytes (section 9.4). |
| Trash group | The set of records trashed together by one folder-trash operation, so that they can be recovered together. |
| File kind | A derived, filterable category of an artifact's current version: `html`, `markdown`, `pdf`, `image`, `video`, `audio`, `code`, `text`, `data`, `archive`, `site`, `other`. It is used for filtering only and never selects a renderer (section 11.2). |
| Folder link | A local-only binding (`flk_<uuid>`) between one Artifact Server folder and one canonical directory on the server's machine. |
| Linked directory | The on-disk directory named by a folder link. |
| Inventory | The folder link's index of regular files under the linked directory. Each inventory entry is `untracked`, `tracked`, or `skipped`. The inventory is ambient observation, like binding freshness. |
| Inventory entry | One `fle_<uuid>` row: a relative path, a fingerprint, size, observed time, state, and, when tracked, the artifact whose source binding names it. |
| Pending | An inventory entry that a capture would change: `untracked`, or `tracked` with binding freshness `modified`. |
| Scan | One bounded reconciliation walk of a linked directory that rewrites the inventory to match the disk. A scan is authoritative. |
| Watch hint | A filesystem notification that a subtree may have changed. Hints only schedule scans and are never trusted as facts. |
| Batch | One request that applies one operation to up to 100 items, with an atomic, independently reported result per item. |

Existing terms (source binding, fingerprint, freshness, live view, capture, relink, link root) keep their meanings from `project/spec/local-workspace-spec.md` section 2.

## 3. Deployment gating

| Capability | local | single_server | kubernetes / cloudflare / aws / gcp |
| --- | --- | --- | --- |
| Folders, move, rename (in-project) | Available | Absent in this fork until a Postgres/D1 port exists | Absent in this fork |
| Cross-project move | Available | Absent | Absent |
| Trash: recover and purge | Available | Delete keeps current one-way tombstone semantics | Same |
| File overview | Available | Absent | Absent |
| Batch operations | Available | Absent | Absent |
| Linked folders | Available when `ARTIFACT_SERVER_LINKED_FILES=on` | Absent | Absent (impossible on Workers; pointless and dangerous on shared remotes) |
| Preview slices (section 12) | Available | Available | Available (web-only, over existing delivery) |

Rules:

- **Fork-local, SQLite first.** This follows the dashboard precedent: only the SQLite (local) persistence implements those queries, and every other deployment answers `CAPABILITY_UNAVAILABLE` (`project/spec/dashboard-insights-spec.md`, "Contract"). The domain model and ports are backend-neutral, so a later Postgres or D1 adapter can implement the same ports without changing the product contract. **[Assumption]** The owner runs only the local deployment and does not need these features on other deployments soon.
- **Capability discovery is the source of truth.** `artifact_capabilities` (MCP) and the HTTP capability shape gain `folders`, `trash`, `fileOverview`, `crossProjectMove`, and `linkedFolders`. Each is advertised only where it is implemented and enabled. The web application renders no affordance for an absent capability.
- **Absent surfaces answer a stable shape.** Routes answer `501` with code `capability-unavailable`, and MCP tools return the same coded error. This matches `local-workspace-spec.md` section 3.
- **Delete must not silently change meaning.** Where `trash` is absent, `DELETE /api/v1/artifacts/:artifactId` and `artifact_delete` keep today's one-way tombstone contract (`src/mcp/artifact-mcp-server.ts:1397-1424`). Where `trash` is present, the same call trashes. The response gains `recoverable: boolean` so callers can tell which one happened.
- **Configuration.** Linked folders reuse `ARTIFACT_SERVER_LINKED_FILES` and `ARTIFACT_SERVER_LINK_ROOTS` (`src/lifecycle/runtime-configuration.ts:711-740`). Linking a folder adds no flag. Folders, trash, and overview need no configuration on the local deployment. One optional setting is added: `ARTIFACT_SERVER_LINKED_FOLDER_WATCH` = `on` (default) | `off`. When it is `off`, the inventory refreshes only on explicit and scheduled scans (section 10.4).

## 4. Domain model

### 4.1 Folders: first-class records, not path prefixes (ADR 0029)

Two shapes were considered:

| | Folder as record (chosen) | Folder as a path prefix on each artifact |
| --- | --- | --- |
| Rename or move a folder | One row update. O(1) regardless of contents. | Rewrite the prefix on every descendant. O(n), so a large move needs a long transaction or a background job. |
| Empty folders | Exist naturally. | Impossible without placeholder rows. |
| Stable identity for URLs, batch items, and folder links | `fld_` ID survives rename and move. | Identity is the path, which changes on rename. |
| Name rules | Sibling-unique normalized names, enforced by one unique index. | Must police `/`, `.`, `..`, and Unicode lookalikes inside a string that also acts as an identity. |
| Cross-project move of a subtree | Re-parent records, then rewrite project scope. | Same rewrite plus string surgery. |
| Hierarchy queries | Recursive CTE over a bounded tree (depth ≤ 16). | `LIKE 'prefix/%'` scans. Simple, but every rename invalidates them. |

Decision: a folder is a record. A folder's path such as `Reports/2026/Q4` is **derived for display** and is never stored as an identity or used to resolve anything.

```ts
export interface FolderRecord {
  readonly id: string;                 // "fld_" + UUID; client-suppliable for idempotent create
  readonly installationId: string;
  readonly projectId: string;
  readonly parentFolderId: string | null; // null = project root
  readonly name: string;               // display label, 1..120 graphemes after trim
  readonly nameKey: string;            // normalized sibling-uniqueness key (see rules)
  readonly revision: number;           // per-folder optimistic concurrency
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly trashedAt: string | null;
  readonly trashGroupId: string | null;
  readonly purgedAt: string | null;
}
```

Rules, all enforced in one repository transaction per mutation:

- **Names.** Trimmed and NFC-normalized, 1..120 graphemes. Control characters (`\p{Cc}`), `/`, `\`, and the exact names `.` and `..` are rejected. Leading and trailing dots and whitespace are rejected so that a name cannot impersonate a hidden or relative path. `nameKey` is the existing search normalization: NFKC, collapsed whitespace, Unicode case fold, NFC (`src/application/artifact-tags.ts:66-70`). `(projectId, parentFolderId, nameKey)` is unique among folders that are not trashed and not purged. Two siblings therefore cannot differ only by case, width, or a compatibility form.
- **Artifact names stay non-unique.** Phase 8 made names labels, not identities (`phase-8-project-scoped-artifacts.md`, "Domain contract"). An agent publishing `report.html` twice today creates two artifacts, and a uniqueness rule would break publishing. The UI disambiguates same-named files by kind, updated time, and ID. **[Assumption]** The owner accepts duplicate file names inside one folder. See open question 3.
- **Bounds.** Depth ≤ 16 below the root. At most 10,000 folders per project. At most 10,000 direct children (folders plus artifacts) per folder is a UI-performance target, not a hard limit. Artifacts per folder are unbounded and paginated.
- **No cycles.** Moving a folder into itself or into one of its descendants is refused with `folder-cycle`. The check walks the destination's ancestor chain (≤ 16 steps) inside the transaction.
- **Concurrency.** Every folder rename, move, and trash names `expectedRevision`. A mismatch returns the current folder. This is the `KAN-003` per-record pattern.
- **Idempotency.** Create accepts a client-supplied `fld_` ID. Replaying an identical create returns the original. The same ID with different fields is a conflict. Other mutations carry an idempotency key, as every other mutation does.
- **Archived projects.** Folder writes in an archived project are refused with the existing project-archived error, because an archived project rejects new artifacts and versions (`phase-8-project-scoped-artifacts.md`, "Domain contract"). Reads continue.

### 4.2 Placement and rename are metadata outside the version

An artifact gains one nullable column, `folder_id`. Moving or renaming an artifact is a metadata change, exactly like changing tags. It names the artifact's `expectedCurrentVersionId`, which is the same guard `ChangeArtifactTags` uses (`src/core/ports.ts:163-174`). It writes one action record against the current version ID. It **never** creates a version.

What a move or rename does not touch:

| Stays identical | Why it is safe |
| --- | --- |
| Artifact ID, version IDs, version numbers, manifests, entry paths, blob bytes | Placement and name are not part of any version or manifest (`versions` and `manifest_entries` carry no name or folder: `src/storage/sqlite-artifact-repository.ts:4745-4768`). |
| Content tokens and version content origins | Origins are keyed by content token, not by name or folder (`src/http/artifact-http-links.ts:27-38`). |
| Stable artifact URL `/artifacts/:artifactId` | Resolved by artifact ID alone, across projects (`src/http/create-http-app.ts:2481-2494`; `src/application/content-access.ts:409-420`). |
| Public-link state and URL | The access setting is an artifact column, so moving does not change it. |
| Comment threads, replies, anchors, dispatches | Threads reference the artifact and version IDs (`src/storage/sqlite-artifact-repository.ts:4552-4580`). |
| Linked source binding | Binding columns live on the artifact row and move with it. **Artifact Server never moves, renames, or deletes anything on disk** (section 10.7). |
| Git-history repository | One repository per artifact, named by the artifact ID (`git-history-spec.md` section 4). In-project moves and renames do not touch it. |
| Kanban attachments | They reference artifact IDs (`local-workspace-spec.md` section 5.2). |

Rename updates `name` and the derived `search_name` (`src/storage/sqlite-artifact-repository.ts:4734-4743`), so name search follows the new label at once.

### 4.3 Cross-project move

Projects are record and policy scope. Blob storage does not move (`phase-8-project-scoped-artifacts.md`, "Storage and migration contract"). However, project identity is **denormalized onto many child rows** in SQLite: `versions`, `actions`, `idempotency_records`, `comment_threads`, `comment_replies`, `agent_dispatches`, content bootstraps and sessions, staging, and Git-history tables (`src/storage/sqlite-artifact-repository.ts:4552-4800`). Phase 8 required every security-sensitive record to carry or resolve exactly one project. A cross-project move must keep that invariant, so it is a **scope rewrite in one transaction**. The other option was a copy, which would mint new IDs and break the owner's requirement that IDs stay stable.

Contract for `moveArtifactToProject({artifactId, fromProjectId, toProjectId, toFolderId, expectedCurrentVersionId})`:

1. Both projects belong to the caller's installation, are active (not archived), and are readable and manageable by the principal.
2. **Refuse with `dispatch-held`** when any of the artifact's threads is held by a `queued`, `claimed`, or `delivered` dispatch (`dispatchHoldsCommentThread`, `src/core/model.ts:536-542`). A dispatch is a single-project bundle of threads, and moving part of it would split the bundle across projects. This mirrors the rule that a held thread is never removed out from under an agent (`src/storage/sqlite-artifact-repository.ts:3452-3458`).
3. **Refuse with `git-history-enabled`** when Git history is enabled for either project or the artifact has persisted repository coordinates. Per-artifact commits record the project ID in `.artifactserver/version.json` (`git-history-spec.md` section 4, "Commit contents"), and project enablement governs which jobs run. Reconciling both is its own design. **[Assumption]** The owner does not use Git history locally. See open question 6.
4. In one transaction, rewrite `project_id` on the artifact, its versions, its actions, its comment threads and replies, and its source binding. Delete its outstanding content bootstraps, content sessions, and preview leases. These rows are bound to the old project (`src/application/content-access.ts:400-404`), so a browser opening the artifact simply gets a new session. Append one `move` action in the destination, with the source project recorded in the action detail.
5. **Idempotency records stay in the source project.** They are keyed by `(project_id, idempotency_key)` (`src/storage/sqlite-artifact-repository.ts:4775-4786`), so moving them could collide with destination keys. Replaying a pre-move key in the source project answers not-found without disclosure, which is the same result as any artifact that is not in that project.
6. A cross-project **folder** move applies steps 1–5 to every non-trashed artifact in the subtree and re-scopes the folder records, all in one transaction. It is bounded to 1,000 artifacts and refused above that with `move-too-large`. Folder-name collisions at the destination parent are refused with `name-conflict`.

What changes for links and URLs:

- `/artifacts/:artifactId`, version content origins, and public links keep working unchanged, because they resolve by artifact ID or content token.
- Review URLs embed `project=` (`src/http/artifact-http-links.ts:10-24`), and a project-scoped artifact read answers not-found for an artifact in another project (`phase-8-project-scoped-artifacts.md`, "Domain contract"). The spec adds `GET /api/v1/artifacts/:artifactId/location`. For a principal with installation-wide artifact read, it answers `{projectId, folderId}` for a live or trashed artifact. The web application calls it when a Review URL answers not-found and replaces the URL with the new project. Callers without installation-wide read get the ordinary not-found, so nothing is disclosed.
- Plannotator workspace references name a project and an artifact (`artifact-server-product-spec.md`, line 308). Plannotator is not a local-deployment integration (`plannotator_capable` excludes `local`), so the local-only cross-project move cannot strand one. A future non-local port must revisit this.

### 4.4 Trash (ADR 0030)

Today's delete is already the right *mechanism*. It sets `deleted_at` without changing any version, stops every access path, appends a `delete` action, and keeps every byte (`src/storage/sqlite-artifact-repository.ts:1686-1744`; ADR 0003). Trash keeps that mechanism and adds two transitions:

```text
          trash (existing delete)            purge (new, irreversible)
 active ─────────────────────────► trashed ─────────────────────────► purged
   ▲                                  │
   └──────────── recover (new) ───────┘
```

- **Trash** sets `deleted_at` (as today) and `trash_group_id`. Access stops exactly as today: stable URL, exact-version routes, content origins, public links, comments, live view, and clone tokens. Versions, comments, actions, tags, the binding, and placement are all retained. A trashed artifact disappears from listings, the overview, search, dashboard counts, and folder views, and appears only in Trash.
- **Recover** clears `deleted_at`. The artifact comes back with the same artifact ID, versions, comments, tags, and binding, in its original folder. If that folder is trashed or purged, it comes back at the project root, and the response says so. **Public links do not come back silently.** A recovered artifact whose access setting was `public_link` returns as `account_required`. The response names the previous setting, and re-sharing is one explicit action. **[Assumption]** See open question 4.
- **Purge** sets `purged_at`. The item leaves Trash and can never be recovered through any product surface. All the access stops that trash applied stay in force for good. Purge is refused with `dispatch-held` while any of the artifact's threads is held by a `queued`, `claimed`, or `delivered` dispatch. That is the same rule that stops a sent comment from being deleted while it is dispatched (`src/core/model.ts:536-542`). Bytes are **not** reclaimed (section 9.4).
- **Folder trash** trashes the folder and its whole non-trashed subtree under one new `trashGroupId`. Recovering the folder recovers exactly that group. Items trashed earlier and separately stay in Trash. Recovering a single artifact out of a trashed folder places it at the project root. A folder whose sibling name is now taken recovers only with an explicit new `name`, and otherwise answers `name-conflict` with the colliding sibling's ID. Folder trash is bounded to 10,000 artifacts per operation and refused with `trash-too-large` above that.
- **Dispatches and trash.** Trashing is allowed while a dispatch holds threads, because nothing is destroyed. While trashed, an agent's `comment_reply` or `comment_resolve` on a held thread answers a stable `artifact-in-trash` error instead of plain not-found. That lets the agent report the dispatch as failed with a reason. The dispatch reaches the caller through a member's explicit send, so this is not a disclosure to a stranger. **[Assumption]** Current behavior of a reply on a tombstoned artifact was not verified.
- **Git history timing changes.** Today the tombstone transaction queues repository deletion (`src/storage/sqlite-artifact-repository.ts:1736-1740`; `git-history-spec.md` section 6). With trash, that job is queued at **purge**, so that recovery can find the mirror intact. New clone tokens are refused for a trashed artifact, and existing tokens expire within their one-hour cap. Locally this is moot under the section 4.3 assumption, but the rule is stated so a future port does not regress.
- **Retention.** No automatic purge by default. Auto-purge is irreversible and, under this spec, frees no space, so it buys nothing. An optional `ARTIFACT_SERVER_TRASH_RETENTION_DAYS` may be added later through the same purge path, attributed to a system principal. See open question 5.
- **Pre-existing tombstones.** Artifacts deleted before this feature lands appear in Trash and are recoverable. Their bytes were retained (ADR 0003). Their Git mirror, if any, may already be gone. **[Assumption]** See open question 7.

### 4.5 Linked folders (ADR 0031, amending ADR 0023)

A folder link binds one Artifact Server folder to one canonical directory:

```ts
export interface FolderLinkRecord {
  readonly id: string;                  // "flk_" + UUID
  readonly installationId: string;
  readonly projectId: string;
  readonly folderId: string;            // the Artifact Server folder that mirrors the directory root
  readonly path: string;                // canonical absolute directory; local member metadata only
  readonly rootDevice: string;          // st_dev of the directory at link time
  readonly ignore: readonly string[];   // per-link glob patterns, ≤ 100, each ≤ 200 chars
  readonly state: "active" | "paused" | "unavailable" | "over-limit";
  readonly lastScanStartedAt: string | null;
  readonly lastScanCompletedAt: string | null;
  readonly entryCount: number;
  readonly revision: number;
  readonly createdAt: string;
}

export interface InventoryEntryRecord {
  readonly id: string;                  // "fle_" + UUID
  readonly folderLinkId: string;
  readonly relativePath: string;        // NFC, "/"-separated, below the linked directory
  readonly fingerprint: string;         // device:inode:size:mtimeNs:ctimeNs (never reads bytes)
  readonly size: number;
  readonly observedAt: string;
  readonly state: "untracked" | "tracked" | "skipped";
  readonly skipReason: "symlink" | "special" | "too-large" | "unreadable" | "hostile-name" | "other-device" | null;
  readonly artifactId: string | null;   // set when tracked
}
```

How it fits ADR 0023:

- **Each captured file is an ordinary single-file linked artifact.** It has a source binding to the file's canonical path, and freshness, live view, capture, relink, and comment anchoring all work through the existing `LNK` contract. A folder link adds two things only: *discovery* (the inventory) and *placement* (captured files land in subfolders that mirror the relative directory, and those subfolders are created on demand at capture time).
- **Observation never publishes.** Scans and watch hints write only inventory rows and existing binding freshness. Freshness was already allowed to be written lazily (`RecordSourceFreshness`, `src/core/ports.ts:389-395`). Observation never creates an artifact, version, action, or folder. ADR 0023's reasons against auto-publish still hold: reads must not become writes, every version needs a responsible principal, and editor save storms must not flood history.
- **One explicit action captures.** `captureInventory({folderLinkId, entryIds | "all-pending"})`, attributed to the caller, turns every selected `untracked` entry into a linked artifact with its initial capture (the `LNK-002` path), and every `tracked` + `modified` entry into a new version (the `LNK-004` path). Results are reported per entry.
- **Linking a folder creates no artifact.** The link record is written and the first scan runs. Nothing becomes an artifact until a capture.
- **The live view extends to untracked entries.** A local authenticated member can preview an untracked entry's current bytes through a per-entry live origin (`live-fle-<uuid>`), with exactly the `LNK-007` audience, `no-store`, and verified-descriptor rules. This lets the owner see a file before deciding to capture it. **[Assumption]** The per-entry live origin is acceptable. It is a new origin shape next to the per-artifact `live-<uuid>` origin (`src/application/linked-artifacts.ts:64-65`, `:372-377`).

Discovery, ignore rules, scale, and on-disk deletes are in section 10.

## 5. Ports and application operations

Product logic stays independent of SQLite, the filesystem, HTTP, and MCP, as AGENTS.md requires. Ports are named for product behavior.

### 5.1 Ports (in `src/core/ports.ts`)

| Port | Operations | Implemented by |
| --- | --- | --- |
| `FolderRepository` | `createFolder`, `renameFolder`, `moveFolder` (same project), `findFolder`, `listFolderChildren` (folders + artifacts, keyset), `folderAncestors` (≤ 16), `trashFolder`, `recoverFolder`, `purgeFolder` | SQLite now; Postgres/D1 later |
| `ArtifactPlacementRepository` | `renameArtifact`, `moveArtifact` (same project), `moveArtifactToProject`, `moveFolderToProject`, `locateArtifact` | SQLite |
| `TrashRepository` | `listTrash` (keyset, cross-project), `recoverArtifact`, `purgeArtifact` | SQLite |
| `FileCatalogRepository` | `listFiles` (cross-project, filters, keyset), `fileFacets` (bounded counts) | SQLite |
| `FolderLinkRepository` | `createFolderLink`, `updateFolderLink` (ignore, pause), `removeFolderLink`, `findFolderLink`, `listFolderLinks`, `applyScanPage` (one transaction per page of observations), `listInventory` (keyset, by state) | SQLite (local only, like `SourceBindingRepository`: `src/core/ports.ts:416`) |
| `LinkedDirectoryScanner` | `canonicalizeDirectory`, `scanPage(canonicalDir, cursor, budget) → {observations, nextCursor}` | Node engine in `src/local/` beside `linked-source-engine.ts` |
| `LinkedDirectoryWatcher` | `watch(folderLinkId, canonicalDir) → Stream<WatchHint>`, `unwatch` | Node engine (FSEvents via recursive `fs.watch` on macOS) |

`IdGenerator` (`src/core/ports.ts:717`) gains `folderId()`, `folderLinkId()`, `inventoryEntryId()`, and `trashGroupId()`. `ArtifactActionKind` (`src/core/model.ts:13-28`) gains `rename`, `move`, `recover`, and `purge`. Folder mutations are recorded in a new `folder_actions` table, because `actions.version_id` is `NOT NULL` and names an artifact version (`src/storage/sqlite-artifact-repository.ts:4788-4798`).

### 5.2 Application services (in `src/application/`)

| Service | Operations | Authorization |
| --- | --- | --- |
| `FolderService` | `createFolder`, `renameFolder`, `moveFolder`, `listFolder`, `getFolderPath` | Read: artifact read on the project. Write: `requireArtifactManagement`, the same as delete (`src/application/artifact-management.ts:561-572`). |
| `ArtifactPlacementService` | `renameArtifact`, `moveArtifact`, `moveAcrossProjects`, `locateArtifact` | Management. `locateArtifact` requires installation-wide artifact read. |
| `TrashService` | `trashArtifact` (the existing `deleteArtifact` when `trash` is present), `trashFolder`, `listTrash`, `recoverArtifact`, `recoverFolder`, `purgeArtifact`, `purgeFolder` | Trash and recover: management. Purge: a direct human member, or a service key holding the new `artifact:purge` capability, which is never granted by default. |
| `FileCatalogService` | `listFiles`, `fileFacets` | Artifact-listing authority, the same rule as `GET /api/v1/artifacts` (ADR 0003 "Listing contract"). |
| `BatchService` | `runBatch({operation, items, params, idempotencyKey})` → per-item results, calling the services above | Each item is authorized as if it were sent alone. |
| `LinkedFolderService` | `linkFolder`, `updateFolderLink`, `unlinkFolder`, `scanNow`, `listInventory`, `captureInventory`, `suggestRelinks`, `issueEntryLiveBootstrap` | The `LNK-006` ladder: local deployment, feature on, loopback application origin, admitted member or a key with the link capability. |
| `LinkedFolderIndexer` (runtime fiber, local only) | Owns watchers, debounces hints, schedules scans, and runs startup and periodic reconciliation | Runs as the system. Writes only inventory and freshness. |

Every write operation takes an idempotency key and a concurrency guard (`expectedCurrentVersionId` for artifacts, `expectedRevision` for folders and links), and appends an action in the same transaction. This is the `ART`/`KAN` discipline.

## 6. Surfaces — HTTP, MCP, CLI, and web parity

New routes follow the code's actual convention: artifact routes are `/api/v1/artifacts/:artifactId` with an optional `projectId` query (`src/http/create-http-app.ts:2765-2768`), and project-owned collections live under `/api/v1/projects/:projectId/...`. (The linked-artifact routes shipped as `/api/v1/artifacts/link|:id/capture|:id/source` — `src/http/create-http-app.ts:2384`, `:2411`, `:2435` — not the project-nested paths that `local-workspace-spec.md` section 4.4 drafted.)

| Operation | HTTP | MCP tool | CLI |
| --- | --- | --- | --- |
| List a folder (children + breadcrumbs) | `GET /api/v1/projects/:projectId/folders/:folderId?cursor=` (`root` for the project root) | `folder_list` | `artifactserver ls [--project] [path-or-id]` |
| Create folder | `POST /api/v1/projects/:projectId/folders` `{id?, name, parentFolderId}` | `folder_create` | `artifactserver mkdir` |
| Rename / move folder (same project) | `PATCH /api/v1/projects/:projectId/folders/:folderId` `{name?, parentFolderId?, expectedRevision}` | `folder_update` | `artifactserver mv` |
| Rename artifact | `PATCH /api/v1/artifacts/:artifactId/name` `{name, expectedCurrentVersionId}` | `artifact_rename` | `artifactserver rename` |
| Move artifact (same or other project) | `POST /api/v1/artifacts/:artifactId/move` `{toProjectId?, toFolderId, expectedCurrentVersionId}` | `artifact_move` | `artifactserver mv` |
| Move folder to another project | `POST /api/v1/projects/:projectId/folders/:folderId/move-to-project` `{toProjectId, toParentFolderId, expectedRevision}` | `folder_move_to_project` | `artifactserver mv --to-project` |
| Locate artifact | `GET /api/v1/artifacts/:artifactId/location` | (in `artifact_get` error detail) | — |
| Trash artifact | `DELETE /api/v1/artifacts/:artifactId` (unchanged shape plus `recoverable`) | `artifact_delete` (description updated) | `artifactserver rm` |
| Trash folder | `DELETE /api/v1/projects/:projectId/folders/:folderId?expectedRevision=` | `folder_trash` | `artifactserver rm -r` |
| List trash | `GET /api/v1/trash?projectId*&cursor=` | `trash_list` | `artifactserver trash ls` |
| Recover | `POST /api/v1/artifacts/:artifactId/recover`, `POST /api/v1/projects/:projectId/folders/:folderId/recover` `{name?}` | `artifact_recover`, `folder_recover` | `artifactserver trash recover` |
| Purge | `POST /api/v1/artifacts/:artifactId/purge`, `.../folders/:folderId/purge` `{confirm: <exact name>}` | **None by default** (open question 8) | `artifactserver trash purge --confirm <name>` |
| File overview | `GET /api/v1/files?projectId*&folderId=&recursive=&kind*&tag*&linked=&createdAfter=&createdBefore=&updatedAfter=&updatedBefore=&search=&sort=&cursor=&limit=` | `file_search` | `artifactserver files` |
| Facets | `GET /api/v1/files/facets?…same filters` | (included in `file_search` output) | — |
| Batch | `POST /api/v1/batch` `{operation, items[], params, idempotencyKey}` | `batch_apply` | `artifactserver batch <operation> --items <file>` (shipped as one command instead of `--batch` on `mv`, `rm`, `tag`) |
| Link folder | `POST /api/v1/projects/:projectId/folder-links` `{path, folderId \| newFolderName, ignore?, idempotencyKey}` | `folder_link` | `artifactserver link-folder <dir>` |
| Update / pause / unlink | `PATCH` / `DELETE /api/v1/folder-links/:folderLinkId` | `folder_link_update`, `folder_unlink` | `artifactserver link-folder --pause/--unlink` |
| Scan now | `POST /api/v1/folder-links/:folderLinkId/scan` | `folder_link_scan` | `artifactserver link-folder --scan` |
| Inventory | `GET /api/v1/folder-links/:folderLinkId/inventory?state=&cursor=` | `folder_link_inventory` | `artifactserver link-folder --status` |
| Capture pending | `POST /api/v1/folder-links/:folderLinkId/capture` `{entryIds \| all: true, idempotencyKey}` | `folder_link_capture` | `artifactserver capture <dir>` |
| Entry live view | `POST /api/v1/folder-links/:folderLinkId/entries/:entryId/live-sessions` | — (agents read files directly) | — |

Batch contract:

- `operation` is one of `move`, `trash`, `recover`, `purge`, `tag-add`, `tag-remove`, `capture`. Items are `{kind: "artifact", projectId, artifactId, expectedCurrentVersionId}` or `{kind: "folder", projectId, folderId, expectedRevision}`, with 1..100 items. A repeated item is refused before any work, which follows the public-link bulk precedent: max 100, no repeats (`src/application/public-link-administration.ts:27`; `src/http/create-http-app.ts:395-404`).
- Each item is its own atomic transaction with its own derived idempotency key: SHA-256 of `batchKey`, item index, and item identity. Results are `{status: "ok" | "conflict" | "not-found" | "refused", code?, current?}` per item, in request order. A replay of the whole batch returns the same per-item results. **Batches are not all-or-nothing.** A 100-item move that hits one conflict moves 99 items and reports one.
- `tag-add` and `tag-remove` compute each artifact's new full tag set under that item's guard and reuse `changeTags` and `parseArtifactTags`, so the 20-tag and 40-grapheme limits (`src/application/artifact-tags.ts:6-7`) apply per item.
- `purge` in a batch still requires the human-member or `artifact:purge` rule, plus a top-level `confirm: "purge <n> items"` string that matches the item count.

MCP rules carried over: MCP carries metadata, never file bytes. `folder_link` accepts a path only on the local deployment. A remote MCP server never accepts a client filesystem path (`local-workspace-spec.md` section 4.4). Destructive-annotation hints: `artifact_delete` and `folder_trash` keep the destructive hint, but their descriptions say the item is recoverable from Trash. `purge`, if it is ever exposed, is destructive.

## 7. Web application

Constraints that are not reopened here: Review keeps its artifact-first layout and gains **no permanent sidebar**, and Settings uses the simple page shell (`project/spec/single-application-administration-spec.md:58-75`). The dashboard is a separate full page at `/review/dashboard` (`apps/web/src/review/review-routes.ts`, `dashboardPath`). The Files page follows the same pattern.

### 7.1 Where things live

| Surface | Placement |
| --- | --- |
| **Files** (the overview) | A new full page at `/review/files`, opened from the catalog header next to the dashboard and settings entries. The page has a filter bar (kind, project, tag, linked status, time range, search), a sortable table (name, kind, project › folder path, size, updated, tags, comment count, linked freshness), and a **page-local** folder tree column on wide viewports. That column is part of the Files page, not application navigation, and it collapses into a "Folder" picker on narrow viewports. All filter and folder state is in the URL (`?project=&folder=&kind=…`), so the page is refresh-safe and shareable. |
| **Folders in Review** | The existing catalog pane (the artifact list beside the preview) gains drill-down: a breadcrumb at the top, folder rows before artifact rows, and Enter or double-click to open a folder. It is a list that navigates, not a tree rail. The selected folder is a `folder=` query parameter in the Review URL. |
| **Trash** | `/review/files/trash`, the same page shell in trash mode. Columns: name, kind, original location, trashed at, trashed by, group. Actions: Recover and Purge. |
| **Move to…** | A dialog with a searchable project-and-folder tree picker and an optional "New folder". The same dialog is used for one item and for a batch. |
| **Details inspector** | Gains a Location row (project › folder path, with "Move…"), a Rename action, and the existing delete action, relabeled **Move to Trash**. |
| **Linked folder** | A folder that has a link shows a link badge in breadcrumbs and Files. Its folder view gains a **Pending** strip ("12 new, 3 changed · Capture all · Review"), an inventory sheet listing pending entries with live-preview buttons, a Scan-now action, an ignore-rules editor, and pause and unlink. |

### 7.2 Selection and batch actions

- A checkbox column in Files and Trash. Click toggles, Shift-click selects a range, and Cmd/Ctrl-A selects all rows **loaded on the current page**. There is no server-side "select all matching" in v1. The UI tells the user when a selection exceeds 100 and runs it as consecutive batches with one combined result summary.
- A selection bar appears only while something is selected: Move…, Add tag, Remove tag, Move to Trash, and, for linked items, Capture. In Trash it offers Recover and Purge.
- **Trash is undoable, so it needs no typed confirmation.** The current Details delete uses a typed-name confirmation (`single-application-administration-spec.md:214-222`). It becomes a one-click Move to Trash followed by an "Undo" toast that calls recover. **Purge keeps the typed confirmation.** For a batch, the user types the item count.
- Per-item failures from a batch are listed in a result sheet. Each line names the item and the reason in plain language (changed elsewhere, held by an agent, name taken, and so on) with a retry for conflicts.
- Drag-and-drop of rows onto folder-tree nodes and breadcrumbs is a progressive enhancement over the same move call. Keyboard parity is via Move….

### 7.3 States the UI must cover

Empty folder, empty project, empty trash, empty filter result, a folder over the 10,000-child UI target (paged), a capture in progress, a linked folder that is `unavailable` (directory missing) or `over-limit`, a recovered public artifact (explaining that it is now account-required), and a capability that is absent (no affordance at all).

## 8. Backup, restore, and integrity

- **Compact backup is still "copy the stopped data directory"** (`phase-11-content-and-lifecycle-closure.md:41-51`). The new tables (`folders`, `folder_actions`, `folder_links`, `folder_inventory`) and columns (`artifacts.folder_id`, `trash_group_id`, `purged_at`, `file_kind`) live in the same SQLite file, so they are included automatically.
- **Restore preserves** folder IDs, parents, names, revisions, placement, trash state, trash groups, purge marks, and folder-link records.
- **Folder links are machine-bound.** After a restore, every folder link starts `unavailable` until its first scan succeeds: the canonical directory must still exist, resolve to the same canonical path, sit inside the current link roots, and pass self-protection. A restore onto a different machine or user never starts watching an arbitrary path. The owner re-links or relinks. Inventory rows from the backup are treated as stale and replaced by the first scan.
- **The integrity check** (`artifactserver integrity`, `src/lifecycle/integrity-check.ts:351`) gains these checks: the folder graph is acyclic and within the depth bound; every `artifacts.folder_id` names a folder in the same project; no non-trashed artifact sits in a purged folder; sibling `nameKey` values are unique among live folders; every tracked inventory entry names an artifact whose binding path equals the link path joined with the relative path; and every child row of an artifact (versions, actions, threads, replies) carries the artifact's current `project_id`, the post-move invariant from section 4.3.

## 9. Security

### 9.1 Names and paths inside Artifact Server

- Folder and artifact names are labels. They never reach a filesystem call, a blob key, a content origin, or a manifest path. Blob storage is keyed by content hash, not by any name. Manifest paths are untouched by every operation in this spec.
- Name validation (section 4.1) rejects control characters, separators, `.`/`..`, and leading or trailing dots and whitespace. Sibling uniqueness uses the case-folded NFKC key, so `Report`, `REPORT`, and the full-width `Ｒｅｐｏｒｔ` collide. Bidirectional-override characters (U+202A–U+202E, U+2066–U+2069) are rejected in folder names and are rendered visibly, never interpreted, in artifact names in the UI.
- Folder IDs, project IDs, and artifact IDs from requests are always resolved through installation → project → record, with one not-found answer for missing and foreign records (`phase-8-project-scoped-artifacts.md`, "Domain contract").

### 9.2 Linked-directory input (the one place a path enters)

The full `LNK-006` ladder applies to `linkFolder`, plus these rules:

1. **Canonicalize the directory** with `realpath`. It must be a directory (`lstat`, not a symlink at the final component), inside a configured link root (`checkLinkRoots`, `src/local/linked-source-engine.ts:135`), and not the data directory or below it, nor an ancestor-or-equal of the SQLite files' directory unless that subtree is hard-excluded (rule 4).
2. **No overlapping links.** A new link whose canonical directory equals, contains, or is contained by an existing link in the installation is refused with `link-overlap`. Overlap would put one file in two inventories and allow two captures.
3. **Scanning never follows symlinks.** Entries are read with `opendir` and `lstat` below the canonical root. A symlink, of any kind and to any target, becomes `skipped: symlink` and is never descended into or captured. Special files (sockets, FIFOs, devices) become `skipped: special`. A directory whose `st_dev` differs from `rootDevice` (a mount point) is not crossed and becomes `skipped: other-device`. These rules together mean a scan cannot escape the link root.
4. **The data directory is always excluded**, wherever it sits relative to the linked directory, regardless of ignore rules. (This fork keeps an `.artifact-server` directory inside the working tree, so the case is real.)
5. **Capture re-verifies everything.** Capturing an entry builds the absolute path from the canonical link path and the stored relative path, re-runs `canonicalizeLinkPath`, `checkLinkRoots`, and `checkSelfProtection`, and requires the canonical result to equal the joined path. Any difference, such as a parent directory swapped for a symlink after the scan, refuses that entry with `source-moved`. It then follows the existing verified-descriptor capture: `O_NOFOLLOW`, fingerprint check on the descriptor, and hash-then-re-verify (`local-workspace-spec.md` section 4.2).
6. **Inventory paths never select storage.** Relative paths are display and lookup data only. The capture path goes through the staging and publish pipeline like any capture, and the manifest path of a captured single file is its sanitized basename, as linking does today.
7. **Disclosure.** Absolute directory paths and relative inventory paths appear only in authenticated application-origin responses on the local deployment. They never appear on the content origin, in public-link responses, in logs, or in metric labels (`local-workspace-spec.md` section 4.3 rule 6).

### 9.3 Hostile file names on disk

- A file name that is not valid UTF-8, or that contains control characters, bidirectional overrides, or a path separator after normalization, becomes `skipped: hostile-name`. It is listed by escaped form in the inventory so the owner knows it exists, and it is never captured or named in a URL.
- Names are NFC-normalized for display and matching. The raw on-disk byte name is kept for the filesystem call, so an NFD name created on macOS still resolves.
- An artifact created from a file takes the file's basename as its name label. A basename that fails artifact-name rules is replaced by a safe escaped form, and the original relative path is visible in the linked-source section.

### 9.4 Purge and bytes

Purge removes recoverability, not bytes. Committed blobs stay until a collector that passes `OPS-007` exists, because a blob may be shared by deduplication with live artifacts and because blob collection was explicitly deferred (`phase-11-content-and-lifecycle-closure.md:29-39`; `ART-007`, `OPS-006`, `OPS-007`). The Trash and Purge UI says plainly: "Purge cannot be undone. It does not free disk space yet." If the owner wants space reclaimed, that is a separate collector design (open question 2).

### 9.5 Authorization summary

| Action | Who |
| --- | --- |
| Read folders, Files, Trash | Artifact-listing authority (admitted human, or a key with installation-wide read) |
| Create, rename, move, trash, recover; batch of those | Artifact management (`requireArtifactManagement`) |
| Cross-project move | Artifact management, with both projects active |
| Purge | Direct human member, or a key holding `artifact:purge` (not granted by default) |
| Link, scan, capture, entry live view | The `LNK-006` ladder |

## 10. Linked folders in detail

### 10.1 Discovery

- **Startup and link time.** A full reconciliation scan runs.
- **Watch hints.** With `ARTIFACT_SERVER_LINKED_FOLDER_WATCH=on`, the indexer subscribes to recursive FSEvents (`fs.watch(dir, {recursive: true})` on macOS). A hint marks its directory dirty. Dirty directories are rescanned after a 750 ms debounce, coalesced per link, with at most one scan per link in flight. **[Assumption]** Node's recursive watch on macOS is reliable enough to use as a hint source. It is never trusted as a fact, so a missed event costs latency, not correctness.
- **Periodic reconciliation.** Every 10 minutes per active link, as a backstop for dropped events, sleep and wake, and watcher overflow. The indexer also rescans after a watcher error and backs off on repeated errors.
- **Manual.** `scanNow` from any surface.
- A file whose fingerprint changes during a debounce window is simply observed once, at its final state. Nothing is published, so save storms cost one inventory write per settle.

### 10.2 Inventory states and transitions

| Observation | Inventory | Binding / artifact |
| --- | --- | --- |
| New regular file, not ignored | `untracked` (pending) | none |
| File whose canonical path equals an existing binding **in this project** | `tracked` | freshness refreshed (`in-sync` / `modified`) |
| File bound by an artifact in **another** project | `skipped`, with that artifact's ID shown to authorized readers | untouched |
| Tracked file modified | `tracked`, pending | freshness `modified` (the existing `LNK-003` path) |
| Untracked file removed | entry deleted | — |
| Tracked file removed | entry deleted | freshness `missing`. **The artifact is not trashed or changed.** |
| Ignored path | not stored. The scan reports `ignoredCount`. | — |

### 10.3 Ignore rules

Applied in order. The first exclusion wins.

1. **Hard exclusions** that cannot be overridden: the data directory and SQLite files; `.git/`; any symlink, special file, or other-device directory.
2. **Built-in defaults** that a per-link rule can re-include: `node_modules/`, `.DS_Store`, `Thumbs.db`, `*.swp`, `*~`, `.~lock.*`, `~$*`, `*.tmp`, `*.partial`, `*.crdownload`, and dot-directories other than `.well-known/`.
3. **A `.artifactignore` file** at the linked directory root, using gitignore syntax and read at scan time. It is bounded to 64 KiB and 1,000 patterns; anything beyond that makes the link `over-limit` until it is fixed.
4. **Per-link `ignore` patterns** stored on the link record.

`.gitignore` is **not** honored by default. Output directories such as `dist/`, `out/`, and `reports/` are usually git-ignored, and those are exactly what the owner wants to capture. **[Assumption]** See open question 9.

### 10.4 Large folders and limits

| Limit | Value | When exceeded |
| --- | --- | --- |
| Inventory entries per link (non-ignored regular files) | 20,000 | Link becomes `over-limit`. Existing entries stay, new files are not indexed, and the UI shows how to narrow the link with ignore rules or a subdirectory. |
| Directory depth below the link | 16 | Deeper entries become `skipped: too-deep` and are counted. |
| Scan page | 2,000 directory entries per `scanPage`, one SQLite transaction per page, yielding between pages | — (a scan of 20,000 files is about 10 short transactions) |
| Concurrent scans | 1 per link, 2 per installation | Queued |
| Per-file capture size | The existing publish per-file limit | `skipped: too-large` (still listed) |
| Capture batch | 100 entries per call. "Capture all" pages through. | — |
| Folder links per installation | 50 | Refused with `link-limit` |

Reads and publishing stay responsive during a scan. Scan pages never hold the write transaction longer than one page, and scan work runs on the indexer fiber, not the request path.

### 10.5 Renames and moves on disk

A file renamed on disk appears as the old entry `missing` and a new entry `untracked`. The indexer computes **relink suggestions**: when a new untracked entry's size equals a missing binding's last captured size, its SHA-256, hashed lazily and only for those candidates, is compared with the binding's last captured content hash. A match produces a suggestion, "Looks like *a.md* moved to *docs/a.md*", and accepting it calls the existing relink, which already requires the expected hash (`LNK-005`). Nothing relinks automatically.

### 10.6 Unlink, pause, and trash of a linked folder

- **Pause** stops watching and scheduled scans and keeps the inventory.
- **Unlink** removes the link and its inventory. Captured artifacts stay as ordinary linked artifacts with their individual bindings, and they stay in their folders.
- **Trashing** the linked folder pauses the link. Recovering the folder resumes it with a fresh scan. Purging the folder removes the link.
  - While the folder is in Trash, the link reads as `paused` with `inTrash: true`, its watcher stops, and no scheduled scan runs. Resume, ignore changes, explicit scans, captures, relink acceptance, and live previews answer `folder-link-in-trash`. Unlink and inventory reads still work. An owner's own pause is kept: a recovered folder resumes the link only if the owner had not paused it.
  - Purging the folder deletes the link with its inventory, capture records, and live grants. Captured artifacts in the purged group are purged with it; nothing on disk changes.
  - A cross-project move of a linked folder carries the link into the destination project and ends its live-preview grants.

### 10.7 Artifact Server never writes to the linked directory

No operation in this spec creates, moves, renames, edits, or deletes anything on disk. This includes rename, move, trash, purge, and unlink. Disk and Artifact Server placement are independent after the first capture: moving a captured artifact to another folder in Artifact Server leaves the file where it is, and the inventory still tracks it by binding path. (The only `.artifactignore` file is one the owner writes.)

## 11. File overview

### 11.1 Query contract

`listFiles` returns non-trashed artifacts across every project the caller may list, optionally narrowed. Filters combine with AND, and multiple values of one filter combine with OR.

- `projectId` (repeatable) and `folderId` with `recursive=true|false`. The recursive form walks a subtree bounded by depth 16 and 10,000 folders.
- `kind` (repeatable), from section 11.2.
- `tag` (repeatable), with the existing exact normalized-tag semantics (`src/core/ports.ts:196-197`).
- `linked`: `any | linked | drifted | missing | not-linked`.
- `createdAfter/Before` and `updatedAfter/Before`, where updated is the current version's commit time.
- `search`: the existing normalized name search.
- `sort`: `updated` (default), `created`, `name`, `size`, `comments`, in either direction. Keyset cursors are opaque and stable under concurrent writes, as `PageCursor` is today (`src/core/model.ts:113-118`).
- `limit` ≤ 100.

Each item returns: the artifact ID, name, project ID and name, folder ID and display path, file kind, current version ID and number, current size (sum of manifest entry sizes), entry media type, tags, comment count, version count, access setting, linked freshness, `createdAt`, and `updatedAt`.

`fileFacets` returns bounded counts per kind, per project, and the top 50 tags for the same filter, so the filter bar can show numbers. Linked-folder untracked entries are **not** files. They appear in their linked folder's Pending strip, plus a Files-header banner: "23 pending in 3 linked folders".

### 11.2 File kind classification

`file_kind` is computed when a version is committed and stored on the artifact as a property of its current version. A restore recomputes it. A migration backfills existing rows. The rules, applied to the current version's normalized entry media type (`media-preview-spec.md:60-69`):

| Kind | Rule |
| --- | --- |
| `site` | The manifest has more than one entry and the entry is `text/html` |
| `html` | `text/html` |
| `markdown` | `text/markdown`, `text/x-markdown` |
| `pdf` | `application/pdf` |
| `image` / `video` / `audio` | `image/*` / `video/*` / `audio/*` |
| `data` | `text/csv`, `text/tab-separated-values`, `application/json`, `application/x-ndjson`, `application/xml`, `text/xml`, `application/yaml`, `application/vnd.apache.parquet`, `application/x-sqlite3` |
| `code` | `text/javascript`, `application/javascript`, `text/x-*` source types, `application/x-sh`, and others |
| `archive` | `application/zip`, `application/gzip`, `application/x-tar`, and others |
| `text` | Any other `text/*` |
| `other` | Everything else |

When the media type is `application/octet-stream` or `text/plain`, the **entry path's extension may refine the kind for filtering only** (for example `.md` → `markdown`, `.ts` → `code`). The extension never chooses a renderer and never promotes a file to inline display. The media-preview rule that "Artifact Server never sniffs bytes or trusts a filename extension to promote a file into an inline preview" stands unchanged (`media-preview-spec.md:60-69`).

## 12. Previews for "any project output" (follow-on slices)

`media-preview-spec.md` covers images and video only, and lists audio, PDF, Markdown, source code, and office documents as non-goals of that slice (`media-preview-spec.md:161-170`). The owner's scope ("each with a suitable preview") needs the follow-on slices named. Each one keeps the established boundaries: exact-version, never sniffing, never inserting untrusted markup into the application origin, and a typed fallback otherwise.

| Kind | Presentation | Boundary |
| --- | --- | --- |
| Audio | Native `<audio controls preload="metadata">`, no autoplay | Same authenticated media route as video. Destination `audio` is added to the media-destination allowlist. Range support is reused. |
| PDF | The browser's PDF viewer inside the **isolated content-origin frame**, loaded from the version content origin with a preview lease | Never rendered as an application-origin document. The media route's document rejection stays (`PRV-003`). |
| Markdown | Rendered to sanitized HTML **inside the isolated review frame** on the content origin. The application origin never parses or inserts it. Raw-source toggle available. | Sanitizer allowlist: no scripts, no event handlers, no `javascript:` URLs. Relative links and images resolve inside the same version only. |
| Code / text | Read as text (≤ 1 MiB, UTF-8 with replacement), rendered as text nodes with line numbers and optional syntax highlighting from a tokenizer that outputs text spans, never `innerHTML` of file bytes | Larger files show the first 1 MiB with a download action. |
| Data (CSV/TSV/JSON/NDJSON) | CSV/TSV: a virtualized table of the first 5,000 rows. JSON: a collapsible tree of the first 5 MiB. Rendered as text nodes. | Parsing runs in a worker with time and size bounds and settles to the typed fallback when exceeded. |
| Office, archives, other | Typed fallback with metadata and download | Unchanged (`PRV-005`) |

These are `PRV-006` through `PRV-010`, continuing the PRV family that `media-preview-spec.md` owns. They are not a new prefix, because they extend that spec's declared follow-on slices.

## 13. Performance targets

Measured with `pnpm perf:baseline` conventions on the local SQLite deployment, on one machine class, repeated runs (AGENTS.md "Performance verification"). These are budgets to establish, not gates to tighten from one laptop run.

| Operation | Data set | Target (p95, warm) |
| --- | --- | --- |
| `listFiles`, first page of 100, default sort, no filter | 100,000 artifacts, 20 projects, 2,000 folders | ≤ 150 ms |
| `listFiles` with kind + tag + time filters | same | ≤ 200 ms |
| `listFolderChildren`, one page | a folder with 10,000 artifacts | ≤ 50 ms |
| Rename or move one folder (any subtree size) | 10,000 descendants | ≤ 20 ms (one row) |
| Move one artifact across projects | 200 versions, 500 threads | ≤ 250 ms |
| Trash a folder subtree | 10,000 artifacts | ≤ 2 s, one transaction |
| Batch of 100 moves | — | ≤ 1.5 s |
| Full scan of a linked folder | 20,000 files, warm cache | ≤ 5 s total; no request-path p95 regression above 10% while it runs |
| Watch hint → inventory visible | single file save | ≤ 2 s |

Indexes (SQLite): `artifacts(project_id, folder_id, deleted_at, search_name)`, `artifacts(deleted_at, file_kind, current_version_created_at DESC, id)`, `artifacts(deleted_at, current_version_created_at DESC, id)`, `folders(project_id, parent_folder_id, name_key)` (unique where live), `folder_inventory(folder_link_id, state, relative_path)`. `current_version_created_at` and `current_size` are denormalized on the artifact at commit and restore, so the overview never joins the version tables per row. **[Assumption]** The denormalization is acceptable. The alternative is a join through `versions` and an aggregate over `manifest_entries` on every page.

## 14. Migration of existing data

One SQLite schema revision. `requiredSqliteSchemaVersion` is 12 today (`src/storage/sqlite-schema.ts:9`), and the migration moves it to 13. It is transactional and repeat-safe, following the phase-8 discipline:

1. Create `folders`, `folder_actions`, `folder_links`, and `folder_inventory`.
2. Add `artifacts.folder_id` (NULL), `trash_group_id` (NULL), `purged_at` (NULL), `file_kind`, `current_version_created_at`, and `current_size`. Backfill the last three from each artifact's current version.
3. **Every existing artifact lands at its project root** (`folder_id = NULL`). No artifact, version, content token, action, tag, comment, binding, or link changes.
4. Existing tombstones (`deleted_at IS NOT NULL`) become Trash entries with no group (open question 7).
5. Widen the `idempotency_records.operation` check (`src/storage/sqlite-artifact-repository.ts:4781`) to include `rename`, `move`, `recover`, and `purge`, using the existing table-rebuild pattern that the file already applies to `idempotency_records`.
6. Advance `user_version` only after every step succeeds. A database newer than the build is refused, as today.

There is no data move, no blob change, and no backfill job. Existing review URLs, stable URLs, and public links keep working exactly as before the migration.

## 15. Non-goals

- Writing to the user's filesystem in any form: syncing back, moving files on disk when they are moved in Artifact Server, or deleting files on purge.
- **Automatic capture** from a linked folder. Watching indexes; capture stays explicit (ADR 0031). An opt-in auto-capture mode would need its own decision (open question 1).
- Linking a directory as **one multi-file site artifact**. Every captured file is its own artifact in v1 (open question 10).
- Unique artifact names, or file-system semantics such as "overwrite on same name".
- Reclaiming blob bytes on purge (section 9.4).
- Project deletion. That stays out of scope (`artifact-server-product-spec.md:78`).
- Folder-level permissions, per-folder sharing, or public folder links. Access stays per artifact plus installation membership.
- Server-side thumbnails, transcoding, office-document rendering, and full-text content search.
- Folders, trash, overview, or linked folders on non-local deployments in this fork.
- An MCP surface for purge (pending open question 8).

## 16. Open questions for the owner

**Decisions (November 24, 2026).** The owner delegated these choices; each takes this spec's recommendation unless noted, and can be revisited:
1. Explicit capture only; no auto-capture in v1.
2. Purge frees no disk space in v1 (blob collection stays with `OPS-007`).
3. Duplicate artifact names in one folder stay allowed.
4. Recovered public artifacts come back account-required.
5. Trash is kept until purged; no automatic purge.
6. Cross-project moves are refused while Git history is enabled for either project.
7. Artifacts deleted before this feature appear in Trash and are recoverable.
8. Purge is human-only.
9. `.gitignore` is ignored by default (its entries are not used as ignore rules).
10. A directory with `index.html` is not captured as one site in v1; files are captured individually.
11. Files is a header entry beside Dashboard and Settings; the Review catalog stays the landing view.
12. No release action in v1; resolving or failing the threads manually unblocks purge.

The original questions follow.

1. **Auto-capture.** Is "new files appear, one click captures" enough, or do you want an opt-in per-link auto-capture? It would be debounced, attributed to the link's creator, and amend ADR 0031 and ADR 0023. Recommendation: ship explicit capture, then measure how often you press "Capture all".
2. **Reclaiming space on purge.** Is "purge stops recoverability but frees no disk space yet" acceptable for v1? Reclaiming bytes needs the deferred blob collector (`OPS-007`), which is a separate and larger design.
3. **Duplicate names in one folder.** Allow them (current behavior; this spec's choice), or enforce unique artifact names per folder? Enforcing would change publishing semantics for agents.
4. **Recovered public links.** Recover public artifacts as account-required (this spec's choice, the safe default), or restore the public link as it was?
5. **Trash retention.** Keep trash forever until purged (this spec's choice), or auto-purge after N days (30?) through the same purge path?
6. **Git history and cross-project moves.** Do you use Git history locally? If not, refusing cross-project moves when it is enabled costs nothing. If you do, the move needs a mirror-reconciliation design.
7. **Old deletions.** Should artifacts deleted before this feature appear in Trash and be recoverable (this spec's choice), or stay invisible tombstones?
8. **Purge from agents.** Should agents be able to purge through MCP with a dedicated key capability, or is purge human-only (this spec's choice)?
9. **`.gitignore`.** Ignore it by default (this spec's choice, because outputs are usually git-ignored), or honor it with a per-link toggle?
10. **Sites in linked folders.** Should a subdirectory containing `index.html` be capturable as one multi-file site artifact instead of N single-file artifacts?
11. **Where the Files entry lives.** Is a header entry beside Dashboard and Settings right, or should Files replace the Review catalog as the default landing view?
12. **Release of a delivered dispatch.** A `delivered` dispatch holds its threads until they are resolved. If an agent never resolves them, purge stays blocked. Do you want a human "release" action, or is resolving and failing the threads manually enough?

## 17. Implementation order

Each phase ends with `pnpm verify:iteration`. `pnpm smoke` runs after phases that touch SQLite, delivery, or restart behavior.

1. **Folders and in-project placement** (`FLD-001`, `FLD-002`, `FLD-003`, `FLD-006`, `FLD-008`): migration to schema 13, the `FolderRepository` and `ArtifactPlacementRepository` ports with SQLite adapters, `FolderService` and `ArtifactPlacementService`, HTTP and MCP and CLI, catalog drill-down, the Move dialog, and Rename. About 1.5 weeks. **[Assumption]** Estimates are relative to the LNK slice's 1.5–2.5 weeks.
2. **Trash** (`TRS-001`–`TRS-005`): recover, purge, folder trash groups, the delete-semantics capability flag, Git-deletion timing, the Trash page, and the Undo toast. About 1 week.
3. **File overview and batch** (`FOV-001`–`FOV-004`, `FLD-005`): `file_kind` and denormalized columns, `FileCatalogRepository`, the `/review/files` page, selection, `BatchService`, and the performance baseline. About 1.5 weeks.
4. **Cross-project move** (`FLD-004`): the scope rewrite, `locateArtifact`, the Review URL fallback, and the hostile tests for dispatch-held, archived, and Git-enabled cases. About 1 week.
5. **Linked folders** (`LFD-001`–`LFD-008`): scanner and watcher engines, indexer fiber, inventory, capture-from-inventory, relink suggestions, the entry live view, the linked-folder UI, and restore behavior. About 2–3 weeks. This is the deepest slice, with the security ladder and hostile-filesystem fixtures.
6. **Preview slices** (`PRV-006`–`PRV-010`), in owner priority order (suggested: Markdown, PDF, code/text, data, audio). Days each. These can run in parallel with phases 3–5.

## 18. Proposed ledger entries

These entries were added to `conformance.yml` when the spec was accepted on November 24, 2026. New prefixes were checked against every prefix in the ledger and the source tree, and `FLD`, `TRS`, `FOV`, and `LFD` are unused. `PRV-006`..`PRV-010` continue the existing PRV family (section 12). Owners reuse existing `allowed_modules`, so the ledger structure does not change.

```yaml
  - id: FLD-001
    kind: behavior
    behavior: Folders are first-class per-project records with stable IDs, an optional parent, sibling-unique normalized names, a depth bound of 16, and per-folder revisions; the project root is implicit.
    owner: artifact-core
    source: {file: file-management-spec.md, anchor: proposed-ledger-entries}
    acceptance:
      behavior: {id: FLD-001-B, description: "Create nested folders, list a folder's children and breadcrumbs, replay an idempotent create with a client-supplied ID, and observe stable IDs and revisions."}
      failure: {id: FLD-001-F, description: "Names that are empty, too long, contain control or bidi-override characters, separators, '.', '..', or leading/trailing dots, and siblings differing only by case or compatibility form, are refused; depth 17, an unknown or foreign parent, and writes in an archived project are refused without creating a record."}
    deployments: [local]
    status: specified
    depends_on: [PRJ-001]
    evidence: []

  - id: FLD-002
    kind: behavior
    behavior: Renaming or moving a folder within a project is a single-record metadata write that leaves every contained artifact's ID, versions, comments, links, and bindings unchanged, under per-folder revision concurrency, idempotency, and an attributed folder action.
    owner: artifact-core
    source: {file: file-management-spec.md, anchor: proposed-ledger-entries}
    acceptance:
      behavior: {id: FLD-002-B, description: "Rename and move a folder holding artifacts with versions, comments, and a public link; observe the new path, an unchanged artifact/version/content-token set, working public and stable URLs, and one folder action per mutation."}
      failure: {id: FLD-002-F, description: "A stale expectedRevision returns the current folder and changes nothing; moving a folder into itself or a descendant is refused as folder-cycle; a destination sibling name collision is refused as name-conflict."}
    deployments: [local]
    status: specified
    depends_on: [FLD-001]
    evidence: []

  - id: FLD-003
    kind: behavior
    behavior: Moving an artifact between folders and renaming an artifact are metadata changes guarded by the current version, recorded as attributed actions, that never create a version or change any artifact, version, content, comment, binding, or link identity.
    owner: artifact-core
    source: {file: file-management-spec.md, anchor: proposed-ledger-entries}
    acceptance:
      behavior: {id: FLD-003-B, description: "Move and rename an artifact; observe the same version list and content tokens, the new placement and name in listings and name search, unchanged comments and public-link delivery, and one move and one rename action."}
      failure: {id: FLD-003-F, description: "A stale expectedCurrentVersionId returns the publish-style conflict with the actual current version; a folder in another project or a trashed folder is refused; replaying the idempotency key returns the original result and a reused key with different input fails."}
    deployments: [local]
    status: specified
    depends_on: [FLD-001, ART-001]
    evidence: []

  - id: FLD-004
    kind: behavior
    behavior: A cross-project move rewrites the artifact's project scope and its child records in one transaction while preserving the artifact ID, versions, content tokens, comments, binding, stable URL, and public link, and old Review URLs resolve to the new project for authorized readers.
    owner: artifact-core
    source: {file: file-management-spec.md, anchor: proposed-ledger-entries}
    acceptance:
      behavior: {id: FLD-004-B, description: "Move an artifact and a folder subtree to another project; observe identical artifact, version, thread, and content-token IDs, the stable URL and public link still serving, every child row scoped to the destination, a move action in the destination, and the location endpoint redirecting an old Review URL."}
      failure: {id: FLD-004-F, description: "The move is refused with nothing changed when a thread is held by a queued, claimed, or delivered dispatch, when either project is archived, when Git history is enabled or coordinates exist, or above 1,000 artifacts; the location endpoint answers not-found to callers without installation-wide read; a pre-move idempotency key replayed in the source project discloses nothing."}
    deployments: [local]
    status: specified
    depends_on: [FLD-003, PRJ-002, DSP-003, CMT-020]
    evidence: []

  - id: FLD-005
    kind: behavior
    behavior: Batch operations apply move, trash, recover, purge, tag-add, tag-remove, or capture to 1..100 distinct items, each in its own atomic transaction with a derived idempotency key, and report per-item results in request order.
    owner: http-api
    source: {file: file-management-spec.md, anchor: proposed-ledger-entries}
    acceptance:
      behavior: {id: FLD-005-B, description: "Run a 100-item move with one stale item and observe 99 moved, one conflict with the current state, and an identical result on replay of the same batch key."}
      failure: {id: FLD-005-F, description: "An empty batch, more than 100 items, a repeated item, or a purge batch without the matching confirmation is refused before any work; each item is authorized as if sent alone, so an unauthorized item fails without affecting the others."}
    deployments: [local]
    status: specified
    depends_on: [FLD-003, TRS-001]
    evidence: []

  - id: FLD-006
    kind: constraint
    behavior: The schema migration places every existing artifact at its project root and backfills derived file columns without changing any existing identity, link, tombstone, or byte, transactionally and repeat-safely.
    owner: database-adapters
    source: {file: file-management-spec.md, anchor: proposed-ledger-entries}
    acceptance:
      behavior: {id: FLD-006-B, description: "Migrate a populated schema-12 database and observe all artifacts at the root, correct file kinds and sizes, and byte-identical artifact, version, manifest, content-token, action, tag, comment, and binding sets."}
      failure: {id: FLD-006-F, description: "An interrupted migration leaves the database at schema 12 and fully usable, a rerun completes it, and a newer schema is refused at startup."}
    deployments: [local]
    status: specified
    depends_on: [FLD-001]
    evidence: []

  - id: FLD-007
    kind: behavior
    behavior: HTTP, MCP, CLI, and the web application expose the same folder, rename, move, trash, recover, and overview operations with identical authorization and shapes, and advertise them through capability discovery.
    owner: mcp
    source: {file: file-management-spec.md, anchor: proposed-ledger-entries}
    acceptance:
      behavior: {id: FLD-007-B, description: "Perform create-folder, move, rename, trash, recover, and file search through HTTP, MCP, and the CLI against one server and observe the same records and action history."}
      failure: {id: FLD-007-F, description: "Where a capability is absent its routes answer 501 capability-unavailable, its MCP tools return the same coded error, and the web application renders no affordance; delete keeps its one-way contract and reports recoverable false."}
    deployments: [local]
    status: specified
    depends_on: [FLD-003, TRS-002, FOV-001]
    evidence: []

  - id: FLD-008
    kind: constraint
    behavior: Backup and restore preserve folders, placement, trash and purge state, and folder links, and the integrity check rejects cycles, cross-project placement, live items in purged folders, duplicate sibling keys, mis-scoped child rows, and inconsistent tracked inventory.
    owner: operations
    source: {file: file-management-spec.md, anchor: proposed-ledger-entries}
    acceptance:
      behavior: {id: FLD-008-B, description: "Back up a stopped data directory with nested folders, trash groups, a cross-project-moved artifact, and a folder link; restore it and observe identical records, integrity passing, and the folder link unavailable until a successful scan."}
      failure: {id: FLD-008-F, description: "Seeded corruption of each kind (folder cycle, foreign folder_id, live artifact in purged folder, duplicate sibling key, child row with a stale project_id, tracked entry with a mismatched binding path) fails the integrity check with a specific finding."}
    deployments: [local]
    status: specified
    depends_on: [FLD-006, OPS-003, OPS-004]
    evidence: []

  - id: TRS-001
    kind: behavior
    behavior: Deleting an artifact or folder moves it to trash, stopping every access path exactly as the tombstone does while retaining versions, blobs, comments, tags, placement, and bindings, and a folder trash marks its whole live subtree as one trash group.
    owner: artifact-core
    source: {file: file-management-spec.md, anchor: proposed-ledger-entries}
    acceptance:
      behavior: {id: TRS-001-B, description: "Trash an artifact and a folder subtree; observe them absent from listings, overview, search, and dashboard counts, present in trash with original location and actor, and every version and blob retained."}
      failure: {id: TRS-001-F, description: "After trashing, the stable URL, exact-version routes, content origins, public link, live view, comment writes, and new clone tokens all refuse; a stale expected version or revision changes nothing; a subtree above 10,000 artifacts is refused as trash-too-large."}
    deployments: [local]
    status: specified
    depends_on: [ART-001, FLD-001]
    evidence: []

  - id: TRS-002
    kind: behavior
    behavior: Recover returns a trashed artifact or trash group with the same IDs, versions, comments, tags, and binding to its original folder or the project root, and returns a formerly public artifact as account-required.
    owner: artifact-core
    source: {file: file-management-spec.md, anchor: proposed-ledger-entries}
    acceptance:
      behavior: {id: TRS-002-B, description: "Recover a single artifact, a folder group, and an artifact whose folder was purged; observe identical identities, the original or root placement as reported, a recover action, and the prior public setting reported with access now account-required."}
      failure: {id: TRS-002-F, description: "Recovering a purged item is not-found; recovering a folder whose sibling name is taken answers name-conflict until a new name is given; recovering never re-enables a public link or creates a version."}
    deployments: [local]
    status: specified
    depends_on: [TRS-001]
    evidence: []

  - id: TRS-003
    kind: security
    behavior: Purge irreversibly ends recoverability for a trashed item, is restricted to direct human members or an explicitly granted purge capability, is refused while a dispatch holds the item's threads, queues Git-repository deletion, and reclaims no blob bytes.
    owner: artifact-core
    source: {file: file-management-spec.md, anchor: proposed-ledger-entries}
    acceptance:
      behavior: {id: TRS-003-B, description: "Purge a trashed artifact and a trashed folder with the exact confirmation; observe them gone from trash, unrecoverable on every surface, a purge action recorded, and every referenced blob still present."}
      failure: {id: TRS-003-F, description: "Purging an active item, purging without the exact confirmation, purging as a service key without the purge capability, and purging while a queued, claimed, or delivered dispatch holds a thread are all refused with nothing changed."}
    deployments: [local]
    status: specified
    depends_on: [TRS-001, CMT-020, ART-007, OPS-007]
    evidence: []

  - id: TRS-004
    kind: behavior
    behavior: Trash lists trashed items across readable projects newest first with bounded keyset pagination, original location, actor, and trash group, and dispatched threads on a trashed artifact answer a stable artifact-in-trash error to agents.
    owner: http-api
    source: {file: file-management-spec.md, anchor: proposed-ledger-entries}
    acceptance:
      behavior: {id: TRS-004-B, description: "Trash items in two projects and page through the trash list without duplicates or gaps; an agent replying on a held thread of a trashed artifact receives artifact-in-trash and can report the dispatch failed."}
      failure: {id: TRS-004-F, description: "Trash listing requires artifact-listing authority, never returns purged items, and a page size above the maximum is refused."}
    deployments: [local]
    status: specified
    depends_on: [TRS-001, CMT-020]
    evidence: []

  - id: TRS-005
    kind: constraint
    behavior: Pre-existing tombstones appear in trash as recoverable items, no item is ever purged automatically unless a retention policy is explicitly configured, and deployments without the trash capability keep the one-way delete contract.
    owner: artifact-core
    source: {file: file-management-spec.md, anchor: proposed-ledger-entries}
    acceptance:
      behavior: {id: TRS-005-B, description: "Migrate a database with a tombstoned artifact, find it in trash, and recover it with its versions intact; leave trash untouched across restarts and observe nothing purged."}
      failure: {id: TRS-005-F, description: "With the trash capability absent, delete reports recoverable false and recover and purge answer capability-unavailable."}
    deployments: [local]
    status: specified
    depends_on: [TRS-002, FLD-006]
    evidence: []

  - id: FOV-001
    kind: behavior
    behavior: The file overview lists every non-trashed artifact across readable projects with keyset pagination, combinable filters for project, folder subtree, kind, tag, linked state, created and updated time, and name search, and bounded facet counts.
    owner: http-api
    source: {file: file-management-spec.md, anchor: proposed-ledger-entries}
    acceptance:
      behavior: {id: FOV-001-B, description: "Seed artifacts across projects, folders, kinds, tags, and times; apply each filter alone and combined; page through every sort without duplicates; and observe facet counts matching the filtered set."}
      failure: {id: FOV-001-F, description: "Trashed and purged artifacts never appear, an unknown project or folder answers not-found without disclosure, malformed filters answer INVALID_INPUT, and a caller without listing authority is denied."}
    deployments: [local]
    status: specified
    depends_on: [FLD-001, ART-002]
    evidence: []

  - id: FOV-002
    kind: constraint
    behavior: File kind is derived from the current version's normalized entry media type at commit and restore, with an entry-path extension used only to refine octet-stream or text/plain for filtering, and never selects a renderer.
    owner: manifest
    source: {file: file-management-spec.md, anchor: proposed-ledger-entries}
    acceptance:
      behavior: {id: FOV-002-B, description: "Publish one fixture per kind, plus a multi-file site and an octet-stream .md file, and observe the documented kinds; restore an earlier version and observe the kind follow the current version."}
      failure: {id: FOV-002-F, description: "A file labeled octet-stream with an .html or .svg extension is classified for filtering but still renders only through the typed fallback, never as an inline document."}
    deployments: [local]
    status: specified
    depends_on: [MAN-001, PRV-005]
    evidence: []

  - id: FOV-003
    kind: constraint
    behavior: Overview, folder listing, folder rename, cross-project move, batch, and linked-folder scan meet the recorded local performance budgets on the specified data sets without regressing request latency during scans.
    owner: operations
    source: {file: file-management-spec.md, anchor: proposed-ledger-entries}
    acceptance:
      behavior: {id: FOV-003-B, description: "Run the perf baseline on the 100,000-artifact and 20,000-file fixtures and record p95 values within the section 13 budgets."}
      failure: {id: FOV-003-F, description: "During a full linked-folder scan, read and publish p95 latency stays within 10% of the idle baseline, and no scan page holds the write transaction beyond one page."}
    deployments: [local]
    status: specified
    depends_on: [FOV-001, LFD-006]
    evidence: []

  - id: FOV-004
    kind: behavior
    behavior: The web application provides a refresh-safe Files page and Trash view with URL-addressable filters, page-local folder navigation, multi-select batch actions, undoable trash, typed-confirmation purge, and folder drill-down in the Review catalog without a permanent sidebar.
    owner: web-application
    source: {file: file-management-spec.md, anchor: proposed-ledger-entries}
    acceptance:
      behavior: {id: FOV-004-B, description: "In a browser, filter Files, reload and keep the filters, select a range, move it via the dialog, trash it, undo, purge one item with typed confirmation, and drill into a folder in Review via breadcrumb and keyboard."}
      failure: {id: FOV-004-F, description: "A batch with per-item failures shows each failure with a reason and retry; an absent capability renders no affordance; Review gains no permanent sidebar; a narrow viewport has no horizontal page overflow."}
    deployments: [local]
    status: specified
    depends_on: [FOV-001, TRS-004, FLD-005]
    evidence: []

  - id: LFD-001
    kind: constraint
    behavior: Linking a folder is local-only behind linked files, protocol-callable, binds one canonical in-root directory to one Artifact Server folder, refuses overlapping links, and creates no artifact or version.
    owner: local-workspace
    source: {file: file-management-spec.md, anchor: proposed-ledger-entries}
    acceptance:
      behavior: {id: LFD-001-B, description: "Link a directory through MCP, HTTP, and the CLI on a local deployment with linked files on, and observe the link record, the folder, a completed first scan, and zero new artifacts, versions, or actions."}
      failure: {id: LFD-001-F, description: "A file path, symlinked directory, out-of-root directory, the data directory, an overlapping directory, a non-loopback origin, an unauthorized principal, and any non-local deployment are refused with the documented codes and no record."}
    deployments: *all
    status: specified
    depends_on: [LNK-001, LNK-006, FLD-001]
    evidence: []

  - id: LFD-002
    kind: behavior
    behavior: Scans and watch hints keep the inventory matched to disk as untracked, tracked, and skipped entries and refresh binding freshness, without creating or changing any artifact, version, folder, or action, and the inventory reconciles after restart.
    owner: local-workspace
    source: {file: file-management-spec.md, anchor: proposed-ledger-entries}
    acceptance:
      behavior: {id: LFD-002-B, description: "Add, modify, and remove files in a linked directory with the watcher on and off; observe inventory states within the hint budget or after a scan, freshness on tracked entries, and correct state after a server restart with changes made while stopped."}
      failure: {id: LFD-002-F, description: "With the database refusing every artifact, version, folder, and action write, scans and hints still complete; a dropped or overflowed watcher event is repaired by periodic reconciliation."}
    deployments: [local]
    status: specified
    depends_on: [LFD-001, LNK-003]
    evidence: []

  - id: LFD-003
    kind: security
    behavior: Scanning never follows symlinks, never crosses devices, always excludes the data directory and .git, skips special, unreadable, oversized, too-deep, and hostile-named files with reasons, and applies built-in, .artifactignore, and per-link ignore rules in the documented order.
    owner: local-workspace
    source: {file: file-management-spec.md, anchor: proposed-ledger-entries}
    acceptance:
      behavior: {id: LFD-003-B, description: "Scan a fixture tree containing ignored patterns, a re-included default, an .artifactignore, and per-link patterns, and observe exactly the documented indexed and ignored sets."}
      failure: {id: LFD-003-F, description: "Symlinks to files, to directories, and to outside the root, a FIFO, a socket, a mounted volume, the data directory nested inside the link, a .git directory, a control-character name, and an over-limit .artifactignore are never indexed as capturable and never descended into."}
    deployments: [local]
    status: specified
    depends_on: [LFD-001]
    evidence: []

  - id: LFD-004
    kind: behavior
    behavior: One explicit, attributed capture turns selected or all pending inventory entries into linked artifacts placed in mirrored subfolders or into new versions of drifted tracked artifacts, with per-entry results and idempotent replay.
    owner: local-workspace
    source: {file: file-management-spec.md, anchor: proposed-ledger-entries}
    acceptance:
      behavior: {id: LFD-004-B, description: "Capture all pending entries in a nested linked directory and observe one linked artifact per untracked file in matching subfolders, one new version per modified tracked file, capture actions attributed to the caller, and the same results on replay."}
      failure: {id: LFD-004-F, description: "An entry whose path changed after the scan (including a parent swapped for a symlink) is refused as source-moved, a mid-read change aborts that entry with the retryable drift error, and neither affects other entries."}
    deployments: [local]
    status: specified
    depends_on: [LFD-002, LNK-002, LNK-004]
    evidence: []

  - id: LFD-005
    kind: behavior
    behavior: Deletions and renames on disk never trash, delete, move, or relink anything automatically; removed tracked files surface as missing and renames surface as hash-verified relink suggestions accepted explicitly.
    owner: local-workspace
    source: {file: file-management-spec.md, anchor: proposed-ledger-entries}
    acceptance:
      behavior: {id: LFD-005-B, description: "Delete one tracked file and rename another on disk; observe the first artifact missing and unchanged, a relink suggestion for the second, and acceptance preserving the artifact ID, versions, and comments."}
      failure: {id: LFD-005-F, description: "A same-size file with different content produces no suggestion, accepting a stale suggestion fails the expected-hash check, and no disk event ever changes artifact state other than binding freshness."}
    deployments: [local]
    status: specified
    depends_on: [LFD-002, LNK-005]
    evidence: []

  - id: LFD-006
    kind: constraint
    behavior: Linked folders enforce entry, depth, scan-page, concurrency, capture-batch, and link-count limits, enter an explicit over-limit state instead of failing, and keep the server responsive during scans.
    owner: local-workspace
    source: {file: file-management-spec.md, anchor: proposed-ledger-entries}
    acceptance:
      behavior: {id: LFD-006-B, description: "Link a 20,000-file tree, observe the full inventory built in bounded pages, then add files past the limit and observe over-limit with existing entries intact and a narrowing hint."}
      failure: {id: LFD-006-F, description: "A 51st link is refused as link-limit, scans beyond the concurrency limit queue rather than run, and a capture request above 100 entries is refused before any work."}
    deployments: [local]
    status: specified
    depends_on: [LFD-002]
    evidence: []

  - id: LFD-007
    kind: security
    behavior: Linked directory and inventory paths appear only in authenticated local application-origin responses, never select storage, never appear in logs, metrics, content origins, or public responses, and untracked-entry live previews follow the linked live-view audience rules.
    owner: local-workspace
    source: {file: file-management-spec.md, anchor: proposed-ledger-entries}
    acceptance:
      behavior: {id: LFD-007-B, description: "As an admitted local member, read link and inventory paths and open an untracked entry's live preview with no-store caching on its per-entry live origin."}
      failure: {id: LFD-007-F, description: "Public-link, anonymous, non-member, and version-session callers never receive a path or a live entry byte, logs and metrics contain no directory or relative path, and a forged entry or link ID from another project answers not-found."}
    deployments: [local]
    status: specified
    depends_on: [LFD-001, LNK-007]
    evidence: []

  - id: LFD-008
    kind: behavior
    behavior: Pause, unlink, trash, recover, purge, and restore of a linked folder behave as documented, never touching disk and never removing captured artifacts' individual bindings on unlink.
    owner: local-workspace
    source: {file: file-management-spec.md, anchor: proposed-ledger-entries}
    acceptance:
      behavior: {id: LFD-008-B, description: "Pause and resume a link, trash and recover its folder (observing a fresh scan), unlink it and observe captured artifacts still linked individually, and restore a backup with the link unavailable until a successful scan."}
      failure: {id: LFD-008-F, description: "No pause, unlink, trash, purge, rename, or move operation creates, edits, moves, or deletes any file under the linked directory, verified by a full before/after tree hash."}
    deployments: [local]
    status: specified
    depends_on: [LFD-001, TRS-001, FLD-008]
    evidence: []

  - id: PRV-006
    kind: behavior
    behavior: The review interface presents an exact-version audio file with native controls, no autoplay, metadata-only preload, and ranged seeking through the authenticated media route.
    owner: web-application
    source: {file: file-management-spec.md, anchor: proposed-ledger-entries}
    acceptance:
      behavior: {id: PRV-006-B, description: "Select an audio entry and play, pause, and seek with ranged requests observed."}
      failure: {id: PRV-006-F, description: "Corrupt or unsupported audio settles into the typed fallback, and the media route still refuses top-level document navigation."}
    deployments: *all
    status: specified
    depends_on: [PRV-003]
    evidence: []

  - id: PRV-007
    kind: security
    behavior: The review interface presents an exact-version PDF only inside the isolated content-origin frame and never as an application-origin document.
    owner: web-application
    source: {file: file-management-spec.md, anchor: proposed-ledger-entries}
    acceptance:
      behavior: {id: PRV-007-B, description: "Select a PDF entry and read it in the browser's PDF viewer inside the review frame on the version content origin."}
      failure: {id: PRV-007-F, description: "A PDF is never served typed to the application origin, a PDF with embedded scripts gains no application-origin access, and an unrenderable PDF settles into the typed fallback."}
    deployments: *all
    status: specified
    depends_on: [PRV-003, CNT-003]
    evidence: []

  - id: PRV-008
    kind: security
    behavior: Markdown renders to sanitized HTML only inside the isolated review frame, with a raw-source toggle, and relative links and images resolve within the same exact version.
    owner: web-application
    source: {file: file-management-spec.md, anchor: proposed-ledger-entries}
    acceptance:
      behavior: {id: PRV-008-B, description: "Render a Markdown fixture with headings, tables, code, relative images, and relative links, and toggle the raw source."}
      failure: {id: PRV-008-F, description: "Script tags, event handlers, javascript: and data:text/html URLs, and raw HTML injection are neutralized, and nothing from the file is parsed into the application origin."}
    deployments: *all
    status: specified
    depends_on: [CNT-003]
    evidence: []

  - id: PRV-009
    kind: behavior
    behavior: Text and source code render as bounded text nodes with line numbers and optional highlighting, truncating at 1 MiB with a download action.
    owner: web-application
    source: {file: file-management-spec.md, anchor: proposed-ledger-entries}
    acceptance:
      behavior: {id: PRV-009-B, description: "Open text and code fixtures, including CRLF, UTF-8 BOM, and a 3 MiB file, and observe correct rendering and truncation notice."}
      failure: {id: PRV-009-F, description: "Invalid UTF-8 renders with replacement characters, markup in a file renders as literal text, and no file byte reaches innerHTML."}
    deployments: *all
    status: specified
    depends_on: [PRV-004]
    evidence: []

  - id: PRV-010
    kind: behavior
    behavior: CSV, TSV, JSON, and NDJSON render as bounded tables or trees parsed off the main thread, settling into the typed fallback when size or time bounds are exceeded.
    owner: web-application
    source: {file: file-management-spec.md, anchor: proposed-ledger-entries}
    acceptance:
      behavior: {id: PRV-010-B, description: "Open CSV, TSV, JSON, and NDJSON fixtures and observe a virtualized table of up to 5,000 rows and a collapsible JSON tree."}
      failure: {id: PRV-010-F, description: "Malformed data, a pathological quoted CSV, and an over-bound JSON file settle into the typed fallback without freezing the page."}
    deployments: *all
    status: specified
    depends_on: [PRV-004, PRV-005]
    evidence: []
```

Notes on the entries:

- `LFD-001` names `*all` for the same reason `LNK-001` does: every non-local deployment must prove the absence shape.
- `PRV-006`..`PRV-010` name `*all` because previews are web-only over existing delivery, as `PRV-001`..`PRV-005` are.
- Every `depends_on` ID outside this spec was checked to exist in `conformance.yml`: `PRJ-001` and `PRJ-002` (project scope), `ART-001`, `ART-002`, and `ART-007`, `MAN-001`, `CNT-003` (origin separation), `CMT-020` (a held thread cannot be deleted), `DSP-003` (single-project dispatch bundles), `OPS-003` (backup and restore identities), `OPS-004` (integrity check), `OPS-007` (blob collection disabled), `PRV-003` through `PRV-005`, and the `LNK` entries.
