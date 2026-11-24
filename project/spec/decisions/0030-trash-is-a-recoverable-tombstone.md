# 0030: Trash is a recoverable tombstone; purge ends recoverability, not bytes

**Status:** Accepted (November 24, 2026)
**Date:** November 24, 2026
**Amends:** [0003](./0003-artifact-lifecycle-and-audit.md) (deletion contract), and the deletion timing in [Optional Git handoff](../git-history-spec.md) section 6
**Spec:** [File management](../file-management-spec.md), section 4.4

## Decision

The existing artifact delete keeps its mechanism exactly. It sets `deleted_at`
without touching any version, stops every access path, appends a `delete`
action, and keeps every byte. Where the `trash` capability is present, that
tombstone becomes **reversible**:

```text
active --trash (existing delete)--> trashed --purge--> purged
   ^                                  |
   +------------- recover ------------+
```

- **Recover** clears the tombstone. The artifact keeps its ID, versions,
  comments, tags, binding, and placement. It returns at the project root if
  its folder is gone. A formerly public artifact returns as account-required,
  and its previous setting is reported.
- **Purge** marks the tombstone permanent. No product surface can recover it,
  and all access stays stopped. Purge requires a direct human member or an
  explicitly granted `artifact:purge` capability, plus an exact confirmation.
  It is refused while a `queued`, `claimed`, or `delivered` dispatch holds one
  of the artifact's threads, which is the same rule that stops a dispatched
  comment from being deleted.
- **Purge reclaims no blob bytes.** Committed-blob collection stays disabled
  under `ART-007`, `OPS-006`, and `OPS-007` until a backup-aware collector
  exists.
- **Folder trash** tombstones a folder and its live subtree under one
  `trash_group_id`, so recovery restores exactly what one action removed.
- **Git-repository deletion moves from trash to purge**, so that recovery finds
  the mirror intact. New clone tokens are refused while trashed.
- **No automatic purge by default.**
- Where `trash` is absent, delete keeps the one-way ADR 0003 contract. Responses
  carry `recoverable` so callers can tell.

## Recorded decisions

### Reuse the tombstone instead of adding a second "trashed" state

ADR 0003's tombstone already does everything trash needs at trash time. It is
attributed, idempotent, guarded by the current version, retains bytes, and
stops every access path. A separate `trashed_at` state in front of the
tombstone would duplicate every access check in delivery, listing, comments,
and live view, and would create a window where an artifact is "in trash but
still served". Making the existing tombstone reversible adds two transitions
and no new access state.

### Purge is honest about space

Physically deleting blobs on purge is the "permanent deletion" that phase 11
explicitly removed from ordinary work. Blobs are content-addressed and may be
shared with live artifacts by deduplication. Deleting them safely requires
the mark-and-sweep or lease design that `OPS-007` gates. Purge therefore
promises only what it can keep: the item is gone from every product surface,
for good. The UI says it frees no space yet.

### Recovery does not silently re-publish

Trashing stopped a public link. Bringing that link back without a fresh
decision would re-expose content the owner may have trashed precisely to
unshare it. Recovery returns the artifact account-required and names the
previous setting, so re-sharing is one explicit, recorded action.

### Trash is allowed while dispatched; purge is not

Trash destroys nothing, so blocking it on agent work would make cleanup
depend on agents finishing. Purge is the irreversible step, so it inherits the
held-thread rule. An agent that touches a held thread of a trashed artifact
gets a stable `artifact-in-trash` error it can report.

### Git deletion waits for purge

Today the tombstone transaction queues repository deletion. If trash kept
that, recovery would bring back an artifact without its mirror. Moving the job
to purge keeps the two consistent. The only residual exposure is a clone token
issued before trashing, which is capped at one hour.

## Rejected alternatives

- **A separate trashed state before the tombstone.** Duplicates access checks
  and opens a served-while-trashed window.
- **Purge deletes blobs now.** Violates `ART-007` and `OPS-007` and risks
  deleting deduplicated bytes of live artifacts.
- **Recover restores public links as they were.** Silent re-exposure.
- **Automatic 30-day purge by default.** Irreversible, and buys no space under
  this decision. It can be added later as an explicit setting through the same
  purge path.
- **Block trash while dispatched.** A never-resolved `delivered` dispatch would
  make an artifact impossible to tidy away.

## Consequences

- New columns `trash_group_id` and `purged_at`. Folder records gain the same
  pair. New action kinds `recover` and `purge`, and new idempotency operations.
- Pre-existing tombstones become recoverable trash entries, unless the owner
  decides otherwise.
- The Details "delete" action becomes Move to Trash with Undo. Typed
  confirmation moves to purge.
- `git-history-spec.md` section 6 needs an amendment when this is accepted:
  "queued at purge where the trash capability is present".
