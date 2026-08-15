# Artifact Server Cloudflare deployment

This package contains the first Cloudflare infrastructure checkpoint. It does
not contain the Artifact Server product runtime.

The stack defines these resources:

- one Cloudflare Worker
- one D1 database
- one private R2 bucket
- two Worker custom domains for public ingress
- one account-level Cloudflare state-store dependency

The Worker returns `503` for all requests. The response prevents users from
mistaking this infrastructure checkpoint for a product deployment.

## Pinned tools

| Tool | Version |
| --- | --- |
| Alchemy | `2.0.0-beta.72` |
| Wrangler | `4.123.0` |
| Cloudflare Workers types | `5.20260815.1` |
| Effect | `4.0.0-rc.108` |
| TypeScript | `7.0.2` |
| Worker compatibility date | `2026-08-15` |

Alchemy has a transitive peer warning. `capnp-es@0.0.14` requests TypeScript
`^5.7.3`, but this repository uses TypeScript `7.0.2`. The package checks pass
with the repository version.

## Install the package

Run this command from `deploy/cloudflare`:

```sh
pnpm install
```

Then run the package checks:

```sh
pnpm check
```

The tests use an in-memory state store. Provider methods stop the test if a
plan tries a provider write.

## Prepare the configuration

Copy `examples/account-probe.config.json` to a file outside the repository.
Replace all example values.

Set the configuration as one JSON environment value:

```sh
export ARTIFACT_SERVER_CLOUDFLARE_CONFIG="$(
  cat /absolute/path/to/cloudflare.config.json
)"
```

Set the Alchemy stage to the same value as `stage` in the configuration:

```sh
export ALCHEMY_STAGE=probe-yourname
```

The parser rejects unknown fields. The parser also rejects unsafe production,
capacity, domain, DNS, WorkOS, and deletion-protection combinations.

`src/deployment-input.ts` applies Cloudflare package pins after it calls the
shared parser in `src/deployment/index.ts`.

## Prepare authentication and state

Log in to the approved Cloudflare account:

```sh
pnpm exec alchemy login --profile default alchemy.run.ts
pnpm exec wrangler login
```

CAUTION: Get approval before you run the next command. The command creates an
account-level Worker and Secrets Store values.

```sh
pnpm exec alchemy cloudflare bootstrap --profile default
```

The state store is an account prerequisite. The Artifact Server stack does not
own it and does not delete it.

## Produce a plan

Disable Alchemy telemetry for repository operations:

```sh
export ALCHEMY_TELEMETRY_DISABLED=1
export DO_NOT_TRACK=1
```

Then produce the plan:

```sh
pnpm exec alchemy plan \
  --stage "$ALCHEMY_STAGE" \
  --profile default \
  alchemy.run.ts
```

A plan reads the Cloudflare account and the remote state store. It does not
apply Artifact Server resources.

For public ingress, the plan reads the zones for both domains. It stops if
either zone identifier does not match `dnsZoneId`.

The state store can write during credential recovery or a version upgrade.
Prepare current cached state credentials before a no-write plan check.

## Deploy and destroy

CAUTION: Get approval before you deploy. Public ingress also changes DNS and
requests edge certificates.

```sh
pnpm exec alchemy deploy \
  --yes \
  --stage "$ALCHEMY_STAGE" \
  --profile default \
  alchemy.run.ts
```

Run the same command again. The second plan must contain only `noop` actions.

Destroy the stack:

```sh
pnpm exec alchemy destroy \
  --yes \
  --stage "$ALCHEMY_STAGE" \
  --profile default \
  alchemy.run.ts
```

The destroy operation deletes the Worker. It retains the D1 database and R2
bucket because both resources use the Alchemy `retain` removal policy.

Alchemy removes retained resource rows from stack state. A later deployment
must use a documented adoption or recovery procedure.

## Run the real-account probe

CAUTION: The probe creates and deletes Cloudflare resources. Run it only in the
approved account.

The probe accepts development configurations only. Both `installationName` and
`stage` must start with `probe-`.

For private ingress, run:

```sh
pnpm probe:account \
  --config /absolute/path/to/cloudflare.config.json \
  --confirm-account 0123456789abcdef0123456789abcdef
```

For public ingress, add the DNS confirmation:

```sh
pnpm probe:account \
  --config /absolute/path/to/cloudflare.config.json \
  --confirm-account 0123456789abcdef0123456789abcdef \
  --confirm-dns fedcba9876543210fedcba9876543210
```

The probe runs these operations:

1. It produces an Alchemy plan.
2. It deploys the stack.
3. It deploys the same stack again.
4. It validates the resolved deployment output.
5. It checks that the second plan has no drift.
6. It destroys the Worker.
7. It checks that D1 and R2 remain.
8. It permanently deletes the probe D1 database and R2 bucket.

The probe disables Alchemy telemetry. It stores hashes of command output, not
the command output.

The evidence file is in `evidence/account-probe-<timestamp>.json`. The package
ignores this generated file until a reviewer approves it for durable evidence.

If cleanup fails, use the resource names in the evidence file. Delete only the
resources that use the approved probe prefix.

If destroy fails, the probe does not delete D1 or R2. First, remove the Worker.
Then, delete the two probe-only durable resources.

## Support outputs

The stack returns the required output keys. The values contain resource
identifiers and locations only.

`supportManifestLocation` identifies this future R2 object:

```text
r2://<bucket>/support/installation-manifest.json
```

This checkpoint does not write the manifest object. The product runtime track
will write and update the manifest.

## Scope

This checkpoint excludes these functions:

- D1 product repositories and migrations
- the R2 product adapter
- WorkOS login and MCP authorization
- optional Git history
- scheduled product work
- the shared hosted control plane
- product release qualification

Read `FINDINGS.md` before you change the state, telemetry, or removal policy.
