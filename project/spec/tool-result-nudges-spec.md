# Tool-result nudges

Status: design for owner review — not implemented.
Owner direction (August 26, 2026): "nudges in api responses… more context
for ai the better." Prior art: Doop appends steering context to every MCP
tool result because pull-based MCP has no push channel — their comment calls
it "the channel through which humans steer agents." The same insight applies
to our weakest tier.

## 1. The problem

Native-tier agents (Pi, OpenCode) and channel-tier agents get bundles
delivered. Mailbox-tier agents (Claude Code over plain MCP, Codex, Cursor)
only learn about work when they call `dispatch_inbox` — and nothing tells
them to call it. A bundle can sit queued for hours while its target agent
happily calls `artifact_get` and `comment_list` for unrelated reasons,
never knowing work is waiting.

## 2. Design

A server-side nudge pass wraps every MCP tool result on the existing MCP
server. When the calling principal has agent-relevant context, one terse
block is appended to the result's text content:

```
— artifact server —
2 review bundles are queued for your inbox. Call dispatch_inbox
{"operation": "claim"} to pick up the oldest.
```

v1 nudge kinds, in priority order (at most ONE block per result):

1. **Queued work.** The principal's mailbox agent has queued dispatches →
   count + the claim instruction. Appears on every tool result until
   claimed; disappears the moment the queue is empty. Stateless.
2. **Unfinished claim.** The principal's mailbox agent holds a claimed or
   delivered dispatch with unresolved threads → "N threads from your
   claimed bundle remain open; reply and resolve them, or report failed."
3. **Progress echo.** Immediately after `comment_reply` or
   `comment_resolve` on a dispatched thread → "M threads remain in this
   bundle." (Doop's review-nudge shape; keeps multi-thread bundles from
   stalling after the first reply.)

## 3. Rules

- Derived at read time from existing dispatch/thread state. No new
  storage, no timers, no background jobs.
- Appended as a trailing text content item only; `structuredContent` is
  never touched, so typed consumers are unaffected.
- Never appended to error results (an actionable error is its own
  instruction) and never to `dispatch_inbox` results (that surface already
  says everything).
- Size-bounded (≤ 400 characters) and rendered through the shared
  sanitization (nudges quote no untrusted text in v1 — counts and ids
  only — but the bound and the rule are stated so v2 additions inherit
  them).
- Principal-scoped: derived strictly from the caller's own agents and
  claims. A nudge can never disclose another principal's queue.
- Honesty unchanged: a nudge is not delivery. Evidence tiers and dispatch
  states are unaffected; the nudge only raises the odds the mailbox gets
  polled.
- Native and channel tiers are untouched — their bridges already deliver.

## 4. Not in v1

Guideline/etiquette nudges (Doop's other use) — we have no guidelines
model; revisit if one appears. Unaddressed-feedback claiming (any agent
takes any note) — conflicts with our addressed-dispatch model; explicitly
rejected. HTTP-response nudges — humans have the UI; agents on HTTP are
the bridges, which need none.

## 5. Conformance sketch (IDs reserved; ledger entries land with the build)

| ID | Behavior |
| --- | --- |
| NDG-001 | A principal with queued mailbox dispatches sees exactly one queued-work nudge on an unrelated MCP tool result; the nudge names the real count, disappears after claim, and never appears on error or `dispatch_inbox` results. |
| NDG-002 | Nudges never cross principals: a second principal calling the same tools sees none of the first principal's counts, and `structuredContent` is byte-identical with and without a pending nudge. |

## 6. Cost

Small: one wrapper at the MCP tool-registration seam plus the derivation
query, two conformance tests. No schema change, no client change.
