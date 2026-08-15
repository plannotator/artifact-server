import * as pulumi from "@pulumi/pulumi";
import {Effect} from "effect";
import {beforeAll, describe, expect, test} from "vitest";

import type {CloudDeploymentDocument} from
  "../../../../src/deployment/cloud-deployment-contract.js";
import {parseCloudDeploymentOutput} from
  "../../../../src/deployment/cloud-deployment-contract.js";
import {parseGcpPulumiConfiguration} from "../configuration.js";
import {defineGcpStack} from "../stack.js";

const digest = `sha256:${"b".repeat(64)}`;
const imageReference = `ghcr.io/plannotator/artifact-server@${digest}`;
const resources: pulumi.runtime.MockResourceArgs[] = [];

beforeAll(async () => {
  await pulumi.runtime.setMocks({
    call: (args) => args.inputs,
    newResource: (args) => {
      resources.push(args);
      return {id: `${args.name}-id`, state: mockResourceState(args)};
    },
  }, "artifact-server-gcp", "production", false, "artifact-server");
});

describe("GCP Pulumi deployment", () => {
  test("DEP-009-B: derives supported Cloud Run and Cloud SQL capacity", () => {
    const configuration = parseGcpPulumiConfiguration(
      gcpInput(),
      "production",
      "artifact-server-production",
    );
    expect(configuration.plan).toMatchObject({
      cpu: "1",
      database: {
        availabilityType: "REGIONAL",
        tier: "db-custom-4-15360",
      },
      maximumDatabaseConnections: 66,
      memory: "2048Mi",
    });
    expect(() => parseGcpPulumiConfiguration(
      gcpInput({ingress: "private"}),
      "production",
      "artifact-server-production",
    )).toThrow("capacity or ingress");
    expect(() => parseGcpPulumiConfiguration(
      gcpInput(),
      "staging",
      "artifact-server-production",
    )).toThrow("active Pulumi stack");
  });

  test("DEP-009-B: defines a private-data GCP graph behind managed HTTPS", async () => {
    resources.length = 0;
    const configuration = parseGcpPulumiConfiguration(
      gcpInput(),
      "production",
      "artifact-server-production",
    );
    const outputs = await pulumi.runtime.runInPulumiStack(async () => {
      const stack = defineGcpStack(configuration);
      return {deployment: stack.deployment};
    });
    const deployment = await Effect.runPromise(parseCloudDeploymentOutput(
      configuration.input,
      outputs?.["deployment"] ?? null,
    ));

    expect(resourceTypes()).toContain("gcp:cloudrunv2/service:Service");
    expect(resourceTypes()).toContain("gcp:sql/databaseInstance:DatabaseInstance");
    expect(resourceTypes()).toContain("gcp:storage/bucket:Bucket");
    expect(resourceTypes()).toContain("gcp:compute/backendService:BackendService");
    expect(resourceTypes()).toContain("gcp:certificatemanager/certificate:Certificate");

    expect(requireResource("gcp:storage/bucket:Bucket").inputs).toMatchObject({
      forceDestroy: false,
      publicAccessPrevention: "enforced",
      uniformBucketLevelAccess: true,
      versioning: {enabled: true},
    });
    expect(requireResource("gcp:sql/databaseInstance:DatabaseInstance").inputs)
      .toMatchObject({
        databaseVersion: "POSTGRES_17",
        deletionProtection: true,
        settings: {
          availabilityType: "REGIONAL",
          deletionProtectionEnabled: true,
          edition: "ENTERPRISE",
          ipConfiguration: {ipv4Enabled: false, sslMode: "ENCRYPTED_ONLY"},
        },
      });
    const service = requireResource("gcp:cloudrunv2/service:Service");
    expect(service.inputs).toMatchObject({
      defaultUriDisabled: true,
      ingress: "INGRESS_TRAFFIC_INTERNAL_LOAD_BALANCER",
      invokerIamDisabled: true,
    });
    const serializedService = JSON.stringify(service.inputs);
    expect(serializedService).toContain("ARTIFACT_SERVER_OBJECT_STORAGE_PROVIDER");
    expect(serializedService).toContain("ARTIFACT_SERVER_GCS_BUCKET");
    expect(serializedService).toContain("/cloudsql");
    expect(serializedService).not.toContain("generated-api-token");
    expect(serializedService).not.toContain("generated-database-password");

    expect(requireResource("gcp:compute/backendService:BackendService").inputs)
      .toMatchObject({enableCdn: true, loadBalancingScheme: "EXTERNAL_MANAGED"});
    expect(requireResources("gcp:dns/recordSet:RecordSet")).toHaveLength(4);
    expect(deployment).toMatchObject({
      applicationUrl: "https://artifacts.example.com",
      contentDomain: "artifact-content.example.net",
      healthUrl: "https://artifacts.example.com/health",
      imageDigest: digest,
      mcpUrl: "https://artifacts.example.com/mcp",
      readinessUrl: "https://artifacts.example.com/ready",
      stateBackend: "gs://artifact-server-pulumi-state/gcp-production",
    });
    expect(JSON.stringify(deployment)).not.toContain("generated-api-token");
    expect(JSON.stringify(deployment)).not.toContain("generated-database-password");
  });

  test("DEP-009-F: adopts an existing GCP network without creating one", async () => {
    resources.length = 0;
    const configuration = parseGcpPulumiConfiguration(gcpInput({
      existingNetwork: {
        privateServiceConnection: "projects/example/global/networks/existing/peerings/sql",
        vpcEgressConfiguration: "projects/example/regions/us-central1/subnetworks/application",
        vpcName: "projects/example/global/networks/existing",
      },
    }), "production", "artifact-server-production");
    await pulumi.runtime.runInPulumiStack(async () => {
      const stack = defineGcpStack(configuration);
      return {deployment: stack.deployment};
    });
    expect(resourceTypes()).not.toContain("gcp:compute/network:Network");
    expect(resourceTypes()).not.toContain("gcp:compute/subnetwork:Subnetwork");
    expect(resourceTypes()).not.toContain("gcp:servicenetworking/connection:Connection");
  });
});

function gcpInput(
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
    dnsZoneIds: {application: "artifacts-zone", content: "content-zone"},
    environment: "production",
    imageReference,
    ingress: "public",
    installationName: "artifact-server",
    region: "us-central1",
    secretsProvider: "gcpkms://projects/example/locations/global/keyRings/as/cryptoKeys/state",
    stackName: "production",
    stateBackendUrl: "gs://artifact-server-pulumi-state/gcp-production",
    target: "gcp",
    ...overrides,
  };
}

function resourceTypes(): string[] {
  return resources.map((resource) => resource.type);
}

function requireResource(type: string): pulumi.runtime.MockResourceArgs {
  const resource = resources.find((candidate) => candidate.type === type);
  if (resource === undefined) throw new Error(`Pulumi did not register ${type}.`);
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
  if (args.type === "random:index/randomString:RandomString") {
    return {...base, result: "a1b2c3d4"};
  }
  if (args.type === "gcp:storage/bucket:Bucket") {
    return {...base, name: "as-123456789abc-a1b2c3d4", url: "gs://as-123456789abc-a1b2c3d4"};
  }
  if (args.type === "gcp:serviceaccount/account:Account") {
    return {...base, email: "as-123456789abc-app@artifact-server-production.iam.gserviceaccount.com"};
  }
  if (args.type === "gcp:sql/databaseInstance:DatabaseInstance") {
    return {
      ...base,
      connectionName: "artifact-server-production:us-central1:as-123456789abc-database",
      privateIpAddress: "10.60.16.2",
    };
  }
  if (args.type === "gcp:certificatemanager/dnsAuthorization:DnsAuthorization") {
    return {
      ...base,
      dnsResourceRecords: [{
        data: "validation.example.invalid.",
        name: `_acme-challenge.${String(args.inputs["domain"])}.`,
        type: "CNAME",
      }],
    };
  }
  if (args.type === "gcp:compute/globalAddress:GlobalAddress") {
    return {...base, address: "203.0.113.10"};
  }
  return base;
}
