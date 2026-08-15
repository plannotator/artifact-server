# Artifact Server on Google Cloud

This Pulumi project deploys the Artifact Server container to Cloud Run with:

- Cloud SQL for PostgreSQL with private IP, point-in-time recovery, retained backups, and deletion protection;
- a private, versioned Google Cloud Storage bucket;
- Secret Manager and a dedicated Cloud Run service account;
- a global external Application Load Balancer and Cloud CDN;
- Certificate Manager DNS authorization for the application name and wildcard content name; and
- Cloud DNS records in two existing managed zones.

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

Pulumi mocks prove the resource graph and shared output contract. The native GCS adapter is tested against a pinned emulator. This package is not called cloud-qualified until a disposable GCP project passes publish, read, restart, scale, provider-outage, backup, restore, state recovery, update, and deletion checks.

Run the repeatable live product and upgrade checks against an existing isolated
qualification stack with:

```bash
PULUMI_BACKEND_URL=gs://example-state/artifact-server \
  scripts/run-gcp-deployment-product-qualification.sh

PULUMI_BACKEND_URL=gs://example-state/artifact-server \
ARTIFACT_SERVER_GCP_UPGRADE_IMAGE=REGISTRY/IMAGE@sha256:DIGEST \
  scripts/run-gcp-upgrade-rollback-qualification.sh
```

The product check publishes through the real CLI, reads through the public load
balancer and Cloud CDN, proves that an earlier public version becomes private,
compares versions, searches tags, checks MCP authentication and discovery, and
records 1/10/25/50/100-user read measurements. The upgrade check runs that same
probe after both the rollout and the rollback and rejects changed installation,
database, or bucket identities.
