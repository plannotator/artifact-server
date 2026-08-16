import * as pulumi from "@pulumi/pulumi";
import {Effect, Schema} from "effect";
import {beforeAll, describe, expect, test} from "vitest";

import {parseAwsPulumiConfiguration} from
  "../configuration.js";
import {defineAwsStack} from "../stack.js";
import {
  type AwsCloudDeploymentInput,
  type CloudDeploymentDocument,
  parseCloudDeploymentOutput,
} from "../../../../src/deployment/cloud-deployment-contract.js";

const digest = `sha256:${"a".repeat(64)}`;
const imageReference = `ghcr.io/plannotator/artifact-server@${digest}`;
const resources: pulumi.runtime.MockResourceArgs[] = [];

beforeAll(async () => {
  await pulumi.runtime.setMocks({
    call: (args) => {
      if (args.token.includes("getAvailabilityZones")) {
        return {
          names: ["us-east-1a", "us-east-1b", "us-east-1c"],
          state: "available",
          zoneIds: ["use1-az1", "use1-az2", "use1-az3"],
        };
      }
      if (args.token.includes("getPartition")) {
        return {
          dnsSuffix: "amazonaws.com",
          partition: "aws",
          reverseDnsPrefix: "com.amazonaws",
        };
      }
      if (args.token.includes("getVpc")) {
        return {...args.inputs, cidrBlock: "10.50.0.0/16"};
      }
      if (args.token.includes("getSubnet")) {
        const subnetId = String(args.inputs["id"]);
        return {
          ...args.inputs,
          availabilityZone: subnetId.endsWith("-a") ? "us-east-1a" : "us-east-1b",
          vpcId: subnetId.includes("wrong-vpc") ? "vpc-other" : "vpc-existing",
        };
      }
      return args.inputs;
    },
    newResource: (args) => {
      resources.push(args);
      return {
        id: `${args.name}-id`,
        state: mockResourceState(args),
      };
    },
  }, "artifact-server-aws", "production", false, "artifact-server");
});

describe("AWS Pulumi deployment", () => {
  test("DEP-008-B: derives supported capacity and rejects unsafe provider plans", () => {
    const configuration = parseAwsPulumiConfiguration(awsInput(), "production");

    expect(configuration.plan).toMatchObject({
      cpuUnits: 1_024,
      database: {
        instanceClass: "db.t4g.medium",
        multiAz: false,
      },
      desiredCount: 2,
      memoryMiB: 2_048,
      natGatewayCount: 2,
      maximumDatabaseConnections: 88,
    });
    expect(() => parseAwsPulumiConfiguration(awsInput({
      capacity: {
        cpu: 1,
        maximumInstances: 4,
        memoryMiB: 1_024,
        minimumInstances: 2,
      },
    }), "production")).toThrow("Fargate and RDS plans");
    expect(() => parseAwsPulumiConfiguration(awsInput({
      capacity: {
        cpu: 1,
        maximumInstances: 5,
        memoryMiB: 2_048,
        minimumInstances: 2,
      },
      databasePlan: "small",
    }), "production")).toThrow("Fargate and RDS plans");
    expect(() => parseAwsPulumiConfiguration(awsInput({
      capacity: {
        cpu: 1,
        maximumInstances: 30,
        memoryMiB: 2_048,
        minimumInstances: 2,
      },
    }), "production")).toThrow("Fargate and RDS plans");
  });

  test("DEP-008-F: rejects stack drift, incomplete network adoption, and private TLS ambiguity", () => {
    expect(() => parseAwsPulumiConfiguration(awsInput(), "staging"))
      .toThrow("active Pulumi stack");
    expect(() => parseAwsPulumiConfiguration(awsInput({
      existingNetwork: {
        applicationSubnetIds: ["subnet-app-a", "subnet-app-b"],
        databaseSubnetIds: ["subnet-db-a", "subnet-db-b"],
        vpcId: "vpc-existing",
      },
    }), "production")).toThrow("shared cloud contract");
    expect(() => parseAwsPulumiConfiguration(awsInput({
      dnsZoneIds: null,
      ingress: "private",
    }), "production")).toThrow("shared cloud contract");
    expect(() => parseAwsPulumiConfiguration(awsInput({
      dnsZoneIds: null,
      ingress: "private",
      privateIngressCidrs: ["10.0.0.0/33"],
      tlsCertificateArn:
        "arn:aws:acm:us-east-1:123456789012:certificate/private-artifacts",
    }), "production")).toThrow("shared cloud contract");
  });

  test("DEP-008-B: defines the secure AWS resource graph and exact shared outputs", async () => {
    resources.length = 0;
    const configuration = parseAwsPulumiConfiguration(awsInput(), "production");
    const stackOutputs = await pulumi.runtime.runInPulumiStack(async () => {
      const stack = await defineAwsStack(configuration);
      return {deployment: stack.deployment};
    });
    const deployment = await Effect.runPromise(parseCloudDeploymentOutput(
      configuration.input,
      stackOutputs?.["deployment"] ?? null,
    ));

    const resourceTypes = resources.map((resource) => resource.type);
    expect(resourceTypes).toContain("aws:ecs/service:Service");
    expect(resourceTypes).toContain("aws:rds/instance:Instance");
    expect(resourceTypes).toContain("aws:s3/bucket:Bucket");
    expect(resourceTypes).toContain("aws:lb/loadBalancer:LoadBalancer");
    expect(resourceTypes).toContain("aws:appautoscaling/target:Target");
    expect(resourceTypes).toContain("aws:cloudwatch/eventRule:EventRule");
    expect(resourceTypes).toContain("aws:cloudwatch/eventTarget:EventTarget");
    expect(resourceTypes.filter((type) => type === "aws:ec2/natGateway:NatGateway"))
      .toHaveLength(2);

    const database = requireResource("aws:rds/instance:Instance");
    expect(database.inputs).toMatchObject({
      backupRetentionPeriod: 14,
      deletionProtection: true,
      engineVersion: "17.10",
      publiclyAccessible: false,
      storageEncrypted: true,
    });
    expect(String(database.inputs["finalSnapshotIdentifier"]))
      .toMatch(/^as-[a-f0-9]{12}-final-[a-z0-9]{8}$/u);
    const publicAccessBlock = requireResource(
      "aws:s3/bucketPublicAccessBlock:BucketPublicAccessBlock",
    );
    expect(publicAccessBlock.inputs).toMatchObject({
      blockPublicAcls: true,
      blockPublicPolicy: true,
      ignorePublicAcls: true,
      restrictPublicBuckets: true,
    });
    const bucket = requireResource("aws:s3/bucket:Bucket");
    expect(String(bucket.inputs["bucketPrefix"]).length).toBeLessThanOrEqual(37);
    const objectStoragePolicy = requireNamedResource(
      "aws:iam/rolePolicy:RolePolicy",
      "object-storage",
    );
    expect(String(objectStoragePolicy.inputs["policy"])).toContain(
      "s3:GetBucketLocation",
    );
    expect(String(objectStoragePolicy.inputs["policy"])).toContain("s3:DeleteObject");
    expect(String(objectStoragePolicy.inputs["policy"])).not.toContain(
      "s3:prefix",
    );
    const loadBalancer = requireResource("aws:lb/loadBalancer:LoadBalancer");
    expect(String(loadBalancer.inputs["name"]).length).toBeLessThanOrEqual(32);
    const targetGroup = requireResource("aws:lb/targetGroup:TargetGroup");
    expect(String(targetGroup.inputs["name"]).length).toBeLessThanOrEqual(32);

    const taskDefinition = requireNamedResource(
      "aws:ecs/taskDefinition:TaskDefinition",
      "application",
    );
    const containers = await Effect.runPromise(Schema.decodeUnknownEffect(
      Schema.Array(Schema.Struct({
        command: Schema.Array(Schema.String),
        environment: Schema.Array(Schema.Struct({name: Schema.String, value: Schema.String})),
        image: Schema.String,
        secrets: Schema.Array(Schema.Struct({name: Schema.String, valueFrom: Schema.String})),
      })),
    )(JSON.parse(String(taskDefinition.inputs["containerDefinitions"]))));
    const container = containers[0];
    expect(container).toBeDefined();
    expect(container?.image).toBe(imageReference);
    expect(container?.command.join(" ")).toContain("migrate apply");
    expect(container?.command.join(" ")).toContain("start-external-storage");
    expect(container?.environment).toContainEqual({
      name: "ARTIFACT_SERVER_STAGING_CLEANUP_SCHEDULE",
      value: "external",
    });
    expect(container?.environment).toContainEqual({
      name: "NODE_EXTRA_CA_CERTS",
      value: "/usr/local/share/ca-certificates/aws-rds-global-bundle.pem",
    });
    expect(container?.environment).toContainEqual({
      name: "ARTIFACT_SERVER_WORKOS_ISSUER",
      value: "https://artifact-server.authkit.example",
    });
    expect(container?.environment.map((entry) => entry.name)).not.toContain(
      "ARTIFACT_SERVER_S3_ACCESS_KEY_ID",
    );
    expect(container?.secrets.map((entry) => entry.name)).toEqual([
      "ARTIFACT_SERVER_API_TOKEN",
      "ARTIFACT_SERVER_DATABASE_URL",
      "ARTIFACT_SERVER_WORKOS_API_KEY",
    ]);
    expect(JSON.stringify(taskDefinition.inputs)).not.toContain(
      "generated-database-password",
    );
    expect(JSON.stringify(taskDefinition.inputs)).not.toContain(
      "generated-api-token",
    );
    const cleanupTaskDefinition = requireNamedResource(
      "aws:ecs/taskDefinition:TaskDefinition",
      "cleanup",
    );
    expect(String(cleanupTaskDefinition.inputs["containerDefinitions"]))
      .toContain("cleanup-staging");
    expect(requireResource("aws:cloudwatch/eventRule:EventRule").inputs)
      .toMatchObject({scheduleExpression: "rate(15 minutes)"});

    expect(deployment).toMatchObject({
      applicationUrl: "https://artifacts.example.com",
      contentDomain: "artifact-content.example.net",
      healthUrl: "https://artifacts.example.com/health",
      imageDigest: digest,
      mcpUrl: "https://artifacts.example.com/mcp",
      readinessUrl: "https://artifacts.example.com/ready",
      stateBackend: "s3://artifact-server-pulumi-state/aws-production",
    });
    expect(JSON.stringify(deployment)).not.toContain("generated-api-token");
    expect(JSON.stringify(deployment)).not.toContain("generated-database-password");
  });

  test("DEP-008-B DEP-008-F: adopts a private two-zone VPC without creating public infrastructure", async () => {
    resources.length = 0;
    const configuration = parseAwsPulumiConfiguration(awsInput({
      dnsZoneIds: null,
      existingNetwork: existingNetwork(),
      ingress: "private",
      privateIngressCidrs: ["172.16.0.0/12"],
      tlsCertificateArn:
        "arn:aws:acm:us-east-1:123456789012:certificate/private-artifacts",
    }), "production");
    await pulumi.runtime.runInPulumiStack(async () => {
      const stack = await defineAwsStack(configuration);
      return {deployment: stack.deployment};
    });

    expect(resources.some((resource) => resource.type === "aws:ec2/vpc:Vpc"))
      .toBe(false);
    expect(resources.some((resource) => resource.type === "aws:ec2/natGateway:NatGateway"))
      .toBe(false);
    expect(resources.some((resource) => resource.type === "aws:acm/certificate:Certificate"))
      .toBe(false);
    expect(resources.some((resource) => resource.type === "aws:route53/record:Record"))
      .toBe(false);
    expect(requireResource("aws:lb/loadBalancer:LoadBalancer").inputs["internal"])
      .toBe(true);
    expect(requireResource("aws:ec2/securityGroup:SecurityGroup").inputs["ingress"])
      .toEqual([expect.objectContaining({cidrBlocks: ["172.16.0.0/12"]})]);

    const invalidConfiguration = parseAwsPulumiConfiguration(awsInput({
      dnsZoneIds: null,
      existingNetwork: {
        ...existingNetwork(),
        applicationSubnetIds: ["subnet-wrong-vpc-a", "subnet-app-b"],
      },
      ingress: "private",
      tlsCertificateArn:
        "arn:aws:acm:us-east-1:123456789012:certificate/private-artifacts",
    }), "production");
    await expect(defineAwsStack(invalidConfiguration)).rejects.toThrow(
      "application subnets must belong to vpc-existing",
    );
  });
});

function awsInput(
  overrides: CloudDeploymentDocument = {},
): CloudDeploymentDocument {
  const document: CloudDeploymentDocument = {
    applicationDomain: "artifacts.example.com",
    backupRetentionDays: 14,
    bootstrapAdministratorEmail: "admin@example.com",
    capacity: {
      cpu: 1,
      maximumInstances: 4,
      memoryMiB: 2_048,
      minimumInstances: 2,
    },
    contentDomain: "artifact-content.example.net",
    databasePlan: "standard",
    deletionProtection: true,
    dnsZoneIds: {
      application: "zone-artifacts",
      content: "zone-content",
    },
    environment: "production",
    imageReference,
    ingress: "public",
    installationName: "team-artifacts",
    region: "us-east-1",
    secretsProvider: "awskms://alias/artifact-server",
    stackName: "production",
    stateBackendUrl: "s3://artifact-server-pulumi-state/aws-production",
    target: "aws",
    workosApiKeySecretRef:
      "arn:aws:secretsmanager:us-east-1:123456789012:secret:workos",
    workosClientId: "client_01",
    workosIssuer: "https://artifact-server.authkit.example",
    ...overrides,
  };
  if (overrides["dnsZoneIds"] !== null) return document;
  return Object.fromEntries(
    Object.entries(document).filter(([key]) => key !== "dnsZoneIds"),
  );
}

function requireResource(type: string): pulumi.runtime.MockResourceArgs {
  const resource = resources.find((candidate) => candidate.type === type);
  if (resource === undefined) {
    throw new Error(`Pulumi did not register ${type}.`);
  }
  return resource;
}

function requireNamedResource(
  type: string,
  nameFragment: string,
): pulumi.runtime.MockResourceArgs {
  const resource = resources.find((candidate) =>
    candidate.type === type && candidate.name.includes(nameFragment)
  );
  if (resource === undefined) {
    throw new Error(`Pulumi did not register ${type} containing ${nameFragment}.`);
  }
  return resource;
}

function existingNetwork(): NonNullable<AwsCloudDeploymentInput["existingNetwork"]> {
  return {
    applicationSubnetIds: ["subnet-app-a", "subnet-app-b"],
    databaseSubnetIds: ["subnet-db-a", "subnet-db-b"],
    loadBalancerSubnetIds: ["subnet-lb-a", "subnet-lb-b"],
    vpcId: "vpc-existing",
  };
}

function mockResourceState(
  args: pulumi.runtime.MockResourceArgs,
): pulumi.runtime.MockResourceResult["state"] {
  const base = {...args.inputs};
  const arn = `arn:aws:mock:us-east-1:123456789012:${args.name}`;
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
  if (args.type === "random:index/randomString:RandomString") {
    return {...base, result: "a1b2c3d4"};
  }
  if (args.type === "aws:s3/bucket:Bucket") {
    return {...base, arn, bucket: `${args.name}-bucket`};
  }
  if (args.type === "aws:rds/instance:Instance") {
    return {...base, arn, endpoint: "database.internal:5432"};
  }
  if (args.type === "aws:acm/certificate:Certificate") {
    return {
      ...base,
      arn,
      domainValidationOptions: [{
        domainName: args.inputs["domainName"],
        resourceRecordName: `_validation.${args.name}`,
        resourceRecordType: "CNAME",
        resourceRecordValue: "validation.acm.invalid",
      }],
    };
  }
  if (args.type === "aws:route53/record:Record") {
    return {...base, fqdn: String(args.inputs["name"])};
  }
  if (args.type === "aws:acm/certificateValidation:CertificateValidation") {
    return {...base, certificateArn: args.inputs["certificateArn"]};
  }
  if (args.type === "aws:lb/loadBalancer:LoadBalancer") {
    return {
      ...base,
      arn,
      dnsName: `${args.name}.elb.amazonaws.com`,
      zoneId: "Z35SXDOTRQ7X7K",
    };
  }
  if (args.type === "aws:ecs/service:Service") {
    return {...base, arn, name: args.name};
  }
  if (args.type === "aws:ecs/cluster:Cluster") {
    return {...base, arn, name: args.name};
  }
  if (args.type === "aws:cloudwatch/logGroup:LogGroup") {
    return {...base, arn, name: `/artifact-server/${args.name}`};
  }
  if (args.type === "aws:iam/role:Role") {
    return {...base, arn, name: args.name};
  }
  if (args.type === "aws:secretsmanager/secret:Secret") {
    return {...base, arn, name: args.name};
  }
  if (args.type === "aws:ecs/taskDefinition:TaskDefinition") {
    return {...base, arn};
  }
  if (args.type === "aws:lb/listener:Listener") {
    return {...base, arn};
  }
  if (args.type === "aws:lb/targetGroup:TargetGroup") {
    return {...base, arn};
  }
  return base;
}
