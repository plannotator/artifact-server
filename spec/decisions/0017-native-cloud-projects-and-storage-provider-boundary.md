# Decision 0017: Use native deployment tools and one object-storage provider boundary

Status: accepted for Phase 9

## Decision

Artifact Server does not build a second infrastructure command line on top of
the tools that own the infrastructure.

- Local installations use the direct Artifact Server package.
- One-server installations use Docker Compose.
- Kubernetes installations use Helm.
- Cloudflare installations use the pinned Alchemy project in
  `deploy/cloudflare`.
- AWS, GCP, and Azure installations use the pinned Pulumi projects in
  `deploy/pulumi/aws`, `deploy/pulumi/gcp`, and `deploy/pulumi/azure`.

Operators run `alchemy plan`, `alchemy deploy`, and `alchemy destroy` for
Cloudflare. They run `pulumi preview`, `pulumi up`, and `pulumi destroy` for a
major-cloud stack. Artifact Server may supply scripts that validate
prerequisites or run product probes, but it does not hide, proxy, or reinterpret
an infrastructure plan or update.

All managed-cloud packages implement the shared contract in
[`../cloud-deployment-contract.md`](../cloud-deployment-contract.md). The
contract fixes the product inputs, secret boundary, runtime configuration,
outputs, and release evidence while leaving provider resources in the provider
package.

The external server runtime receives one `ObjectStorageProviderFactory`. A
connected provider supplies immutable blob operations, staged-upload
operations, readiness, and shutdown. The runtime, lifecycle inspection, and
integrity scanner do not construct a provider SDK client. AWS SDK types stay in
the S3 adapter. Native GCS and Azure Blob adapters can therefore be added by
implementing the same factory without changing artifact, HTTP, MCP,
authorization, or external-runtime code. The native GCS and Azure Blob
factories now implement that boundary and the same runtime selects them from
deployment configuration.

## Default managed-cloud topologies

| Target | Runtime | Records | Files | Infrastructure tool |
| --- | --- | --- | --- | --- |
| Cloudflare | Workers | D1 | R2 | Alchemy |
| AWS | ECS Fargate | RDS PostgreSQL | S3 | Pulumi |
| GCP | Cloud Run | Cloud SQL for PostgreSQL | Google Cloud Storage | Pulumi |
| Azure | Container Apps | Azure Database for PostgreSQL Flexible Server | Azure Blob Storage | Pulumi |

EKS, GKE, and AKS use the existing Helm chart. The first cloud packages do not
create or own a Kubernetes cluster.

## State and credentials

Pulumi Cloud is optional. A team can use an existing Pulumi Cloud organization
or a customer-owned S3, GCS, or Azure Blob backend. A customer-owned backend
must exist before the main stack runs; the stack cannot safely create the
bucket that holds its own state. The backend must have encryption, versioning,
backup, access control, and update locking appropriate to the installation.

Stack secrets use a customer-selected Pulumi secrets provider. Application
secrets are generated or adopted by the provider package and stored in the
cloud secret manager. The running application uses workload identity. Static
cloud credentials are not application configuration and are never emitted as
stack outputs.

Cloudflare team and CI deployments use Alchemy's Cloudflare state store. Local
Alchemy state is development-only. The Alchemy package pins its exact version
and Cloudflare compatibility date because Alchemy is still pre-stable.

## Consequences

- Operators see the real infrastructure plan and can use native policy,
  approval, drift, import, and state tooling.
- Artifact Server maintains four small deployment surfaces instead of a custom
  orchestration framework.
- Provider packages can evolve independently, but they must emit the same
  product outputs and pass the same product probes.
- A new object store changes provider composition and deployment configuration,
  not the server core.
- The first-party adapter claim remains evidence-based. An S3-compatible
  service is supported only after it passes the storage contract against the
  actual service.

## Rejected alternatives

### Artifact Server deployment wrapper

Rejected because it would duplicate planning, credentials, state, approvals,
imports, drift handling, failures, and diagnostics while hiding the tool an
operator must still understand during recovery.

### Alchemy for every cloud

Rejected for the initial release. Alchemy is a strong Cloudflare fit, but the
AWS, GCP, and Azure packages need one mature, first-party, cross-cloud resource
surface and customer-owned state today.

### One generic object-storage SDK

Not required. Artifact Server's storage contract is deliberately smaller and
includes its own fingerprint, size, namespace, staging, and immutability rules.
Provider SDKs remain replaceable adapter details.

## Verification

- Dependency checks reject AWS, Google, and Azure SDK imports outside their
  adapters and deployment packages.
- The S3 adapter and every future native adapter run the same real-provider
  streaming, immutability, isolation, restart, authorization, and failure
  contract.
- Every cloud project proves native preview, apply, repeat apply, upgrade,
  compatible rollback, state recovery, backup, restore, and safe destroy.
- Provider outputs contain identifiers and addresses only; tests fail if a
  credential or secret value appears.
- The complete product conformance suite runs against each target before that
  target is advertised as supported.

## Current references

- [Alchemy CLI lifecycle](https://alchemy.run/cli/deploy/)
- [Alchemy Cloudflare state store](https://alchemy.run/state-store/)
- [Pulumi state and backends](https://www.pulumi.com/docs/iac/concepts/state-and-backends/)
- [Pulumi secrets](https://www.pulumi.com/docs/iac/concepts/secrets/)
