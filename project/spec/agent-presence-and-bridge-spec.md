# Agent presence, frictionless dispatch, and the reusable bridge protocol

Status: design for owner review — nothing here is implemented.
Builds on `agent-dispatch-spec.md` (the shipped dispatch model) and the
comments spec. Owner feedback that motivated it, August 25, 2026:

1. The send confirmation dialog is friction.
2. Comments need a way to be cleared out.
3. The UI must show, with confidence, that Pi is connected, that a send will
   land, and that the agent is working or replying — presence, like the
   Workspaces app, with motion while the agent is active.
4. The connectivity/presence/reply protocol should be reusable so the same
   loop can be built for opencode and other agents as custom plugins.

## 1. Frictionless send (no confirmation dialog)

Today `Send to agent` always opens a dialog (agent picker, selected
annotations, optional note). That dialog earns its place only when there is a
choice to make.

Design:

- **One connected agent → one click.** `Send to agent` dispatches immediately
  to that agent. No dialog. The button carries the agent's presence dot and
  name (`Send to checkout-redesign`), so the destination is visible before
  the click.
- **Undo instead of confirm.** After a one-click send, a toast shows
  "Sent 3 threads to checkout-redesign — Undo". Undo calls the existing
  `POST /agent-dispatches/:id/cancel` (valid from `queued`/`claimed`, already
  clears thread markers). The toast lives ~8 s; a dispatch claimed and
  delivered before the undo lands simply reports the cancel conflict and the
  toast says so. No new API.
- **The dialog remains for choices.** Zero connected agents (explains how to
  connect one), two or more agents (picker), or the user opens the split-button
  caret to add a bundle note. The note field is the only reason the dialog
  exists for a single-agent send, and it moves behind the caret.

No server change. This is a web-application change plus one UX rule.

## 2. Clearing comments out

Per-thread deletion already exists end to end (author or administrator;
`DELETE` routes; thread card "Delete" action with confirm). Two gaps remain:

- **Bulk clear.** New route
  `POST /api/v1/projects/:projectId/artifacts/:artifactId/comments/clear`
  with body `{state: "resolved" | "all", versionId?}`, human member or
  `artifact:manage:any` only. Deletes matching threads (replies cascade, as
  single deletion already does), appends one `comment_delete` action per
  thread to the ledger, and returns `{deleted: number}`. Threads inside an
  active dispatch (`queued`/`claimed`) are skipped and counted separately
  (`{skippedDispatched: number}`) — clearing must not yank work out from
  under an agent; cancel the dispatch first.
- **Discoverability.** The comments panel gains a small overflow menu:
  "Clear resolved…" and (managers only) "Clear all…". One confirm for bulk —
  bulk destruction keeps its confirm even though single send loses its
  dialog; the asymmetry is deliberate (irreversible × many).
- MCP parity per CMT-012: `comment_clear` tool with the same shape.

## 3. Presence and activity

### 3.1 What exists

Liveness only: the claim long-poll bumps `lastSeenAt`; `GET /agents` derives
`connected = seen within 90 s`. The UI shows a static "Connected" label
inside the send dialog and nothing anywhere else. Nothing distinguishes an
idle agent from one mid-bundle, and nothing on the comments panel shows that
a reply is on its way.

### 3.2 Presence model (derived first, beacon second)

Two layers, cheapest first, both computed lazily on read — no background
jobs, matching the dispatch spec's posture:

**Layer 1 — derived activity (no new writes).** `GET /agents` items gain:

```ts
activity: "disconnected" | "idle" | "working";
activeDispatchId: string | null;   // the claimed/delivered, not-yet-addressed dispatch
lastActivityAt: string;            // max(lastSeenAt, latest dispatch transition)
```

`working` = the agent holds a dispatch in `claimed` or `delivered` whose
threads are not all resolved. Everything needed already sits in
`agent_dispatches`; this is a join at read time.

**Layer 2 — the activity beacon (finer grain, optional).** One new route:

| Route | Auth | Contract |
| --- | --- | --- |
| `POST /agents/:agentId/activity` | `agent:connect`, own agent | Body `{state: "thinking" \| "replying" \| "idle", dispatchId?}`. Stored on the agent row (`activity_state`, `activity_at`, nullable). TTL 60 s: a stale beacon decays to the derived state on read. `204`. Throttle guidance: at most one per 10 s per agent; the server accepts and overwrites regardless. |

Bridges send it best-effort at natural boundaries (bundle accepted →
`thinking`; first `artifact_comments reply` → `replying`; work boundary →
`idle`). A bridge that never sends it still gets Layer 1. The beacon is
display metadata, never authorization or ordering input.

**Web polling.** The comments panel already polls; the same cadence fetches
`GET /agents` when the panel is open and at least one thread is `Sent`.
No sockets in v1 — presence freshness of one poll interval (~5 s) is enough
for this loop. A future SSE channel can upgrade both comments and presence at
once; explicitly out of scope here.

### 3.3 Presence in the UI

Adopting the Workspaces presence language (identity-color dot, motion only
while live), tuned down to this app's zero-radius, quiet style:

- **Agent chip.** Wherever an agent is named (send button, dialog row,
  thread state), it renders as a chip: 8 px identity-color presence dot +
  display name. Color = stable hash of agent id into an 8-slot presence
  palette (`--presence-0..7`, light and dark variants, same parity contract
  Workspaces pins in tests).
- **States as motion.** `idle`: solid dot. `working`/`thinking`: the dot
  pulses (2 s ease, opacity 1 → 0.35). `replying`: a 1.5 px conic spinning
  border on the chip — the "agent is doing something" signal the owner asked
  for. `disconnected`: hollow grey dot, chip text muted, send disabled with
  reason. All motion sits behind `prefers-reduced-motion` (falls back to a
  static two-tone dot), and animations attach only to live states so there is
  no idle CPU burn.
- **Thread-level feedback.** A `Sent` thread whose dispatch is `claimed` or
  `delivered` shows "‹chip› working…" under the state pill; when the agent's
  beacon says `replying`, it shows "‹chip› replying…". When the reply lands,
  the poll delivers it and the row updates — the presence line is replaced by
  the real reply.
- **Loading states.** The send button renders its own resolution state:
  reading agents (spinner), no agent (dimmed + "Connect an agent" hint),
  ready (chip). The dialog's existing "Reading connected agents…" copy stays.

### 3.4 Honesty rules

- `connected` keeps meaning "the long-poll heartbeat is fresh" — presence
  never claims more than the server can verify. The beacon only decorates an
  already-connected agent; a beacon from a stale agent is ignored on read.
- A send to an agent whose heartbeat went stale between paint and click fails
  with the existing dispatch failure and the toast says the agent
  disconnected — the UI never silently queues into the void (the 15-minute
  `agent_unavailable` lazy failure remains the backstop).

## 4. The reusable bridge protocol

### 4.1 What already generalizes

`integrations/pi/bridge-core.ts` is already host-agnostic by construction:
everything Pi-specific enters through the `PiPort` interface (notify,
sendUserMessage, isCompacting) and the thin `index.ts` adapter. The protocol
underneath is five HTTP interactions any process can implement:

1. `POST /agents` — self-registration, stable `connectionKey` upsert.
2. `POST /agents/:id/claims?wait=25` — long-poll claim; the poll is the
   heartbeat.
3. `POST /agent-dispatches/:id/delivered` / `failed` — delivery report.
4. Comment routes (via the `artifact_comments` tool surface) — reply/resolve
   close the loop.
5. `POST /agents/:id/disconnect` — courtesy teardown.

Plus the rules that make bridges good citizens: follow-up delivery only
(never interrupt the host agent), hold delivery while the host compacts,
fail open (dormant + one notice, exponential 1–30 s backoff), report
`delivered` only after the host accepted the message.

### 4.2 Design

- **Name and document it.** `docs/agent-bridge-protocol.md` — a public,
  implementation-free page: the five interactions, the rendering contract
  for bundles, the citizenship rules above, and the new activity beacon.
  Written so someone building an opencode plugin never needs to read Pi code.
- **Extract the client.** `integrations/bridge-core/` becomes the shared,
  host-agnostic package (working name `@artifact-server/agent-bridge`):
  `resolveBridgeCredentials`, `startBridge`, `createCommentOperations`,
  `renderBundleMessage`, backoff, and the beacon — parameterized by a renamed
  `HostPort` (today's `PiPort`: notify / deliverFollowUp / isBusy). The Pi
  extension shrinks to its current `index.ts`: type the host's API
  structurally, wire the port, register the tool. An opencode plugin is the
  same ~250-line shape against opencode's plugin API.
- **Widen `kind`.** `registered_agents.kind` is a CHECK-constrained closed
  set (`'pi'`). Relax to a validated slug (`^[a-z][a-z0-9-]{0,39}$`) checked
  in the application layer; the CHECK constraint drops in a schema migration
  on all three backends (SQLite, Postgres, D1 — each by its own mechanics).
  `kind` remains display/analytics metadata; nothing branches on it, which is
  what makes widening safe. The dispatch spec reserved this for "a future
  ADR" — this is that decision, recorded as ADR when implemented.
- **Non-goals.** No webhook push transport (long-poll stays the only claim
  path in v1); no bridge-side plugin marketplace; no per-kind server
  behavior.

## 5. Conformance sketch (IDs reserved, all `specified`)

| ID | Behavior |
| --- | --- |
| PRS-001 | `GET /agents` derives `activity`/`activeDispatchId` from dispatch state with no stored activity writes. |
| PRS-002 | Activity beacon stores, decays after 60 s, never applies to a stale agent. |
| PRS-003 | Beacon rejected for another principal's agent (404, no disclosure). |
| PRS-004 | Single-connected-agent send dispatches without a dialog; undo cancels from `queued`/`claimed`; a terminal-state undo reports the conflict. |
| PRS-005 | Bulk clear deletes matching threads with ledger entries, skips actively dispatched threads, and reports both counts. |
| PRS-006 | Presence chip renders all four states; motion only on live states; reduced-motion fallback. |
| PRS-007 | `kind` accepts any valid slug and round-trips; invalid slugs fail 422. |
| BRP-001 | The extracted bridge core drives a fake host through register → claim → deliver → reply → resolve with no Pi import anywhere in the module. |

## 6. Open questions for the owner

1. Bulk clear scope: per artifact (proposed) or also per project in one call?
2. Presence poll piggybacks the comments poll (~5 s). Fine, or is the
   send-button presence wanted on screens where comments are closed too?
3. Should the npm package publish from this repo (like the Pi extension) or
   stay an internal module until an opencode plugin actually exists?
4. Identity-color palette: adopt Workspaces' 8 oklch slots verbatim for
   cross-product familiarity, or derive a local set from the iris accent?
