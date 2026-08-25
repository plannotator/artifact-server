# Connect AI agents with MCP

Artifact Server exposes one MCP endpoint at `POST /mcp`. MCP uses the same product operations and permissions as the CLI and HTTP API.

## Connect a local client

Run the automatic connection command:

```sh
artifactserver connect
```

If more than one supported client is installed, select one client:

```sh
artifactserver connect codex
artifactserver connect claude
artifactserver connect cursor
artifactserver connect vscode
```

Inspect or remove a managed connection:

```sh
artifactserver doctor codex
artifactserver disconnect codex
```

The command registers a local stdio bridge. The bridge starts or locates the local service and handles its private credential.

The credential does not appear in client configuration, command output, or startup logs.

## Connect to a team server

Add the exact MCP address to the client:

```text
https://artifacts.example.com/mcp
```

The client opens the configured identity provider. Complete browser authorization, then return to the client.

The access token is valid for that exact `/mcp` resource. A token for another installation or application resource does not qualify.

## Publish from an agent

MCP sends metadata and small results. Artifact files use the staged upload API.

An agent uses this sequence:

1. Call `artifact_capabilities` to read limits and available features.
2. Call `artifact_create_upload` with each path, size, media type, and SHA-256 fingerprint.
3. Upload each file to its returned opaque upload URL.
4. Call `artifact_commit_upload` with the publication target and idempotency key.

When the agent publishes a new version, it first reads the current version ID. It sends that ID as `expectedCurrentVersionId`.

## Use the publication result

Every successful publication returns structured data and a short text summary.

```json
{
  "links": {
    "review": "https://artifacts.example.com/review?...&view=focus",
    "artifact": "https://artifacts.example.com/artifacts/art_example",
    "version": "https://ver-example.content.example.com/"
  }
}
```

The server instructions tell the agent to share `links.review` first. This link opens the exact version full screen with comments.

`links.artifact` follows the current version. `links.version` opens the immutable raw artifact without the Artifact Server interface.

The agent must not place bootstrap URLs, access tokens, or credentials in chat.

## Tool groups

| Group | Tools |
| --- | --- |
| Discovery | `artifact_capabilities` |
| Projects | `project_list`, `project_create`, `project_rename`, `project_archive`, `project_unarchive` |
| Artifacts | `artifact_list`, `artifact_get`, `artifact_open`, `artifact_version_list`, `artifact_diff` |
| Publication | `artifact_create_upload`, `artifact_commit_upload` |
| Management | `artifact_set_visibility`, `artifact_set_tags`, `artifact_restore_version`, `artifact_delete` |
| Comments | `comment_list`, `comment_get`, `comment_create`, `comment_reply`, `comment_update`, `comment_resolve`, `comment_delete` |
| Git history planning | `project_git_history_status`, `project_git_history_estimate` |

Linked-artifact tools appear only when the deployment enables linked artifacts.

`project_set_git_history` enables one project only after an authorized caller confirms a fresh estimate. Provider configuration alone copies nothing. Agents should report the returned project state and must not describe `waiting`, `degraded`, or `budget-limited` history as ready.

## Install the Artifact Server skill

Install the portable Agent Skill:

```sh
npx skills add plannotator/artifact-server
```

The skill routes artifact work and explicit server-administration work to separate internal instructions. It uses the CLI for files on the developer machine and MCP for server data and agent-held context.

In clients that expose installed skills as slash commands, publish finished work with a request such as:

```text
/artifact-server upload that HTML design doc
```

The agent returns the full-screen review link first so the recipient can view and comment on the exact version.

Read the [MCP product baseline](../project/spec/artifact-server-mcp-baseline.md) for the protocol and authorization contracts.
