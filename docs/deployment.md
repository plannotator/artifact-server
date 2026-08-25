# Deploy Artifact Server

Artifact Server supports local, single-server, Kubernetes, and managed-cloud deployments.

## Choose a deployment

| Deployment | Data layer | Detailed guide |
| --- | --- | --- |
| Cloudflare | D1 and R2 | [Cloudflare](../deploy/cloudflare/README.md) |
| Compact Compose | SQLite and one file volume | [Compose](../packaging/compose/README.md) |
| External-storage Compose | PostgreSQL and S3-compatible storage | [Compose](../packaging/compose/README.md) |
| Kubernetes | PostgreSQL and object storage | [Helm](../packaging/helm/artifact-server/README.md) |
| AWS | ECS, RDS, and S3 | [AWS Pulumi](../deploy/pulumi/aws/README.md) |
| Google Cloud | Cloud Run, Cloud SQL, and Cloud Storage | [Google Cloud Pulumi](../deploy/pulumi/gcp/README.md) |

## Configure the shared boundaries

Each remote deployment needs these boundaries:

1. Configure one HTTPS application origin.
2. Configure a separate wildcard content domain.
3. Configure WorkOS or one generic OIDC provider.
4. Admit team members through Artifact Server.
5. Store service credentials outside source control.
6. Back up the database and artifact files.
7. Pin release deployments to an immutable image digest.

The application origin serves Artifact Server, its API, and its MCP endpoint. The content domain serves untrusted artifact files.

## Select storage

Compact Compose uses one SQLite database and one file volume. Run only one application process with this data layer.

External-storage deployments use PostgreSQL and object storage. These deployments support replaceable application processes and horizontal scaling.

## Configure authentication

Local-owner access works only on an exact loopback origin. Do not use it for remote access.

Remote deployments use WorkOS or a generic OIDC provider. Network access and application authorization remain separate controls.

## Back up the installation

Back up metadata and artifact files as one coordinated recovery set. Use the procedure in the selected deployment guide.

Do a restore test before the first production release. Then repeat the test after a storage or deployment change.
