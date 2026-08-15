import * as aws from "@pulumi/aws";
import type * as pulumi from "@pulumi/pulumi";

import type {AwsCloudDeploymentInput} from
  "../../../src/deployment/cloud-deployment-contract.js";
import type {AwsDeploymentPlan} from "./plan.js";

export interface AwsNetwork {
  readonly applicationSubnetIds: pulumi.Input<string>[];
  readonly databaseSubnetIds: pulumi.Input<string>[];
  readonly loadBalancerSubnetIds: pulumi.Input<string>[];
  readonly resourceIds: AwsNetworkResourceIds;
  readonly vpcCidrBlock: pulumi.Input<string>;
  readonly vpcId: pulumi.Input<string>;
}

interface AwsNetworkResourceIds {
  [name: string]: pulumi.Input<string>;
}

interface AwsNetworkOptions {
  readonly input: AwsCloudDeploymentInput;
  readonly name: string;
  readonly plan: AwsDeploymentPlan;
  readonly tags: Readonly<Record<string, string>>;
}

/** Adopt an operator VPC or create the documented three-tier two-AZ network. */
export async function defineAwsNetwork(
  options: AwsNetworkOptions,
): Promise<AwsNetwork> {
  const existing = options.input.existingNetwork;
  if (existing !== undefined) {
    const [vpc] = await Promise.all([
      aws.ec2.getVpc({id: existing.vpcId}),
      validateSubnetGroup(
        "application",
        existing.applicationSubnetIds,
        existing.vpcId,
      ),
      validateSubnetGroup(
        "database",
        existing.databaseSubnetIds,
        existing.vpcId,
      ),
      validateSubnetGroup(
        "load balancer",
        existing.loadBalancerSubnetIds,
        existing.vpcId,
      ),
    ]);
    return {
      applicationSubnetIds: [...existing.applicationSubnetIds],
      databaseSubnetIds: [...existing.databaseSubnetIds],
      loadBalancerSubnetIds: [...existing.loadBalancerSubnetIds],
      resourceIds: {
        vpc: existing.vpcId,
        ...indexedResources("applicationSubnet", existing.applicationSubnetIds),
        ...indexedResources("databaseSubnet", existing.databaseSubnetIds),
        ...indexedResources("loadBalancerSubnet", existing.loadBalancerSubnetIds),
      },
      vpcCidrBlock: vpc.cidrBlock,
      vpcId: existing.vpcId,
    };
  }

  const availabilityZones = await aws.getAvailabilityZones({state: "available"});
  const selectedZones = availabilityZones.names.slice(0, 2);
  if (selectedZones.length < 2) {
    throw new Error(`AWS region ${options.input.region} has fewer than two available zones.`);
  }

  const vpc = new aws.ec2.Vpc(`${options.name}-vpc`, {
    cidrBlock: "10.42.0.0/16",
    enableDnsHostnames: true,
    enableDnsSupport: true,
    tags: options.tags,
  });
  const internetGateway = new aws.ec2.InternetGateway(`${options.name}-igw`, {
    tags: options.tags,
    vpcId: vpc.id,
  });
  const publicRouteTable = new aws.ec2.RouteTable(`${options.name}-public`, {
    routes: [{
      cidrBlock: "0.0.0.0/0",
      gatewayId: internetGateway.id,
    }],
    tags: options.tags,
    vpcId: vpc.id,
  });

  const loadBalancerSubnets: aws.ec2.Subnet[] = [];
  const applicationSubnets: aws.ec2.Subnet[] = [];
  const databaseSubnets: aws.ec2.Subnet[] = [];
  const natGateways: aws.ec2.NatGateway[] = [];
  const resourceIds: AwsNetworkResourceIds = {
    internetGateway: internetGateway.id,
    publicRouteTable: publicRouteTable.id,
    vpc: vpc.id,
  };

  for (const [index, availabilityZone] of selectedZones.entries()) {
    const loadBalancerSubnet = new aws.ec2.Subnet(
      `${options.name}-load-balancer-${index + 1}`,
      {
        availabilityZone,
        cidrBlock: `10.42.${index}.0/24`,
        mapPublicIpOnLaunch: false,
        tags: options.tags,
        vpcId: vpc.id,
      },
    );
    const applicationSubnet = new aws.ec2.Subnet(
      `${options.name}-application-${index + 1}`,
      {
        availabilityZone,
        cidrBlock: `10.42.${10 + index}.0/24`,
        mapPublicIpOnLaunch: false,
        tags: options.tags,
        vpcId: vpc.id,
      },
    );
    const databaseSubnet = new aws.ec2.Subnet(
      `${options.name}-database-${index + 1}`,
      {
        availabilityZone,
        cidrBlock: `10.42.${20 + index}.0/24`,
        mapPublicIpOnLaunch: false,
        tags: options.tags,
        vpcId: vpc.id,
      },
    );
    const loadBalancerAssociation = new aws.ec2.RouteTableAssociation(
      `${options.name}-load-balancer-route-${index + 1}`,
      {routeTableId: publicRouteTable.id, subnetId: loadBalancerSubnet.id},
    );

    loadBalancerSubnets.push(loadBalancerSubnet);
    applicationSubnets.push(applicationSubnet);
    databaseSubnets.push(databaseSubnet);
    resourceIds[`loadBalancerSubnet${index + 1}`] = loadBalancerSubnet.id;
    resourceIds[`applicationSubnet${index + 1}`] = applicationSubnet.id;
    resourceIds[`databaseSubnet${index + 1}`] = databaseSubnet.id;
    resourceIds[`loadBalancerRouteAssociation${index + 1}`] =
      loadBalancerAssociation.id;
  }

  for (let index = 0; index < options.plan.natGatewayCount; index += 1) {
    const elasticAddress = new aws.ec2.Eip(`${options.name}-nat-${index + 1}`, {
      domain: "vpc",
      tags: options.tags,
    }, {dependsOn: [internetGateway]});
    const publicSubnet = loadBalancerSubnets[index];
    if (publicSubnet === undefined) {
      throw new Error("The NAT gateway plan exceeds the available public subnets.");
    }
    const natGateway = new aws.ec2.NatGateway(`${options.name}-nat-${index + 1}`, {
      allocationId: elasticAddress.id,
      subnetId: publicSubnet.id,
      tags: options.tags,
    }, {dependsOn: [internetGateway]});
    natGateways.push(natGateway);
    resourceIds[`natElasticAddress${index + 1}`] = elasticAddress.id;
    resourceIds[`natGateway${index + 1}`] = natGateway.id;
  }

  for (const [index, subnet] of applicationSubnets.entries()) {
    const natGateway = natGateways[index % natGateways.length];
    if (natGateway === undefined) {
      throw new Error("The application network requires at least one NAT gateway.");
    }
    const routeTable = new aws.ec2.RouteTable(
      `${options.name}-application-${index + 1}`,
      {
        routes: [{cidrBlock: "0.0.0.0/0", natGatewayId: natGateway.id}],
        tags: options.tags,
        vpcId: vpc.id,
      },
    );
    const applicationAssociation = new aws.ec2.RouteTableAssociation(
      `${options.name}-application-route-${index + 1}`,
      {routeTableId: routeTable.id, subnetId: subnet.id},
    );
    resourceIds[`applicationRouteTable${index + 1}`] = routeTable.id;
    resourceIds[`applicationRouteAssociation${index + 1}`] =
      applicationAssociation.id;
  }

  const databaseRouteTable = new aws.ec2.RouteTable(`${options.name}-database`, {
    tags: options.tags,
    vpcId: vpc.id,
  });
  resourceIds["databaseRouteTable"] = databaseRouteTable.id;
  for (const [index, subnet] of databaseSubnets.entries()) {
    const databaseAssociation = new aws.ec2.RouteTableAssociation(
      `${options.name}-database-route-${index + 1}`,
      {routeTableId: databaseRouteTable.id, subnetId: subnet.id},
    );
    resourceIds[`databaseRouteAssociation${index + 1}`] = databaseAssociation.id;
  }

  return {
    applicationSubnetIds: applicationSubnets.map((subnet) => subnet.id),
    databaseSubnetIds: databaseSubnets.map((subnet) => subnet.id),
    loadBalancerSubnetIds: loadBalancerSubnets.map((subnet) => subnet.id),
    resourceIds,
    vpcCidrBlock: vpc.cidrBlock,
    vpcId: vpc.id,
  };
}

async function validateSubnetGroup(
  label: string,
  subnetIds: readonly string[],
  vpcId: string,
): Promise<void> {
  const subnets = await Promise.all(subnetIds.map((id) =>
    aws.ec2.getSubnet({id})
  ));
  const foreignSubnet = subnets.find((subnet) => subnet.vpcId !== vpcId);
  if (foreignSubnet !== undefined) {
    throw new Error(`The existing ${label} subnets must belong to ${vpcId}.`);
  }
  if (new Set(subnets.map((subnet) => subnet.availabilityZone)).size < 2) {
    throw new Error(`The existing ${label} subnets must span two availability zones.`);
  }
}

function indexedResources(
  prefix: string,
  identifiers: readonly string[],
): Record<string, string> {
  return Object.fromEntries(identifiers.map((identifier, index) => [
    `${prefix}${index + 1}`,
    identifier,
  ]));
}
