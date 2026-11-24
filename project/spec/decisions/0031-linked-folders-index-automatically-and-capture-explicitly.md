# 0031: Linked folders index automatically and capture explicitly

**Status:** Accepted (November 24, 2026)
**Date:** November 24, 2026
**Amends:** [0023](./0023-linked-artifacts-are-captured-snapshots.md) ("Protocol-first linking": no directory scanning, no watcher)
**Spec:** [File management](../file-management-spec.md), sections 4.5 and 10

## Decision

A **folder link** binds one Artifact Server folder to one canonical directory
on the server's machine. It is local-only, available only when linked files
are on, and checked by the same ladder as `LNK-006`: loopback, link roots,
self-protection, and authorized principal. The link itself is an explicit
protocol call, exactly like linking a file.

Inside a linked directory, the server **observes automatically**. Scans and
watch hints maintain an *inventory* of regular files (`untracked`, `tracked`,
`skipped`) and refresh the freshness of existing bindings. Observation writes
**only** inventory rows and binding freshness. It never creates an artifact,
version, folder, or action.

Turning inventory into history is **one explicit, attributed capture**: "Capture
all pending" or a selection. It makes each untracked file an ordinary
single-file linked artifact (the `LNK-002` path) placed in a subfolder that
mirrors its directory. It makes each modified tracked file a new version (the
`LNK-004` path). Results are reported per entry.

```text
disk dir --scan / watch hint--> inventory (untracked | tracked | skipped)   [no versions]
                                     |
                      capture (explicit, attributed, per-entry)
                                     v
              linked artifact per file  -->  ADR 0023 unchanged from here
```

## What this amends in ADR 0023

ADR 0023 said "no directory scanning, no watcher, no implicit import". Its
reasons were these:

1. reads must not become writes to version history;
2. every version needs a responsible principal;
3. editor save storms must not flood history.

This decision keeps all three. Scanning and watching are now allowed because
they write nothing those reasons protect. Inventory is ambient observation of
the same kind as binding freshness, which ADR 0023 already allowed to be
written lazily. Auto-publish stays rejected. "Nothing becomes an artifact
without an explicit call" still holds, because the call is now "capture" on a
linked folder rather than "link" on a file.

## Recorded decisions

### Each captured file is its own linked artifact

Reusing the single-file binding means freshness, live view, relink, comment
anchoring with implicit capture, and every `LNK` hostile test apply unchanged.
The folder link adds discovery and placement, not a new delivery or
versioning model. Capturing a directory as one multi-file site artifact is a
possible later option, not v1.

### Hints are not facts

Filesystem events (FSEvents through recursive `fs.watch` on macOS) only mark
directories dirty and schedule a debounced scan. A bounded, paged
reconciliation scan is the single source of truth. It runs at startup, at
link time, every 10 minutes, after watcher errors, and on demand. A dropped
event costs latency, never correctness.

### The scanner cannot leave the root

The scanner reads with `opendir` and `lstat` and never follows a symlink. It
never crosses a device boundary. It always excludes the data directory and
`.git`, and it records special, oversized, too-deep, and hostile-named files as
`skipped` with a reason. Capture rebuilds the path from the canonical link
path, re-canonicalizes it, re-checks roots and self-protection, and requires
equality, then uses the existing `O_NOFOLLOW` verified-descriptor capture. A
parent directory swapped for a symlink after the scan is refused.

### The disk is read-only to Artifact Server

No operation (move, rename, trash, purge, unlink) writes, moves, or deletes
anything under a linked directory. A file deleted on disk becomes a `missing`
binding, never a trashed artifact. A file renamed on disk produces a
hash-verified relink *suggestion* that the owner accepts explicitly.

### Untracked files can be previewed live

To decide what to capture, the local member can open an untracked entry's
current bytes on a per-entry live origin. The audience, `no-store`, and
verified-descriptor rules are exactly those of `LNK-007`. Nobody else ever
sees an untracked byte, because untracked entries have no versions to share.

### `.gitignore` is not honored by default

Build and report outputs are usually git-ignored, and they are exactly what a
linked output folder is for. Built-in defaults, an `.artifactignore` file, and
per-link patterns cover exclusion.

## Rejected alternatives

- **Auto-capture on change.** Rejected for the reasons ADR 0023 gave against
  auto-publish. An opt-in, debounced, attributed mode can be a later decision.
- **Auto-link every new file as an artifact without capturing.** Every linked
  artifact must have an initial version (`LNK-002`), so this would be
  auto-publish under another name.
- **Inventory as artifacts with a "pending" state.** A version-less artifact
  kind threads a second semantics through listing, delivery, comments, and Git.
- **Trust watcher events as truth.** FSEvents coalesces and drops events, and
  sleep, wake, and restarts lose them.
- **Mirror Artifact Server moves back to disk.** Turns the server into a
  filesystem writer and widens the attack surface. It is a non-goal.

## Consequences

- New local-only tables `folder_links` and `folder_inventory`, a scanner port
  and a watcher port with Node engines in `src/local/`, and an indexer fiber in
  the local runtime.
- New limits: 20,000 entries per link, depth 16, 50 links, scan pages of 2,000,
  and capture batches of 100. Exceeding the entry limit puts the link in an
  explicit `over-limit` state.
- Backup restores folder links as `unavailable` until a successful scan, so a
  restore never starts watching a path on a different machine.
- `local-workspace-spec.md` section 4.4 and its non-goal "Linking directories"
  need a pointer to this ADR when it is accepted.
