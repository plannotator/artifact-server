# Cloudflare Artifacts Git history

[Cloudflare Artifacts](https://developers.cloudflare.com/artifacts/) provides version storage through Workers bindings, a REST API, and Git smart HTTP.

Artifact Server uses Cloudflare Artifacts as an optional Git handoff. Artifact Server remains the source of truth for publication, review, delivery, and recovery.

![Cloudflare Artifacts provides version storage through Workers bindings](./assets/cloudflare-artifacts-git-handoff.svg)

## How it works

- Git history is off by default.
- An operator configures one Cloudflare Artifacts namespace for the installation.
- A project administrator enables Git history for one project.
- Each artifact receives one private repository.
- Each saved artifact version maps to one deterministic commit.
- Provider errors do not block artifact publication or delivery.
- Disabling Git history does not delete repositories.

One repository per artifact gives each artifact an independent history, token, lifecycle, and deletion boundary.

Cloudflare bills aggregate storage and operations. It does not bill by repository count.

## Configure a Node deployment

Set the provider:

```sh
ARTIFACT_SERVER_GIT_HISTORY_PROVIDER=cloudflare-artifacts
```

Set the Cloudflare account and namespace:

```sh
ARTIFACT_SERVER_CLOUDFLARE_ARTIFACTS_ACCOUNT_ID=example-account-id
ARTIFACT_SERVER_CLOUDFLARE_ARTIFACTS_NAMESPACE=artifact-server-production
ARTIFACT_SERVER_CLOUDFLARE_ARTIFACTS_API_TOKEN_FILE=/run/secrets/cloudflare-artifacts-token
```

The token needs Cloudflare Artifacts Read and Edit permissions. Artifact Server does not accept a raw token environment variable.

The namespace must belong only to one Artifact Server installation environment. Use different namespaces for production, development, and live tests.

## Configure copy limits

Artifact Server copies files within explicit bounds:

| Variable | Default | Purpose |
| --- | --- | --- |
| `ARTIFACT_SERVER_GIT_HISTORY_COPY_LIMIT_BYTES` | `10485760` | Maximum copied bytes for one file. |
| `ARTIFACT_SERVER_GIT_HISTORY_VERSION_COPY_LIMIT_BYTES` | `52428800` | Maximum copied bytes for one version. |
| `ARTIFACT_SERVER_GIT_HISTORY_STORAGE_BUDGET_BYTES` | Not set | Optional application budget for copied bytes. |

Files above a copy limit remain in primary storage. The Git commit contains deterministic pointer metadata for those files.

## Enable one project

Provider configuration makes the integration available. It does not copy project data.

A project administrator follows this sequence:

1. Read the provider and project status.
2. Request the storage estimate.
3. Review the estimated copied and pointer bytes.
4. Enable Git history for the project.
5. Monitor backfill and provider health.

The Workbench, HTTP API, and MCP expose the same project setting.

## Keep account data separate

Use a dedicated namespace for Artifact Server. Do not use a namespace that belongs to another product.

Live tests require a namespace that starts with `artifact-server-test-`. Each test run uses a unique repository prefix and bounded cleanup.

This design gives production, development, tests, and unrelated Cloudflare projects separate cleanup boundaries.

## Availability and release gate

The current code provides configuration validation, provider health discovery, estimates, and per-project enablement.

Repository writes, clone tokens, deletion, recovery, and live Cloudflare qualification remain behind conformance requirement `GATE-004`.

Cloudflare controls access to Cloudflare Artifacts. Confirm account access before you enable the provider.

Read the current Cloudflare [pricing](https://developers.cloudflare.com/artifacts/platform/pricing/) and [limits](https://developers.cloudflare.com/artifacts/platform/limits/).

Read the [Git history specification](../project/spec/git-history-spec.md) and [ADR 0026](../project/spec/decisions/0026-cloudflare-artifacts-configurable-git-handoff.md) for the complete contract.
