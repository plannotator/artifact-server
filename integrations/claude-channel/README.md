# @artifact-server/claude-channel

The Artifact Server bridge for [Claude Code
channels](https://code.claude.com/docs/en/channels-reference). Claude Code
spawns this process over stdio; it runs the same claim loop as the Pi bridge
(the long poll is the heartbeat, so presence is real), pushes each dispatched
annotation bundle into the opted-in session as a
`notifications/claude/channel` event, and exposes the `artifact_comments`
tool so Claude replies to and resolves each thread.

## Evidence tier

This bridge registers with `capabilities: {beacon: true, evidence:
"channel"}`. `delivered` means the notification was written to the
transport — admission to the session, not model processing. Claude Code
queues channel events while the session is busy, which matches the bridge's
follow-up-only delivery rule.

## Configuration

Same resolution as the Pi extension, once at start:

| Source | Setting |
| --- | --- |
| Environment | `ARTIFACT_SERVER_ORIGIN` + `ARTIFACT_SERVER_AGENT_TOKEN` |
| Environment | `ARTIFACT_SERVER_AGENT_NAME` (optional display name) |
| Local discovery | `~/.artifact-server/local-service.json` + `local-api-token` |

Nothing resolved → one stderr notice, then dormant.

## Try it (research preview)

Channels are a research preview; custom channels run behind a development
flag. From a project directory:

1. Add the channel to that project's `.mcp.json`:

   ```json
   {
     "mcpServers": {
       "artifact-server": {
         "command": "npx",
         "args": ["tsx", "/path/to/artifact-server/integrations/claude-channel/index.ts"]
       }
     }
   }
   ```

2. Start the local Artifact Server (`pnpm dev` in this repository, or a
   packaged `artifactserver start`).

3. Launch Claude Code with the development bypass for this entry:

   ```bash
   claude --dangerously-load-development-channels server:artifact-server
   ```

4. In the Artifact Server web UI: comment on an artifact and Send to agent —
   the session appears in the picker as a `claude`-kind agent with live
   presence. The bundle lands in the Claude session as a
   `<channel source="artifact-server">` event; Claude replies and resolves
   through `artifact_comments`, and the threads update in the web UI.

The `channelsEnabled` organization policy still applies; the flag bypasses
only the allowlist.

## Tested

`tests/client/claude-channel.test.ts` drives this process over real stdio
MCP against a real spawned server: channel-tier registration, one
notification per bundle (sanitized), `delivered` on transport admission,
and reply/resolve through the tool to `addressed`.
