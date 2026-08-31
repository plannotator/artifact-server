# Send all: the primary send action, unpaginated comments, tier-aware states

Status: implemented August 26, 2026. Supersedes the "restore or retire send-all" follow-up
from the /review consolidation review.

## 1. Why

The common review workflow is: do a pass, leave N comments, hand the
whole batch to a coding agent. The consolidation lost the "Send all open
on this version" action without a recorded decision, leaving one-click
send of one comment at a time as the only path. Owner direction: sending
one specific comment is the exception; sending everything is the default. Two related
decisions ride with it: comments are shown in full (pagination in the UI
was what made the old send-all count dishonest), and the send control
must never fake a send — its availability and label follow the connected
agent's tier.

## 2. Decisions

1. **Send-all is the primary send action.** The comments panel's main
   control reads `Send all open (N) to ‹agent›`. Sending one specific
   comment from its card is the only secondary path. Review has no
   multi-select annotation state or selection bar.
2. **Comments are not paginated in the UI.** The client walks every page
   of the comment list API (`maximumCommentPageSize` = 100 per page) on
   load and on each poll; the panel scrolls. The count in the control is
   therefore exact. `openCountIsLowerBound` and the "N or more" copy are
   deleted, not restored.
3. **Delegation stays a human click.** Send-all is a human action in the
   UI; the WebMCP surface deliberately has no dispatch tool
   (`webmcp-review-tools-spec.md` §3).

## 3. The send control, state by state

The control derives its state from the same agent presence the panel
already polls (`GET /api/v1/agents`: `connected`, `activity`,
`capabilities.evidence`).

| Connected agents | Control | Click |
| --- | --- | --- |
| None | Disabled: `No agent connected — connect one to send.` | — |
| One | `Send all open (N) to ‹name›` with its presence avatar | Sends at once (PRS-004 rule: no dialog; undo toast). |
| Several, default known | Split button: main part `Send all open (N) to ‹default›`; caret opens an inline menu of the others, each with its presence avatar | Main part sends to the default; picking from the menu makes that agent the default and sends. |
| Several, no default yet | `Send all open (N)…`; the caret menu is the one-time prompt | Choosing sets the default and sends. |
| Default disconnected | Disabled: `‹default› disconnected — pick another`; caret still open | Never falls through silently to a different agent. |
| Target is mailbox tier (`evidence: "mailbox"`) | Enabled; label after send: `Queued for ‹name› — it picks this up when it next checks in.` | Sends; the tool-result nudges (NDG-001) make that promise real. |

The **default** is remembered per project (`localStorage`, key
`dispatch-default:<principalId>:<projectId>`): the last agent sent to.
It is a convenience, never authority — if the remembered agent is gone
from the listing, the control treats it as "no default yet."

`N` counts open threads on the current version that are not inside an
active dispatch (the server's default `dispatched=exclude` listing).
`N = 0` disables the control with `Nothing open to send.`

The optional bundle note stays behind the caret ("Send with a note…"),
exactly as PRS-004 specified.

## 4. Undo and honesty

Unchanged from PRS-004: after a send, the toast offers Undo for ~8 s,
calling dispatch cancel; a terminal-state conflict is reported honestly.
No state in this spec implies delivery; evidence tiers and dispatch
states are untouched.

## 5. Conformance (IDs reserved; ledger entries land with the build)

| ID | Behavior |
| --- | --- |
| SND-001 | The comments panel loads every comment page and shows all threads; the send control's count equals the exact number of open, undispatched threads on the version; with one connected agent, one click dispatches all of them, and the Sent filter, the Addressed badge after resolution, cancel returning threads to open, and pin removal all behave as the retired `dispatch-send` proof asserted. |
| SND-002 | The control is tier-aware and honest: disabled with the stated reason when no agent is connected and when the remembered default has disconnected (no silent fall-through); with several agents a remembered default sends on one click and the caret menu switches it; a mailbox-tier target sends and labels the queue truthfully; `N = 0` disables. |

## 6. Cost

Web application only, plus tests. Extend `send-to-agent-dialog.tsx`
(`SendToAgentControl`) and `dispatch-toast.tsx`; do not fork them. The
comment loader gains a walk-all-pages path. Delete the lower-bound code.
