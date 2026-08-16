# Compose packages

Compact Compose is the default `compose.yaml`. It runs one Artifact Server
container with SQLite and file storage
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
members without WorkOS. To use WorkOS, set the exact AuthKit issuer in
`ARTIFACT_SERVER_WORKOS_ISSUER`, set `ARTIFACT_SERVER_WORKOS_CLIENT_ID`, and set either
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

## External-storage Compose

External-storage Compose runs one or more stateless Artifact Server containers
against Postgres and object storage that already exist. It uses the same image
as Compact Compose. The override changes the command and removes the compact
data volume and fixed container name. It does not install Postgres, an object
store, a reverse proxy, DNS, or certificates.

Use this package when the installation already has managed or separately
operated providers, or when more than one Artifact Server process is required.
The application containers keep no artifact records or bytes on their local
filesystems.

### Requirements

- Docker with Docker Compose
- the immutable Artifact Server image digest for the release
- a reachable Postgres database dedicated to this installation
- an existing AWS S3 bucket, Cloudflare R2 bucket, or another object store that
  has passed the Artifact Server S3 adapter contract tests
- a gateway or proxy attached to the Compose network when running multiple
  replicas

MinIO is used only by the automated integration test. It is not installed or
recommended by this production package.

### Configure providers and secrets

Copy the external-storage environment example and create the two required
secret files:

```sh
cp .env.external-storage.example .env
install -d -m 0700 /etc/artifact-server
openssl rand -base64 32 > /etc/artifact-server/api-token
chmod 0600 /etc/artifact-server/api-token
```

Write the complete Postgres URL, including its credential, to the database
secret file. Do not put either secret value in `.env`:

```sh
printf '%s\n' 'postgresql://artifactserver:replace_me@postgres.example/artifactserver' \
  > /etc/artifact-server/database-url
chmod 0600 /etc/artifact-server/database-url
```

Edit `.env`. Set the image digest, stable installation ID, administrator email,
application origin, content domain, bucket, region, and exact host paths for the
two secret files. The bucket and database must exist before the next command.

AWS installations should use a container-accessible instance, task, or other
workload identity instead of static S3 keys. For Cloudflare R2, AWS without a
workload identity, or another supported provider that uses static credentials, copy
`compose.external-storage.s3-credentials.yaml.example` to a private operator
file, configure the two additional host secret paths, and include that file in
every command shown below.

### Validate and migrate

Parse the complete configuration and connect to both providers without serving:

```sh
docker compose --file compose.yaml --file compose.external-storage.yaml \
  run --rm --no-deps artifact-server \
  config check --mode external-storage
```

Inspect the database schema, then apply the release migrations explicitly:

```sh
docker compose --file compose.yaml --file compose.external-storage.yaml \
  run --rm --no-deps artifact-server migrate status
docker compose --file compose.yaml --file compose.external-storage.yaml \
  run --rm --no-deps artifact-server migrate apply
```

Serving containers validate the schema. They never apply a migration during
startup.

### Start one or more application processes

The scalable package exposes port 8787 only to its Compose network. Start two
replicas when an existing gateway or reverse proxy is attached to that network:

```sh
docker compose --file compose.yaml --file compose.external-storage.yaml \
  up --detach --scale artifact-server=2 --wait
```

Route both the application hostname and wildcard content hostname to the
`artifact-server` service on port 8787. The gateway decides how traffic is
balanced across replicas.

For one replica on one server, the optional local-port overlay binds port 8787
to loopback so a host-level Caddy, Nginx, Traefik, HAProxy, or company gateway
can reach it:

```sh
docker compose --file compose.yaml --file compose.external-storage.yaml \
  --file compose.external-storage.local-port.yaml \
  up --detach --wait
```

Do not combine the fixed local-port overlay with more than one replica. A
Kubernetes Ingress, cloud load balancer, or provider edge does not use this
overlay and does not need Caddy.

### Replace application containers

Application containers are disposable because all committed state is in
Postgres and object storage:

```sh
docker compose --file compose.yaml --file compose.external-storage.yaml \
  up --detach --scale artifact-server=2 \
  --force-recreate --wait
```

Replacement preserves artifact IDs, version IDs, current pointers, manifests,
access settings, action history, and bytes. If either provider is unavailable,
the schema is incompatible, or a required secret cannot be read, the new
container does not report ready.

### Back up and restore

Treat Postgres and the complete Artifact Server installation prefix in object
storage as one backup unit. The first supported procedure is offline:

1. Stop every Artifact Server application container.
2. Create a transaction-consistent logical Postgres backup.
3. Copy the complete installation prefix from object storage.
4. Record checksums and the output of `support manifest` with both halves.
5. Restore both halves into empty providers, run `integrity check`, and start
   the application only after the report is healthy.

Provider-native snapshots are acceptable only when they produce the same
coordinated, restorable result. Helm, Compose, and Artifact Server do not claim
that a database-only or bucket-only backup is complete.

### Verify the release package

From the source checkout:

```sh
pnpm verify:external-storage-compose
```

The gate builds and loads the real production image, starts real Postgres and
S3-compatible processes outside the application package, runs two Artifact
Server replicas, publishes through both, forces a write conflict, replaces
every application container, checks exact records and bytes through each
replacement, and proves incomplete or unavailable provider configurations do
not report ready. The gate is also part of `pnpm verify:iteration`.
