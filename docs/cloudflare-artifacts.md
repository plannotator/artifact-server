# Optional Git history with Cloudflare Artifacts

[Cloudflare Artifacts](https://developers.cloudflare.com/artifacts/) can keep a private Git copy of selected Artifact Server projects. Artifact Server remains the source of truth for publishing, Review, comments, delivery, restore, and recovery.

![Cloudflare Artifacts provides optional Git-backed history](./assets/cloudflare-artifacts-git-handoff.svg)

> Cloudflare Artifacts is currently a closed beta. Request access before you configure this integration. Git history is off by default and Artifact Server remains complete without it.

## How it works

- An administrator enables Git history one project at a time after reviewing a copy estimate.
- Artifact Server creates one private repository per artifact, only when the first version is ready to mirror.
- Every saved version becomes one deterministic commit on `main` and one immutable `v/<versionId>` tag.
- Large files stay in primary object storage and appear in Git as pointer metadata.
- Publication never waits for Git. Provider failures retry in a durable outbox and do not affect saved artifacts.

Disabling a project stops new copies but preserves its repositories and mappings. Re-enabling the same project resumes and backfills missing versions. Deleting an artifact queues deletion of that artifact's repository.

## Choose an isolated namespace

Create one dedicated namespace for each Artifact Server environment. Do not reuse a namespace owned by another product or installation.

```sh
pnpm --dir deploy/cloudflare exec wrangler artifacts namespaces create artifact-server-production
```

Use separate namespaces for production, development, and live qualification. Artifact Server persists the account and namespace identity after the first successful check. Changing either value after repositories exist reports `migration-required` instead of writing to a different location.

## Configure a Node deployment

Node deployments use the namespace-scoped REST control plane and Git smart HTTP. Put an Artifacts Read/Edit token in a secret file; a raw token environment variable is rejected.

```sh
ARTIFACT_SERVER_GIT_HISTORY_PROVIDER=cloudflare-artifacts
ARTIFACT_SERVER_CLOUDFLARE_ARTIFACTS_ACCOUNT_ID=<account-id>
ARTIFACT_SERVER_CLOUDFLARE_ARTIFACTS_NAMESPACE=artifact-server-production
ARTIFACT_SERVER_CLOUDFLARE_ARTIFACTS_API_TOKEN_FILE=/run/secrets/cloudflare-artifacts-token
```

Optional copy controls:

| Variable | Default | Effect |
| --- | ---: | --- |
| `ARTIFACT_SERVER_GIT_HISTORY_COPY_LIMIT_BYTES` | `10485760` | Files above this size become pointers. |
| `ARTIFACT_SERVER_GIT_HISTORY_VERSION_COPY_LIMIT_BYTES` | `52428800` | Deterministic excess in one version becomes pointers. |
| `ARTIFACT_SERVER_GIT_HISTORY_STORAGE_BUDGET_BYTES` | unset | Pauses new mirror writes before the logical copy budget is exceeded. |

Restart the application after changing installation configuration. A missing, invalid, or unavailable provider reports a Git-specific state and does not make Artifact Server unready.

## Configure the Cloudflare deployment

Set `cloudflareArtifactsNamespace` in the Cloudflare deployment input. Alchemy binds the existing namespace as `ARTIFACTS`; no REST token is used by the Worker.

```ts
{
  cloudflareArtifactsNamespace: "artifact-server-production"
}
```

The Worker persists and checks the Cloudflare account and namespace identity before it enables provider writes.

## Enable a project

Open **Projects**, find the project, and select **Enable Git history**. Artifact Server shows the current repository, version, and byte estimate before confirmation. The setting starts off for every existing and new project.

Project state progresses through `waiting`, `backfilling`, and `ready`. `degraded` means the provider needs attention. `budget-limited` means primary publishing still works, but new Git writes are paused by the configured budget.

HTTP and MCP expose the same operations:

| Intent | HTTP | MCP |
| --- | --- | --- |
| Read status | `GET /api/v1/projects/:projectId/git-history` | `project_git_history_status` |
| Estimate | `POST /api/v1/projects/:projectId/git-history/estimate` | `project_git_history_estimate` |
| Enable or disable | `PUT /api/v1/projects/:projectId/git-history` | `project_set_git_history` |

## Clone history

Authenticated members can request a short-lived, read-only token for one provisioned artifact. Public links never grant Git access.

```sh
artifactserver history clone --project prj_example art_example ./artifact-history
artifactserver history checkout-project prj_example ./project-history
```

The project command clones provisioned repositories with bounded concurrency and writes `.artifactserver/project.json`. Artifacts that have not been provisioned are reported without failing successful clones.

## Remove all derived history

Disabling Git history is reversible and does not delete repositories. Permanent installation-wide removal is a separate operator action. Always inspect the read-only plan first:

Disable Git history for every project before applying a purge. The command refuses to delete repositories while any project remains enabled.

```sh
artifactserver history purge --plan --mode compact --data /srv/artifact-server
artifactserver history purge --apply --mode compact --data /srv/artifact-server \
  --confirm-installation inst_example
```

Use `--mode external-storage` inside a Postgres deployment with its normal database and installation environment. The command uses persisted coordinates, requires an exact installation ID and matching provider identity, deletes in bounded pages, and resumes after interruption. It never deletes primary artifacts or the Cloudflare namespace.

For a Cloudflare D1 deployment, run the transient operator Worker from the source checkout. It binds only the named D1 database and Artifacts namespace and is not part of the deployed application:

```sh
ARTIFACT_SERVER_CLOUDFLARE_ACCOUNT_ID=<account-id> \
ARTIFACT_SERVER_CLOUDFLARE_D1_DATABASE_ID=<database-id> \
ARTIFACT_SERVER_CLOUDFLARE_ARTIFACTS_NAMESPACE=artifact-server-production \
ARTIFACT_SERVER_INSTALLATION_ID=inst_example \
pnpm purge:cloudflare-artifacts -- --plan

# After reviewing the plan:
pnpm purge:cloudflare-artifacts -- --apply \
  --confirm-installation inst_example
```

The apply request is sent once. Each confirmed repository deletion is recorded in D1 before the next repository, so the same command safely resumes a partial run.

## Qualify your account

The repository includes bounded live suites for both supported Cloudflare control planes. They refuse to run without explicit opt-in and use only the dedicated `artifact-server-test-qualification` namespace.

```sh
ARTIFACT_SERVER_CLOUDFLARE_ARTIFACTS_LIVE=1 pnpm qualify:cloudflare-artifacts
ARTIFACT_SERVER_CLOUDFLARE_ARTIFACTS_LIVE=1 pnpm qualify:cloudflare-artifacts:binding
```

Every repository receives a generated `artifact-server-test-<run>-` prefix. Cleanup uses only the run manifest or exact run prefix; it never deletes a namespace or sweeps an account. The checked-in [qualification evidence](../project/evidence/cloudflare-artifacts-live-qualification.json) records successful REST and Workers-binding checks. It also records a bounded August 27, 2026 product run through availability, estimate, project enablement, backfill, a second mirrored version, read-only clone, disablement, artifact deletion, and exact cleanup.

## Costs and limits

Cloudflare prices aggregate operations and stored bytes, not repository count. One repository per artifact therefore matches Artifact Server's authorization and deletion boundary without adding a per-repository fee. The live qualification is intentionally small and does not try to approach account quotas. Review Cloudflare's current [pricing](https://developers.cloudflare.com/artifacts/platform/pricing/) and [limits](https://developers.cloudflare.com/artifacts/platform/limits/) before enabling large projects.

For the complete product contract, read the [Git history specification](../project/spec/git-history-spec.md) and [ADR 0026](../project/spec/decisions/0026-cloudflare-artifacts-configurable-git-handoff.md).
