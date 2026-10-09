# 0030: Artifact owner and opt-in restricted access

**Status:** Proposed
**Date:** October 9, 2026

Would amend AUTH-002, AUTH-008, and SCP-008, and the "exactly two access
settings" wording in the product specification. Nothing changes for an
artifact unless someone chooses the new setting.

## Decision

Every artifact records its **owner**: the principal that created it. A third
access setting, **restricted**, joins `account_required` and `public_link`.
A restricted artifact is visible to, and manageable by, only its owner and the
installation's administrators. `account_required` stays the default, and both
existing settings behave exactly as today.

| Who | `restricted` | `account_required` (default) | `public_link` |
| --- | --- | --- | --- |
| Owner | lists, reads, opens content, publishes, restores, changes access and tags, deletes, comments | unchanged | unchanged |
| Installation administrator | same as the owner | unchanged | unchanged |
| Other admitted members | not listed; direct access answers as if the artifact did not exist | unchanged | unchanged |
| Service principals, whatever their capabilities | not listed; direct access answers as if the artifact did not exist | unchanged | unchanged |

Only the owner or an administrator may switch an artifact to or from
`restricted`. The default does not change.

## Why

A private-team installation with a few hundred people publishes many pages
that are not meant for everyone yet: personal drafts, notes for a later
review, pages that will be shared once they are finished. Today every admitted
member can find, read, overwrite, restore, and delete each of them. The only
way to keep a page to yourself is not to publish it, which pushes those pages
back into whatever tool the installation was meant to replace.

`f1586f7` removed per-artifact ownership to keep the access model small, and
this decision does not undo that simplification. The removed ownership never
restricted reading: every member could read every artifact, and the owner
only gated mutation and scoped service keys. Restricted access is a new,
opt-in reading rule for one artifact at a time, chosen by the person who
published it.

## Recorded decisions

### The owner is the creator, and existing artifacts are backfilled

A new artifact records the principal that commits its first version. Existing
artifacts take the `publisher_principal_id` of their version 1, which every
backend keeps and which restore never deletes. Some owners will be service
principals or the local CLI token. Such an artifact can still be restricted by
an administrator, who can then manage it. There is no ownership transfer in
this change; an artifact whose owner left stays manageable by administrators.

A member-bound API key carries the member's own id, so the owner keeps access
through it, as through the browser and MCP OAuth.

### Administrators see restricted artifacts

"Only me" means the owner and the installation's administrators. Without that,
a page that must come down could not be found, and an artifact whose owner was
deactivated could not be managed at all. The interface says so where the
setting is chosen.

### Service principals do not

A service key with `artifact:read` or `artifact:manage:any` acts for an
automation, not for a person. It does not see restricted artifacts, so an
installation-wide key cannot be used to read pages their owners kept to
themselves. For the same reason only a person can publish a new artifact as
restricted: a service principal would own something it could never see. In
local-owner mode there is one person, so MCP does not advertise the setting
there.

### Hidden, not forbidden

Listings, search, counts, and sort-by-comments filter restricted artifacts
inside the query, so pagination and totals stay correct. A direct request for
a restricted artifact by someone who may not see it answers the same
not-found error as a missing artifact, so the response does not confirm that
it exists.

### Switching to restricted takes effect at once for content

Content sessions and preview leases outlive an access change by up to fifteen
minutes today. Switching to restricted therefore deletes, in the same
transaction, every content session and unconsumed bootstrap of that artifact
that does not belong to its owner, so an open tab of another member stops
loading new files immediately. Administrators simply open the artifact again.
New sessions are minted only after the visibility check.

Git history clone credentials are issued by the provider and cannot be
revoked early. New credentials for a restricted artifact are issued only to
its owner and administrators, and the mirror still pushes the artifact to the
provider repository, whose own access rules apply. Git history is off by
default. The deployment guide records this limit.

### Comments and dispatch follow the artifact

Reading and writing comments requires seeing the artifact. Creating a dispatch
treats a thread of a restricted artifact the sender cannot see exactly like an
unknown thread, so only the owner or an administrator can send such threads to
an agent. An agent then reads them through the ordinary comment operations,
which apply the same visibility, so a service-principal agent cannot read them
at all. Dispatch records list thread identifiers only, never thread bodies.

### Storage: two additive columns

Each backend gains a nullable `owner_principal_id` and a boolean `restricted`
on `artifacts`, plus an index for the owner-scoped listing. The existing
`access_setting` column and its CHECK constraint stay as they are, and the
repositories map the pair to one of three API values. Adding a third value to
the CHECK would need a rebuild of the `artifacts` table on SQLite and D1,
where many tables reference it. The API exposes one field either way:
`accessSetting: "restricted" | "account_required" | "public_link"`.

`restricted` and `public_link` are exclusive. The administrator "make private"
action in the public-link inventory keeps setting `account_required`.

## Requirements

- **AUTH-030:** every artifact records its owner; new artifacts record the
  creating principal and existing ones are backfilled from version 1.
- **AUTH-031:** a restricted artifact is visible to and manageable by only its
  owner and administrators, on every surface: listing and search, metadata,
  versions, content sessions and preview leases, comments, dispatch, git
  history credentials, HTTP, MCP, and the web interface.

Both are proved with normal and hostile tests: the AUTH-030 and AUTH-031
conformance tests drive the local server, and the Postgres and D1 runtime tests
cover owners, the listing filter, replay, and the upgrade backfill on those
backends.

## What it would amend

- **AUTH-002:** `account_required` stays the default and still admits every
  member; the sentence gains "unless the artifact is restricted".
- **AUTH-008:** "every admitted human member can manage artifacts" gains the
  restricted exception.
- **SCP-008:** there is still no per-project or per-artifact member list. The
  one documented reader rule is owner plus administrators, which SCP-008-F
  already allows by refusing only an *undocumented* reader ACL.
- **Product specification** `#sharing`, `#scope`, and `#decisions`: three
  access settings instead of two.

## Not part of this decision

- Grants to named members or groups. They would extend `restricted` with a
  grant list later, under their own decision.
- Ownership transfer.
- An installation-wide setting that hides `account_required` or makes
  `restricted` the default.

## Rejected alternatives

### An installation-wide "private by default" mode

Every artifact would start private, and every share would need a second step.
It changes the experience of every installation that is happy with today's
model. The per-artifact setting gives the same protection to the people who
want it.

### Restore the removed ownership as it was

It gated mutation only and never reading, so it does not answer the problem,
and its capability pair (`artifact:manage:owned`, `artifact:publish:owned`)
is the complexity `f1586f7` removed.

### Per-project member lists

Moves the problem from one page to a whole project and adds a membership
surface per project, which SCP-008 and PRJ-003 rule out.
