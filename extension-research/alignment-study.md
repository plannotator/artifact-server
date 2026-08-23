# Alignment study: Artifact Server ↔ Pi bi-directional communication

**Date:** 2026-08-18
**Status:** Research synthesis. No design is committed; section 6 lists the decisions that need the owner.
**Sources:** the consultant packet in this directory (verified against real Pi source), the Pi checkout at `~/oss-agents/pi` (HEAD 2a9b4eb; canonical — the sibling `pi-mono` is the older predecessor), Pi's shipped docs and examples, and the current Artifact Server tree. Every load-bearing claim below was verified in source by at least two independent readers plus a spot-check pass; file:line citations live in the session research maps.

## 1. The headline: Pi already has the exact primitive we want

The owner's requirement — *create an annotation, click send, it queues, Pi picks it up when its current work finishes, no human involvement* — is a **single documented Pi API call**:

```ts
pi.sendUserMessage(text, { deliverAs: "followUp" })
```

Verified semantics (`agent-session.ts:1165-1180`, `agent-loop.ts:160-274`):
- Pi idle → the message sends immediately and starts a run.
- Pi mid-run → the message queues and is drained **at the point the agent loop would otherwise stop**, and the run continues into addressing it.
- The same call is safe in both states. No idle/busy branching is needed.

**One correction to the packet:** `pi-extension.md:63-68` branches idle→`followUp` / busy→`steer`. That mapping is wrong for our requirement and contradicted by the consultant's own formal spec and prototype. `steer` cuts in *mid-run* (after the current assistant turn's tool calls, before the next LLM call). "Wait until Pi finishes what it's doing" is `followUp`, always. For reference, Pi's own TUI default is the opposite of our requirement: plain Enter mid-run steers; Alt+Enter is the follow-up queue. We want the Alt+Enter semantics, programmatically.

Also verified about Pi extensions, all favorable:
- Plain TypeScript modules, loaded in-process with full Node privileges, auto-discovered from `~/.pi/agent/extensions/` or project-local `.pi/extensions/` (after project trust). No manifest, no build step.
- Background work is documented and supported: an extension may hold sockets, watchers, and timers — started in `session_start`, torn down in `session_shutdown`.
- Extensions can register tools (`pi.registerTool`), transform input, subscribe to ~30 event types (`agent_settled` is the true "Pi is done" signal), and drive TUI affordances (notify, status, widgets, confirm).
- `examples/extensions/file-trigger.ts` ships in the repo with the docstring "useful for external systems to send messages to the agent" — the pattern has first-party blessing.
- **Pi deliberately has no MCP client** (its docs state MCP is intentionally excluded, to be added as extensions). Our MCP server is therefore useless for the Pi path; the return channel must be HTTP.

## 2. Verdict on the consultant's model

The holistic model is sound and we should keep its spine. Its center of gravity — a multi-harness, hosted-backend bridge — is more than target one needs, and the packet says so itself: the collapse rule.

| Consultant concept | Verdict for target one | Why |
| --- | --- | --- |
| "Local backend IS the sidecar; never run two processes" | **Adopt as the cornerstone** | Artifact Server already runs locally beside Pi. It absorbs the sidecar duties. Zero new processes. |
| Adapter connects **outward**, never listens; enqueue-and-return; agent never blocks on backend; fail-open when backend is away | **Adopt verbatim** | This is the correct safety posture for code living inside someone's coding agent. |
| Durable mailbox in the backend (send survives the agent being closed) | **Adopt** | This is the one genuinely missing Artifact Server piece — see section 3. |
| Delivery status as asynchronous states, never a boolean; "queued in mailbox" is not "delivered" | **Adopt, trimmed** | We need ~4 states, not 6. Pi's `sendUserMessage` is fire-and-forget from the extension API, so "delivered" is inferred from Pi's queue/message events — this shapes the state machine. |
| Command envelope with client-supplied id for reconnect dedup | **Adopt** | Artifact Server already has exactly this idiom (16–200 char idempotency keys on creates). Reuse, don't invent. |
| Normalized cross-harness event journal, session registry, adapter discovery, one multiplexed WebSocket per machine | **Defer** | Multi-harness machinery. Target one has one harness and needs none of it. Design the wire shapes so this can grow later; build none of it now. |
| MCP as internal transport | **Rejected by consultant, confirmed by us** | Pi cannot speak it anyway. |
| Idle/busy → followUp/steer mapping | **Reject (wrong)** | Section 1. `followUp`, unconditionally. |

Packet hygiene notes: the vocabulary drifts across the messages (three capability shapes, two event vocabularies, mailbox placed in two homes), and `message3.md` — the owner's own message that introduced the mailbox premise and stated the constraints — was never in the packet. Nothing blocking, but the packet is a conversation, not a spec; this study plus the eventual design spec supersede it.

## 3. Where Artifact Server stands (alignment inventory)

**Already aligned — the pull half exists and is strong:**
- Complete comment read/write surface with HTTP/MCP parity, `?since=` polling with documented at-least-once semantics, idempotent creates, attributed action ledger with thread ids recoverable from action rows.
- Auth that fits: managed API keys with scoped capabilities; on a local install, the all-capability local token at `<data>/local-api-token` — same-machine trust, no provisioning ceremony for v1.
- A UI click surface in exactly the right places (review-screen thread panel, Comments tab).

**Confirmed missing — the push half is net-new:**
- **No outbound anything.** Zero streaming primitives in the entire codebase (no SSE, no WebSocket, no webhooks), MCP subscriptions explicitly rejected in the baseline, and the comments spec scoped live push out. The "click send → something is told" leg does not exist at any layer.
- **No dispatch record.** Nothing represents "this thread was sent to an agent, and here is where that stands." The mailbox is a new (small) concept.
- **No agent/session binding.** A thread knows project/artifact/version — nothing about machines, checkouts, or agent sessions. Some minimal notion of "a connected agent" must be invented.
- **Browser cannot bypass the server:** the app CSP is `connect-src 'self'`, so the send button must talk to Artifact Server, never to a local bridge port directly. (Correct anyway — durability demands the server owns the mailbox.)

## 4. The minimal foundation this points to

Not a design — the shape the evidence supports, sized to "Pi only, don't boil the ocean":

1. **Mailbox in Artifact Server** (the only new server concept): a dispatch record — **one record per bundle**, carrying the ordered set of thread ids in that bundle, target (v1: the installation's connected agent), state (`queued → claimed → delivered → addressed / failed`), timestamps, idempotency key. "Addressed" is not a new mechanism: the agent's reply/resolve already lands in the comment tables; the UI infers it.
2. **Transport: long-polling, not WebSockets.** The consultant assumed an outbound WebSocket; nobody priced the cheap option. Artifact Server has zero streaming primitives, the volume is human-clicks-per-hour, and Pi's extension can trivially hold a long-poll loop (outward connection, bounded retry, fail-open — exactly the adapter posture). Long-poll on the claim route gives sub-second delivery with pure request/response idioms. The mailbox model is transport-neutral, so SSE/WebSocket remains a later upgrade, not a redesign.
3. **A Pi extension** (`artifact-server.ts`, one file): `session_start` → read the local token, register presence, start the claim loop; on claim → render the annotation into one message (artifact, version, file, quoted selection, body, thread id, and the instruction to answer via the tool — leading `/` avoided, since Pi intercepts slash-prefixed input as commands) → `pi.sendUserMessage(text, {deliverAs: "followUp"})` → report delivery state from Pi's queue/message events (the call itself returns void; two verified traps: compaction-in-progress throws and needs retry, and `/new`/`/resume` tear down and rebind the extension). `session_shutdown` → deregister.
4. **Return path closes the loop:** the extension registers one Pi tool wrapping the existing comment HTTP API (get thread, reply, resolve) with the local token. The agent addresses the annotation, replies, resolves — and the human sees it in the Artifact Server UI through the surfaces that already exist. Bi-directional, with the reverse leg costing almost nothing because comments already shipped.
5. **Bundles, not coalescing (owner's rule, 2026-08-18):** the atomic unit is the **bundle** — the set of annotations the human selected for one send. One send = one dispatch record = one `sendUserMessage` call = one message to the agent. Separately-sent bundles are NEVER merged: Pi's default follow-up queue drains exactly one queued message per stop-boundary and then continues working, so bundle B automatically waits until bundle A's work finishes. This is Pi's out-of-the-box behavior (`followUpMode: "one-at-a-time"`); the extension must not change the queue mode and must not batch across dispatches. The UI supports multi-select so a human can put several annotations into one bundle deliberately.

What this deliberately does not include: transcript mirroring into Artifact Server, session registries for fleets of agents, adapter discovery, hosted-backend connectors, other harnesses, live streaming of agent activity into the browser. All compatible later; none needed for the loop.

## 5. Honest risks and unknowns

- **Multi-session routing** is the one real product wrinkle: two Pi instances on one machine both claim. V1 policy must be explicit (single claimant per installation, first-come; surface the connected agent's cwd in the UI so the human knows who will receive).
- **Delivery acknowledgment is inferred**, not returned — the extension watches Pi's events to move `delivered`; a wedged Pi looks like `claimed` forever, so claims need a lease/timeout.
- **Version skew:** research verified against Pi HEAD 2a9b4eb and installed 0.84.1; the extension API surface used here (sendUserMessage, registerTool, session hooks) is documented public API, the safest subset.
- The **agent-side UX of "addressed"** (must the agent resolve the thread, or reply and leave the human to resolve?) is a product decision, not a technical one.

## 6. Decisions needed from the owner

1. **RESOLVED (owner, 2026-08-18): the unit is the bundle.** The UI offers per-thread send and multi-select send; one send is one bundle; bundles queue FIFO and are never merged. Remaining sub-question only: whether a "select all open on this version" convenience button ships in v1.
2. **RESOLVED (owner, 2026-08-18): explicit agent registry and targeted send.** Multiple Pi sessions connect concurrently; each registers itself (identity, working directory, session, liveness) and appears in the UI; the human picks the target agent at send time; each agent has its own FIFO of bundles. This must hold at scale and in a deployed state — hosted Artifact Server, many machines, every extension connecting outward.
3. **RESOLVED (owner, 2026-08-18): fully hands-off.** The bundle instructs; Pi does the work, replies to the thread with what it did, and resolves the thread. Reopening remains a human action.

## 7. Suggested next round

A design/spec round (same pattern as the comments and OIDC specs): one spec covering the mailbox model + routes + conformance IDs, the extension contract (message rendering, tool shape, event-to-state mapping), and the UI states — then the build/review rounds.
