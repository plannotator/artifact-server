---
name: publish-artifact
description: Publish and manage files, finished client-side sites, and immutable versions with Artifact Server. Use when the user asks to publish or update a local file or directory; list, open, tag, share, compare, restore, or delete an Artifact Server artifact; manage an Artifact Server project; or provides an Artifact Server link. Use the CLI for files on the user's machine and MCP for work that only needs server data. Do not use for installing, deploying, upgrading, reconfiguring, backing up, restoring, repairing, or deleting an Artifact Server installation.
---

# Publish Artifact

Artifact Server stores and serves finished files and websites that run entirely
in a browser. A person or agent publishes one file or one finished website and
gets a browser link. That published item is an artifact. It belongs to a
project, and publishing it again creates a new saved version without changing
the earlier versions. Opening an artifact can require an account or use a
public link. Artifact Server may run on the user's computer or on a server
managed by a team. It serves files as published; it does not build source code
or run backend code for an artifact.

Use this skill to perform the user's artifact task without making them choose
between the CLI and MCP. Choose the adapter from where the required files exist.

## Keep these boundaries

- Use `artifactserver publish` when a source or destination is a local file or directory.
- Use the connected Artifact Server MCP for reads and changes that need only server data.
- Never send inline HTML, CSS, JavaScript, base64, or invented file content as a substitute for a real file.
- Never give a remote MCP server a local path and claim it uploaded the file.
- Never read, print, request, or write bearer tokens, API keys, cookies, or refresh tokens.
- Keep public sharing off unless the user explicitly requests it.
- Do not install, deploy, upgrade, reconfigure, back up, restore, repair, or delete an Artifact Server installation. Those are operator tasks.

## Run the workflow

1. Identify the requested action and whether it needs a local path.
2. Resolve the server and project using [target selection](references/target-selection.md). Ask one short question if the target remains ambiguous.
3. For a local path, confirm it exists and invoke the installed `artifactserver` CLI. Let the CLI inspect, hash, upload, retry, and commit the files.
4. For server-only work, use the connected MCP tools. Call `artifact_capabilities` first when installation behavior or limits affect the action.
5. Before updating or mutating an existing artifact, call `artifact_get` and use its current version ID as the optimistic guard.
6. For each MCP mutation, create one new opaque idempotency key. Reuse that key only when retrying the exact same input.
7. Verify success from the structured CLI or MCP result. Never infer success from a started request.
8. Return the server, project ID, artifact ID, exact version ID, browser link, and access setting when the operation supplies them.

Read [routine operations](references/routine-operations.md) for exact CLI and MCP routing. Read [failures and compatibility](references/failures-and-compatibility.md) only when an operation fails, a client cannot open a link, or the installed server lacks an expected capability.

## Publish a local file or finished site

Use one CLI command. Quote the path and pass the resolved target explicitly when it did not come from the user's default profile.

```sh
artifactserver publish "<path>" --profile "<profile>" --server "<origin>" --project "<project-id>"
```

Omit flags that are genuinely unresolved or unnecessary. For a new artifact, add only the options the user requested:

```sh
--name "<name>" --tag "<tag>" --public --entry "<relative-entry-file>"
```

The default is account-required access. `--public` means anyone who can reach that Artifact Server and has the link can open the artifact without signing in; it does not put a private server on the internet.

To publish a new version, first obtain the current version ID, then run:

```sh
artifactserver publish "<path>" --profile "<profile>" --server "<origin>" --project "<project-id>" --artifact "<artifact-id>" --expected-version "<current-version-id>"
```

Do not pass `--name`, `--tag`, or `--public` when publishing a new version. Change tags or sharing separately through MCP.

## Open an artifact

Call `artifact_open` with the artifact ID, project ID, and exact version ID when the user named one. Use the returned browser URL.

- If the client can open URLs on the user's machine and the user asked to open it, open that URL there.
- Otherwise, return the URL.
- Never attempt to launch a browser on the Artifact Server machine.

## Report the result

Keep the response short and concrete:

```text
Published
Server: <origin>
Project: <project-id>
Artifact: <artifact-id>
Version: <version-id>
Link: <browser-url>
Access: Account required | Public link
```

Use `Updated`, `Opened`, `Compared`, `Restored`, or the actual completed action instead of `Published` when appropriate. State what blocked the action and what the user must do next if it did not complete.
