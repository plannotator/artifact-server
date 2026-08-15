# Failures and compatibility

Stop on uncertainty. Do not turn a failed or partial request into a success report.

## Authentication

- Inspect CLI profiles with `artifactserver auth status`; it does not print credentials.
- If a remote CLI profile is missing, ask the user to run `artifactserver auth login <server>` or guide them through that browser flow. Do not ask them to paste a token into chat.
- If a self-hosted server uses an administrator-issued API key, the human stores it through `artifactserver auth login <server> --api-key-stdin`. Do not type or echo the key for them.
- If MCP is disconnected, tell the user to connect the selected Artifact Server. Do not fall back to an unrelated server.

## Target and project failures

- If an artifact link, named profile, project config, and conversation context disagree, use the explicit current request and confirm before a write.
- If no exact server is selected, ask local or team and do nothing else.
- If more than one active project exists and no project is selected, call `project_list` and ask.
- If the user supplies only a project display name but the selected server has no connected MCP, ask for the stable project ID or ask them to connect MCP. The current CLI cannot list projects.
- If `.artifactserver.json` contains credentials or a server URL with a path, query, fragment, or embedded credentials, reject the file as unsafe project configuration.

## Publication failures

- Missing or unreadable path: report the exact path and stop.
- Unsupported symlink or unsafe path: preserve the CLI's explanation; do not dereference or copy around the check.
- Stale current version: fetch the new current version with `artifact_get`, explain that another publisher won the race, and ask before retrying with the user's bytes.
- Interrupted upload: rerun the same CLI command. Let the CLI create or resume safe transfer work; do not manually replay upload URLs.
- Expired upload instructions: rerun publication so the CLI obtains a new upload plan. Artifact versions themselves do not expire.
- Integrity failure: report the expected and observed size or fingerprint from the CLI result and stop.

## Client behavior

- A local or desktop client may open the URL returned by `artifact_open` on the user's computer.
- A remote agent that cannot launch a user browser returns the URL.
- A remote-only agent cannot read a file that exists only on the user's machine. Ask the user to run the local CLI or move the task to an agent with filesystem and process access.

## Older or incompatible installations

1. Inspect `artifactserver --version` and `artifactserver publish --help` for CLI work.
2. Call `artifact_capabilities` for MCP work when available.
3. Use only commands and tools the installed release advertises.
4. Do not fall back to inline content, base64, guessed tools, or a legacy transport.
5. If the required operation is unavailable, state the missing capability and stop. Route an explicit upgrade request to server operations rather than performing it through this skill.
