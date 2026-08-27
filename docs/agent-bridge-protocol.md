# Agent bridge protocol

A bridge is a small process that connects one live coding-agent session to one Artifact Server installation. A human selects comment threads on an artifact and sends them to that agent. The bridge receives the bundle, hands it to its host agent, and the agent replies to each thread and resolves it.

The protocol is five HTTP interactions plus one optional beacon. Any process that can hold an HTTP connection and hand text to an agent can implement it. This page is the whole contract. You do not need to read the Pi extension to build an adapter for another harness.

Sections marked **Planned** describe contracts that are specified but not in a release yet. Do not depend on them until they ship.

## Vocabulary

| Term | Meaning |
| --- | --- |
| Host | The coding agent the bridge feeds, such as a Pi or OpenCode session. |
| Bridge | The process that speaks this protocol on the host's behalf. |
| Registered agent | One live bridge connection known to the installation. The bridge names itself at registration. |
| Bundle | The ordered set of comment threads a human selected for one send. |
| Dispatch | The durable mailbox record for one bundle: target agent, thread IDs, delivery state. |
| Claim | The bridge's act of taking the oldest queued dispatch under a lease. |
| Evidence | How strongly `delivered` is proved for this bridge: `native`, `channel`, or `mailbox`. |

One send is one bundle is one dispatch is one message to the host. Bundles are never merged and never split. Separate sends form a strict per-agent FIFO.

## Authentication

A bridge needs two values: the installation origin and a service token whose principal holds the `agent:connect` capability. Send the token as `Authorization: Bearer <token>` on every request.

Register, claim, report, disconnect, and the beacon require `agent:connect`. Direct human sessions are not agents and are refused. Sending and canceling a dispatch are human actions and are never available to an agent token.

Agent rows are scoped to the registering principal. Another principal presenting the same connection key registers its own separate agent and can never reclaim this one or its queue. Acting on an agent that belongs to another principal answers `404 AGENT_NOT_FOUND` with no disclosure.

## The five interactions

All routes are under `/api/v1`.

### 1. Register

```text
POST /api/v1/agents
```

```json
{
  "connectionKey": "sha256-of-host-and-working-directory",
  "displayName": "checkout-redesign",
  "kind": "opencode",
  "workingDirectory": "/Users/example/work/site",
  "agentSessionId": "session-id-or-null",
  "capabilities": {"beacon": true, "evidence": "native"}
}
```

| Field | Rule |
| --- | --- |
| `connectionKey` | Stable upsert key, 200 characters or fewer, scoped to the calling principal. Derive it from something that survives a restart, such as a hash of hostname and working directory, so a restarted session reclaims the same agent ID and its pending queue. |
| `displayName` | Self-chosen, 1 to 120 characters. The name a human picks from. |
| `kind` | A slug matching `^[a-z][a-z0-9-]{0,39}$`. Display and analytics metadata only. Nothing in the server or the interface branches on it. |
| `workingDirectory` | Display metadata, 1024 characters or fewer. |
| `agentSessionId` | Optional host session ID, refreshed on re-registration. |
| `capabilities` | Optional. See below. |

The response is `200 {"agent": {…}, "protocolVersion": 1}`. Read `protocolVersion` to learn what the server you reached supports. Treat an absent field as `1`, because an older server predates the handshake.

Registration is one upsert. Re-registering with the same key keeps the agent ID, refreshes the name and session ID, and leaves queued dispatches in place. There is no other registration ceremony.

**Capabilities.** Servers and interfaces branch on capabilities, never on `kind`.

| Key | Values | Meaning |
| --- | --- | --- |
| `beacon` | boolean | The bridge sends activity beacons. Default `false`. |
| `evidence` | `native`, `channel`, `mailbox` | How strongly this bridge can prove delivery. Default `native`. |

Unknown keys inside `capabilities` are ignored, so a newer bridge is safe against an older server. A missing `capabilities` object is stored as `{"evidence": "native"}` with `beacon` false. `GET /api/v1/agents` returns the normalized object with defaults applied.

### 2. Claim, which is also the heartbeat

```text
POST /api/v1/agents/:agentId/claims?wait=25
```

Answers `200 {"dispatch": {…}}` with the oldest queued dispatch for this agent, or `204` when nothing is queued within the wait. `wait` is in seconds and capped at 25; a larger value is clamped, not rejected. A deployment may answer early, so loop rather than assume the full wait elapsed.

The poll is the only liveness signal in the protocol. Each poll request bumps `lastSeenAt` once; `GET /api/v1/agents` reports `connected` when that stamp is within 90 seconds. A bridge that re-polls at the 25-second cap stays comfortably inside that window. There is no separate heartbeat route and none is needed.

A successful claim sets the dispatch to `claimed` under a five-minute lease. While this agent holds a `claimed` dispatch, the route answers `204`: one active claim per agent. Dispatches in `delivered` do not block the next claim, because the host's own follow-up queue orders them. An expired lease returns the dispatch to `queued` and it is redelivered.

Treat `404` or `403` on this route as an instruction to register again on the next pass. The agent row was reaped or now belongs to another principal, and polling that ID again can never succeed.

### 3. Report delivered or failed

```text
POST /api/v1/agent-dispatches/:dispatchId/delivered   {"agentId": "agt_…"}
POST /api/v1/agent-dispatches/:dispatchId/failed      {"agentId": "agt_…", "reason": "…"}
```

Only the claim holder may report. `delivered` moves `claimed → delivered`. `failed` moves the dispatch to `failed` and clears the thread markers, so the annotations reappear for the human. `reason` is 500 characters or fewer.

Report `delivered` only after the host accepted the message. See the citizenship rules.

Reports are best-effort by design. A lost report costs one lease redelivery, which is the documented at-least-once posture; it must never stall the loop. Report `failed` when the bundle cannot be rendered or handed over at all, so the work returns to the human instead of disappearing.

There is no `addressed` report. The server infers `addressed` when every thread in the bundle is resolved. Thread resolution is the ground truth, and an explicit report could only proxy or contradict it.

### 4. Reply and resolve

The return path is the ordinary comment API. Nothing is invented for agents.

```text
GET   /api/v1/artifacts/:artifactId/comments/:threadId?projectId=…
POST  /api/v1/artifacts/:artifactId/comments/:threadId/replies?projectId=…   {"body": "…"}
PATCH /api/v1/artifacts/:artifactId/comments/:threadId?projectId=…           {"state": "resolved"}
```

Replies take an `Idempotency-Key` header, as everywhere else in the API. A dispatched thread stays readable by ID even though it is hidden from default listings, so the bridge can always fetch what it was sent.

An MCP-capable host may use the `comment_reply` and `comment_resolve` tools instead. The effect is identical; see [MCP and AI agents](./mcp.md).

Resolving the last open thread of a bundle is what closes the loop: the dispatch reads `addressed`, and the human does nothing further.

### 5. Disconnect

```text
POST /api/v1/agents/:agentId/disconnect
```

Answers `204`. A courtesy teardown that deletes the agent row when the host session ends. Dispatch history is unaffected, because it snapshots the agent name. It is idempotent, and a crashed bridge that never calls it costs nothing: the row goes stale and is reaped.

## Dispatch lifecycle

| From | To | Cause |
| --- | --- | --- |
| — | `queued` | A human sends a bundle. |
| `queued` | `claimed` | A claim poll succeeds. |
| `claimed` | `queued` | The five-minute lease expires. |
| `claimed` | `delivered` | The bridge reports delivered. |
| `delivered` | `addressed` | Every thread in the bundle is resolved. Inferred, never reported. |
| `queued`, `claimed`, `delivered` | `failed` | The bridge reports failed, or the target agent's heartbeat is more than 15 minutes stale while the dispatch is still queued. |
| `queued`, `claimed` | `canceled` | A human cancels. |

Terminal states never transition. `failed` and `canceled` clear the thread markers so the annotations return to the human's view; work is never silently lost.

## Activity beacon

**Planned.** Optional refinement on top of the claim heartbeat.

```text
POST /api/v1/agents/:agentId/activity    {"state": "thinking" | "replying" | "idle", "dispatchId": "dsp_…"}
```

Answers `204`. Requires `agent:connect` on the bridge's own agent; another principal's agent answers `404`.

Send it best-effort at natural boundaries: `thinking` when the host accepts a bundle, `replying` at the first comment reply, `idle` at a work boundary. Send at most one every 10 seconds per agent; the server accepts and overwrites regardless.

The beacon is display metadata only. It is never authorization or ordering input. A beacon older than 60 seconds decays to the state the server derives from dispatch records, and a beacon from an agent whose heartbeat has gone stale is accepted but ignored on read. A bridge that never sends one still gets derived presence: `disconnected`, `idle`, or `working`.

## Bundle rendering contract

A claimed dispatch carries thread IDs, not text. The bridge reads the threads and renders one message. The rendering rules are part of the protocol because they are what makes the message safe and legible in any host.

```text
Artifact Server: {sender} sent {N} annotation(s) to address.
{bundle note, when present}

1. [{artifact name} · version {number} · {path}] "{quoted selection, when the anchor has one}"
   {thread body}
   (thread {threadId})
2. …

When each item is done: use the artifact_comments tool to reply to its thread
with what you did, then resolve it. Do not wait for confirmation.
```

Rules:

- One bundle renders to exactly one message. Never split a bundle across messages and never merge two bundles into one.
- The message never begins with `/`. Many hosts intercept slash-prefixed input as a command. The constant `Artifact Server:` prefix guarantees this.
- Items keep the order the human selected.
- Every item carries its thread ID, because the reply and resolve calls need it.
- A quoted selection has its whitespace collapsed and is bounded to 300 characters with an ellipsis. Bodies are already capped server-side at 8 KiB each.
- The closing instruction names the reply-and-resolve surface the host actually has. Substitute your host's tool name; keep the instruction.

### Unicode sanitization

Comment bodies, bundle notes, and quoted selections are untrusted human text that ends up inside an agent's context. Before composing the message, strip these code points from every one of those fields:

| Class | Code points |
| --- | --- |
| Bidirectional overrides and isolates | U+202A to U+202E, U+2066 to U+2069 |
| Zero-width and invisible characters | U+200B to U+200F, U+2060, U+FEFF |

These characters can reorder or conceal rendered text, so a comment can read one way to the human who wrote it and another way to the agent that receives it. Sanitizing is the bridge's job, not the server's: it happens inside the render path, so it applies identically no matter which server or which host is involved. It applies to every evidence tier, including bundles pushed through a channel.

## Delivery evidence

`delivered` does not mean the same thing for every host. The `evidence` capability is what lets one interface tell the truth about several tiers at once.

| Tier | The loop | Presence | What `delivered` proves |
| --- | --- | --- | --- |
| `native` | The bridge runs inside the host session and injects the bundle as follow-up input. | Real heartbeat from the claim poll, plus the beacon. | The host accepted the message into its own queue. |
| `channel` | A local process long-polls claims and pushes the bundle into an opted-in session as a notification event. | Real heartbeat, because the process polls claims. | The transport admitted the notification. It does not prove the model processed it. |
| `mailbox` | The agent polls its own inbox through a tool call, claims, and reports. | None. Inferred from recent tool calls. | The agent checked its inbox. |

Interfaces must not dress a weaker tier as a stronger one. A `mailbox` agent shows hollow presence, and its threads read "queued for agent", never "working". The mailbox tier still beats copying feedback by hand, but it is not the autonomous loop.

### Evidence ladder mapping

This loop is work-centric. The Live Session Bridge research solves the session-centric problem of streaming transcripts out of a harness and steering into it, and this protocol deliberately adopts neither streaming, steering, nor interrupts. It does adopt that research's delivery-evidence ladder, and the two vocabularies map one to one:

| Live Session Bridge | This protocol | Meaning |
| --- | --- | --- |
| `queued` | `queued` | The bundle waits in the mailbox. |
| `adapter_received` | `claimed` | The bridge holds it under a lease. |
| `native_accepted` | `delivered` | The host accepted the message. |
| `completed` | `addressed` | Every thread in the bundle is resolved. |

Use these names when comparing the two efforts. Do not re-derive equivalents.

## Citizenship rules

A bridge shares a session with a human and an agent doing their own work. These rules are as binding as the routes.

1. **Follow-up delivery only.** Deliver a bundle the way the host queues ordinary user input, so it lands when the host reaches a work boundary. Never steer, interrupt, or preempt. The host's own one-at-a-time drain is what makes bundle B wait for bundle A's work to finish, and that FIFO is the product promise.
2. **Hold while the host compacts.** Hosts reject input during context compaction. Track the host's compaction boundaries and hold delivery until it finishes. Bound the hold well inside the five-minute claim lease; a hold that outlives the lease lets the server requeue the bundle underneath you and deliver the same annotations twice. If the hold reaches its bound, report `failed` rather than injecting late.
3. **Report `delivered` only after host acceptance.** Not after rendering, not after claiming. Await an asynchronous host handoff. If it rejects, report `failed`, return the annotations to the human, and continue the claim loop. A synchronous throw is reserved for an invalid host handle; stop the loop and let lease expiry requeue that uncertain delivery. Do not retry a refused handoff automatically.
4. **Native work fails open; remote control fails closed.** A bridge failure must never degrade the host's own work: with no credential, no server, or no supported host API, go dormant with one notice and let the session continue normally. Anything driven from the far side of the connection refuses rather than guesses: an uncertain delivery is not reported delivered, an unclaimable dispatch is not injected, and an ambiguous host state is a hold, not an attempt.
5. **Bounded backoff.** On any error, back off from 1 second, doubling to a 30-second ceiling, with jitter. Reset on the first successful poll. No error path may sleep longer than the ceiling, and none may spin.
6. **Never throw into the host.** Contain every exception at the bridge boundary. Treat an invalidated host handle as the loop's shutdown signal, and let the host's next session start register again.
7. **Tolerate at-least-once.** A dispatch may be delivered twice after a lease expiry or a lost report. Replies and resolves are idempotent by design, so the recovery is to re-run, not to invent deduplication.
8. **Disconnect on the way out.** Fire the courtesy disconnect at session shutdown; treat its failure as unremarkable.

## Building an adapter

The whole loop, in order:

1. Resolve an origin and a token. Without both, go dormant with one notice.
2. `POST /agents` with your `kind`, name, working directory, and capabilities. Keep the agent ID and the protocol version.
3. Loop: `POST /agents/:agentId/claims?wait=25`. On `204`, loop again. On `404` or `403`, register again.
4. On a dispatch: read its threads, sanitize, render one message, hold while the host is compacting, hand it to the host.
5. `POST /agent-dispatches/:id/delivered` after the host accepts it, or `/failed` with a reason.
6. Expose reply and resolve to the host, backed by the comment routes.
7. On session shutdown, abort the in-flight poll and `POST /agents/:agentId/disconnect`.

Errors back off 1 to 30 seconds with jitter. Nothing else is required.

## Out of scope

There is no push transport: the claim long-poll is the only delivery path. There is no transcript mirroring, no steering, no interrupts, and no per-`kind` server behavior. The protocol is deliberately transport-independent, so a future move onto standard MCP primitives replaces the transport without touching the dispatch lifecycle, the evidence ladder, the presence model, or the rendering contract above.

## Related documents

- [Agent dispatch and the Pi bridge](../project/spec/agent-dispatch-spec.md) — the shipped dispatch model and its storage, routes, and conformance requirements.
- [Agent presence, frictionless dispatch, and the reusable bridge protocol](../project/spec/agent-presence-and-bridge-spec.md) — the design this page documents.
- [Pi live feedback extension](../integrations/pi/README.md) — the reference native bridge.
- [MCP and AI agents](./mcp.md) — the tool surface an agent uses to reply and resolve.
