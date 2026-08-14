# Compact Compose

Compact Compose runs one Artifact Server container with SQLite and file storage
in one Docker volume. It is intended for one private team on one server. It does
not provide application failover or horizontal scaling.

The package does not include Caddy, another reverse proxy, DNS, or certificates.
The default configuration binds to `127.0.0.1` and uses localhost addresses. A
server reached from another device needs a trusted reverse proxy and the two
DNS names described under [Network access](#network-access).

## Requirements

- Docker with Docker Compose
- the immutable Artifact Server image digest for the release
- enough local disk for the current data volume, a backup copy, and growth

This package is currently tested with Docker Compose 5.1.4. A minimum supported
Compose version will be published after the compatibility matrix runs.

## Install

Copy this directory to the server. Work from the copied directory so Docker
Compose reads its `.env` file.

```sh
cp .env.example .env
```

Edit `.env`. Set `ARTIFACT_SERVER_IMAGE` to the published image digest. Do not
use `latest` or another floating tag.

Initialize the empty data volume:

```sh
docker compose run --rm --no-deps artifact-server \
  init --admin-email admin@example.com \
  --data /var/lib/artifact-server/data
```

The command prints the installation ID and a one-time browser bootstrap
credential. Store the credential securely. Later server logs do not print it.

Start the server:

```sh
docker compose up --detach --wait
```

Check the process and full readiness separately:

```sh
curl --fail http://127.0.0.1:8787/health
curl --fail http://127.0.0.1:8787/ready
```

`docker compose restart` and `docker compose up --detach --force-recreate`
preserve the named data volume. Do not scale the service. The package assigns a
fixed container name so Docker Compose rejects a second application writer.

## Back up

The backup command stops the service, copies the complete data directory,
writes a SHA-256 checksum and support manifest, then restarts the service and
waits for health. The backup target must not exist.

```sh
./compact-backup.sh /srv/backups/artifact-server/2026-08-14
```

The resulting directory contains:

- `data.tar`: the complete persistent data directory
- `data.tar.sha256`: the archive checksum
- `support-manifest.json`: the installation, image, schema, and adapter record

If the operation fails, the directory retains an `INCOMPLETE` marker and the
restore command rejects it.

## Restore

Restore requires a stopped service and an empty target volume. The command
checks the archive digest and paths, rejects links and unsupported filesystem
entries, extracts the data, and runs the Artifact Server integrity check. It
does not start the restored service. Extraction first writes a durable
`.restore-incomplete` marker inside the target data directory. Artifact Server
refuses to start while that marker exists, so an interrupted or failed restore
cannot later serve partial state. The restore command removes the marker only
after the integrity check succeeds.

Use a new Compose project name for a recovery drill or when the existing volume
must remain untouched:

```sh
export COMPOSE_PROJECT_NAME=artifact-server-restored
./compact-restore.sh /srv/backups/artifact-server/2026-08-14
docker compose up --detach --wait
```

Keep the application origin and content domain unchanged when restoring the
same installation. Confirm the installation ID, artifacts, versions, action
history, current pointers, access settings, manifests, and file bytes before
routing users to the restored service.

The restore command refuses a running target, a nonempty volume, a missing or
incomplete backup, a checksum mismatch, an unsafe archive path, and an archive
containing links or special files.

## Network access

No proxy is needed when only the same computer uses the default localhost
configuration.

A server reached from another device needs:

- an HTTPS application origin, such as `https://artifacts.example.com`;
- a separate registrable wildcard content domain, such as
  `*.content.example.net`;
- a trusted TLS reverse proxy that routes both names to port 8787 and preserves
  the validated host and protocol; and
- firewall rules chosen by the server administrator.

Caddy is one possible proxy. Nginx, Traefik, HAProxy, or an existing company
gateway can provide the same boundary. This Compose package does not install or
configure a proxy, issue certificates, open a firewall, or create a tunnel.

Changing an artifact to public removes the Artifact Server login check. It does
not make a private server reachable from the internet.

## Optional WorkOS login

The base installation supports its generated local administrator and admitted
members without WorkOS. To use WorkOS, set
`ARTIFACT_SERVER_WORKOS_CLIENT_ID` and either
`ARTIFACT_SERVER_WORKOS_API_KEY` or
`ARTIFACT_SERVER_WORKOS_API_KEY_FILE`. A file-backed key also needs a Compose
override that mounts the file read-only. Use a dedicated Artifact Server WorkOS
environment. Partial WorkOS configuration makes startup fail.

## Limits

- Exactly one Artifact Server application process is supported.
- The data volume must use a filesystem suitable for SQLite locking and atomic
  replacement. NFS-like filesystems are not supported without separate proof.
- Cross-version upgrade and rollback compatibility is not yet claimed. It
  requires two released images and a tested schema compatibility path.
- Compact-to-external-storage transfer is not implemented yet.
