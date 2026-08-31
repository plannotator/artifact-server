# Artifact operations

Use the CLI for local files and MCP for server-only work. Both enforce the same Artifact Server permissions. Invoke the installed `artifactserver` program normally. Inside the Artifact Server source checkout, use `pnpm artifactserver` when the installed program is unavailable.

## CLI publication

Inspect the installed command when compatibility is uncertain:

```sh
artifactserver --version
artifactserver publish --help
artifactserver auth status
```

The publish command always returns structured JSON. Do not add a `--json` flag.

### Create an artifact

```sh
artifactserver publish "<path>" --profile "<profile>" --server "<origin>" --project "<project-id>" --name "<name>"
```

Optional creation flags are repeatable `--tag`, `--public`, and `--entry`. Account-required access is the default.

### Publish a new version

Obtain `artifact.currentVersionId` with `artifact_get`, then run:

```sh
artifactserver publish "<path>" --profile "<profile>" --server "<origin>" --project "<project-id>" --artifact "<artifact-id>" --expected-version "<current-version-id>"
```

The CLI owns local file inspection, symlink policy, media types, SHA-256 hashing, upload planning, transfer retries, and commit verification. Do not reproduce those steps in a skill script.

## MCP reads

- `artifact_capabilities`: inspect limits, sharing modes, project rules, and deployment mode.
- `project_list`: resolve a project when more than one exists.
- `artifact_list`: list artifacts; use `projectId`, exact `tag`, cursor, and bounded limit when relevant.
- `artifact_get`: obtain current metadata, manifest, current version ID, tags, access, `current.links.review` for exact full-screen Review, and `links.artifact` for moving latest in one call.
- `artifact_open`: obtain `reviewUrl` for exact full-screen Review and `browserUrl` for raw immutable content for the current or an exact saved version. Prefer `reviewUrl` for human handoff. Never describe `browserUrl` as Review.
- `artifact_version_list`: list immutable versions newest first.
- `artifact_diff`: compare two exact version IDs.

Prefer `artifact_get` over several discovery calls when the artifact ID is already known.

## MCP writes

Call `artifact_get` immediately before a write to obtain the current version ID. Generate a new opaque idempotency key for the action and reuse it only for an exact retry.

- `artifact_set_visibility`: set `account_required` or `public_link` without changing file bytes.
- `artifact_set_tags`: replace the complete tag set. Preserve existing tags the user did not ask to remove.
- `artifact_restore_version`: make an existing saved version current. This restores an artifact version; it does not restore a server backup. When the user identifies the target relatively, such as "the older of the latest two," run `artifact_version_list` again immediately before the restore and confirm that the chosen version still has that relationship to the current version. An optimistic current-version guard alone does not preserve a relative description.
- `artifact_delete`: use only for an explicit request to delete one artifact. Repeat the artifact name, server, and project before the destructive call. This does not delete the installation.

Project creation, rename, archive, or unarchive are ordinary product actions but must be explicit. Use `project_create`, `project_rename`, `project_archive`, or `project_unarchive`. Archiving a project preserves readable history and stops new publication until it is unarchived.

## MCP file upload

Do not use MCP upload tools when the files exist on the user's machine and the CLI is available. The CLI provides the one-step authenticated experience.

Use `artifact_create_upload` and `artifact_commit_upload` only when the current agent environment can actually read the file bytes and execute the returned authenticated HTTP uploads. Call `artifact_capabilities` first. Never place file bytes, base64, or a local path in MCP arguments, and never expose the MCP bearer credential to the model or output.

## Final result

For publication, collect these fields from the structured result:

- server origin;
- project ID;
- artifact ID;
- exact version ID;
- full-screen review link, stable artifact link, and exact-version raw link;
- access setting.

Present the full-screen review link first because it is the primary human link
for viewing and commenting on the exact published version. Present the raw
immutable link second when direct artifact content is useful.

For comparisons, summarize added, removed, renamed, and changed files and link the compared versions. For a mutation, report the new current version ID or confirm that the current immutable version did not change, as appropriate.
