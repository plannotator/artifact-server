# Agent dispatch and the Pi bridge

**Status:** Accepted (ADR 0021); implemented — DSP-001 through DSP-013 behavior-verified on the local deployment; the live-host proofs stay outside the ledger as owner-run adapter verification and live suites that are not part of `verify:iteration` (August 26, 2026)
**Date:** August 18, 2026
**Owner:** Artifact Server product engineering
**Companion documents:** [Artifact comments](./artifact-comments-spec.md), [Conformance ledger](./conformance.yml), research synthesis (`project/research/alignment-study.md`), consultant packet (`project/research/`)

## 1. What this adds and why

A human annotates an artifact, sends one annotation or all open annotations to a connected agent, and continues reviewing. The annotations leave the screen. The Pi coding agent receives them as one message when it finishes its current work, does the work, replies to each thread with what it did, and resolves them. The human does nothing else.

This is the bi-directional loop the comment system was missing: Artifact Server already has the pull half (comment reads with `?since=` polling, at-least-once semantics, idempotent writes), and nothing today can tell an agent anything (no push of any kind exists in the codebase — verified: zero SSE/WebSocket/webhook primitives, MCP subscriptions disabled). This spec adds the push half as two small, transport-neutral concepts — a **registered agent** and a **dispatch mailbox** — plus one Pi extension that connects them to a live Pi session.

Owner decisions this spec is built on (recorded in `project/research/alignment-study.md` §6):

1. **The bundle is the atomic unit.** One send = one bundle = one message to the agent. Separately sent bundles form a strict FIFO; they are never merged. Bundle B is delivered only after the agent finishes the work bundle A started. This maps exactly onto Pi's default follow-up queue (`deliverAs: "followUp"`, `followUpMode: "one-at-a-time"`), so Pi provides the FIFO and this system never changes Pi's queue settings.
2. **Explicit agent registry with targeted send.** Multiple Pi sessions connect concurrently, each registers itself and appears in the UI, and the human picks the target at send time. The shapes must survive a hosted deployment (many machines, agents connecting outward) without redesign.
3. **Fully hands-off.** The agent does the work, replies, and resolves. Reopening is a human action.
4. **Send is consumptive.** Sending removes the annotations from the artifact surfaces immediately — pins gone, cards gone. That is the experience: "I sent them and they're gone." No progress badges or status chrome decorate the comment surfaces. The one exception: if a dispatch permanently fails, its threads reappear, because work must never be silently lost.

Sized deliberately: Pi is the only supported agent; the transport is long-polling over the existing HTTP conventions; no other harness, no live streams, no transcript mirroring.

## 2. Vocabulary

| Term | Meaning |
| --- | --- |
| Registered agent | One live agent connection known to the installation: identity, kind (`pi`), working directory, session id, liveness. |
| Bundle | The ordered set of annotations (comment threads) the human selected for one send. |
| Dispatch | The durable mailbox record for one bundle: target agent, thread ids, delivery state. One row per bundle. |
| Claim | The agent's act of taking the oldest queued dispatch for itself, under a lease. |
| Delivery states | `queued → claimed → delivered → addressed`, terminal `failed` and `canceled`. Never collapsed into a boolean; "queued in the mailbox" is not "delivered" (consultant vocabulary, kept). |
| Dispatched thread | A comment thread referenced by an active dispatch. Excluded from default comment listings — this is what makes send consumptive. |

## 3. Model

Two new records plus one marker column, all installation- and project-scoped per repo law.

```ts
/**
 * One live agent connection. A disposable liveness record, not a durable
 * object: the agent NAMES ITSELF in the registration request, rows carry no
 * lifecycle state beyond lastSeenAt, stale rows are deleted, and nothing
 * durable hangs off the row. The durable object is the dispatch queue, which
 * survives agent restarts because the same connectionKey upserts back into
 * the same id.
 */
export interface RegisteredAgentRecord {
  readonly id: string;                    // "agt_" + UUID
  readonly installationId: string;
  readonly connectionKey: string;         // stable upsert key, ≤200 chars, scoped to the registering principal (extension default: sha256 of host + cwd)
  readonly displayName: string;           // self-named, 1..120 chars (extension defaults to basename(cwd); user-overridable)
  readonly kind: "pi";                    // closed set; widened only by a future ADR
  readonly workingDirectory: string;      // display metadata, ≤1024 chars
  readonly agentSessionId: string | null; // Pi session id, refreshed on re-registration
  readonly principalId: string;           // who registered (audit)
  readonly createdAt: string;
  readonly lastSeenAt: string;            // bumped once per claim poll request — the poll IS the heartbeat; the only liveness state
}

/** One bundle sent to one agent. */
export interface AgentDispatchRecord {
  readonly id: string;                    // "dsp_" + UUID
  readonly installationId: string;
  readonly projectId: string;
  readonly agentId: string;               // no FK — agent rows are disposable; the name is snapshotted below
  readonly agentDisplayName: string;      // snapshot at send time, so history survives agent-row deletion
  readonly threadIds: readonly string[];  // ordered, 1..100, all open + undispatched at send time, all in projectId
  readonly note: string | null;           // optional human bundle note, ≤2000 chars
  readonly state: "queued" | "claimed" | "delivered" | "addressed" | "failed" | "canceled";
  readonly sender: CommentAuthor;         // same snapshot shape comments use
  readonly idempotencyKey: string;
  readonly claimedAt: string | null;
  readonly leaseExpiresAt: string | null; // claim lease; expiry returns the dispatch to queued
  readonly deliveredAt: string | null;
  readonly addressedAt: string | null;
  readonly failedAt: string | null;
  readonly failureReason: string | null;  // ≤500 chars, from the agent report or "agent_unavailable"
  readonly canceledAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}
```

`comment_threads` gains one nullable marker: `dispatch_id TEXT NULL` (FK where the backend supports it). Set when a dispatch is created, in the same transaction; cleared when the dispatch fails or is canceled, and released when a thread is reopened while its dispatch has already left the queue (`delivered`, `addressed`, `failed`, `canceled`) — a reopened thread that kept its marker would be invisible on every default surface and unsendable forever. Setting and releasing the marker bumps the thread's `updatedAt`, so a `?since=` poller sees the thread leave and come back. A thread can be in at most one active dispatch — the send validates `dispatch_id IS NULL` and `state = 'open'` for every thread in the same transaction that sets the markers, so two concurrent sends cannot double-book a thread.

**State machine.** `queued → claimed` (claim), `claimed → delivered` (agent report), `claimed → queued` (lease expiry, lazily on next read/claim), `queued|claimed → canceled` (human), `queued|claimed|delivered → failed` (agent report, or automatic `agent_unavailable` when the target agent's `lastSeenAt` is more than 15 minutes stale while the dispatch is still queued — evaluated lazily on read, no background job), `delivered → addressed` (**inferred**: every thread in the bundle is `resolved`; observed on the read path and stamped when first observed). Terminal states never transition. `failed` and `canceled` clear the thread markers; `addressed` does not while the threads stay resolved (they are already invisible), and reopening one releases its marker.

Why inferred `addressed` rather than an agent report: thread resolution is the ground truth the owner cares about, it already lands through the existing comment API, and an explicit report could only proxy or contradict it.

Why no new action-ledger kinds: the `actions` table is artifact-and-version-scoped and its kind set is a closed enum enforced by CHECK constraints in three backends; a dispatch spans artifacts and self-audits (sender snapshot, every transition timestamped). The dispatch row is the audit record.

## 4. Storage

`AgentDispatchRepository` port in `src/core/ports.ts` (Promise-based, like `CommentRepository`): `registerAgent` (upsert on `(installation_id, principal_id, connection_key)` — the key is scoped to the registering principal, so one principal never reclaims another's row and the dispatches queued for it), `disconnectAgent`, `listAgents`, `findAgent`, `createDispatch` (transactional with marker set + validation), `claimNextDispatch(agentId, now, bumpHeartbeat)` (atomic oldest-queued claim honoring the one-active-claim rule and lease reclaim; `bumpHeartbeat` marks the first attempt of one held poll request — a re-check attempt with it false stays a pure read while nothing is claimable), `markDelivered`, `markFailed`, `cancelDispatch`, `listDispatches` (keyset paging), `findDispatch`, `observeAddressed(dispatchId, now)`. `IdGenerator` gains `registeredAgentId()` and `agentDispatchId()`.

Tables (SQLite dialect; Postgres and D1 mirror, same shapes as the comment tables' conventions):

```sql
CREATE TABLE registered_agents (
  id TEXT PRIMARY KEY,
  installation_id TEXT NOT NULL,
  connection_key TEXT NOT NULL,
  display_name TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('pi')),
  working_directory TEXT NOT NULL,
  agent_session_id TEXT,
  principal_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  UNIQUE (installation_id, principal_id, connection_key)
) STRICT;

CREATE TABLE agent_dispatches (
  id TEXT PRIMARY KEY,
  installation_id TEXT NOT NULL,
  project_id TEXT NOT NULL REFERENCES projects(id),
  agent_id TEXT NOT NULL,                 -- no FK: agent rows are disposable and deletable; display name is snapshotted
  agent_display_name TEXT NOT NULL,
  thread_ids_json TEXT NOT NULL,          -- ordered JSON array; members also carry the back-marker below
  note TEXT,
  state TEXT NOT NULL CHECK (state IN ('queued','claimed','delivered','addressed','failed','canceled')),
  sender_principal_id TEXT NOT NULL,
  sender_principal_kind TEXT NOT NULL CHECK (sender_principal_kind IN ('human','service')),
  sender_display_name TEXT NOT NULL,
  sender_authorized_by_principal_id TEXT,
  idempotency_key TEXT NOT NULL,
  claimed_at TEXT, lease_expires_at TEXT, delivered_at TEXT,
  addressed_at TEXT, failed_at TEXT, failure_reason TEXT, canceled_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (installation_id, project_id, idempotency_key)
) STRICT;

ALTER TABLE comment_threads ADD COLUMN dispatch_id TEXT REFERENCES agent_dispatches(id);

CREATE INDEX agent_dispatches_claim ON agent_dispatches (agent_id, state, created_at, id);
CREATE INDEX comment_threads_dispatch ON comment_threads (dispatch_id);
```

Schema versions bump by one on each backend **from whatever the tree holds when implementation starts** — the comments feature took SQLite to 5 / Postgres to 4 / D1 to 3, and the in-flight OIDC work may claim the next numbers first; the implementer verifies at build time and follows each backend's migration mechanics (probe + version, `Migrator.fromRecord` + `expectedHistory`, `upgradeFromVersionN` batch). Claim atomicity uses each backend's existing idiom: SQLite `#transaction`, Postgres `sql.withTransaction` + advisory lock, D1 `batch` with a `mutation_checks` guard (`state='queued'` predicate).

## 5. Access

One new capability: **`agent:connect`** — added to the closed capability sets in `src/core/identity.ts`, the HTTP key-issuance enum, the MCP principal schema, the web client enum, and the stored-capability enums in all three identity repositories (the comments build proved the last group is easy to miss). The local API token gains it (all-capability principal).

| Operation | Rule |
| --- | --- |
| Register, claim, report delivered/failed, disconnect | Service principal with `agent:connect` (or the local token). Direct humans are not agents. |
| Send a dispatch, cancel a dispatch | Direct human member, or a service principal with `artifact:manage:any`. No new send capability in v1. |
| List agents, list/read dispatches | Same authority as reading artifacts (`requireArtifactRead`): members and read-capable keys. Agents are not secrets; the picker needs them. |
| Everything | Installation must match; project must resolve; cross-project ids fail as not-found without disclosure; archived projects reject new dispatches and allow reads. |

The registry is installation-scoped (like members and keys); dispatches are project-scoped (they reference threads in exactly one project). A bundle may span artifacts within its project; it may never span projects.

## 6. Application service

`src/application/agent-dispatch.ts`, `AgentDispatchService`, same construction as `ArtifactCommentService` (Context.Service, `Layer.effect`, `Effect.fn`-named operations, Effect-wrapped repository, failures preserved through a classify function in the local layer). Operations: `registerAgent`, `disconnectAgent` (row deletion, best-effort), `listAgents` (liveness derived: connected = `lastSeenAt` within 90 s; stale rows lazily deleted), `createDispatch`, `claimDispatch` (single-shot; the HTTP adapter owns the long-poll loop around it), `reportDelivered`, `reportFailed`, `cancelDispatch`, `listDispatches`, `getDispatch`. New errors: `AgentNotFound` (404 `AGENT_NOT_FOUND`), `AgentDispatchNotFound` (404 `DISPATCH_NOT_FOUND`), `InvalidDispatch` (422 `INVALID_DISPATCH` — empty/oversized bundle, thread not open, thread already dispatched, cross-project thread), `DispatchStateConflict` (409 `DISPATCH_STATE_CONFLICT` — report or cancel against a state that forbids it, or a claim report from a non-holder). Wired into `errorCodes`, the failure schema union, the exhaustive HTTP failure switch, and the repository-failure operation literals, exactly as the comments feature did.

## 7. HTTP routes

All under `/api/v1`, existing conventions (`?projectId=` where project-scoped, `Idempotency-Key` on the send, cursor paging, `runHttpApplicationEffect`).

| Method and path | Auth | Contract |
| --- | --- | --- |
| `POST /agents` | `agent:connect` | One upsert by `connectionKey` **within the calling principal**, in which the agent **names itself**: `{connectionKey?, displayName, kind:"pi", workingDirectory, agentSessionId?}` → `200 {agent}`. Re-registration refreshes name, session id, and `lastSeenAt`; pending dispatches survive because the id is stable. Another principal presenting the same key registers its own separate agent and never reclaims this row or its queue. No other ceremony exists. |
| `POST /agents/:agentId/disconnect` | `agent:connect`, same principal | `204`, best-effort courtesy: deletes the row (dispatch history is unaffected — it snapshots the name). A crashed agent that never calls this simply goes stale. Idempotent. |
| `GET /agents` | read | `{items: [{…agent, connected: boolean}]}` (connected = seen within 90 s). Installation-scoped. Rows unseen for 7 days are deleted lazily on this read — disposable by design. |
| `POST /agent-dispatches` | human member / `manage:any` | Header `Idempotency-Key`; body `{projectId?, agentId, threadIds: string[], note?}` → `201 {dispatch, replayed}`. Validates and marks threads transactionally (section 3). Bundle bound: 1..100 annotations (comment threads) — aligned with `maximumCommentPageSize` and sized for the owner's send-all case; a worst-case bundle renders large (bodies are capped at 8 KiB each), which is Pi's context to manage, and the render bounds each quoted selection to 300 characters to keep the message proportionate. Replay by key returns the original. |
| `POST /agents/:agentId/claims?wait=` | `agent:connect` | Long-poll: returns the oldest queued dispatch for this agent (`200 {dispatch}`) or `204` after `wait` seconds (cap 25 — an over-cap `wait` is clamped, not rejected; served best-effort per deployment via bounded 1 s re-checks — the extension loops regardless, so a deployment that answers early is conformant). Claiming and reporting act only for the calling principal's own registered agents. Claiming sets `claimed` + a 5-minute lease. **One-active-claim rule:** while this agent holds a dispatch in `claimed`, the route returns `204` (Pi's own follow-up queue handles `delivered` FIFO, so delivered dispatches do not block the next claim). Every call bumps `lastSeenAt` — this is the heartbeat, at poll-request granularity: one held poll is one bump, stamped when the request arrives and refreshed again by a successful claim, while the bounded re-checks inside the held request write nothing (no heartbeat, no lease sweep) unless they find an expired lease to reclaim or a queued dispatch to claim. A healthy agent re-polls at least every 25 s, well inside the 90 s connected window, and an expired lease still redelivers within one held poll of a live claimer. |
| `POST /agent-dispatches/:id/delivered` | `agent:connect`, claim holder | Body `{agentId}` (the reporting agent; the server verifies the caller registered it). `claimed → delivered`. `200 {dispatch}`. |
| `POST /agent-dispatches/:id/failed` | `agent:connect`, claim holder | Body `{agentId, reason}`. → `failed`, markers cleared. |
| `POST /agent-dispatches/:id/cancel` | human member / `manage:any` | Only from `queued`/`claimed` → `canceled`, markers cleared. |
| `GET /agent-dispatches?projectId=&state=&agentId=&cursor=&limit=` | read | Keyset page, newest first. Lazy transitions (lease reclaim, `agent_unavailable` failure, `addressed` inference) are applied before shaping. |
| `GET /agent-dispatches/:id` | read | `{dispatch}` with the same lazy evaluation. |

**Comment-listing amendment (makes send consumptive):** `GET …/comments` and the `comment_list` MCP tool gain `dispatched=exclude|include|only` (default `exclude`). The default therefore hides dispatched threads from every existing surface with no client change; `only` powers the UI's "Sent" filter. `comment_get` on a dispatched thread still works (the agent reads it; deep links keep working). CMT-012's HTTP/MCP parity requirement extends to the new parameter.

## 8. The Pi bridge extension

Ships as a **distributable npm package and standard Pi extension**: workspace package **`integrations/pi/`** (added to `pnpm-workspace.yaml`, which today lists `.`, `apps/*`, `deploy/cloudflare`, `deploy/pulumi/*`), package name **`@artifact-server/pi-extension`** (matching `@artifact-server/web`).

- **Contents:** `index.ts` (the thin Pi-facing entry; `package.json` declares it under the `pi.extensions` key, the convention Pi's loader resolves for package extensions), `bridge-core.ts` (all logic, a pure library — the split serves both testing and packaging), `README.md`, `LICENSE`. The tarball ships TypeScript source — Pi loads extensions through jiti with no build step, the same raw-source precedent `@plannotator/ui` uses.
- **Install (standard Pi mechanisms only):** `pi install npm:@artifact-server/pi-extension` or settings.json `packages: ["npm:@artifact-server/pi-extension"]`; local development uses `pi -e integrations/pi/index.ts`. Nothing bespoke.
- **Versioning and compatibility:** the package version tracks Artifact Server releases (it is the client of this server's dispatch API); the README records the Pi extension-API range it is tested against (currently `@earendil-works/pi-coding-agent` 0.84.x) and the bridge fails soft on missing API surface (dormant + one notice, never a crash).
- **Publishing:** rides the repo's existing release process as one more publish step alongside the server artifacts; `VERIFY.md` (the live-Pi manual proof, section 10) stays in the repo directory, not the tarball.

**Configuration**, resolved once per `session_start`, in order: (1) env `ARTIFACT_SERVER_ORIGIN` + `ARTIFACT_SERVER_AGENT_TOKEN`; (2) local discovery — read `~/.artifact-server/local-service.json` (0600, loopback-only origin, already the local discovery contract) and `~/.artifact-server/local-api-token`. Optional `ARTIFACT_SERVER_AGENT_NAME` overrides the self-chosen display name (default: `basename(cwd)`). If no origin/credential resolves, the extension notifies once (`ctx.ui.notify`) and stays dormant. It never throws into Pi and never blocks a Pi event handler on the network.

**Lifecycle** (every Pi claim below is verified against Pi source or docs; citations in the research maps):

- `session_start`: resolve config → `POST /agents` upsert, self-naming (`displayName` = config override or `basename(cwd)`; `connectionKey` = sha256 of hostname + cwd, so restarts and `/new`/`/resume` reclaim the same agent id and its pending FIFO — the queue is the durable thing, the row is not) → start the claim loop. Started here and not in the factory, per Pi's documented rule for background work.
- Claim loop: `POST /agents/:id/claims?wait=25` → on `204`, loop; on a dispatch: render (below) → **hold if compaction is in progress** (tracked via `session_before_compact`/`session_compact`; Pi rejects prompts mid-compaction) → `pi.sendUserMessage(rendered, { deliverAs: "followUp" })` — always `followUp`, never `steer`, in both idle and busy states (idle starts immediately; busy queues until Pi finishes its current work; Pi's default one-at-a-time draining delivers exactly one bundle per work boundary, which is the owner's FIFO) → `POST …/delivered` → loop. Network errors back off 1 s → 30 s with jitter, fail-open: Pi continues normally with the backend away.
- Stale handle (`/reload`, `/new`, `/resume`, `/fork` invalidate captured `pi` handles, which then throw): the loop treats a stale-handle throw as its shutdown signal; the replacement instance's `session_start` re-registers and resumes. A dispatch injected but not yet reported `delivered` at that moment is redelivered after lease expiry — at-least-once, matching the comment system's documented posture.
- `session_shutdown`: abort the in-flight poll and fire a best-effort `POST /agents/:id/disconnect` — a crash that skips it costs nothing; the row just goes stale and is reaped.
- Delivery truthfulness: `pi.sendUserMessage` is fire-and-forget (the extension wrapper discards the promise and routes rejections to Pi's error channel), so `delivered` means "accepted into Pi's queue by a live handle" — the strongest signal available without transcript inspection. Residual risk documented, mitigated by the compaction hold and lease redelivery.
- Asynchronous host admission: the shared `HostPort.sendUserMessage` contract accepts `void | Promise<void>`. OpenCode awaits `promptAsync`; Claude awaits its channel notification. The bridge reports `delivered` only after that handoff resolves. An asynchronous rejection reports the dispatch `failed`, releases its comments, and leaves the loop running for later work. A synchronous throw remains the signal for an invalidated host handle and ends that loop. The bridge does not retry a rejected handoff because the host has no idempotency contract that can distinguish rejection from ambiguous admission.

**Bundle rendering** — one message, never starting with `/` (Pi intercepts slash-prefixed input as commands):

```
Artifact Server: {sender.displayName} sent {N} annotation(s) to address.
{note, when present}

1. [{artifact name} · version {number} · {path}] {quoted selection, when the anchor has originalText}
   {thread body}
   (thread {threadId})
2. …

When each item is done: use the artifact_comments tool to reply to its thread
with what you did, then resolve it. Do not wait for confirmation.
```

**The registered tool** — `pi.registerTool` name `artifact_comments`, operations `get_bundle {threadIds}` (each named thread with its replies, so one call reads a whole bundle), `reply {threadId, body}`, `resolve {threadId}`, wrapping the existing comment HTTP routes with the same credential. This closes the loop: the agent's replies and resolves land in the comment tables, resolution flips the dispatch to `addressed`, and nothing new is invented on the return path.


## 9. Web application

Consumptive send, per the owner:

- **Send controls:** a "Send to agent" action on each open annotation's card and — v1, owner decision — **"Send all open"** on a version (Comments tab version filter and the review panel header): thirty open annotations become ONE human-initiated send, split only at the server's 100-thread dispatch bound. Review does not support arbitrary multi-select bundles. Both actions use the same tier-aware agent control: connected agents with display name, working directory, and last-seen; disabled state when none are connected. Sending creates one idempotency key per dispatch and holds it across retries.
- **On success the annotations vanish** — lists refresh under the default `dispatched=exclude`, review pins disappear with them. No status chip, badge, or progress surface appears anywhere on the artifact surfaces.
- **The state filter gains "Sent"** (`dispatched=only`) so history is findable on demand. That view is where a queued/claimed/delivered dispatch can be canceled — cancel and failure are the single exception to "gone is gone": their threads reappear in the default views automatically because the server clears the markers.
- The loop finishes invisibly: the agent's resolves leave the threads hidden (resolved), and reopening a thread the agent got wrong is the existing reopen action.

## 10. Conformance and testing

New module `agent-dispatch` in `allowed_modules`; requirements `DSP-001…DSP-013`, entering as `specified` with empty evidence.

| ID | Kind | Behavior (short) | Failure test |
| --- | --- | --- | --- |
| DSP-001 | behavior | Agent registration is one self-naming upsert by connection key; listing derives liveness from claim polling; stale rows are reaped without touching dispatch history. | Re-registration with the same key keeps the id and pending dispatches; deleting a stale agent row leaves its dispatches intact and attributed; a foreign installation's key never appears. |
| DSP-002 | security | Register, claim, and report require `agent:connect`; humans and read-only keys are refused. | An `artifact:read` key cannot register or claim; a claim report from a non-holder is a state conflict. |
| DSP-003 | behavior | One send = one dispatch: ordered threads, same-project validation, 1..100 bounds, idempotent replay. | Cross-project, resolved, already-dispatched, or oversized bundles are rejected atomically — no partial markers. |
| DSP-004 | behavior | Dispatched threads leave default comment listings on HTTP, MCP, and web, and return under `dispatched=only`; `comment_get` still serves them. | A dispatched thread appears in no default list on any surface; the filter round-trips it. |
| DSP-005 | behavior | Claims are FIFO per agent with the one-active-claim rule; the long-poll returns a dispatch or an empty answer within the wait bound. | A second claim while one is `claimed` returns empty; two agents never receive the same dispatch. |
| DSP-006 | behavior | A claim lease expires back to `queued` and the dispatch is redelivered exactly once effectively. | A dead claimer's dispatch is reclaimable after the lease; no double-active claim exists at any point. |
| DSP-007 | behavior | State transitions are exactly the section-3 machine; terminal states are immutable. | Every illegal transition is a `DISPATCH_STATE_CONFLICT`; timestamps never regress. |
| DSP-008 | behavior | `addressed` is inferred when every bundle thread is resolved, and stamped once. | Resolving all-but-one thread does not address; unresolving is impossible (resolve/reopen flows through comments and reopen reverts nothing already stamped). |
| DSP-009 | behavior | Failure, cancel, and agent-unavailable auto-failure clear thread markers so the threads reappear. | After `failed`/`canceled`, default listings include the threads again; `addressed` clears nothing while its threads stay resolved, and reopening one returns it to the default listings and to the sendable set. |
| DSP-010 | security | Sending and canceling require a direct human member or `artifact:manage:any`; the agent token cannot send; cross-project ids fail without disclosure. | An `agent:connect`-only key cannot create or cancel a dispatch. |
| DSP-011 | behavior | The bridge core renders a bundle to the specified template (no leading slash, ordered items, tool instruction) and always injects with `followUp`. | A rendered message never begins with `/`; no code path passes `steer` or omits `deliverAs`. |
| DSP-012 | behavior | The bridge core claim loop is fail-open: dormant without configuration, bounded backoff on errors, never propagates an exception into the host. | Backend-down and stale-handle scenarios end the loop or back off without a throw reaching the host contract. |
| DSP-013 | behavior | Delivery waits for host admission. An asynchronous refusal fails only that dispatch and the loop remains available for later work. | A pending handoff remains claimed; rejection returns its comments to the open list; a later dispatch succeeds without restarting the bridge. A synchronous invalidated handle still ends the loop. |

**Testing seam, per repo rules (no module mocks):** DSP-001..010 are conformance tests over the real HTTP app with a plain fetch "fake agent" client — the same real-boundary style as the CMT suite. DSP-011..013 test the published bridge package through an injected `HostPort` against the real HTTP server. OpenCode also runs through a structurally accurate fake plugin context against that server, including a target session deleted while `promptAsync` is pending. These are constructor-injected ports, not module interception. What only a live host proves stays in its adapter verification layer:

1. **`integrations/pi/VERIFY.md`** — the scripted manual pass, kept because the owner runs it personally; recorded as manual evidence, never claimed by the ledger.
2. **`test:pi-live`** — an automated end-to-end suite (separate script like `test:oidc`, NOT part of `verify:iteration` until proven stable) built on the owner's `@plannotator/webtui` (github.com/plannotator/webtui): it runs a real coding agent in a PTY via node-pty with programmatic session control (`createAgentTerminalSession`, `session.sendAgentMessage`, WebSocket-readable output). The suite boots a real Artifact Server on a temp data dir, spawns a REAL `pi` process with the bridge loaded (`pi -e integrations/pi/artifact-server.ts`), and asserts the live-only behaviors: (a) the full round trip — publish, comment, send a bundle while Pi is mid-task, Pi receives it only after its current work finishes, the `artifact_comments` tool replies and resolves, the dispatch reads `addressed`; (b) one-bundle-per-work-boundary drain order across three queued bundles; (c) the compaction hold; (d) `/resume` re-registration reclaiming the same agent id. Honest caveats: webtui is early-stage (a young repo, ~17 commits) and may need a Pi agent-config contribution before it can drive `pi`; PTY-driven agents are timing-sensitive, which is exactly why this suite stays out of the required gate until it has a flake-free track record.

## 11. Scope fences

No transcript mirroring into Artifact Server. No WebSockets or SSE (the mailbox is transport-neutral; long-poll is the v1 transport). No agents other than Pi; `kind` stays a closed one-value set. No MCP anywhere in the Pi path (Pi has no MCP client, by its own design). No steering, ever — `followUp` is the only delivery mode the bridge may use. No changes to Pi's queue settings. No new notification products (email, Slack, browser push). No local annotation files in v1 — the database, kept-forever dispatches, and the "Sent" filter are the durable record; a user-facing export of annotations to files may come later as its own feature, and nothing in v1 depends on it.

## 12. Acceptance walk-through

1. Pi starts in a repo; the extension registers → `GET /agents` lists "pi · ~/work/site" as connected.
2. The human opens the review view, pins two annotations, and clicks "Send all open" to the Pi session. The two pins and cards vanish. A reviewer who wants to send only one uses that annotation card's Send action instead.
3. Pi is mid-task. The extension claims the dispatch (long-poll), injects one two-item message with `followUp`, reports delivered. Pi finishes its current work, receives the bundle, edits the artifact source, replies to both threads via `artifact_comments`, publishes, resolves both.
4. The dispatch reads `addressed`; the threads are resolved; the default views show nothing — the loop closed with zero further human actions.
5. The human sends bundle B and then bundle C while Pi works on A's follow-up. B and C sit queued in Artifact Server (one-active-claim), then drain strictly in order, one work-boundary each.
6. The human quits Pi with bundle D queued. Fifteen minutes later the dispatch reads `failed (agent_unavailable)` and D's annotations are back on screen. Nothing was lost.

## 13. Confidence notes: verified vs assumed

Verified (citations in `scratchpad/pi-maps/*` and the current tree): every Pi behavior relied on — `sendUserMessage` signature and idle/streaming semantics, `followUp` drain point and one-at-a-time default, the streaming-without-`deliverAs` throw, fire-and-forget wrapper, background-work lifecycle rules, stale-handle invalidation on `/reload`/`/new`/`/resume`/`/fork`, per-handler exception containment, slash-command input interception, `session_start`/`session_shutdown` contract, `registerTool`/`ctx.ui` surfaces, and the shipped `git-merge-and-resolve.ts` example that injects `followUp` from an external condition. On the Artifact Server side: comment route shapes and filters, the closed capability enums and their five addition sites, idempotency mechanics, no existing push primitives, local discovery files (`local-service.json`, `local-api-token`), CSP forbidding browser-to-bridge connections, and the three backends' transaction idioms.

Additionally verified for the owner's amendments: `github.com/plannotator/webtui` exists and is active ("agent tui in a web gui", pushed 2026-08-18), and this repo's workspace layout (`pnpm-workspace.yaml`: `.`, `apps/*`, `deploy/cloudflare`, `deploy/pulumi/*`) plus Pi's package-extension loading convention (`package.json` `pi.extensions[]`, settings.json `packages[]`, `pi install npm:…`) support `integrations/pi/` as a publishable workspace member.

Assumed, to confirm at build time: exact schema version numbers after the in-flight OIDC work lands; Pi's `registerTool` schema convention (TypeBox/zod specifics — read `types.ts` at implementation); that a 25 s held request is acceptable on the Cloudflare worker (the contract already permits early return, so the fallback is a shorter server-side wait); empirical `/resume` re-registration order (source-verified, not yet executed — VERIFY.md and `test:pi-live` prove it); webtui's actual API surface and whether driving `pi` needs an upstream agent-config addition (repo not vendored locally; verified existence only).

## 14. Decisions recorded (owner, August 18, 2026)

1. **Retention: keep dispatch history forever** — it is the audit trail. The local-annotation-files idea was considered and **reversed the same day** (owner, 2026-08-18): the database already stores every annotation, so per-bundle markdown files are too much for v1; files cut, DB retention stands, a user-facing annotation export may come later as its own feature.
2. **"Send all open on this version" ships in v1.** Thirty annotations, one click, one bundle, one message. The bundle bound is 1..100 threads accordingly.
3. **Testing: both layers.** VERIFY.md stays as the owner-run manual pass, and an automated live-Pi suite (`test:pi-live`, section 10) is specified on `@plannotator/webtui`, kept out of `verify:iteration` until it proves flake-free.
