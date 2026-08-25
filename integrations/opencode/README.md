# @artifact-server/opencode-extension

The Artifact Server bridge for [OpenCode](https://opencode.ai). It connects
an OpenCode instance to an Artifact Server installation so that annotation
bundles sent from the review UI arrive in the active OpenCode session as
follow-up prompts, and the agent replies to and resolves each comment thread
through the `artifact_comments` tool.

## What it does

- Registers this OpenCode instance as an agent (`POST /api/v1/agents`,
  kind `opencode`, capabilities `{beacon: true, evidence: "native"}`),
  self-named after the project directory. Restarts reclaim the same agent
  identity, so pending bundles survive.
- Long-polls the dispatch mailbox (`POST /api/v1/agents/:id/claims?wait=25`).
  Each claimed bundle is rendered as one message and injected with
  `client.session.promptAsync` into the most recently active top-level
  session — follow-up delivery, never steering or interrupt: OpenCode
  queues the prompt server-side and the running loop picks it up at its
  next work boundary. Subagent (task) sessions are never targeted.
- Holds delivery while no top-level session exists yet or while the target
  session is compacting (`experimental.session.compacting` hook, cleared by
  the `session.compacted` event, bounded at five minutes).
- Registers the `artifact_comments` tool (`get_bundle`, `reply`, `resolve`)
  through OpenCode's plugin tool hook, wrapping the comment HTTP routes with
  the same credential, so the agent closes the loop without human action.
- Sends the best-effort activity beacon at the natural work boundaries
  (bundle accepted → thinking, first reply → replying, last thread
  resolved → idle).
- Fails open. A plugin context without the expected surface, or no resolved
  configuration, leaves the bridge dormant; an unreachable server only
  produces bounded backoff (1–30 s). No bridge failure is ever thrown into
  OpenCode. Notices go through `client.tui.showToast` and are dropped
  silently on headless hosts.

## Install

Add the package to your OpenCode config:

```json title="opencode.json"
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["@artifact-server/opencode-extension"]
}
```

For development inside this repository, copy or symlink `index.ts` into a
plugin directory (`.opencode/plugins/` or `~/.config/opencode/plugins/`)
with `@plannotator/agent-bridge` and `zod` resolvable (see OpenCode's
plugin-dependency docs).

## Configuration

Resolved once when the plugin loads, in order:

| Source | Setting | Meaning |
| --- | --- | --- |
| Environment | `ARTIFACT_SERVER_ORIGIN` | Server origin, e.g. `https://artifacts.example.com`. Used together with the token below. |
| Environment | `ARTIFACT_SERVER_AGENT_TOKEN` | Bearer credential. Needs `agent:connect` plus comment read/write for the tool; the local API token carries everything. |
| Environment | `ARTIFACT_SERVER_AGENT_NAME` | Optional display-name override (default: the project directory's basename). |
| Local discovery | `~/.artifact-server/local-service.json` | The managed local server's discovery record (loopback origin). |
| Local discovery | `~/.artifact-server/local-api-token` | The local installation's private API credential. |

If neither source resolves, the bridge notifies once (when a TUI is
attached) and stays dormant.

## Pinned OpenCode version

Coded and verified against the OpenCode source at version **1.18.18**
(`@opencode-ai/plugin` 1.18.18, repository commit `ad905f8e6c`, dev branch,
2026-08-18), using the **V1 plugin API** (`(input) => Promise<Hooks>`). A
beta V2 plugin API (`@opencode-ai/plugin/v2/*`) exists at that commit; this
adapter deliberately pins V1, the API OpenCode loads for plain exported
plugin functions.

## Verified vs. assumed

Verified by reading the pinned source:

- Plugins load in-process and receive `client`, an SDK client bound to the
  same OpenCode server instance that backs the TUI.
- `client.session.promptAsync` (`POST /session/:id/prompt_async`) answers
  204 once the prompt is accepted; while the session is busy the appended
  user message is picked up at the running loop's boundary — real
  follow-up semantics. Interrupt would be `session.abort`; this bridge
  never uses it, and steering is not claimed.
- Plugins register model-callable tools through the `tool` hook (zod
  argument shapes converted to JSON Schema by OpenCode's tool registry),
  so `artifact_comments` is a native tool — no MCP fallback needed.
- `client.tui.showToast` exists as the notification surface.
- Compaction is observable via the `experimental.session.compacting` hook
  and the `session.compacted` event.

Assumed (recorded honestly, not proven against a live OpenCode):

- Cross-instance zod interop: this package ships zod `4.4.3` argument
  schemas; OpenCode composes them with its own zod (`4.1.8` at the pinned
  commit) through the `_zod` protocol. This is the standard path for every
  npm plugin, but it is not executed by this repository's tests.
- `delivered` is reported once the injection request has been handed to
  `promptAsync`; the port's injection contract is synchronous, so a
  rejected injection can only surface a warning toast afterward. The
  at-least-once lease posture bounds the cost of that gap.
- The `experimental.*` hook names are marked experimental by OpenCode and
  may change in later versions; the bridge degrades to "no compaction
  hold" if they stop firing.
- No live OpenCode smoke test exists here: the adapter is proven through a
  fake plugin context driving the real bridge core against a real spawned
  Artifact Server (`tests/client/opencode-bridge.test.ts`).

## Compatibility

- The package version tracks Artifact Server releases; it is a client of
  the server's dispatch API (`project/spec/agent-dispatch-spec.md`).
- Ships TypeScript source; OpenCode loads plugins with Bun, no build step.
