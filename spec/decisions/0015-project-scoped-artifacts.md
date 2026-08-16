# 0015: Project-scoped artifacts

**Status:** Accepted
**Date:** August 14, 2026

## Decision

One Artifact Server installation represents one person, team, or company. The
installation is the membership and trust boundary. It does not contain a list
of organizations and does not have an organization switcher.

An installation contains projects. Every artifact belongs to exactly one
project, and every saved version belongs to its artifact.

```text
Artifact Server installation
└── Project
    └── Artifact
        └── Immutable version
```

There is no separate Artifact Store or Namespace object.

A new installation creates one default project. Local publishing uses that
project automatically. A team can create more projects without changing its
membership model. Projects do not have their own member list or access-control
list in the first release. Account-required reads continue to use installation
membership. Every admitted human member can manage artifacts in every project;
service credentials require explicit capabilities.

Project identity is an enforced part of every artifact operation. Repository
queries, uploads, idempotency records, browser sessions, API operations, MCP
tools, audit records, backups, and restores must reject a project from another
installation. A caller-supplied project ID never selects an installation or a
raw storage location.

Physical file storage does not change. One filesystem, S3-compatible store, or
R2 bucket can hold files for many projects in the same installation. Project
is a database and authorization boundary, not a bucket-per-project rule.

Existing installations migrate into one default project. The migration
preserves installation IDs, artifact IDs, version IDs, manifests, fingerprints,
links, and action records.

The first project lifecycle supports rename and archive. Archiving stops new
artifacts and new versions but preserves reads, history, links, and comparisons.
Artifact Server does not silently delete every artifact when a project is
archived or removed from an external system. Destructive project deletion needs
a separate retention and recovery decision.

## Plannotator mapping

The first Plannotator integration uses this direct mapping:

```text
Plannotator organization -> Artifact Server installation
Plannotator project      -> Artifact Server project
Plannotator workspace    -> references to project artifacts and versions
```

Plannotator workspaces do not own artifact storage. A workspace may reference
an artifact or exact version from its project. Moving, unfiling, or deleting a
workspace does not move or delete the project artifact.

Plannotator remains responsible for its organization membership, project and
workspace records, workspace visibility, comments, annotations, replies,
notifications, and review state. Artifact Server remains responsible for
project records paired to Plannotator, artifact and version identity, manifests,
file bytes, browser delivery, comparisons, and artifact access settings.

A workspace permission may authorize a short-lived, read-only browser session
for one referenced artifact version. It does not grant access to the project
artifact list and does not grant publish, restore, visibility, or delete
authority. In particular, a public or `link_edit` workspace cannot
mutate a project artifact.

One Artifact Server installation connects to one Plannotator organization in
the first integration release. Plannotator personal projects are outside that
connection. Shared hosted infrastructure may run many isolated installations,
but each installation still represents only one organization or customer.

## Rejected alternatives

### Organizations inside one installation

This duplicates the boundary already represented by the installation and adds
an organization switcher that the standalone product does not need.

### Artifact Store beneath a project

This adds a product object with no separate customer behavior. The project is
the artifact collection and authorization scope.

### Separate standalone and Plannotator-managed artifact areas

This creates two artifact models inside one installation. Plannotator-connected
projects use the same Artifact Server project, artifact, version, storage, and
audit rules as standalone projects. The integration adds a paired project and
narrow delegated operations, not a second storage area.
