import * as pulumi from "@pulumi/pulumi";
import {Effect} from "effect";
import {beforeAll, describe, expect, test} from "vitest";

import type {CloudDeploymentDocument} from
  "../../../../src/deployment/cloud-deployment-contract.js";
import {parseCloudDeploymentOutput} from
  "../../../../src/deployment/cloud-deployment-contract.js";
import {parseAzurePulumiConfiguration} from "../configuration.js";
import {defineAzureStack} from "../stack.js";

const subscriptionId = "00000000-1111-2222-3333-444444444444";
const tenantId = "55555555-6666-7777-8888-999999999999";
const digest = `sha256:${"c".repeat(64)}`;
const imageReference = `ghcr.io/plannotator/artifact-server@${digest}`;
const resources: pulumi.runtime.MockResourceArgs[] = [];

beforeAll(async () => {
  await pulumi.runtime.setMocks({
    call: (args) => args.token.includes("getSharedKeys")
      ? {primarySharedKey: "generated-log-key"}
      : args.inputs,
    newResource: (args) => {
      resources.push(args);
      return {id: `${args.name}-id`, state: mockResourceState(args)};
    },
  }, "artifact-server-azure", "production", false, "artifact-server");
});

describe("Azure Pulumi deployment", () => {
  test("DEP-010-B: derives supported Container Apps and PostgreSQL capacity", () => {
    const configuration = parseAzurePulumiConfiguration(
      azureInput(),
      "production",
      subscriptionId,
    );
    expect(configuration.plan).toMatchObject({
      cpu: 1,
      database: {
        highAvailabilityMode: "ZoneRedundant",
        skuName: "Standard_D4ds_v5",
      },
      maximumDatabaseConnections: 66,
      memory: "2Gi",
    });
    expect(() => parseAzurePulumiConfiguration(
      azureInput({ingress: "private"}),
      "production",
      subscriptionId,
    )).toThrow("capacity or ingress");
    expect(() => parseAzurePulumiConfiguration(
      azureInput(),
      "staging",
      subscriptionId,
    )).toThrow("active Pulumi stack");
  });

  test("DEP-010-B: defines private Azure data services behind managed HTTPS", async () => {
    resources.length = 0;
    const configuration = parseAzurePulumiConfiguration(
      azureInput({installationName: "artifact-server-customer-production-team"}),
      "production",
      subscriptionId,
    );
    const outputs = await pulumi.runtime.runInPulumiStack(async () => {
      const stack = defineAzureStack({...configuration, tenantId});
      return {deployment: stack.deployment};
    });
    const deployment = await Effect.runPromise(parseCloudDeploymentOutput(
      configuration.input,
      outputs?.["deployment"] ?? null,
    ));

    expect(resourceTypes()).toContain("azure-native:app:ContainerApp");
    expect(resourceTypes()).toContain("azure-native:dbforpostgresql:Server");
    expect(resourceTypes()).toContain("azure-native:storage:StorageAccount");
    expect(resourceTypes()).toContain("azure-native:cdn:Profile");
    expect(resourceTypes()).toContain("azure-native:cdn:AFDCustomDomain");

    expect(requireResource("azure-native:storage:StorageAccount").inputs)
      .toMatchObject({
        allowBlobPublicAccess: false,
        allowSharedKeyAccess: false,
        defaultToOAuthAuthentication: true,
        enableHttpsTrafficOnly: true,
        minimumTlsVersion: "TLS1_2",
      });
    expect(requireResource("azure-native:storage:BlobServiceProperties").inputs)
      .toMatchObject({
        isVersioningEnabled: true,
        deleteRetentionPolicy: {days: 14, enabled: true},
      });
    expect(requireResource("azure-native:dbforpostgresql:Server").inputs)
      .toMatchObject({
        backup: {backupRetentionDays: 14, geoRedundantBackup: "Enabled"},
        highAvailability: {mode: "ZoneRedundant"},
        network: {publicNetworkAccess: "Disabled"},
        version: "17",
      });
    const app = requireResource("azure-native:app:ContainerApp");
    expect(app.inputs).toMatchObject({
      configuration: {
        activeRevisionsMode: "Single",
        ingress: {allowInsecure: false, external: true},
      },
      identity: {type: "UserAssigned"},
    });
    const serializedApp = JSON.stringify(app.inputs);
    expect(serializedApp).toContain("ARTIFACT_SERVER_OBJECT_STORAGE_PROVIDER");
    expect(serializedApp).toContain("ARTIFACT_SERVER_AZURE_BLOB_ACCOUNT_URL");
    expect(serializedApp).not.toContain("generated-api-token");
    expect(serializedApp).not.toContain("generated-database-password");
    expect(requireResources("azure-native:cdn:AFDCustomDomain")).toHaveLength(2);
    expect(requireResource("azure-native:cdn:Profile").inputs["profileName"])
      .toMatch(/^as-[a-f0-9]{12}-edge$/u);
    expect(requireResource("azure-native:cdn:AFDEndpoint").inputs["endpointName"])
      .toMatch(/^as-[a-f0-9]{12}$/u);
    for (const domain of requireResources("azure-native:cdn:AFDCustomDomain")) {
      expect(domain.inputs["customDomainName"])
        .toMatch(/^as-[a-f0-9]{12}-(?:application|content)$/u);
    }
    expect(requireResource("azure-native:cdn:Route").inputs).toMatchObject({
      forwardingProtocol: "HttpsOnly",
      httpsRedirect: "Enabled",
      linkToDefaultDomain: "Disabled",
    });
    expect(requireResources("azure-native:dns:RecordSet")).toHaveLength(2);
    expect(deployment).toMatchObject({
      applicationUrl: "https://artifacts.example.com",
      contentDomain: "artifact-content.example.net",
      healthUrl: "https://artifacts.example.com/health",
      imageDigest: digest,
      mcpUrl: "https://artifacts.example.com/mcp",
      readinessUrl: "https://artifacts.example.com/ready",
      stateBackend: "azblob://artifact-server-pulumi-state/azure-production",
    });
    expect(JSON.stringify(deployment)).not.toContain("generated-api-token");
    expect(JSON.stringify(deployment)).not.toContain("generated-database-password");
    expect(JSON.stringify(deployment)).not.toContain("generated-log-key");
  });

  test("DEP-010-F: adopts an existing Azure network without creating one", async () => {
    resources.length = 0;
    const configuration = parseAzurePulumiConfiguration(azureInput({
      existingNetwork: {
        containerAppsSubnetId: `${resourcePrefix("Network")}/virtualNetworks/existing/subnets/application`,
        postgresSubnetId: `${resourcePrefix("Network")}/virtualNetworks/existing/subnets/database`,
        privateDnsZoneId: `${resourcePrefix("Network")}/privateDnsZones/private.postgres.database.azure.com`,
        virtualNetworkId: `${resourcePrefix("Network")}/virtualNetworks/existing`,
      },
    }), "production", subscriptionId);
    await pulumi.runtime.runInPulumiStack(async () => {
      const stack = defineAzureStack({...configuration, tenantId});
      return {deployment: stack.deployment};
    });
    expect(resourceTypes()).not.toContain("azure-native:network:VirtualNetwork");
    expect(resourceTypes()).not.toContain("azure-native:network:Subnet");
    expect(resourceTypes()).not.toContain("azure-native:privatedns:PrivateZone");
  });

  test("DEP-010-F: rejects malformed DNS and certificate resource IDs", () => {
    expect(() => parseAzurePulumiConfiguration(azureInput({
      dnsZoneIds: {application: "not-an-arm-id", content: contentZoneId()},
    }), "production", subscriptionId)).toThrow("Microsoft.Network/dnsZones");

    expect(() => parseAzurePulumiConfiguration(azureInput({
      tlsCertificateSecretId: "not-a-key-vault-secret",
    }), "production", subscriptionId)).toThrow("versionless Key Vault secret");
  });
});

function azureInput(
  overrides: CloudDeploymentDocument = {},
): CloudDeploymentDocument {
  return {
    applicationDomain: "artifacts.example.com",
    backupRetentionDays: 14,
    bootstrapAdministratorEmail: "operator@example.com",
    capacity: {cpu: 1, maximumInstances: 3, memoryMiB: 2_048, minimumInstances: 2},
    contentDomain: "artifact-content.example.net",
    databasePlan: "high-availability",
    deletionProtection: true,
    dnsZoneIds: {
      application: `${resourcePrefix("Network")}/dnsZones/example.com`,
      content: contentZoneId(),
    },
    environment: "production",
    imageReference,
    ingress: "public",
    installationName: "artifact-server",
    region: "westus3",
    secretsProvider: "azurekeyvault://artifact-server-state.vault.azure.net/keys/pulumi",
    stackName: "production",
    stateBackendUrl: "azblob://artifact-server-pulumi-state/azure-production",
    target: "azure",
    tlsCertificateSecretId: `${resourcePrefix("KeyVault")}/vaults/artifact-server-certificates/secrets/edge-certificate`,
    ...overrides,
  };
}

function contentZoneId(): string {
  return `${resourcePrefix("Network")}/dnsZones/example.net`;
}

function resourcePrefix(provider: string): string {
  return `/subscriptions/${subscriptionId}/resourceGroups/artifact-server-shared/providers/Microsoft.${provider}`;
}

function resourceTypes(): string[] {
  return resources.map((resource) => resource.type);
}

function requireResource(type: string): pulumi.runtime.MockResourceArgs {
  const resource = resources.find((candidate) => candidate.type === type);
  if (resource === undefined) {
    throw new Error(`Pulumi did not register ${type}. Registered: ${resourceTypes().join(", ")}`);
  }
  return resource;
}

function requireResources(type: string): pulumi.runtime.MockResourceArgs[] {
  return resources.filter((candidate) => candidate.type === type);
}

function mockResourceState(
  args: pulumi.runtime.MockResourceArgs,
): pulumi.runtime.MockResourceResult["state"] {
  const base = {...args.inputs};
  if (args.type === "random:index/randomUuid4:RandomUuid4") {
    return {...base, result: "019c1111-2222-7333-8444-555555555555"};
  }
  if (args.type === "random:index/randomPassword:RandomPassword") {
    return {
      ...base,
      result: args.name.includes("database")
        ? "generated-database-password"
        : "generated-api-token",
    };
  }
  if (args.type === "azure-native:managedidentity:UserAssignedIdentity") {
    return {
      ...base,
      clientId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
      principalId: "ffffffff-1111-2222-3333-444444444444",
      tenantId,
    };
  }
  if (args.type === "azure-native:storage:StorageAccount") {
    return {...base, name: "as123456789abc"};
  }
  if (args.type === "azure-native:dbforpostgresql:Server") {
    return {
      ...base,
      fullyQualifiedDomainName: "as-123456789abc-database.postgres.database.azure.com",
    };
  }
  if (args.type === "azure-native:operationalinsights:Workspace") {
    return {...base, customerId: "12121212-3434-5656-7878-909090909090"};
  }
  if (args.type === "azure-native:app:ContainerApp") {
    return {
      ...base,
      latestRevisionFqdn: "as-123456789abc.internal.azurecontainerapps.io",
    };
  }
  if (args.type === "azure-native:cdn:Profile") {
    return {
      ...base,
      identity: {principalId: "abababab-cdcd-efef-0101-232323232323", type: "SystemAssigned"},
    };
  }
  if (args.type === "azure-native:cdn:AFDEndpoint") {
    return {...base, hostName: "artifact-server-production.azurefd.net"};
  }
  return base;
}
