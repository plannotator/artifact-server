# 0021: Agent dispatch and the Pi bridge

**Status:** Accepted
**Date:** August 18, 2026

## Decision

Artifact Server can send annotations to a coding agent. A person selects one or
more comment threads on an artifact version, picks a connected agent, and sends
them. The threads leave the screen. The agent receives them as one message,
does the work, replies to each thread, and resolves it.

This adds the push half of the loop the comment system was missing. Two
transport-neutral records carry it, and one Pi extension connects them to a
live coding session.

```text
Artifact Server installation
├── Registered agent          (one live connection, disposable)
└── Project
    └── Agent dispatch        (one bundle, durable)
        └── Comment threads   (marked while the dispatch is active)
```

A registered agent is a liveness record: the agent names itself, the row
carries no state beyond when it was last seen, and stale rows are deleted. A
dispatch is the durable record: target agent, ordered thread identifiers,
delivery state, and the sender snapshot. The dispatch row is its own audit
trail; no new action-ledger kind is added.

## Recorded decisions

### The bundle is the atomic unit and bundles drain first in, first out

One send is one bundle is one message to the agent. Separately sent bundles are
never merged. A later bundle is delivered only after the agent finishes the work
the earlier bundle started. Pi's own follow-up queue provides that ordering, so
the bridge always injects with the follow-up delivery mode, never steers, and
never changes Pi's queue settings.

### Sending is consumptive

A sent thread leaves every default listing immediately: pins gone, cards gone.
No progress badge, status chip, or other chrome decorates the comment surfaces.
The comment listings gain one filter parameter whose default hides dispatched
threads, so existing clients get the new behavior with no change, and a "Sent"
view can still find them. Reading one thread directly keeps working, because
the agent reads them that way.

The one exception is loss. A dispatch that fails or is canceled clears its
thread markers and the threads reappear. Work is never silently lost.

### The registry is liveness, not a durable object

An agent registers itself with one upsert on a stable connection key. The claim
poll is the heartbeat; there is no separate heartbeat call. Rows that go stale
are reaped, and reaping one costs nothing because the dispatch queue is the
durable thing and the dispatch snapshots the agent's display name. A restarted
agent upserts back into the same identifier and finds its queue waiting.

### Pi first, shipped as an ordinary npm extension

Pi is the only supported agent kind, and the kind stays a closed one-value set
until a later decision widens it. The bridge ships as a workspace package
published to npm and installed through Pi's standard extension mechanisms. All
of its logic lives in a plain library that takes its host, network, and clock as
an explicit parameter contract, so the behavior is testable without a live
agent. The bridge fails soft: without configuration it stays dormant, and it
never throws into its host.

### The pull model stays

Long polling over the existing HTTP conventions is the transport. Nothing here
introduces WebSockets, server-sent events, or webhooks, and the mailbox stays
transport-neutral so a later transport is an addition, not a redesign. Comment
change polling with a since time and a cursor continues to work exactly as it
does today, alongside dispatch.

### Delivery state is never a boolean

A dispatch is queued, claimed, delivered, addressed, failed, or canceled.
Queued in the mailbox is not delivered to the agent. The terminal state
`addressed` is inferred from the ground truth the product already owns: every
thread in the bundle is resolved. An agent report could only proxy or
contradict that, so no such report exists.

## What stays excluded

- Agents other than Pi.
- WebSockets, server-sent events, webhooks, and any other push transport.
- Steering a running agent, and any change to the agent's own queue settings.
- Transcript mirroring into Artifact Server.
- Notifications of any kind: in-product, email, chat, or browser push.
- Local annotation files. The database is the durable record; an annotation
  export may come later as its own feature.

## Rejected alternatives

### Merge pending bundles into one message

Merging loses the person's own grouping and hides which send a reply answers.
Strict first-in, first-out delivery keeps each send an intelligible unit of
work and matches how the agent already drains follow-up work.

### One implicit agent instead of a registry with targeted send

Several sessions run at once on different working directories, and a person
sending to "the agent" cannot say which one. Naming the target at send time is
also what a hosted installation needs, so the shapes survive that move without
a redesign.

### Show dispatch progress on the comment surfaces

Progress chrome asks the person to keep watching work they handed off. Sending
is meant to end their involvement, so the annotations simply leave and come
back only if the work could not be delivered.

### Make the registry durable with a lifecycle

A durable agent record invites lifecycle state, ownership, and cleanup rules
for something that is only ever a live connection. Keeping the queue durable
and the connection disposable removes all of it, and a restart costs nothing.

### Report `addressed` from the agent

The agent's own claim of completion can disagree with the threads. Resolution
already flows through the comment API, is attributable, and is what the reader
sees, so it is the only signal the state machine trusts.
