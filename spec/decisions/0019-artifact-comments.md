# 0019: Artifact comments

**Status:** Accepted
**Date:** August 18, 2026

## Decision

Artifact Server stores comment threads on its own artifact versions. A comment
on a published artifact belongs next to the immutable version it was made on,
so the product that owns the version owns the comment record.

A comment thread names one exact saved version, optionally one manifest entry
path inside that version, and carries an opaque client-owned anchor. A thread
made on version 1 keeps naming version 1 after version 2 is published or an
older version is restored. A reply is one level deep and only lands on an open
thread. A thread is `open` or `resolved`; reopening is the same operation as
resolving with the other value.

```text
Artifact Server installation
└── Project
    └── Artifact
        └── Immutable version
            └── Comment thread
                └── Reply
```

Comments use the Workspaces comment vocabulary. Thread, reply, state, anchor,
and author mean here what `annotations` and `annotation_replies` mean there,
and the MCP argument names match where the concept matches. The value taken
from Workspaces is the shared model and vocabulary only.

Every comment operation is project-scoped and audited. A comment mutation
appends an attributed action record naming the thread's artifact and version in
the same transaction as the mutation, through the existing action history.
Creates are idempotent by idempotency key. Comment data is served only from the
application origin to principals with artifact read authority; it never appears
on the content domain and never through a public link.

## Recorded decisions

### Workspaces integration is out of scope

This work adds no Workspaces integration, client, or migration, and nothing in
Workspaces changes. Plannotator and Workspaces remain responsible for their own
product's collaboration: workspace records, workspace membership, workspace
permissions, their own comments and review state, and notifications.

### Any member may comment; only the author may edit

Any admitted human member, or a service principal holding the `comment:write`
capability, can create a thread, reply, resolve, and reopen. Only the author can
edit their own thread body or reply. An administrator can delete any comment but
cannot edit anyone else's comment. Reading comments requires the same authority
as reading the artifact.

### Slicing is the implementer's call

The work is sliced iteratively by the implementer, each slice verifiable end to
end before the next starts, rather than by a fixed decomposition recorded here.

## Reversal of the recorded exclusion

The product specification previously listed comments, annotations, and review
workflow under what stays outside the product, and the conformance ledger
recorded that exclusion as `SCP-003` and the ownership split as `PLN-003`. That
exclusion is reversed for comments on Artifact Server's own artifact versions.

`SCP-003` now excludes notifications, workspace collaboration, and workspace
membership only. `PLN-003` no longer assigns comments and replies exclusively
to Plannotator; each system stores the comments its own product owns, with
stable cross-references between them.

## What stays excluded

- Notifications of any kind: in-product, email, or chat.
- Workspace collaboration and workspace membership.
- Reactions, edit history, `@mentions`, and nested threads.
- Live push, WebSockets, and server-initiated updates. Clients poll.
- Per-artifact comment permissions separate from artifact authority.

## Rejected alternatives

### Keep comments out and require a second product

This forces a user or agent to leave and answer feedback in another product
that does not own the version the feedback is about. The cross-reference
survives, but the comment stops being part of the artifact's own record.

### Store Artifact Server comments in Workspaces

This makes artifact feedback depend on a second product being installed,
connected, and reachable, and it puts a comment about an immutable version
behind a workspace lifecycle that can move, unfile, or delete its reference.

### Invent a separate comment vocabulary

Two products describing the same concept with different words creates
translation work at every boundary and in every conversation. Borrowing the
Workspaces model costs nothing here and keeps the two descriptions aligned.

### Attach comments to the artifact instead of the exact version

A comment about a chart on version 12 is wrong the moment version 13 changes
the chart. Threads name the exact version and stay there; a later publish or
restore does not move, retarget, or invalidate a thread.
