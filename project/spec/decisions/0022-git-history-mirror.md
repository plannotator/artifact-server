# 0022: Git history is a per-artifact mirror

**Status:** Superseded by [ADR 0026](./0026-cloudflare-artifacts-configurable-git-handoff.md)
**Date:** August 18, 2026

## Decision

This ADR records the original provider-neutral mirror design. ADR 0026 keeps
the mirror safety boundary and one-repository-per-artifact model, but changes
the launch scope: Cloudflare Artifacts is the first managed provider, it is an
explicit installation configuration that is off by default, and enabling it on
an existing installation backfills prior versions. The fixed four-provider
launch assumption and automatic provider selection do not survive.

Optional Git history is a private **mirror** of saved versions: one bare Git
repository per artifact, written asynchronously by an outbox worker after each
version commits, cloneable by installation members with a short-lived read
token. The authoritative database and blob store remain the only truth for
publication, currency, comparison, and delivery. Four providers implement one
five-operation interface (create, commit, lookup, health, delete): `local`,
`cloudflare-artifacts`, `code-storage`, and `private-remote`.

```text
Publish transaction (primary truth)
├── Version + manifest + blobs      (durable first, always)
└── History job                     (same transaction, drained later)
    └── Mirror worker               (single writer per artifact)
        └── art_<id> repository     (main branch, v/<versionId> tags)
```

## Recorded decisions

### One repository per artifact

The decisive argument is deletion. Artifact deletion must delete history as a
unit, and with a per-artifact repository that unit is the repository itself:
one provider delete, no history rewrite, and zero blast radius to any other
artifact's history. Any coarser granularity (per project, per installation)
turns artifact deletion into history rewriting inside a shared repository —
force-pushes, rewritten parents, and every clone of unrelated artifacts
invalidated.

Secondary reasons, each pointing the same way: per-artifact single-writer
matches the product's existing per-artifact version serialization
(`expectedCurrentVersionId`), so job order equals version order with no new
concurrency model; Worker pushes stay small (one version's files, never a
project's); read tokens scope to exactly "this artifact's history" and nothing
more; and the one-repo-per-unit-of-work shape follows the providers' own
guidance. A project-level "clone everything" aggregation MAY layer on later as
its own feature; it is a v1 non-goal.

### Mirror, not truth

Git receives a copy only after the primary version is durable, and a Git
failure of any kind changes only history status. Nothing reads Git to decide
what is published, what is current, what changed between versions, or what a
browser receives. Consequences that fall out for free: history can be disabled,
misconfigured, or down without touching the product; a lost repository is
rebuildable from primary storage; backup and restore exclude Git from primary
recovery; and there is no `current` ref, because currency is the API's
authority and mirroring it would require force-updates that can contradict the
database.

### Four named providers behind one fixed interface

`local` (bare repositories under the installation data directory, zero Git
dependency while history is off), `cloudflare-artifacts` (one jurisdictional
namespace per deployment, feature-flagged while the service is in closed
beta, degrading to history-unavailable rather than erroring), `code-storage`
(Pierre Computer Company's hosted Git backend, driven through its commit-pack
HTTP API with offline-minted scoped JWTs, so it works identically from Node
and Workers with no git client), and `private-remote` (the existing generic
smart-HTTP option, unchanged). The interface stays exactly repository
creation, exact-version commit, mapping lookup, health, and deletion; write
credentials exist only inside the mirror worker and are minted at one site
with explicit scope and TTL.

### Version metadata lives in the committed file, not provider features

Every commit carries `.artifactserver/version.json` (and
`.artifactserver/pointers.json` for excluded large files). code.storage
offers git notes, but a provider-specific metadata channel would make clones
unequal across providers. One committed representation everywhere.

## What stays excluded

- User pushes, branches, pull requests, and Git hosting of any kind.
- Project- or installation-level repositories in v1.
- A `current` ref.
- Serving artifact bytes from Git, and Git-based comparisons.
- Public or anonymous history access.
- Per-version deletion from history; deletion is artifact-level only.
- Git LFS; large files are pointer entries, not LFS objects.

## Rejected alternatives

### One repository per project or per installation

Fails on deletion semantics: removing one artifact's history from a shared
repository is a history rewrite that invalidates every clone and touches
unrelated artifacts' commits. It also breaks single-writer-per-artifact into
cross-artifact contention, grows pushes and clones without bound, and makes
the narrowest possible read token "everything in the project."

### Git as a source of truth or comparison engine

Comparison already works from primary manifests, byte-exactly and without
optional infrastructure. Making Git load-bearing would turn an optional
feature's outage into a product outage and force every deployment to carry a
Git dependency — the opposite of `GIT-001`.

### A `current` ref in each repository

Restore makes currency non-monotonic, so a `current` ref needs force-updates
and can disagree with the database between worker runs. A ref that is
sometimes wrong is worse than no ref; the API answers currency.

### Content-supplied commit metadata

Letting artifact content shape commit messages or author fields injects
untrusted text into a surface Git tooling renders and trusts. Commit metadata
is built exclusively from Artifact Server identities; deterministic identity
and version timestamps also make retried commits reproduce the same logical
commit, which the retry-adoption rule depends on.

### Git notes for version metadata (code.storage)

Notes are per-provider plumbing that clones do not fetch by default. The
committed `version.json` is visible in every clone on every provider with no
extra fetch configuration.
