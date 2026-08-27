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

- **Agent avatar.** Presence renders as an avatar circle carrying the
  agent's own brand mark — the Pi glyph for `kind: "pi"`, an opencode mark
  for `opencode`, a neutral mark for unknown kinds. The web app maps `kind`
  to a bundled asset (glyph + brand accent color); no remote fetches. The
  avatar appears wherever the agent is named: the send button, dialog rows,
  and under Sent threads.
- **State on the border.** The avatar's ring is the state signal, colored
  from the agent's brand accent: quiet solid ring = connected and idle;
  pulsing ring (2 s ease) = working/thinking; spinning conic ring =
  replying; hollow grey ring + muted name = disconnected, send disabled with
  the reason. State is never carried by color alone — motion plus the
  popover below carry the meaning. All motion sits behind
  `prefers-reduced-motion` (static two-tone ring fallback) and attaches only
  to live states, so an idle page burns nothing.
- **Hover popover.** Hovering or keyboard-focusing the avatar opens a small
  popover that says the state in words: agent name and kind, "Working —
  claimed your bundle of 3 threads, 40 s ago", last-seen time, working
  directory. The same popover explains a disconnected agent ("last seen 6
  minutes ago — restart Pi to reconnect").
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
  host-agnostic package, published from this repo as
  `@artifact-server/agent-bridge` (section 6, decision 3):
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
- **Registration advertises capabilities.** Alongside `kind`, registration
  gains a `capabilities` object (e.g. `{beacon: boolean, delivery:
  "follow_up", evidence: "native" | "mailbox"}`). Servers and UI branch on
  capabilities, never on `kind` — the rule the Live Session Bridge research
  states as "check `capabilities.steer`, not `harness === 'pi'`". Adding it
  at widening time is cheap; retrofitting it after three harnesses exist is
  not. Unknown capability keys are ignored (forward compatibility), and the
  registration response carries a protocol version so a bridge knows what
  the server it reached supports.
- **Sanitize rendered bundles.** Comment bodies and quoted selections are
  untrusted text injected into an agent's context. The render contract
  strips bidirectional-override and invisible Unicode before composing the
  message (the same class of control the Live Session Bridge security model
  requires for tool summaries). This applies server-independent, inside the
  shared render function.
- **Name the tools the recipient has.** Bundle rendering defaults to the
  native/channel profile, which names `artifact_comments`. The MCP mailbox
  requests the mailbox profile, which names `comment_reply` and
  `comment_resolve`. Both profiles share the same structure and sanitization.
- **Non-goals.** No webhook push transport (long-poll stays the only claim
  path in v1); no bridge-side plugin marketplace; no per-kind server
  behavior.

## 4.3 Prior art: the Live Session Bridge research

`~/oss/agent-comms/LIVE_SESSION_BRIDGE_ENGINEERING_HANDOFF.md` (separate
project) solves the *session-centric* problem — streaming live transcripts
out of a harness and steering into it. This loop stays *work-centric* and
deliberately never adopts streaming, steering, or interrupts. What it does
adopt from that research:

- **Capability descriptors** (above) and its **delivery-evidence ladder**,
  which maps onto ours: their `queued` = `queued`, `adapter_received` =
  `claimed`, `native_accepted` = `delivered`, `completed` = `addressed`. The
  protocol doc records this mapping so the two efforts share vocabulary.
- **Non-interference wording.** "Native work fails open; remote control
  fails closed" and the bounded-queue rules enter
  `docs/agent-bridge-protocol.md` as written there, not re-derived.
- **The opencode homework.** Their tested adapter fixes our opencode
  adapter's shape: in-process client, `session.promptAsync` for follow-up
  input, `session.abort` for interrupt (unused here), steering advertised
  `false`, and a V2-plugin-API version-pinning caveat to resolve before
  shipping.
- **Claude Code joins at two tiers.** Baseline: a `dispatch_inbox` MCP tool
  (list my queued dispatches, claim, report) lets any MCP-capable agent join
  with no extension — honestly weaker (`evidence: "mailbox"`: delivery means
  "the agent polled its inbox"; presence derives from recent tool calls, no
  heartbeat). Upgrade: a **Claude Channel** bridge
  (code.claude.com/docs/en/channels-reference) — a local MCP server that
  long-polls the claims route exactly like the Pi bridge (so it has the
  heartbeat, and real presence) and pushes each claimed bundle into the
  opted-in session as a `notifications/claude/channel` event. Channel
  semantics queue events while Claude is busy, which is functionally our
  follow-up-only delivery rule; Claude replies and resolves through the same
  MCP comment tools. Caveats to record honestly: Channels are a research
  preview behind user/org opt-in, events land only while the enabled session
  is open, and writing the notification proves transport admission, not
  model processing — so `evidence: "channel"` sits between `mailbox` and
  `native`, and the bundle text passes the same Unicode sanitization plus
  the channel sender-gating guidance. The capability object
  (`evidence: "native" | "channel" | "mailbox"`) is what lets the UI show
  each tier truthfully.

## 4.4 Cross-product reuse (Workspaces)

Artifact Server is the open-source offering out of Workspaces; the same
integrated-agent capability is wanted there. Strategy: promote the protocol,
not the plugin.

- **One protocol, two servers.** Workspaces implements the same five routes
  (plus beacon) against its own models and auth. The client package and the
  harness adapters are shared verbatim; a bridge is pointed at a server by
  origin + token and cannot tell the products apart.
- **One extension, many connections.** The bridge client grows multi-
  connection resolution: local Artifact Server discovery and a Workspaces
  org credential can both resolve, and one Pi session runs one bridge per
  connection. Bundles already render with their source named.
- **Naming follows adoption.** If Workspaces commits, the package publishes
  at the family level (`@plannotator/agent-bridge`) rather than
  `@artifact-server/agent-bridge` — this supersedes section 6 decision 3's
  package name if and when that commitment lands; decide before first
  publish, because renaming a published package is churn.
- **What Workspaces adds on its own:** multi-tenant agent-token issuance
  (device-flow-style), org/workspace scoping on the registry, and rate
  limits on claim polls. The protocol itself needs none of that to change —
  which is the point.

### 4.5 Per-agent support, realistically

| Agent | Tier | The loop | Presence | What "delivered" means |
| --- | --- | --- | --- | --- |
| Pi | native | Full, shipped | Heartbeat now; beacon when built | Host accepted the message |
| OpenCode | native | Full, buildable now | Same as Pi (same bridge core) | Host accepted via `promptAsync` |
| Claude Code + Channel | channel | Full, near-Pi | Real heartbeat (the Channel process long-polls claims) | Notification handed to the session; queues while busy |
| Claude Code, plain MCP | mailbox | Passive | Inferred from recent tool calls | The agent checked its inbox |
| Codex | mailbox | Passive; no deeper path today (desktop has no injection surface) | None | Inbox check |
| Cursor / Copilot | mailbox | Passive, user-prompted in practice | None | Inbox check |

The mailbox tier still beats copy-pasting feedback, but it is not the
autonomous loop, and the UI must not pretend otherwise: hollow presence,
threads say "queued for agent," never "working…". The registration
capability object is what keeps all tiers honest in one UI.

### 4.6 MCP convergence (the long-term transport)

The MCP roadmap (modelcontextprotocol.io/development/roadmap, 2026-08-22)
prioritizes exactly the pieces this loop hand-rolls today:

- **Tasks (SEP-2663)** — long-running work units with a shared lifecycle:
  a dispatch is a Task.
- **Server-initiated events** (Triggers & Events WG) — channels,
  subscriptions, and webhooks so servers push instead of clients polling:
  replaces the claims long-poll, and upgrades the mailbox floor to a real
  wake path for every MCP-capable agent.
- **Agent identity** (DPoP, ID-JAG, workload identity federation) — the
  multi-tenant token story Workspaces otherwise has to invent.

Posture, decided: **when these specs land, standard MCP becomes the
transport.** Until then the five HTTP routes and harness adapters are the
interim, built so the swap stays contained: the domain model (dispatch
lifecycle, evidence ladder, presence states, render contract) is
transport-independent; only the transport layer (routes, long-poll, harness
adapters) gets replaced. Concretely that means: no domain logic in route
handlers or adapters, the protocol version handshake from day one, and the
capability object expressed in terms MCP can later satisfy (`evidence`,
delivery mode) rather than harness names. Track the Tasks and
Triggers & Events working groups; when a Claude/OpenCode/Codex host speaks
Tasks + server-initiated events natively, its bespoke adapter retires.

## 5. Conformance sketch (IDs reserved, all `specified`)

| ID | Behavior |
| --- | --- |
| PRS-001 | `GET /agents` derives `activity`/`activeDispatchId` from dispatch state with no stored activity writes. |
| PRS-002 | Activity beacon stores, decays after 60 s, never applies to a stale agent. |
| PRS-003 | Beacon rejected for another principal's agent (404, no disclosure). |
| PRS-004 | Single-connected-agent send dispatches without a dialog; undo cancels from `queued`/`claimed`; a terminal-state undo reports the conflict. |
| PRS-005 | Bulk clear deletes matching threads with ledger entries, skips actively dispatched threads, and reports both counts. |
| PRS-006 | Presence avatar renders all four ring states with the kind's brand assets; popover states the meaning in words; motion only on live states; reduced-motion fallback. |
| PRS-007 | `kind` accepts any valid slug and round-trips; invalid slugs fail 422. |
| BRP-001 | The extracted bridge core drives a fake host through register → claim → deliver → reply → resolve with no Pi import anywhere in the module. |

## 6. Decisions from owner review (August 25, 2026)

The first draft ended with four open questions; two rounds of owner
annotations resolved all four.

1. **Decided — bulk clear stays per artifact.** Owner: "keep it
   focused/simple." The "Clear resolved…" menu item acts on the artifact you
   are looking at; there is no project-wide clear.
2. **Decided — how often presence refreshes.** The question was only about
   where the live dot updates: the web app refreshes agent presence on the
   same ~5-second cycle it already uses to refresh comments, so presence is
   live wherever a comments panel is open. Screens without comments show the
   last known state. Good enough for v1; revisit only if presence is wanted
   on other screens.
3. **Decided — publish the package.** Owner: "why not?" The bridge core
   publishes from this repo as `@artifact-server/agent-bridge`, the same way
   `@artifact-server/pi-extension` already does.
4. **Decided — presence wears the agent's brand.** Presence is an avatar
   circle carrying the agent's own mark (Pi's glyph, opencode's mark), and
   its ring colors come from that agent's brand identity — not the app
   accent, not a generated palette. The `kind` → brand-asset map in the web
   app is the single place a new agent kind registers its look.

## 7. Build-out path

Ordered so each phase ships value alone, the reusable pieces harden before
anything depends on them, and Workspaces can join without rework.

**Phase 0 — freeze the reusable core (gates everything).**
Extract `integrations/bridge-core/` as the shared client package; write
`docs/agent-bridge-protocol.md`; add the capability object and protocol
version handshake to registration; Unicode sanitization in the shared
render function. Decide the package name before first publish:
`@plannotator/agent-bridge` if the Workspaces commitment stands, otherwise
`@artifact-server/agent-bridge`. Pi extension re-ships on the extracted
core (behavior unchanged — a refactor proven by BRP-001).

**Phase 1 — the owner-facing UX, no new agents.**
Derived presence in `GET /agents` (PRS-001) + the avatar/ring/popover in
the web app (PRS-006); frictionless single-agent send with undo (PRS-004);
per-artifact bulk clear (PRS-005). Then the beacon route (PRS-002/003) and
the Pi bridge sending it. All Artifact Server web/server work.

**Phase 2 — the mailbox floor.**
`dispatch_inbox` MCP tools (list/claim/report) on the existing MCP server,
registered as `evidence: "mailbox"` agents. Instantly enables Claude Code,
Codex, Cursor, and Copilot at the passive tier with server-side work only.
UI honesty (hollow presence, "queued for agent") rides the Phase 1
capability plumbing.

**Phase 3 — OpenCode, the second native adapter.**
Pin the supported OpenCode version (V2 plugin API decision), port the
prior-art adapter onto the shared core, one real integration test proving
follow-up delivery semantics, publish. This is the proof the extraction is
actually reusable.

**Phase 4 — Workspaces implements the protocol.**
Workspaces builds the five routes + beacon against its own models, plus
its own concerns: multi-tenant agent-token issuance, org/workspace scoping,
claim-poll rate limits. The client package gains multi-connection
resolution (local discovery + Workspaces org credential; one bridge per
connection in one host session). No shared code changes shape — that is
the acceptance test of the strategy.

**Phase 5 — Claude Channel bridge, when the preview stabilizes.**
The Channel process on the shared core: long-poll claims (heartbeat),
push bundles as channel notifications, `evidence: "channel"`. Gated on
Channels leaving research preview or the owner deciding preview status is
acceptable.

**Horizon — MCP convergence (section 4.6).**
Dispatch becomes a Task, server-initiated events replace the long-poll and
wake the mailbox tier, agent identity replaces bespoke tokens. Bespoke
adapters retire host by host as hosts speak the new primitives natively.
The phases above are built to make this a transport swap, not a rewrite.
