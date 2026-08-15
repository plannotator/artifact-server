import * as pulumi from "@pulumi/pulumi";

import type {AzureCloudDeploymentInput} from
  "../../../src/deployment/cloud-deployment-contract.js";

/** Parsed Azure DNS zone resource identifier. */
export interface ParsedAzureResourceId {
  readonly name: string;
  readonly resourceGroupName: string;
}

/** Parsed, versionless Key Vault secret resource identifier. */
export interface ParsedKeyVaultSecretId extends ParsedAzureResourceId {
  readonly secretName: string;
  readonly secretUrl: string;
  readonly vaultId: string;
}

/** Validate every provider-specific resource identifier before a preview. */
export function validateAzureResourceIdentifiers(
  input: AzureCloudDeploymentInput,
): void {
  const certificateId = requireTlsCertificateSecretId(input);
  parseKeyVaultSecretId(certificateId);
  if (input.workosApiKeySecretRef !== undefined) {
    parseKeyVaultSecretId(input.workosApiKeySecretRef);
  }
  const application = parseDnsZoneId(requireDnsZoneId(input, "application"));
  const content = parseDnsZoneId(requireDnsZoneId(input, "content"));
  relativeDnsName(input.applicationDomain, application.name);
  relativeDnsName(`*.${input.contentDomain}`, content.name);
}

/** Parse one complete Azure DNS zone resource identifier. */
export function parseDnsZoneId(resourceId: string): ParsedAzureResourceId {
  const match = /^\/subscriptions\/[^/]+\/resourceGroups\/([^/]+)\/providers\/Microsoft\.Network\/dnsZones\/([^/]+)$/iu.exec(resourceId);
  if (match?.[1] === undefined || match[2] === undefined) {
    throw new pulumi.RunError(
      "Azure DNS zone IDs must be complete Microsoft.Network/dnsZones resource IDs.",
    );
  }
  return {name: match[2], resourceGroupName: match[1]};
}

/** Parse one complete, versionless Key Vault secret resource identifier. */
export function parseKeyVaultSecretId(resourceId: string): ParsedKeyVaultSecretId {
  const match = /^(\/subscriptions\/[^/]+\/resourceGroups\/([^/]+)\/providers\/Microsoft\.KeyVault\/vaults\/([^/]+))\/secrets\/([^/]+)$/iu.exec(resourceId);
  if (
    match?.[1] === undefined || match[2] === undefined ||
    match[3] === undefined || match[4] === undefined
  ) {
    throw new pulumi.RunError(
      "Azure secret references must be complete, versionless Key Vault secret resource IDs.",
    );
  }
  return {
    name: match[3],
    resourceGroupName: match[2],
    secretName: match[4],
    secretUrl: `https://${match[3]}.vault.azure.net/secrets/${match[4]}`,
    vaultId: match[1],
  };
}

/** Return one required public-ingress DNS zone identifier. */
export function requireDnsZoneId(
  input: AzureCloudDeploymentInput,
  name: "application" | "content",
): string {
  const resourceId = input.dnsZoneIds?.[name];
  if (resourceId === undefined) {
    throw new pulumi.RunError("Public Azure ingress requires two existing Azure DNS zones.");
  }
  return resourceId;
}

/** Return the required Key Vault certificate secret identifier. */
export function requireTlsCertificateSecretId(input: AzureCloudDeploymentInput): string {
  if (input.tlsCertificateSecretId === undefined) {
    throw new pulumi.RunError(
      "Public Azure ingress requires a Key Vault certificate secret resource ID.",
    );
  }
  return input.tlsCertificateSecretId;
}

/** Convert a domain inside a DNS zone to an Azure relative record name. */
export function relativeDnsName(hostname: string, zoneName: string): string {
  const normalizedHostname = hostname.toLowerCase();
  const normalizedZone = zoneName.toLowerCase();
  if (normalizedHostname === normalizedZone) return "@";
  const suffix = `.${normalizedZone}`;
  if (!normalizedHostname.endsWith(suffix)) {
    throw new pulumi.RunError(`${hostname} does not belong to Azure DNS zone ${zoneName}.`);
  }
  return normalizedHostname.slice(0, -suffix.length);
}
