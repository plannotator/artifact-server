# Server operations

Use this route only when the user explicitly asks to operate an Artifact Server
installation. Routine publishing, sharing, reviewing, and artifact-version
restore do not require administrator instructions.

## Select the installation and deployment target

Identify the exact installation before changing it. Determine whether it runs
as a local package, Docker Compose, Kubernetes, Cloudflare, AWS, or Google
Cloud. Inspect the matching repository guide instead of translating commands
from another target:

- local package: `docs/deployment.md`
- Docker Compose: `packaging/compose/README.md`
- Kubernetes: `packaging/helm/artifact-server/README.md`
- Cloudflare: `deploy/cloudflare/README.md`
- AWS: `deploy/pulumi/aws/README.md`
- Google Cloud: `deploy/pulumi/gcp/README.md`

Use the target's native tool. Artifact Server does not provide one generic
`artifactserver deploy` command.

## Plan before changing infrastructure

1. Inspect the current release, deployment configuration, storage drivers,
   identity mode, and health without printing credentials.
2. State the proposed change, affected installation, expected interruption,
   rollback path, and any backup or restore consequence.
3. Confirm that the request authorizes that exact material change. Ask before a
   different installation, destructive restore, data deletion, public network
   exposure, or materially expanded scope.
4. Apply the smallest target-native change.
5. Verify both `/health` and `/ready`, then verify one authenticated product
   operation appropriate to the deployment.

## Protect data and credentials

- Never paste infrastructure, database, object-storage, OIDC, or Artifact
  Server credentials into chat or command output.
- Resolve exact backup objects and destinations before a restore. A server
  backup restore is destructive and is different from making an immutable
  artifact version current.
- Preserve the configured metadata and blob-store pairing. Do not point an
  existing metadata store at an unrelated blob namespace.
- Back up before an upgrade or migration when the deployment guide requires it.
- Stop when the installed release, migration direction, storage ownership, or
  rollback path is uncertain.

## Report the result

Name the installation, deployment target, previous and resulting release,
storage mode, checks that passed, and any remaining operator action. If the
operation did not complete, state the exact failed check and leave the existing
installation state clear.
