import * as gcp from "@pulumi/gcp";
import type * as pulumi from "@pulumi/pulumi";

import type {GcpCloudDeploymentInput} from
  "../../../src/deployment/cloud-deployment-contract.js";

/** Network values consumed by Cloud Run and Cloud SQL. */
export interface GcpNetwork {
  readonly networkId: pulumi.Input<string>;
  readonly networkName: pulumi.Input<string>;
  readonly resourceIds: Readonly<Record<string, pulumi.Input<string>>>;
  readonly serviceConnection: pulumi.Resource | undefined;
  readonly subnetworkId: pulumi.Input<string>;
}

/** Create or adopt the regional network required by the GCP stack. */
export function defineGcpNetwork(input: {
  readonly deployment: GcpCloudDeploymentInput;
  readonly name: string;
  readonly projectId: string;
}): GcpNetwork {
  const existing = input.deployment.existingNetwork;
  if (existing !== undefined) {
    return {
      networkId: existing.vpcName,
      networkName: existing.vpcName,
      resourceIds: {
        network: existing.vpcName,
        privateServiceConnection: existing.privateServiceConnection,
        subnetwork: existing.vpcEgressConfiguration,
      },
      serviceConnection: undefined,
      subnetworkId: existing.vpcEgressConfiguration,
    };
  }

  const network = new gcp.compute.Network(`${input.name}-network`, {
    autoCreateSubnetworks: false,
    name: input.name,
    project: input.projectId,
    routingMode: "REGIONAL",
  });
  const subnetwork = new gcp.compute.Subnetwork(`${input.name}-application`, {
    ipCidrRange: "10.60.0.0/24",
    name: `${input.name}-application`,
    network: network.id,
    privateIpGoogleAccess: true,
    project: input.projectId,
    region: input.deployment.region,
  });
  const privateRange = new gcp.compute.GlobalAddress(`${input.name}-database`, {
    addressType: "INTERNAL",
    name: `${input.name}-database-services`,
    network: network.id,
    prefixLength: 20,
    project: input.projectId,
    purpose: "VPC_PEERING",
  });
  const serviceConnection = new gcp.servicenetworking.Connection(
    `${input.name}-database`,
    {
      network: network.id,
      reservedPeeringRanges: [privateRange.name],
      service: "servicenetworking.googleapis.com",
    },
  );
  return {
    networkId: network.id,
    networkName: network.name,
    resourceIds: {
      applicationSubnetwork: subnetwork.id,
      databaseAddressRange: privateRange.id,
      network: network.id,
      privateServiceConnection: serviceConnection.id,
    },
    serviceConnection,
    subnetworkId: subnetwork.id,
  };
}
