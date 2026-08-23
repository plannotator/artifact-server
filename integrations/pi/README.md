# @artifact-server/pi-extension

The Artifact Server bridge for the [Pi coding agent](https://pi.dev). It
connects a live Pi session to an Artifact Server installation so that
annotation bundles sent from the review UI arrive in Pi as follow-up work,
and Pi replies to and resolves each comment thread through the
`artifact_comments` tool.

## What it does

- Registers this Pi session as an agent (`POST /api/v1/agents`), self-named
  after the working directory. Restarts, `/new`, and `/resume` reclaim the
  same agent identity, so pending bundles survive.
- Long-polls the dispatch mailbox (`POST /api/v1/agents/:id/claims?wait=25`).
  Each claimed bundle is rendered as one message and injected with
  `pi.sendUserMessage(text, {deliverAs: "followUp"})` — always follow-up
  delivery, never steering: Pi finishes its current work first, then receives
  exactly one bundle per work boundary.
- Holds delivery while the session is compacting, and reports `delivered`
  only after Pi accepted the message.
- Registers the `artifact_comments` tool with `get_bundle`, `reply`, and
  `resolve` operations wrapping the comment HTTP routes with the same
  credential, so the agent can close the loop without any human action.
- Fails open. Without configuration it stays dormant after one notice. With
  the server unreachable it backs off between 1 s and 30 s and Pi continues
  normally. No bridge failure is ever thrown into Pi.

## Install

```bash
pi install npm:@artifact-server/pi-extension
```

or in `settings.json`:

```json
{
  "packages": ["npm:@artifact-server/pi-extension"]
}
```

For development inside this repository:

```bash
pi -e integrations/pi/index.ts
```

## Configuration

Resolved once per session start, in order:

| Source | Setting | Meaning |
| --- | --- | --- |
| Environment | `ARTIFACT_SERVER_ORIGIN` | Server origin, e.g. `https://artifacts.example.com`. Used together with the token below. |
| Environment | `ARTIFACT_SERVER_AGENT_TOKEN` | Bearer credential. Needs `agent:connect` plus comment read/write for the tool; the local API token carries everything. |
| Environment | `ARTIFACT_SERVER_AGENT_NAME` | Optional display-name override (default: the working directory's basename). |
| Local discovery | `~/.artifact-server/local-service.json` | The managed local server's discovery record (loopback origin). |
| Local discovery | `~/.artifact-server/local-api-token` | The local installation's private API credential. |

If neither source resolves, the extension notifies once and stays dormant for
the session. It never blocks a Pi event handler on the network.

## Compatibility

- Pi extension API: tested against `@earendil-works/pi-coding-agent` 0.84.x.
  The bridge fails soft on missing API surface (dormant plus one notice,
  never a crash).
- The package version tracks Artifact Server releases; it is a client of the
  server's dispatch API (`spec/agent-dispatch-spec.md`).
- Ships TypeScript source; Pi loads extensions through jiti with no build
  step.
