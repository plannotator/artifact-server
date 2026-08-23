# 0026: Cloudflare Artifacts is a configurable Git handoff

**Status:** Accepted
**Date:** August 23, 2026
**Supersedes:** [ADR 0022](./0022-git-history-mirror.md)

The normative implementation contract is
[Optional Git handoff and version history](../git-history-spec.md). Observable
promises are indexed as `GIT-001` through `GIT-014` and `GATE-004` in the
[conformance ledger](../conformance.yml).

## Context

Cloudflare Artifacts is a strong fit for Artifact Server: it stores versioned
file trees, exposes ordinary Git remotes, and is designed for agent and
automation workflows. It is also not available to every Cloudflare account or
every Artifact Server operator. Artifact Server must remain useful on a laptop,
one server, Kubernetes, or another cloud without Cloudflare Artifacts access.

The product already has authoritative immutable versions in its database and
blob store. Git therefore adds portable handoff to Git-aware people, agents,
and tools; it must not become a second source of truth.

## Decision

Artifact Server ships Cloudflare Artifacts as the first managed Git handoff
provider behind an explicit installation configuration. The configuration is
**off by default** on every deployment.

```text
ARTIFACT_SERVER_GIT_HISTORY_PROVIDER=off                    # default
ARTIFACT_SERVER_GIT_HISTORY_PROVIDER=cloudflare-artifacts   # explicit opt-in
```

There is no `auto` setting. Artifact Server never chooses a remote provider
from the deployment type, a hostname, an artifact path, or the presence of an
ambient credential.

The day-one Git handoff slice includes:

- `off`, which loads no Git implementation, requires no provider credential,
  makes no provider request, and changes no artifact behavior;
- `cloudflare-artifacts`, usable through the Workers binding in the Cloudflare
  runtime and through Cloudflare's REST control plane from other runtimes;
- one private repository per artifact and one deterministic commit per saved
  version;
- a short-lived, repository-scoped read token for an authorized member to
  clone that repository;
- one persisted on/off setting per project, disabled until a project
  administrator explicitly enables it; and
- asynchronous backfill when an administrator enables one project after
  versions already exist.

Provider configuration means **available**, not **mirror everything**. Merely
selecting `cloudflare-artifacts` verifies the provider and exposes its
availability; it creates no repository and queues no history job. The ordinary
administrator surface may enable one project after showing an on-demand
planning estimate. There is no installation policy, inheritance, or "all
future projects" mode. A later bulk action may switch existing projects one at
a time, but every new project starts disabled. The project setting is durable
product state shared by the browser, HTTP API, and MCP; the provider, account,
namespace, credentials, and hard copy limits remain operator-owned deployment
configuration.

The authoritative database and blob store remain the only source for
publication, current-version selection, comparison, browser delivery, backup,
and recovery. A Git outage or configuration error can make Git handoff
unavailable, but cannot make Artifact Server unavailable.

## Provider and project transitions

Changing provider infrastructure requires a process restart or a new
deployment. Changing one project's Git history setting is a project-management
operation with matching browser, HTTP, and MCP behavior. Setting the same value
again is naturally idempotent.

- **`off` to `cloudflare-artifacts`:** start serving immediately, verify the
  provider asynchronously, but create no repository and queue no copy solely
  because the provider became available. Resume work only for projects whose
  durable setting was already enabled.
- **Project disabled to enabled:** calculate and present version, operation,
  copied-byte, and pointer-byte estimates first. After explicit confirmation,
  enqueue every unmapped version in that project oldest-first per artifact.
  New publishes in that project enqueue their own history job in the
  publication transaction. Backfill never delays a publish or artifact read.
- **Project enabled to disabled:** stop new mirror jobs and worker claims for
  that project without deleting jobs, mappings, coordinates, or repositories.
  Versions published while disabled are found if the project is re-enabled.
- **`cloudflare-artifacts` to `off`:** stop provider calls and new worker
  claims, and do not insert new version-mirror jobs while off. Preserve existing
  jobs, repository coordinates, and mappings. Artifact deletion still records
  a durable repository-deletion job when coordinates exist; it waits for
  re-enable or explicit purge. Versions published while off are found by
  reconciliation after re-enable. Do not delete remote repositories merely
  because the feature is disabled.
- **`off` back to the same provider:** resume queued work and reconcile missing
  mappings. Already mapped versions do not create new commits.
- **Provider replacement:** changing from one non-`off` provider to another is
  not an automatic migration in the first release. The application continues
  to serve artifacts but reports `provider-change-requires-migration` until a
  separately specified migration or purge operation completes.

Disabling the provider is not a deletion request. Before permanently removing
provider credentials, an operator who wants remote data erased must select the
same provider long enough to run the explicit, confirmed
`artifactserver history purge` procedure. Artifact deletion jobs remain durable
while the provider is off and resume when it is re-enabled; issued clone tokens
expire within one hour.

## Cloudflare composition

Cloudflare deployments receive an `ARTIFACTS` Workers binding for one stable,
pre-created namespace. Other deployments use the REST API with an account ID,
namespace, and API token supplied through the normal secret-file convention.
The provider uses the binding or REST only for repository and token control;
commits use Git smart HTTP. The application never stores a provider token in a
remote URL or log.

The namespace is an operator-owned resource. Artifact Server creates and
deletes repositories inside it but does not delete the namespace. Jurisdiction
is selected when the namespace is provisioned and cannot be changed by an
artifact request. Each Artifact Server installation and environment owns an
exclusive namespace; a production integration, a development installation,
and the live provider suite never share one. The configured namespace is
persisted with provider identity on first activation, is never accepted from a
request or artifact record, and changing it after repositories exist reports
`migration-required` rather than writing into a second namespace.

Cloudflare's control-plane credential is account-scoped, so namespace routing
is reinforced in code: the adapter constructs one namespace-specific base URL
at startup and has no account-wide delete or namespace-delete operation. A
live suite requires a dedicated namespace whose name begins with
`artifact-server-test-`, a separate revocable credential, explicit opt-in, and
unique run-prefixed repository names. Cleanup may delete only repositories in
the run manifest; it never sweeps an account, another namespace, or the
namespace itself.

## Cost boundary

Cloudflare bills aggregate repository operations and stored bytes, not the
number of repositories. One repository per artifact therefore remains the
correct lifecycle boundary: it adds one create operation per mirrored artifact
but permits independent tokens, writes, recovery, and storage reclamation on
artifact deletion. A project repository would couple unrelated writers and
make deletion of one artifact require retaining its bytes or rewriting other
artifacts' history.

Cost control happens at selection and copy boundaries instead:

- no project is mirrored merely because the provider is configured;
- an on-demand planning estimate precedes project enablement and is explicitly
  labeled as guidance rather than an invoice or account-usage reading;
- copied bytes are limited both per file and per version; excluded bytes become
  pointer entries;
- an optional logical copied-byte budget pauses new provider writes in a
  `budget-limited` state without changing primary behavior; and
- repositories are created lazily by the first history job and are deleted
  independently when their artifact is tombstoned or explicitly purged.

## Product and provider boundaries

The first slice is deliberately small: server-written `main`, version tags,
and read-only clone handoff. User pushes, arbitrary branches, pull requests,
fork workspaces, push events, and build-on-push automation are later optional
capabilities. They may use Cloudflare-specific features without becoming
requirements of the portable history mirror.

`local`, `code-storage`, and `private-remote` remain planned adapters. They are
not accepted configuration values and are not advertised until each passes the
same persistence, retry, security, backup, deletion, and recovery suite.

## Consequences

- Artifact Server can launch and operate anywhere without Cloudflare Artifacts.
- The Cloudflare path is intentional and first-class rather than an accidental
  deployment default.
- Operators can enable the feature after installation without losing earlier
  history.
- Artifact Server pays the storage and operation cost of a derived Git copy
  only for explicitly enabled projects.
- Provider-specific opportunities can grow later without making Cloudflare a
  dependency of the core product.

## Rejected alternatives

### Require Cloudflare Artifacts on Cloudflare deployments

Rejected because account access and service availability are not universal.
It would turn an optional integration into a deployment blocker.

### Select a provider automatically

Rejected because it makes installation behavior depend on ambient bindings or
credentials and can create remote repositories and cost without an explicit
operator decision.

### Mirror only versions published after enablement

Rejected because a clone would silently contain an incomplete history. The
primary store already has the information required for a deterministic
backfill.

### Treat provider configuration as consent to mirror every project

Rejected because infrastructure availability is not a cost or data-placement
decision. It would create repositories and duplicate stored bytes merely
because an operator supplied a credential. Each project instead has one
explicit, off-by-default setting with a planning estimate before enablement.

### Use one repository per project

Rejected because projects are organizational containers, not atomically
versioned workspaces. A shared branch would serialize unrelated artifact
publishes, a project clone would expose every artifact, the provider's storage
limit would be concentrated, and removing one artifact's private history would
require a repository-wide history rewrite. A project checkout command may
aggregate artifact repositories without changing the canonical boundary.

### Delete repositories when the feature is disabled

Rejected because a configuration rollback must be reversible. Remote deletion
is a separate destructive operation with its own authorization and evidence.
