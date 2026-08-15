# Azure deployment

This Pulumi project installs Artifact Server on Azure Container Apps with:

- Azure Database for PostgreSQL Flexible Server on a private network;
- Azure Blob Storage with Microsoft Entra authentication, versioning, and soft delete;
- one user-assigned managed identity for the application;
- Key Vault references for runtime secrets;
- Azure Front Door for HTTPS, caching, and the application and wildcard content names;
- Azure DNS records in two existing zones; and
- Log Analytics for application logs.

The first installer supports public ingress. Private Azure ingress is intentionally rejected until its complete network path is qualified.

## Required shared resources

The operator supplies two existing Azure DNS zone resource IDs and one versionless Key Vault secret resource ID. The secret must contain a valid PFX certificate whose subject alternative names include both:

- the exact application domain, such as `artifacts.example.com`; and
- the wildcard content domain, such as `*.artifact-content.example.net`.

Azure Front Door does not issue a managed wildcard certificate. The same certificate is also bound to Container Apps so Front Door can preserve the requested host when it reaches the application.

The deployment identity needs permission to create the listed resources and role assignments. The certificate vault can live in a different resource group, but it must be in the same tenant and subscription for this initial installer.

## Configuration and output

The project consumes the shared cloud deployment contract in `src/deployment/cloud-deployment-contract.ts`. Use a digest-pinned OCI image. The active Pulumi stack name must equal `stackName` in the input.

The `deployment` output is the shared, secret-free cloud output. It includes the stable URLs and the Azure resource IDs required for support and recovery. It never returns generated passwords, tokens, Log Analytics keys, or certificate contents.

## Current qualification status

The resource graph, contract rejection paths, output safety, and existing-network adoption are tested locally with Pulumi's resource monitor. A real Azure create, upgrade, restart, backup/restore, failure, and destroy qualification is still required before this installer is called production-qualified.
