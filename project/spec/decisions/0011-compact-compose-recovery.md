# ADR 0011: Compact Compose uses one guarded writer and stopped-volume recovery

Status: accepted

## Decision

Compact Compose runs one Artifact Server container and one named or bind-mounted
data volume. The container uses the compact runtime with SQLite and file-backed
artifact storage. Docker Compose refuses a second replica because the service
has one project-scoped container name.

The service runs as UID and GID 1000, drops every Linux capability, disables
privilege escalation, uses a read-only root filesystem, and receives writable
storage only at `/var/lib/artifact-server` and `/tmp`. The host port binds to
loopback unless the operator changes it.

Initialization remains an explicit one-time command. The normal server command
requires the initialized volume and never creates a replacement installation
identity or prints a credential.

The first recovery procedure stops the application, archives the complete data
directory, writes a SHA-256 checksum and support manifest, restarts the source,
and verifies restore into an empty volume before serving. Restore rejects an
incomplete marker, checksum mismatch, unsafe path, link, special filesystem
entry, running target, or nonempty target. Artifact Server runs its integrity
check after extraction and does not start the restored service automatically.
Restore writes a durable marker before extracting; runtime configuration
refuses to start while that marker exists. Only a successful integrity check
removes it.

## Why

SQLite coordinates one process well and keeps the shortest team installation
small. A Compose package that silently permits several SQLite writers would
imply a failover model the product does not support.

The complete compact data directory is one recovery unit. Stopping the only
writer before copying avoids an unproved online SQLite and file-storage
snapshot protocol. Restoring into an empty volume prevents old and restored
installation state from being mixed.

The existing lifecycle CLI already owns initialization, configuration parsing,
support manifests, integrity checks, serving, readiness, and shutdown. Compose
invokes that CLI directly rather than adding different product behavior.

## Verification

The release test runs Docker Compose against the exact production image. It
publishes a file and complete site, reads both through their browser hosts,
restarts and replaces the container, backs up while coordinating shutdown,
restores into another clean Compose project, and compares authenticated
artifact details, saved versions, manifests, action IDs and attribution,
access settings, current pointers, installation ID, and file bytes.

The failure test runs the broken configurations. It removes durable storage,
requests two replicas, starts without initialization, removes a generated
secret, denies volume access, violates the domain boundary, supplies incomplete
WorkOS configuration, corrupts a backup, marks a backup incomplete, targets a
running service, and targets a nonempty volume. It also interrupts restore by
removing a referenced blob and proves the partial target cannot start. None may
report ready.

## Limits

This decision does not claim cross-version upgrade compatibility, online
backup, failover, NFS support, automatic proxy or certificate configuration,
or compact-to-external-storage transfer. Each needs a separate tested path.
