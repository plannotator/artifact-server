# Decision 0010: one production OCI image

Status: accepted for the image-foundation phase

## Decision

Artifact Server publishes one Linux OCI image for AMD64 and ARM64. The same
image runs the complete lifecycle CLI. Deployment packages select
`start-compact` or `start-external-storage`; the image does not contain separate
product logic for Docker, Compose, or Kubernetes.

The image contains compiled JavaScript and production dependencies. It starts
as the fixed `node` user, works with a read-only root filesystem, and uses a
writable temporary filesystem. Compact mode receives one writable volume at
`/var/lib/artifact-server` and stores its installation below that path.
External-storage mode receives no writable durable volume.

The build pins the Node base image, Dockerfile frontend, package-manager
version, and SBOM scanner. It produces a multi-architecture OCI archive,
archive checksum, per-platform digests, SPDX software inventories, and SLSA
provenance. Registry releases add an immutable registry digest and signature.

## Why

One image keeps the runtime contract identical across a local container, one
server, Kubernetes, and managed-cloud deployment packages. It also prevents a
compact-only or cloud-only entrypoint from drifting away from the direct local
CLI.

Loading and executing the final OCI archive catches packaging failures that an
in-process test or a second Docker build cannot prove. The image gate therefore
runs both CPU architectures, then performs real compact and Postgres/S3
workflows from the loaded archive.

## Boundaries

- Direct local use remains a normal extracted package and does not require
  Docker.
- The image does not bundle Postgres, MinIO, Caddy, or another infrastructure
  service.
- The image does not choose DNS, TLS, ingress, replica count, or backup policy.
- Compact mode is one process and one writable data volume. It does not claim
  high availability.
- External-storage mode keeps durable records in Postgres and bytes in the
  configured object store. Container replacement must not need local state.
- Image signing cannot be completed by an anonymous local build. It is enforced
  when the release registry and release identity are configured.
