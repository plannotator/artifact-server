# 0029: Folders are first-class placement records outside the version

**Status:** Accepted (November 24, 2026)
**Date:** November 24, 2026
**Spec:** [File management](../file-management-spec.md), sections 4.1–4.3

## Decision

A folder is a database record (`fld_<uuid>`) inside one project. It has a
name label, an optional parent folder, and a per-record revision. An artifact
gains one nullable `folder_id`, where null means the project root.

Placement (project and folder) and the artifact's name label are **mutable
metadata outside the version**. Moving or renaming an artifact or a folder:

- never creates a version, and never changes a version, manifest, entry path,
  content token, or blob;
- never changes an artifact, version, comment, dispatch, or binding ID;
- leaves the stable artifact URL, version content origins, and public links
  serving exactly as before;
- is guarded by optimistic concurrency (`expectedCurrentVersionId` for
  artifacts, as tag changes are; `expectedRevision` for folders), is
  idempotent, and appends an attributed action in the same transaction.

A folder's path, such as `Reports/2026/Q4`, is derived for display. It is never
stored as an identity and never resolves anything.

Moving an artifact to another project is a **scope rewrite in one
transaction**. It rewrites `project_id` on the artifact and every child row
that carries it, and it never mints a copy with new IDs. It is refused while a
dispatch holds one of the artifact's threads, when either project is archived,
and when Git history is involved.

## Recorded decisions

### Record, not path prefix

With a prefix stored on each artifact, a folder rename or move rewrites every
descendant, which is O(n) inside one transaction or a background job with
partial states. Empty folders become impossible without placeholder rows. The
identity of a folder becomes a string that changes on rename. Name policing
(`/`, `.`, `..`, Unicode lookalikes) also has to live inside a value that
doubles as an identity.

A record makes rename and move one row update. It gives folders a stable ID
for URLs, batch items, and folder links, and it puts sibling uniqueness in one
unique index over a normalized key. The cost is a recursive ancestor walk for
cycle checks and breadcrumbs, which a depth bound of 16 keeps trivial.

### Placement is not version content

A version is the immutable bytes a reviewer commented on. Where a file sits in
the owner's organization is not part of what was reviewed. Putting placement
or names into the version (for example, as a manifest field) would make every
reorganization a publish. That would flood history, re-key Git mirrors, and
break the rule that a version never changes after commit. Tags already set the
pattern: mutable artifact metadata guarded by the current version, recorded as
an action, and absent from the manifest.

### Artifact names stay non-unique

Phase 8 made names labels. Agents routinely publish `report.html` more than
once, and today each publish of a new artifact is a new artifact. Unique names
per folder would change publishing semantics for every agent. Folder names,
which only people and explicit calls create, are unique among siblings by a
case-folded NFKC key.

### Cross-project move rewrites scope instead of copying

The owner requires that IDs, comments, and links survive. A copy cannot do
that. A rewrite can, provided the phase-8 invariant (every security-sensitive
row resolves to exactly one project) holds at commit. The rewrite therefore
covers every row that carries `project_id`. It revokes outstanding content
sessions bound to the old project. It leaves idempotency records in the source
project, where a replay discloses nothing. It is refused in the three cases
where a rewrite would cross another system's boundary:

- a held dispatch, because a bundle is single-project;
- an archived project, because archive rejects new artifacts;
- Git history, because per-artifact commits embed the project ID and
  enablement is per project.

## Rejected alternatives

- **Path prefix on artifacts.** O(n) renames, no empty folders, and an identity
  that changes on rename.
- **Folders as tags (a reserved `folder:` tag).** Allows an artifact in many
  "folders", has no hierarchy or rename semantics, and collides with the
  20-tag limit.
- **Placement in the manifest or version.** Every move becomes a publish, and
  versions stop being immutable records of reviewed bytes.
- **Copy-and-tombstone for cross-project move.** New IDs break links, comments,
  dispatch references, and Kanban attachments.
- **Unique artifact names.** Breaks agent publishing semantics.

## Consequences

- New tables `folders` and `folder_actions`. The latter exists because the
  `actions` table requires an artifact version ID. There is a new
  `artifacts.folder_id` column and new action kinds `move` and `rename`.
- Review URLs, which embed the project, need a `locate` fallback after a
  cross-project move. The stable `/artifacts/:id` URL does not.
- Non-local backends must implement the same ports before advertising the
  `folders` capability.
