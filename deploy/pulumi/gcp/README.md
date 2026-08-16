# Artifact Server on Google Cloud

This Pulumi project deploys the Artifact Server container to Cloud Run with:

- Cloud SQL for PostgreSQL with private IP, point-in-time recovery, retained backups, and deletion protection;
- a private, versioned Google Cloud Storage bucket;
- Secret Manager and a dedicated Cloud Run service account;
- a global external Application Load Balancer and Cloud CDN;
- Certificate Manager DNS authorization for the application name and wildcard content name; and
- Cloud DNS records in two existing managed zones.

Cloud Scheduler invokes one private Cloud Run Job every 15 minutes to remove
expired uploads that were never committed. The Job uses the application
workload identity, Cloud SQL connection, GCS bucket, and Secret Manager values.
A separate scheduler identity has only permission to invoke that Job. Serving
instances disable their internal cleanup loop.

Cloud CDN honors the application's cache headers for ordinary requests.
Requests that contain a `Range` header bypass the CDN and reach Artifact Server
so single ranges, malformed ranges, and unsupported multiple ranges have the
same result on cache hits and cache misses.

The current package supports public ingress. It rejects `ingress: private` instead of creating an unqualified private path. A future private path needs its own internal load-balancer and network qualification.

## Required provider configuration

Set `gcp:project` to a dedicated Google Cloud project. Set `gcp:region` to the same value as `region` when you set a provider region.

For public ingress, `dnsZoneIds.application` and `dnsZoneIds.content` are Cloud DNS **managed-zone names**, not numeric IDs. The two zones must already be authoritative for the requested application and content domains.

Use a digest-pinned multi-architecture image. Use a `gs://` backend or Pulumi Cloud for state, and configure a secrets provider before adding secret config.

## Network adoption

By default the project creates one VPC, one regional application subnet, and private service networking for Cloud SQL. To adopt an existing network, provide:

- `vpcName`: full VPC resource name or accepted VPC name;
- `vpcEgressConfiguration`: the regional subnetwork used by Cloud Run direct VPC egress; and
- `privateServiceConnection`: the existing private-services peering identifier recorded in the support manifest.

The operator is responsible for proving that an adopted network has working private services access, enough subnet addresses for the maximum Cloud Run instance count, and the required organization policies.

## Qualification status

Pulumi mocks prove the resource graph and shared output contract. The native GCS adapter is tested against a pinned emulator.

The public deployment has passed a live, isolated GCP qualification: create and
no-change preview; publish, read, access control, MCP, and bounded
1/10/25/50/100-user reads; upgrade and rollback; API-secret rotation; exact
Pulumi checkpoint import; Cloud SQL backup restoration into a temporary private
instance; and an exact GCS object copy by name, size, and checksum. Temporary
restore resources were deleted after verification.

This is deliberately a minimum provider qualification. It does not claim
cross-region failover, automated disaster recovery, continuous chaos tests, or
private ingress. The supported direct GCP target is public ingress with private
Cloud SQL, private object storage, workload identity, and the lifecycle checks
listed above. Teams that require private ingress use the qualified Helm chart
on GKE until a separate Cloud Run private-ingress path is implemented and
qualified.

Run the repeatable live product and upgrade checks against an existing isolated
qualification stack with:

```bash
PULUMI_BACKEND_URL=gs://example-state/artifact-server \
  scripts/run-gcp-deployment-product-qualification.sh

PULUMI_BACKEND_URL=gs://example-state/artifact-server \
ARTIFACT_SERVER_GCP_UPGRADE_IMAGE=REGISTRY/IMAGE@sha256:DIGEST \
  scripts/run-gcp-upgrade-rollback-qualification.sh

PULUMI_BACKEND_URL=gs://example-state/artifact-server \
  scripts/run-gcp-secret-rotation-qualification.sh

PULUMI_BACKEND_URL=gs://example-state/artifact-server \
  scripts/run-gcp-state-recovery-qualification.sh
```

The product check publishes through the real CLI, reads through the public load
balancer and Cloud CDN, proves that an earlier public version becomes private,
compares versions, searches tags, checks MCP authentication and discovery, and
records 1/10/25/50/100-user read measurements. The upgrade check runs that same
probe after both the rollout and the rollback and rejects changed installation,
database, or bucket identities.

The credential-rotation check adds a temporary Secret Manager version, rolls a
new Cloud Run revision, proves that only the new credential works, publishes
through the replacement revision, restores the original credential, destroys
the temporary secret version, and reconciles the service with Pulumi.

## Delete a stack safely

The artifact bucket uses `forceDestroy: false`. A normal `pulumi destroy` cannot
silently delete published files. Back up anything that must be kept, run the
destroy, explicitly empty every version from the named artifact bucket, and run
the same destroy command again.

Cloud Run Direct VPC egress can retain its serverless subnet addresses for one
to two hours after the service is deleted. If the second destroy reports a
`serverless-ipv4-*` address using the subnet, wait for Google to release it and
run the same destroy command again. Do not manually delete that address. See
[Google's Direct VPC egress cleanup documentation](https://docs.cloud.google.com/run/docs/configuring/vpc-direct-vpc#cannot_delete_subnet).

Cloud SQL can retain producer-side network resources for up to four days after
instance deletion. The service-networking connection therefore uses
`deletionPolicy: "ABANDON"`, Google's documented declarative-destroy workaround.
Google removes its producer-side resources after the recovery window. See
[Google's private services access deletion documentation](https://docs.cloud.google.com/vpc/docs/configure-private-services-access#delete-connection).

Live records are in `evidence/gcp-deployment-product.json`,
`evidence/gcp-upgrade-rollback.json`, `evidence/gcp-secret-rotation.json`,
`evidence/gcp-state-recovery.json`, `evidence/gcp-minimum-recovery.json`, and
`evidence/gcp-destroy.json`.
