# Artifact Server Cloudflare deployment

This package deploys the Artifact Server application core on Cloudflare
Workers. D1 stores records and R2 stores uploaded and published file bytes.

The stack defines these resources:

- one Cloudflare Worker
- one D1 database
- one private R2 bucket
- one application custom domain for public ingress
- one proxied wildcard DNS record and Worker route for version content
- one account-level Cloudflare state-store dependency

The Worker runs the same HTTP, MCP, publishing, project, artifact, version,
sharing, and API-key services as the other deployments. The Cloudflare package
supplies D1 repositories and direct R2 bindings instead of SQLite, Postgres, or
an S3 client.

The package accepts an Artifact Server API token and can also bind one complete
WorkOS hosted-authentication configuration: API key secret, client ID, and
exact AuthKit issuer. The verifier, protected-resource metadata, and browser
login wiring are implemented. Live browser approval, refresh, revocation, and
named-client qualification remain release gates, so this package must not yet
be advertised as the complete hosted Artifact Server service.

The isolated WorkOS staging environment has CIMD, compatibility DCR, the exact
staging MCP resource, and its callback configured. The secret-free dashboard
record is `../../project/evidence/workos-mcp-staging-configuration.json`. That record
proves configuration only; it does not replace the live client-flow gate.

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

The plan tests use an in-memory state store. Provider methods stop the test if
a plan tries a provider write. The runtime test starts the real Worker bundle
through Wrangler with local D1 and R2, publishes and renders a file, restarts
the Worker, and races two publications against the same current version.

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

Set a generated Artifact Server API token. Use at least 32 random characters;
do not commit or print it:

```sh
export ARTIFACT_SERVER_API_TOKEN="$(openssl rand -base64 32)"
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
either zone identifier does not match `dnsZoneIds`. It creates the application
custom domain, a proxied `*.content-domain` DNS record, and a wildcard Worker
route. Cloudflare custom domains cannot provide the required wildcard content
host by themselves.

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

The probe accepts private development configurations only. It rejects
`dnsZoneIds` and public ingress. Both `installationName` and `stage` must start
with `probe-`. Every generated Worker, D1, and R2 name also starts with
`probe-`.

A stage beginning with `probe-runtime-` temporarily enables the probe Worker's
`workers.dev` address. The probe generates an API token in memory and verifies
health, readiness, authentication, D1, R2 upload, publication, idempotent
replay, and listing before cleanup. Normal private deployments keep
`workers.dev` disabled.

The probe uses the active `npx wrangler` login. Run:

```sh
pnpm probe:account \
  --config /absolute/path/to/cloudflare.config.json \
  --confirm-account 0123456789abcdef0123456789abcdef
```

The probe runs these operations:

1. It verifies the exact Wrangler account.
2. It verifies that the stage and proposed resource names are unused.
3. It requires a plan with exactly three create actions.
4. It deploys the stack and records exact resource identifiers.
5. It deploys the same stack again.
6. It validates the resolved output and checks for no drift.
7. It destroys the Worker and verifies its removal.
8. It verifies that the exact D1 and R2 resources remain.
9. It lists and removes objects only from the exact probe R2 bucket.
10. It deletes D1 by UUID and R2 by its exact bucket name.
11. It verifies that the non-probe D1 and R2 inventories did not change.

For `probe-runtime-` stages, the functional runtime check runs after step 4.

The probe disables Alchemy telemetry. It stores hashes of command output, not
the command output. The evidence includes the exact probe resource names and
identifiers.

The evidence file is in `evidence/account-probe-<timestamp>.json`. The package
ignores this generated file until a reviewer approves it for durable evidence.
The approved repository summary is `../../project/evidence/cloudflare-runtime.json`.

If cleanup fails, use only the exact names and identifiers in the evidence
file. Do not use a wildcard or an account-wide cleanup command.

If destroy fails, the probe does not delete D1 or R2. First, remove the Worker.
Then, delete the two probe-only durable resources.

## Recover D1 and R2 together

Use the checked-in coordinated recovery command only after writes to the source
installation are quiesced and clean restore targets have been created. It uses
Cloudflare's remote D1 export/import, copies R2 bodies plus required metadata,
runs the normal product integrity scanner, and starts the current Worker against
only the restored targets. The command rejects nonempty, mismatched, changing,
partial, or corrupt targets.

Follow [RECOVERY.md](./RECOVERY.md). Do not substitute an independent D1 export
or partial R2 copy; those operations do not form a recoverable installation.

## Support outputs

The stack returns the required output keys. The values contain resource
identifiers and locations only.

`supportManifestLocation` identifies this future R2 object:

```text
r2://<bucket>/support/installation-manifest.json
```

The stack does not yet write this support object. That remains an operational
release gate, not a dependency of artifact publication.

## Scope

The live Cloudflare provider qualification now includes public TLS, separate
trusted and untrusted domains, static and SPA routing, conditional requests,
and exact media ranges. The redacted result is
`../../project/evidence/cloudflare-phase11-content.json`.

The current Cloudflare release work still excludes or has not qualified these
functions:

- optional Git history
- live WorkOS login, refresh, revocation, and named-client qualification
- hosted load, quota, and abuse controls
- the shared hosted control plane
- complete hosted-product release qualification

Read `FINDINGS.md` before you change the state, telemetry, or removal policy.
