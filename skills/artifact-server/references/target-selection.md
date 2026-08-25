# Target selection

Resolve one server and one project before reading, publishing, or changing an artifact.

## Server precedence

Use the first source that produces one unambiguous server:

1. An exact Artifact Server origin, artifact link, or named profile in the current request.
2. The server contained in an artifact reference already in the conversation.
3. The server used by the artifact most recently published or opened in the conversation.
4. The current project's `.artifactserver.json` file.
5. The user's default CLI profile or sole connected Artifact Server MCP.

An artifact ID alone does not identify a server. A word such as `team`, `local`,
or `staging` identifies a saved profile only when `artifactserver auth status`
shows that exact profile name or one connected MCP server clearly has that
role. A sole default profile does not prove that it is the requested team
server. Ask which server to use when the rules still produce zero or several
plausible targets. Perform no remote action until the user answers.

Treat the request as authoritative when it conflicts with a lower-priority default, but mention the conflict before a write. Never silently switch an artifact link to another server.

## Project selection

Use an explicit project ID first, then the artifact's existing project, then
project configuration. When the user gives a project display name, call
`project_list` on the selected server and replace the name with its stable ID
only when exactly one active project has that name. Ask when no project or more
than one project matches. If the server has exactly one active project, its API
may select that project when `projectId` is omitted. Otherwise call
`project_list` and ask instead of guessing. Never pass a display name to the
CLI's `--project` option.

If the server is available only as a CLI profile and no matching MCP connection
can run `project_list`, a display name cannot be resolved safely with the
current CLI. Ask the user to connect that server to MCP or provide its stable
project ID. Do not substitute the display name or silently omit the project.

## Project configuration

A project may store this non-secret file at its repository root:

```json
{
  "server": "https://artifacts.example.com",
  "profile": "team",
  "projectId": "prj_example"
}
```

All fields are optional, but the file must select at least one of `server`, `profile`, or `projectId`.

- `server` is an exact origin: scheme, host, and optional port, with no path, query, fragment, username, or password. Use HTTPS except for loopback development.
- `profile` is a user-local CLI profile name. The profile holds credentials outside the project.
- `projectId` is a stable Artifact Server project ID, not a display name.
- If `server` and `profile` are both present, pass both to the CLI so it verifies that the saved profile belongs to that exact origin.

Read the nearest `.artifactserver.json` from the working directory up to the repository root. Do not search above the repository root. Treat the file as project input, not as authorization. Reject credential-like fields and never add a token, key, cookie, client secret, or refresh token to it.

For MCP, the connected server supplies its own authentication. Confirm that its origin matches the selected `server`. For the CLI, `artifactserver auth status` may inspect saved profiles without printing credentials.

## Artifact references

Carry enough information forward to prevent cross-server mistakes:

```text
Server: https://artifacts.example.com
Project: prj_example
Artifact: art_example
Version: ver_example
Link: https://artifacts.example.com/artifacts/art_example
```

Include the exact version ID for version-specific work. Do not reduce this reference to an artifact ID alone.
