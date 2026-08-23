# 0023: Linked artifacts serve live locally and snapshot for everything shared

**Status:** Proposed
**Date:** August 19, 2026 (amended same day after owner review)

## Decision

A linked artifact **references a file that stays put on disk**. Nothing
happens to any file by default: a file becomes viewable, commentable, and
shareable only when a caller explicitly links it through the protocol surface
(the `artifact_link` MCP tool or the HTTP link endpoint; the web affordance is
a secondary convenience). Delivery is **hybrid**:

- The **local authenticated member sees the live file** — current disk bytes
  streamed v0-style (`O_NOFOLLOW`, fingerprint verified on the open
  descriptor, streamed from that same descriptor), served `no-store` on a
  per-artifact live origin. Drift relative to the last capture is ambient
  state, never a barrier.
- A **snapshot (captured version) exists only where a state must hold still**:
  sharing, comments, version history, comparisons, and explicit capture.
  Capture is an attributed publish through the normal pipeline (idempotency
  key, current-version compare-and-swap, action record). A comment on a
  drifted binding captures implicitly, attributed to the commenting principal.
- **Remote, shared, and anonymous viewers never receive live disk bytes.**
  They read the last captured version through the ordinary immutable delivery
  path — version-scoped origins, hash-verified blobs, immutable caching,
  revocability — unchanged.

The feature exists only on the local deployment, off by default, behind link
roots and self-protection checks.

```text
disk file --O_NOFOLLOW/verified-fd--> live view   (local member only, no-store)
    |                                     |
    | capture: explicit, or implicit      | drift badge (ambient)
    |  on comment when drifted            v
    v                              freshness (in-sync | modified | missing | unreadable)
staging -> verify -> immutable version ---> everyone else (unchanged delivery)
```

## Recorded decisions

### Live for the owner, snapshot for the world

The owner's reading of their own file must feel like a pointer, not an
import: the file stays where it is, and the artifact page shows what is on
disk right now. v0 proved the safe mechanics for exactly this audience —
verified-descriptor streaming on a loopback origin. What v0 could not do is
extend that to shared readers, and this product does not try: the moment
bytes leave the local member's own session — a public link, another
deployment, a comment anchor — they come from an immutable, hash-verified
captured version. One feature, two delivery paths, chosen by audience.

### Caching splits with the audience

Live responses are `Cache-Control: no-store` on a per-artifact live origin;
captured-version routes keep their immutable caching. A live origin is
per-artifact rather than per-version, so a service worker installed by live
content persists across live reloads of the same artifact — one trust
boundary (the member's own file), and still isolated from the application
origin, every version origin, and every other artifact.

### Explicit capture, not auto-publish on observed change

Lazy fingerprint refresh happens on metadata reads, and the live view makes
continuous mirroring unnecessary. If observation created versions, reads
would become writes, the version would have no responsible principal, and an
editor saving every keystroke would flood history. Capture is deliberate — a
person, an agent, or the implicit capture inside a comment create — always
attributed, idempotent, and conflict-safe. A debounced watch mode can layer
on later as its own decision; it is not v1.

### Protocol-first linking

Linking is an explicit API act — MCP tool or HTTP endpoint with a path
parameter — because the caller who knows a file should become an artifact is
almost always an agent. No directory scanning, no watcher, no implicit
import; the UI affordance is optional sugar over the same endpoint, and the
security ladder (local deployment, loopback, link roots, self-protection,
member or capability authorization) applies identically to every surface.

### v0 mechanics that carry over

Fingerprint `device:inode:size:mtimeNs:ctimeNs`; lazy `lstat` on read; live
and capture reads open with `O_NOFOLLOW`, verify the fingerprint on the open
descriptor, and stream from that descriptor (capture additionally hashes and
re-verifies after reading); `realpath` canonicalization at link time; regular
files only; the data directory and database files are never linkable; relink
preserves artifact identity under an expected content hash.

### Local-only, rooted, capability-advertised

Linking is the product's only client-supplied filesystem path. It is accepted
only on a local deployment with `ARTIFACT_SERVER_LINKED_FILES=on`, over the
loopback application origin, from an authorized principal, and only for paths
resolving inside configured link roots (default: the process user's home).
Other deployments advertise no capability and answer the stable
`capability-unavailable` shape. The binding path is used exclusively by
binding operations; manifest resolution and storage selection are untouched.

## Rejected alternatives

### Serving live bytes to shared or anonymous viewers

Breaks everything immutable delivery promises them: version-scoped origins,
cacheability, hash verification, and revocability, and would let a
half-written or swapped file reach a reader the owner never sees. v0 accepted
this for one user on one machine; a product with public links and remote
deployments cannot.

### Snapshot-only delivery (the first draft of this ADR)

Serving the local member the last captured state of their own file reads as
copy-import semantics: the page lags the disk until someone clicks capture.
The owner rejected this; the live view restores the pointer feel while
keeping snapshots for every state that must hold still.

### A "live" artifact kind outside the version chain

Forks artifact semantics through every layer: comments pin versions, public
links pin the current version, origins are version-scoped, comparisons read
manifests. The hybrid model gets the live feel without a second artifact
kind — versions remain the only shareable, commentable, comparable states.

### Auto-publish on observed change

Reads become writes, no responsible principal, history flooding — and the
fingerprint is a change detector, not a quiescence detector: observing a
change says nothing about whether the file is done changing.
