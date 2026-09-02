# Claude Code live feedback

Connect a Claude Code session to Artifact Server through
[Claude Code Channels](https://code.claude.com/docs/en/channels-reference).
Reviewers can send open comment threads to the session. Claude receives the
threads, completes the work, replies, and resolves them in Artifact Server.

## Current support

Claude Code Channels are a research preview. Custom channels require a
development flag. Team and Enterprise administrators must also enable the
`channelsEnabled` organization policy.

The Artifact Server channel is currently available from a source checkout.
The npm package is not published yet.

## Before you start

Before you start, make sure that:

- Artifact Server is running.
- The Artifact Server source is available locally.
- Node.js 24.12.0 or later is installed.
- pnpm 10.34.3 is installed.
- Claude Code supports Channels.

From the Artifact Server source directory, install the dependencies:

```bash
pnpm install
```

## Connect to Artifact Server

### Local installation

If `artifactserver start` runs the server, the channel reads the connection
from these files:

- `~/.artifact-server/local-service.json`
- `~/.artifact-server/local-api-token`

No additional connection settings are necessary.

If `pnpm dev` runs the server from source, set the origin and token in the
shell that starts Claude Code:

```bash
export ARTIFACT_SERVER_ORIGIN="http://127.0.0.1:8787"
export ARTIFACT_SERVER_AGENT_TOKEN="$(<.artifact-server/local-api-token)"
```

Run these commands from the Artifact Server source directory. Do not print or
commit the token.

### Team installation

Ask an Artifact Server administrator to issue an API key with these
permissions:

- **Connect agents**
- **Manage comments**

Set the server origin and API key in the shell that starts Claude Code:

```bash
export ARTIFACT_SERVER_ORIGIN="https://artifacts.example.com"
export ARTIFACT_SERVER_AGENT_TOKEN="replace-with-the-api-key"
```

Do not add the API key to `.mcp.json` or source control.

You can also set `ARTIFACT_SERVER_AGENT_NAME` to change the session name that
appears in Artifact Server. The default name is the current directory name.

## Add the channel to Claude Code

Add this entry to `.mcp.json` in the project where you use Claude Code:

```json
{
  "mcpServers": {
    "artifact-server": {
      "command": "node",
      "args": [
        "/absolute/path/to/artifact-server/integrations/claude-channel/bin/claude-channel.js"
      ]
    }
  }
}
```

Replace the example path with the absolute path to your Artifact Server
checkout.

## Start Claude Code

Start Claude Code from the project that contains `.mcp.json`:

```bash
claude --dangerously-load-development-channels server:artifact-server
```

Claude Code shows a warning for the development channel. Select **I am using
this for local development**. If Claude Code also asks whether to use the MCP
server, select **Use this MCP server**.

## Send comments to Claude

1. Open an artifact in Artifact Server.
2. Add one or more comments.
3. Select the Claude session in the agent picker.
4. Send the open comments to the session.

Claude receives the comments as follow-up work. The channel gives Claude the
`artifact_comments` tool to read, reply to, and resolve each thread.

## Troubleshooting

If the channel does not start, run `/mcp` in Claude Code. Make sure that the
server entry uses the correct absolute path.

If Claude Code reports that an organization policy blocked the channel, ask
an administrator to enable `channelsEnabled`.

If the channel starts but no agent appears in Artifact Server, make sure that
Artifact Server is running. Then make sure that the connection settings are
available in the shell that started Claude Code.

If `MCP_PROTOCOL_NEGOTIATION=auto` is set, Claude Code can reject the MCP
version of the channel. Unset the variable. Then restart Claude Code.

Claude Code writes channel errors to
`~/.claude/debug/<session-id>.txt`.
