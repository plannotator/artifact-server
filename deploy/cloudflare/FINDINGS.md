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

The probe uses Wrangler and the Cloudflare API for permanent deletion after it
proves retention. It lists and removes objects only from the exact probe R2
bucket, deletes D1 by UUID, and deletes R2 by its exact bucket name.

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

Public ingress attaches the application hostname as a custom domain. It creates
a proxied wildcard `AAAA` record for `*.content-domain` and attaches the Worker
with a wildcard route. Cloudflare custom domains do not support wildcard DNS,
so an exact content-domain alias cannot serve the per-version content hosts.

The stack reads the zone for each domain before it defines resources. Both zone
identifiers must match `dnsZoneIds`. The application custom-domain API infers
its zone from the hostname; the wildcard content route uses its configured zone
identifier directly.

Private ingress attaches no custom domain. The stack also disables
`workers.dev` and preview URLs. A `probe-runtime-` development stage is the one
exception: it enables `workers.dev` only long enough to qualify the real Worker,
D1, and R2 lifecycle without changing DNS.

The Worker rejects unknown hosts. Application requests use the configured
application hostname. Artifact content uses a token beneath the separate
content domain, and the HTTP application exposes only content routes there.

## Output boundary

Alchemy output expressions resolve after the provider apply. Effect Schema
cannot parse unresolved output expressions during stack construction.

The package checks the realized output shape with provider-free tests. The
real-account probe also validates the realized output from both the first and
no-drift deployments. A separate support command will still need a direct read
of persisted stack outputs.

The support manifest location points to R2. The current stack does not create
the manifest object.

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

`src/worker.ts` reuses the shared Effect application layer and creates one
managed runtime per Worker isolate. Caller identity remains request-scoped.
D1 and R2 implementations stay inside this package so the application core
does not import Cloudflare SDK types.

WorkOS, optional Git, scheduled cleanup, and the shared hosted control plane
remain separate release work.

## Live runtime qualification

The private runtime probe passed on August 15, 2026. It created one Worker, one
D1 database, and one R2 bucket in the approved standalone Cloudflare account.
It verified health, readiness, API-token rejection, upload, publication,
idempotent replay, listing, no-drift deployment, retention, and exact cleanup.
It made no DNS changes. The redacted durable result is
`../../evidence/cloudflare-runtime.json`.

This proves the Cloudflare application core and private deployment lifecycle.
Hosted load and abuse controls remain separate release gates.

## Public content qualification

The public content probe passed on August 16, 2026. It used the trusted
application hostname `phase11.artifactserver.com` and isolated version hosts
beneath `agentartifacts.org`. Cloudflare served valid edge certificates for
both. Real publications proved static 404 behavior, SPA navigation fallback,
missing-asset 404 behavior, full media delivery, conditional requests, ranged
HEAD, exact single byte ranges, and multiple-range rejection. Redacted evidence
is checked in at `../../evidence/cloudflare-phase11-content.json`.

The live operator used a proxied wildcard `AAAA` record with the reserved
originless address `100::` plus a wildcard Worker route. The application used
an exact Worker custom domain. This matches the resources produced by the
Alchemy stack. A full Alchemy public deployment needs Cloudflare credentials
that can read and write DNS; Wrangler's interactive OAuth grant alone does not
have that permission.

## Coordinated recovery qualification

The checked-in coordinated recovery command passed against live Cloudflare D1,
R2, and Workers on August 16, 2026. A quiesced source installation contained
three artifacts, three immutable versions, five manifest entries, and ten R2
objects. Wrangler remote D1 export/import and the R2 binding copy preserved the
complete application-row digest, identifier-set digest, every object-body
digest, and HTTP/custom metadata digest. The normal product integrity scan was
healthy against only the restored targets, and the current Worker returned
`200` for health and readiness.

Qualification cleanup deleted both exact D1 UUIDs, both exact R2 buckets and
their ten objects each, and the exact helper and restored Workers. The command
did not access DNS or the account-level Alchemy state Worker. Redacted evidence
is checked in at `../../evidence/cloudflare-coordinated-recovery.json`.

The live qualification also exposed Worker revision propagation between rapid
helper redeployments. The command now waits until the helper reports the exact
source, copy, or restore binding mode before it starts that phase. It does not
use an arbitrary delay and never retries the non-idempotent copy request.

The procedure and safety boundary are documented in `RECOVERY.md`. It is a
coordinated quiesced-write recovery procedure, not a promise of point-in-time,
zero-downtime, or region-wide disaster recovery.

## Dependency findings

The package pins all direct dependencies.

Alchemy includes `capnp-es@0.0.14`. That package requests TypeScript `^5.7.3`.
The repository pins TypeScript `7.0.2`.

Lint, type checks, unit tests, and the in-memory plan pass with TypeScript
`7.0.2`. The real-account application-core probe also passes. A future Alchemy
update can remove this peer warning.

pnpm blocks build scripts for optional local-runtime packages by default. The
foundation plan does not need those build scripts.

## Cloudflare references

- [Workers Custom Domains](https://developers.cloudflare.com/workers/configuration/routing/custom-domains/)
- [Workers Routes](https://developers.cloudflare.com/workers/configuration/routing/routes/)
- [Workers routing options](https://developers.cloudflare.com/workers/configuration/routing/)
- [R2 Objects API](https://developers.cloudflare.com/api/resources/r2/subresources/buckets/subresources/objects)
