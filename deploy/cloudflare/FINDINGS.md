# Alchemy foundation findings

This record applies to Alchemy `2.0.0-beta.72`.

## State store

`Cloudflare.state()` uses one account-level state Worker. The Worker stores
encrypted state in a Durable Object.

Alchemy serves this Worker through the account `workers.dev` subdomain. The
state client requires that URL. Disabling `workers.dev` on the Artifact Server
Worker does not disable it on the Alchemy state Worker.

`Cloudflare.state()` always selects the `alchemy-state-store` Worker in this
version. The bootstrap command has a custom Worker-name option, but the stack
state client does not use that custom name.

The state system also uses account-level Secrets Store values. These values
contain the bearer token and the encryption key.

The Artifact Server stack does not own these account resources. A stack destroy
does not delete them.

If cached state credentials are absent, Alchemy derives new credentials from
the account. This process creates a temporary edge-preview Worker.

If the state Worker is absent, an interactive command offers to create it. A
command with `--yes` can create or upgrade it automatically.

As a result, a remote-state plan is no-write only after state setup is complete.
The in-memory plan test separately proves that resource planning calls no write
method.

State recovery uses the authenticated Cloudflare account. Alchemy rejects
cached state credentials from a different account.

## Removal policy

The Worker uses the default `destroy` policy. D1 and R2 use the `retain` policy.

Alchemy deletes the state row for a retained resource. It does not delete the
Cloudflare resource.

This behavior prevents data loss during a normal destroy. It also removes the
ownership link that a later plan needs.

Use an explicit adoption procedure to manage a retained resource again. Never
use broad adoption against an unreviewed account.

The probe uses Wrangler for permanent deletion after it proves retention. It
deletes D1 by UUID and R2 by its exact bucket name.

## Telemetry

The Alchemy CLI sends OpenTelemetry data to `otel.alchemy.run` by default.

Set one of these environment variables to disable this telemetry:

- `ALCHEMY_TELEMETRY_DISABLED=1`
- `DO_NOT_TRACK=1`
- `NO_TRACK=1`

The account probe sets all three variables. It also disables Wrangler metrics.

Cloudflare Worker observability stays enabled. The Worker has invocation logs
and the configured sample rate.

## Domain behavior

Public ingress attaches two custom domains to one Worker. The application
domain is canonical. The content domain is an alias.

The stack reads the zone for each domain before it defines resources. Both zone
identifiers must match `dnsZoneId`. The custom-domain API then infers the same
zones from the hostnames because it does not accept a zone identifier.

Private ingress attaches no custom domain. The stack also disables
`workers.dev` and preview URLs.

This checkpoint does not implement separate application and content route
tables. The Worker returns the same `503` response on both domains.

## Output boundary

Alchemy output expressions resolve after the provider apply. Effect Schema
cannot parse unresolved output expressions during stack construction.

The package checks the realized output shape with provider-free tests. The
real-account probe still needs a direct read of persisted stack outputs.

The support manifest location points to R2. This checkpoint does not create the
manifest object.

The installation identifier uses the installation name and environment. The
product runtime track must replace it with a generated identifier in durable
backup data.

The shared capacity and `databasePlan` values have no Cloudflare size control
in this checkpoint. Workers, D1, and R2 use provider-managed capacity.

The package checks `backupRetentionDays` and `deletionProtection`. D1 backup
features have no Alchemy resource property in this version.

## Replacement boundaries

The Cloudflare package keeps Alchemy and Cloudflare types inside
`deploy/cloudflare`.

`src/deployment-input.ts` calls the shared executable contract. It adds only
the exact compatibility-date and state-store requirements for this package.

`src/worker.ts` is also temporary. Replace it when the Worker runtime
composition is ready.

Do not add D1 repositories, the R2 product adapter, WorkOS, or optional Git to
this checkpoint.

## Dependency findings

The package pins all direct dependencies.

Alchemy includes `capnp-es@0.0.14`. That package requests TypeScript `^5.7.3`.
The repository pins TypeScript `7.0.2`.

Lint, type checks, unit tests, and the in-memory plan pass with TypeScript
`7.0.2`. A future Alchemy update can remove this peer warning.

pnpm blocks build scripts for optional local-runtime packages by default. The
foundation plan does not need those build scripts.
