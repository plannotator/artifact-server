# Decision 0018: Support Azure through Kubernetes

Status: accepted on August 15, 2026

## Decision

Artifact Server will not ship an Azure-specific Pulumi project or claim a
turnkey Azure deployment.

Azure teams use the same Helm chart as every other Kubernetes team. AKS is an
official Kubernetes environment only after the chart's normal Kubernetes
qualification passes there; it does not require an Azure-specific application
architecture.

The native Azure Blob storage adapter remains in the server as a preview. It is
useful for AKS and other customer-managed deployments, but it is not called
supported until the storage contract passes against a real Azure account. The
adapter does not create Azure infrastructure.

## Official deployment options

- Direct executable for local use.
- Docker Compose for one server.
- Helm for Kubernetes, including AKS.
- Alchemy for Cloudflare.
- Pulumi for AWS.
- Pulumi for GCP.

There is no direct Azure installer, Azure release gate, or Azure entry in the
shared cloud-deployment input contract.

## Why

The Helm chart already gives Azure users a standard path without maintaining a
second unqualified topology based on Container Apps, Front Door, Key Vault,
PostgreSQL Flexible Server, and Pulumi Azure Native. Removing that topology
reduces code, documentation, release testing, and support obligations while
preserving a serious Azure option for teams that run AKS.

Keeping the storage adapter separate preserves useful provider support without
pretending that a complete Azure installation has been tested.

## Verification

- No released command or document points to `deploy/pulumi/azure`.
- The shared cloud-deployment contract accepts only Cloudflare, AWS, and GCP.
- Azure does not appear as a conformance deployment target.
- The Helm chart remains provider-neutral and documents AKS as an applicable
  Kubernetes environment.
- Azure Blob is labeled preview in configuration and product documentation.
- A live Azure storage-contract run is required before removing the preview
  label.
