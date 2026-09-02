# Cloud deployment contract

Status: shared executable contract and AWS and GCP provider packages implemented.
The public AWS and GCP variants passed isolated live qualification. Signed
release evidence and the AWS private-ingress qualification remain open.

This document is the handoff boundary for the Cloudflare, AWS, and GCP
deployment work. It says exactly what every package receives, what it creates,
what it gives the Artifact Server process, and what it returns to an operator.

## Tool and directory responsibilities

| Target | Operator commands | Package directory | Default topology |
| --- | --- | --- | --- |
| Cloudflare | `alchemy plan`, `alchemy deploy`, `alchemy destroy` | `deploy/cloudflare` | Workers, D1, R2 |
| AWS | `pulumi preview`, `pulumi up`, `pulumi destroy` | `deploy/pulumi/aws` | ECS Fargate, RDS PostgreSQL, S3 |
| GCP | `pulumi preview`, `pulumi up`, `pulumi destroy` | `deploy/pulumi/gcp` | Cloud Run, Cloud SQL PostgreSQL, GCS |

There is no `artifactserver deploy` wrapper. Provider developers own only their
package, provider tests, and provider documentation. They do not change the
artifact model, HTTP routes, MCP tools, authorization policy, database schema,
or shared storage ports.

## Executable contract

The provider-neutral TypeScript boundary lives in
`src/deployment/cloud-deployment-contract.ts`.
It is ordinary library code, not a deployment wrapper. Each Pulumi or Alchemy
project passes its native configuration object into `parseCloudDeploymentInput`
before defining provider resources. After an apply, the provider package's
verification command passes the realized machine-readable outputs into
`parseCloudDeploymentOutput`. Native Pulumi `Output` values remain native
Pulumi values inside the infrastructure program; the contract does not wrap or
replace them.

The parser rejects unknown keys and applies the shared `0.01` request-log sample
default. It enforces domain isolation, pinned images, capacity, backup,
deletion-protection, DNS, WorkOS reference, Pulumi-state, and Alchemy-state
rules before a provider write. Output parsing verifies the exact requested URLs
and rejects credential-bearing URLs, signed URLs, private keys, access keys,
JWT-shaped tokens, connection strings, and any secret value supplied through an
Effect `Redacted` wrapper. Errors identify the unsafe field but never include
the rejected value.

Provider projects emit `CloudDeploymentEvidence`. Partial or failed evidence is
valid diagnostic input. `validateCloudDeploymentReleaseEvidence` is the stricter
release gate: it requires every lifecycle, recovery, ingress, identity,
performance, destroy, and permanent-deletion check below to pass. These local
contract tests prove validation behavior only. They do not satisfy `DEP-021`;
that requirement still needs apply and failure evidence from each real cloud.

## Shared operator inputs

Alchemy and Pulumi use their native configuration files and secret handling,
but every package must expose these names and meanings.

| Name | Required | Type and rule |
| --- | --- | --- |
| `installationName` | yes | 1–40 lowercase letters, numbers, and hyphens; stable after creation |
| `environment` | yes | `development`, `staging`, or `production` |
| `region` | yes | One provider region supported by the selected package |
| `imageReference` | yes for AWS/GCP | OCI image reference pinned by digest, never a floating tag |
| `applicationDomain` | yes | Exact application host, such as `artifacts.example.com` |
| `contentDomain` | yes | Separate registrable content domain used for version hosts, such as `artifact-content.example.net` |
| `bootstrapAdministratorEmail` | yes | Existing administrator email; not a public sign-up address |
| `ingress` | yes | `public` or `private` |
| `capacity` | yes | Object with `minimumInstances`, `maximumInstances`, `cpu`, and `memoryMiB`; minimum is at least 1 in production |
| `databasePlan` | yes | `small`, `standard`, or `high-availability`; provider mapping is pinned in that package |
| `backupRetentionDays` | yes | Integer from 7 through 35; production minimum is 14 |
| `deletionProtection` | yes | Must be `true` in production; a separate deliberate recovery procedure is required to disable it |
| `existingNetwork` | no | Provider-specific existing network and subnet identifiers; if absent, the package creates its documented network |
| `dnsZoneIds` | public only | Existing authoritative zone IDs for `application` and `content`; the IDs must differ because the domains have separate registrable boundaries |
| `workosClientId` | hosted login only | Non-secret WorkOS client identifier for this environment |
| `workosIssuer` | hosted login only | Exact HTTPS AuthKit issuer for this environment |
| `workosApiKeySecretRef` | hosted login only | Provider secret-manager reference, never the key value |
| `otlpEndpoint` | no | HTTPS OTLP collector address |
| `requestLogSampleRate` | no | Number from 0 through 1; default `0.01` |
| `resourceTags` | no | String map merged with required Artifact Server management tags |

The package rejects an unpinned image, equal application and content domains,
an invalid capacity range, a public deployment without a DNS zone, and a
production deployment without deletion protection. It performs these checks
before a provider write.

### Pulumi-only stack prerequisites

Each direct-cloud stack additionally receives:

| Name | Required | Rule |
| --- | --- | --- |
| `stateBackendUrl` | yes | Existing Pulumi Cloud organization or existing `s3://` or `gs://` backend selected with `pulumi login` |
| `secretsProvider` | yes | Pulumi Cloud default or customer KMS, Cloud KMS, Vault, or protected passphrase provider |
| `stackName` | yes | Stable Pulumi stack name, normally the environment name |

The main stack does not create its own state backend. Customer-owned state is
an explicit prerequisite because a stack cannot recoverably manage the bucket
that contains its own state. Pulumi Cloud remains optional.

### Cloudflare-only stack prerequisites

The Cloudflare package additionally receives:

| Name | Required | Rule |
| --- | --- | --- |
| `stage` | yes | Stable Alchemy stage; production uses `production` |
| `cloudflareAccountId` | yes | Target account identifier |
| `compatibilityDate` | yes | Exact date pinned by the package release |
| `stateStore` | yes | `cloudflare`; local state is allowed only for individual development |

Alchemy and the Cloudflare compatibility date are exact package dependencies.
Team and CI deployments use `Cloudflare.state()`; the account-level state
Worker and its Secrets Store values remain outside any one Artifact Server
stack.

## Provider-specific configuration

### AWS

- `existingNetwork`, when supplied, contains `vpcId`, at least two application
  subnet IDs, at least two load-balancer subnet IDs, and at least two database
  subnet IDs across two availability zones.
- Without it, the package creates one VPC, public load-balancer subnets,
  private ECS and database subnets across two availability zones, and the
  documented outbound path.
- `databasePlan` maps to one pinned RDS PostgreSQL instance class, allocated
  storage, Multi-AZ setting, and connection limit. Production `high-availability`
  is Multi-AZ.
- The ECS task role receives only its S3 installation prefix, required secret
  versions, telemetry, and health dependencies. The task receives no static AWS
  key.
- Public ingress creates and validates separate ACM certificates for the
  application host and wildcard content host in their respective Route 53
  zones. Private ingress requires `tlsCertificateArn` for an existing ACM
  certificate that covers both names. Private Route 53 records are created when
  `dnsZoneIds` is supplied; otherwise the operator owns private DNS.
- Public ingress places one CloudFront distribution in front of the load
  balancer for both the application host and the wildcard content host, with a
  separate DNS-validated `us-east-1` ACM certificate covering both names. The
  distribution honors origin `Cache-Control` headers and caches nothing without
  origin instruction, keys the cache on host, query string, and
  `Authorization`, forwards every viewer header, cookie, and query string to
  the origin, compresses responses, and waits 60 seconds for origin responses
  to cover agent long-polling. Route 53 aliases both names to the
  distribution, and the load-balancer security group accepts HTTPS only from
  the CloudFront origin-facing managed prefix list. Private ingress has no
  CloudFront distribution.
- A private load balancer accepts the VPC CIDR by default. Set
  `privateIngressCidrs` when VPN, transit-gateway, peered-network, or on-premises
  callers arrive from other IPv4 ranges.
- Capacity validation reserves enough database connections for the configured
  maximum task count and a rolling deployment at 200 percent capacity. Each
  task's Postgres pool size is configurable through
  `ARTIFACT_SERVER_POSTGRES_MAX_CONNECTIONS` (default 10 connections) and feeds
  that reservation math. An unsafe task-count, pool-size, and RDS-plan
  combination is rejected before deployment.

### GCP

- `existingNetwork`, when supplied, contains a VPC name, direct VPC-egress
  subnetwork, and the private service connection required by
  Cloud SQL.
- Without it, the package creates those network resources in the selected
  project and region.
- `databasePlan` maps to one pinned Cloud SQL PostgreSQL tier, storage policy,
  regional availability setting, and connection limit.
- The Cloud Run service account receives only its bucket prefix, required
  secret versions, Cloud SQL connection, and telemetry permissions. It uses
  Application Default Credentials; it receives no service-account key file.

## Runtime configuration the package must produce

Every package supplies the running application with the common values below.
Secrets are mounted, injected by the managed runtime, or fetched from the
provider secret manager. They are not plain stack outputs or task-definition
values. The direct-cloud Pulumi packages inject the API token, database URL, and
optional WorkOS key from their secret manager and expose typed WorkOS inputs
only; generic OIDC runs on those deployments through container environment
variables, with typed OIDC inputs a scoped follow-up. Compose and Kubernetes use
the file variants below and support either browser-login family.

A package supplies one browser-login family or neither. The WorkOS variables and
the generic OIDC variables are mutually exclusive, and each family is
all-or-nothing; a package that emits part of a family, or both families, makes
the application fail at startup.

| Runtime value | Source |
| --- | --- |
| `ARTIFACT_SERVER_INSTALLATION_ID` | Stable generated installation ID preserved by backup and restore |
| `ARTIFACT_SERVER_ORIGIN` | `https://` plus `applicationDomain` |
| `ARTIFACT_SERVER_CONTENT_DOMAIN` | `contentDomain` |
| `ARTIFACT_SERVER_BOOTSTRAP_ADMIN_EMAIL` | Shared input |
| `ARTIFACT_SERVER_API_TOKEN_FILE` or `ARTIFACT_SERVER_API_TOKEN` | Provider secret; fallback automation credential only |
| `ARTIFACT_SERVER_DATABASE_URL_FILE` or `ARTIFACT_SERVER_DATABASE_URL` | Provider-managed PostgreSQL connection secret |
| `ARTIFACT_SERVER_POSTGRES_MAX_CONNECTIONS` | Per-process Postgres pool size; `10` unless the package proves another value |
| `ARTIFACT_SERVER_HOST` | `0.0.0.0` inside the managed runtime |
| `ARTIFACT_SERVER_PORT` | `8787` |
| `ARTIFACT_SERVER_REQUEST_LOG_SAMPLE_RATE` | Shared input or `0.01` |
| `ARTIFACT_SERVER_WORKOS_CLIENT_ID` | Hosted login only; shared WorkOS client input |
| `ARTIFACT_SERVER_WORKOS_ISSUER` | Hosted login only; exact AuthKit issuer |
| `ARTIFACT_SERVER_WORKOS_API_KEY_FILE` or `ARTIFACT_SERVER_WORKOS_API_KEY` | Hosted login only; provider secret reference |
| `ARTIFACT_SERVER_OIDC_ISSUER` | Generic OIDC login only; exact issuer URL, HTTPS with no query or fragment |
| `ARTIFACT_SERVER_OIDC_CLIENT_ID` | Generic OIDC login only; registered client for this installation |
| `ARTIFACT_SERVER_OIDC_CLIENT_SECRET_FILE` or `ARTIFACT_SERVER_OIDC_CLIENT_SECRET` | Generic OIDC login only; optional provider secret reference, omitted for a public PKCE client |
| `ARTIFACT_SERVER_OIDC_SCOPES` | Generic OIDC login only; defaults to `openid email profile` |
| `ARTIFACT_SERVER_READINESS_WITHDRAWAL_MS` | `1000` unless the package proves another value |
| `ARTIFACT_SERVER_SHUTDOWN_DEADLINE_MS` | `10000` unless the package proves another value |

Provider storage configuration is adapter-specific:

| Adapter | Required runtime configuration | Credential path |
| --- | --- | --- |
| S3 | `ARTIFACT_SERVER_OBJECT_STORAGE_PROVIDER=s3`, `ARTIFACT_SERVER_S3_BUCKET`, `ARTIFACT_SERVER_S3_REGION`, optional `ARTIFACT_SERVER_S3_ENDPOINT`, and optional `ARTIFACT_SERVER_S3_FORCE_PATH_STYLE` | ECS task role or AWS provider chain; `ARTIFACT_SERVER_S3_ACCESS_KEY_ID_FILE` and `ARTIFACT_SERVER_S3_SECRET_ACCESS_KEY_FILE` exist only for explicit self-hosted S3-compatible deployments |
| GCS | `ARTIFACT_SERVER_OBJECT_STORAGE_PROVIDER=gcs`, `ARTIFACT_SERVER_GCS_PROJECT_ID`, and `ARTIFACT_SERVER_GCS_BUCKET` | Cloud Run service account through Application Default Credentials; no service-account key file |
| Azure Blob (preview) | `ARTIFACT_SERVER_OBJECT_STORAGE_PROVIDER=azure-blob`, `ARTIFACT_SERVER_AZURE_BLOB_ACCOUNT_URL`, and `ARTIFACT_SERVER_AZURE_BLOB_CONTAINER` | AKS workload identity or another identity exposed through the default Azure credential chain; no client secret or storage account key |
| R2 Worker binding | `ARTIFACT_SERVER_OBJECT_STORAGE_PROVIDER=r2` and the typed `ARTIFACT_SERVER_R2_BUCKET` Worker binding | Cloudflare binding; no S3 or account key in the Worker |

The GCS and preview Azure Blob names are executable configuration in the Node runtime.
The R2 binding is executable only in the separate Cloudflare Worker runtime.
All adapters implement the same provider-neutral server contract.

## Required stack outputs

Every successful deployment emits a machine-readable output object with these
keys:

| Output | Meaning |
| --- | --- |
| `installationId` | Stable Artifact Server installation identity |
| `applicationUrl` | Exact browser application origin |
| `contentDomain` | Exact base domain used by version hosts |
| `mcpUrl` | Exact remote MCP endpoint |
| `healthUrl` | Liveness endpoint |
| `readinessUrl` | Dependency-readiness endpoint |
| `imageDigest` | Deployed OCI digest, or Worker bundle digest on Cloudflare |
| `runtimeResourceId` | ECS service, Cloud Run service, or Worker ID |
| `databaseResourceId` | RDS, Cloud SQL, PostgreSQL Flexible Server, or D1 ID |
| `objectStorageResourceId` | S3 bucket, GCS bucket, Blob container, or R2 bucket ID |
| `workloadIdentityResourceId` | Task role, service account, managed identity, or Worker identity boundary |
| `secretResourceIds` | Map of secret names to provider resource IDs; never secret values |
| `networkResourceIds` | Map of created or adopted network resource IDs |
| `logDestination` | Provider log group, project log scope, workspace, or Worker log destination |
| `stateBackend` | Redacted Pulumi backend address or Alchemy state-store identity |
| `supportManifestLocation` | Durable location of the secret-free installation manifest |

Output validation fails when a secret, credential-bearing URL, database
password, access token, API key, private key, or signed object URL appears.

## Resource invariants

Every provider package must produce all of the following:

1. Application and content hosts are separate, use HTTPS, and route only their
   allowed surfaces.
2. Public artifacts can be cached; account-required content and every
   management response use `private, no-store` behavior, except the
   authenticated immutable version file route, which may use `private`
   immutable browser caching with a strong `ETag`.
3. Postgres and object storage are private by default and use encryption at
   rest and in transit.
4. The runtime can scale horizontally and has no correctness dependency on
   process memory or local disk.
5. Object keys are installation-scoped by the storage adapter; no request or
   artifact value selects a bucket or raw prefix.
6. Database and object storage have deletion protection, provider backup, and a
   documented coordinated restore path.
7. The deployment emits logs, request metrics, health, readiness, and a
   secret-free support manifest.
8. The package grants least privilege through workload identity and has no
   static application cloud credential.

## Lifecycle and release evidence

Provider work is complete only after real-cloud evidence proves:

- native preview makes no writes;
- clean apply and repeat apply;
- product publish, open, private access, projects, versions, comparison, CLI,
  and MCP behavior;
- horizontal replica concurrency;
- image upgrade and schema-compatible rollback;
- provider outage, partial apply, interrupted update, and state recovery;
- coordinated database and object restore with identical installation,
  project, artifact, and version IDs;
- workload-identity and secret rotation;
- every ingress mode that the package advertises (AWS supports public and
  private; the first GCP package supports public only);
- bounded 1, 10, 25, 50, and 100-user performance and cost evidence;
- safe destroy that retains durable data by default; and
- separately confirmed permanent deletion.

The evidence file records the Artifact Server version, image digest,
infrastructure-tool version, provider-package versions, region, realized
resource sizes, test revision, and timestamps. Passing one cloud does not
qualify another.

## Object-storage adapter contract

The server runtime consumes `ObjectStorageProviderFactory`. The factory creates
one installation-scoped provider with:

- `blobs.inspect`, `blobs.open`, and verified streaming `blobs.put`;
- `staging.open` and verified streaming `staging.put`;
- `readiness(signal)` for a bounded provider check; and
- `close()` for provider-owned client cleanup.

An adapter must stream without buffering a complete file, verify declared byte
count and SHA-256, preserve immutable content-addressed bytes, isolate
installation prefixes, reject hostile identifiers, survive restart, fail
closed when unauthorized or unavailable, and clean up interrupted multipart
writes. Provider SDK types and errors cannot enter application, HTTP, MCP,
repository, or artifact model types.

Real MinIO qualifies the S3-compatible contract implementation. Real AWS S3
qualifies AWS. Real GCS tests are required for the supported native GCS adapter.
The Azure Blob adapter remains preview until the same contract passes against
real Azure. A provider is not supported merely because it claims compatibility.

## Primary infrastructure references

- [Alchemy deployment lifecycle](https://alchemy.run/cli/deploy/)
- [Alchemy Cloudflare state](https://alchemy.run/state-store/)
- [Pulumi state backends](https://www.pulumi.com/docs/iac/concepts/state-and-backends/)
- [Pulumi secrets providers](https://www.pulumi.com/docs/iac/concepts/secrets/)
- [Pulumi AWS ECS service](https://www.pulumi.com/registry/packages/aws/api-docs/ecs/service/)
- [Pulumi GCP Cloud Run v2 service](https://www.pulumi.com/registry/packages/gcp/api-docs/cloudrunv2/service/)
