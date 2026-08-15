import * as azure from "@pulumi/azure-native";
import type * as pulumi from "@pulumi/pulumi";

import type {AzureCloudDeploymentInput} from
  "../../../src/deployment/cloud-deployment-contract.js";

/** Network values used by Container Apps and PostgreSQL Flexible Server. */
export interface AzureNetwork {
  readonly containerAppsSubnetId: pulumi.Input<string>;
  readonly postgresSubnetId: pulumi.Input<string>;
  readonly privateDnsZoneId: pulumi.Input<string>;
  readonly resourceIds: Readonly<Record<string, pulumi.Input<string>>>;
  readonly virtualNetworkId: pulumi.Input<string>;
}

/** Create or adopt the Azure network required by the deployment. */
export function defineAzureNetwork(input: {
  readonly deployment: AzureCloudDeploymentInput;
  readonly location: string;
  readonly name: string;
  readonly resourceGroupName: pulumi.Input<string>;
  readonly tags: Readonly<Record<string, string>>;
}): AzureNetwork {
  const existing = input.deployment.existingNetwork;
  if (existing !== undefined) {
    return {
      containerAppsSubnetId: existing.containerAppsSubnetId,
      postgresSubnetId: existing.postgresSubnetId,
      privateDnsZoneId: existing.privateDnsZoneId,
      resourceIds: {
        containerAppsSubnet: existing.containerAppsSubnetId,
        postgresPrivateDnsZone: existing.privateDnsZoneId,
        postgresSubnet: existing.postgresSubnetId,
        virtualNetwork: existing.virtualNetworkId,
      },
      virtualNetworkId: existing.virtualNetworkId,
    };
  }

  const virtualNetwork = new azure.network.VirtualNetwork(`${input.name}-network`, {
    addressSpace: {addressPrefixes: ["10.70.0.0/16"]},
    location: input.location,
    resourceGroupName: input.resourceGroupName,
    tags: input.tags,
    virtualNetworkName: `${input.name}-network`,
  });
  const containerAppsSubnet = new azure.network.Subnet(`${input.name}-application`, {
    addressPrefix: "10.70.0.0/23",
    delegations: [{
      name: "container-apps",
      serviceName: "Microsoft.App/environments",
    }],
    resourceGroupName: input.resourceGroupName,
    subnetName: "application",
    virtualNetworkName: virtualNetwork.name,
  });
  const postgresSubnet = new azure.network.Subnet(`${input.name}-database`, {
    addressPrefix: "10.70.2.0/24",
    delegations: [{
      name: "postgresql-flexible-server",
      serviceName: "Microsoft.DBforPostgreSQL/flexibleServers",
    }],
    privateEndpointNetworkPolicies: "Disabled",
    resourceGroupName: input.resourceGroupName,
    subnetName: "database",
    virtualNetworkName: virtualNetwork.name,
  });
  const privateDnsZone = new azure.privatedns.PrivateZone(`${input.name}-postgres`, {
    location: "global",
    privateZoneName: "private.postgres.database.azure.com",
    resourceGroupName: input.resourceGroupName,
    tags: input.tags,
  });
  const privateDnsLink = new azure.privatedns.VirtualNetworkLink(
    `${input.name}-postgres`,
    {
      location: "global",
      privateZoneName: privateDnsZone.name,
      registrationEnabled: false,
      resourceGroupName: input.resourceGroupName,
      tags: input.tags,
      virtualNetwork: {id: virtualNetwork.id},
      virtualNetworkLinkName: `${input.name}-postgres`,
    },
  );
  return {
    containerAppsSubnetId: containerAppsSubnet.id,
    postgresSubnetId: postgresSubnet.id,
    privateDnsZoneId: privateDnsZone.id,
    resourceIds: {
      containerAppsSubnet: containerAppsSubnet.id,
      postgresPrivateDnsLink: privateDnsLink.id,
      postgresPrivateDnsZone: privateDnsZone.id,
      postgresSubnet: postgresSubnet.id,
      virtualNetwork: virtualNetwork.id,
    },
    virtualNetworkId: virtualNetwork.id,
  };
}
