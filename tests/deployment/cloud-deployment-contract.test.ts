import {Effect, Redacted} from "effect";
import {describe, expect, test} from "vitest";

import {
  type CloudDeploymentDocument,
  parseCloudDeploymentInput,
  parseCloudDeploymentOutput,
} from "../../src/deployment/cloud-deployment-contract.js";
import {
  cloudDeploymentReleaseCheckIds,
  parseCloudDeploymentEvidence,
  validateCloudDeploymentReleaseEvidence,
} from "../../src/deployment/cloud-deployment-evidence.js";

const digest = `sha256:${"a".repeat(64)}`;
const imageReference = `ghcr.io/plannotator/artifact-server@${digest}`;

describe("shared cloud deployment contract", () => {
  test("normalizes the shared defaults and accepts each native provider shape", async () => {
    const inputs = [
      awsInput(),
      gcpInput(),
      cloudflareInput(),
    ];
    const parsed = await Promise.all(inputs.map((input) =>
      Effect.runPromise(parseCloudDeploymentInput(input))
    ));

    expect(parsed.map((input) => input.target)).toEqual([
      "aws",
      "gcp",
      "cloudflare",
    ]);
    expect(parsed.every((input) => input.requestLogSampleRate === 0.01)).toBe(true);
    expect(parsed.every((input) => Object.keys(input.resourceTags).length === 0))
      .toBe(true);
  });

  test("accepts isolated private DNS names without requiring a public suffix", async () => {
    const parsed = await Effect.runPromise(parseCloudDeploymentInput(awsInput({
      applicationDomain: "artifacts.team.internal",
      contentDomain: "content.assets.internal",
      ingress: "private",
      tlsCertificateArn:
        "arn:aws:acm:us-west-2:123456789012:certificate/private-artifacts",
    })));

    expect(parsed).toMatchObject({
      applicationDomain: "artifacts.team.internal",
      contentDomain: "content.assets.internal",
      ingress: "private",
    });
  });

  test.each([
    ["floating image tag", awsInput({imageReference: "artifact-server:latest"})],
    ["same registrable content domain", awsInput({
      applicationDomain: "artifacts.example.com",
      contentDomain: "content.example.com",
    })],
    ["same private DNS boundary", awsInput({
      applicationDomain: "artifacts.team.internal",
      contentDomain: "content.team.internal",
      ingress: "private",
    })],
    ["reversed capacity", awsInput({
      capacity: {
        cpu: 1,
        maximumInstances: 2,
        memoryMiB: 1_024,
        minimumInstances: 3,
      },
    })],
    ["disabled production deletion protection", awsInput({
      deletionProtection: false,
    })],
    ["missing public DNS", awsInput({dnsZoneIds: null})],
    ["one zone for isolated domains", awsInput({
      dnsZoneIds: {application: "zone-artifacts", content: "zone-artifacts"},
    })],
    ["incomplete WorkOS configuration", awsInput({
      workosClientId: "client_01",
    })],
    ["credential-bearing telemetry URL", awsInput({
      otlpEndpoint: "https://collector:password@telemetry.example.org/v1/traces",
    })],
    ["credential-bearing state backend", awsInput({
      stateBackendUrl: "s3://operator:password@state-bucket/production",
    })],
    ["main stack state-backend creation", awsInput({
      createStateBackend: true,
    })],
    ["unsupported direct Azure target", sharedInput({
      imageReference,
      secretsProvider: "passphrase",
      stackName: "production",
      stateBackendUrl: "s3://artifact-server-pulumi-state/azure-production",
      target: "azure",
    })],
    ["local Alchemy state outside development", cloudflareInput({
      stateStore: "local",
    })],
    ["invalid Cloudflare compatibility date", cloudflareInput({
      compatibilityDate: "2026-02-31",
    })],
    ["non-global Cloudflare region", cloudflareInput({region: "us-west-2"})],
  ])("rejects %s before a provider write", async (_name, input) => {
    const failure = await Effect.runPromise(
      parseCloudDeploymentInput(input).pipe(Effect.flip),
    );

    expect(failure).toMatchObject({reason: "invalid_input"});
  });

  test("accepts exact secret-free outputs and binds URLs to the requested stack", async () => {
    const input = await Effect.runPromise(parseCloudDeploymentInput(awsInput()));
    const parsed = await Effect.runPromise(parseCloudDeploymentOutput(
      input,
      deploymentOutput(),
    ));

    expect(parsed).toMatchObject({
      applicationUrl: "https://artifacts.example.com",
      contentDomain: "artifact-content.example.net",
      healthUrl: "https://artifacts.example.com/health",
      mcpUrl: "https://artifacts.example.com/mcp",
      readinessUrl: "https://artifacts.example.com/ready",
    });
  });

  test("rejects output drift, extra output keys, credential URLs, and known secrets", async () => {
    const input = await Effect.runPromise(parseCloudDeploymentInput(awsInput()));
    const knownSecret = "this-is-a-real-provider-secret";
    const cases = [
      deploymentOutput({mcpUrl: "https://other.example.org/mcp"}),
      deploymentOutput({providerConsoleUrl: "https://console.aws.amazon.com"}),
      deploymentOutput({
        supportManifestLocation:
          "https://storage.example.net/manifest.json?X-Amz-Signature=abc",
      }),
      deploymentOutput({
        supportManifestLocation: `s3://support/${knownSecret}/manifest.json`,
      }),
      deploymentOutput({
        secretResourceIds: {
          [knownSecret]: "artifact-server-secret-resource",
        },
      }),
    ];

    const failures = await Promise.all(cases.map((output) => Effect.runPromise(
      parseCloudDeploymentOutput(input, output, {
        knownSecrets: [Redacted.make(knownSecret)],
      }).pipe(Effect.flip),
    )));

    expect(failures.map((failure) => failure.reason)).toEqual([
      "inconsistent_output",
      "invalid_output",
      "secret_output",
      "secret_output",
      "secret_output",
    ]);
    expect(JSON.stringify(failures)).not.toContain(knownSecret);
  });

  test("keeps partial evidence for diagnosis but requires every passing gate for release", async () => {
    const input = await Effect.runPromise(parseCloudDeploymentInput(awsInput()));
    const partial = deploymentEvidence([releaseCheck("clean-apply")]);

    const parsed = await Effect.runPromise(parseCloudDeploymentEvidence(
      input,
      partial,
    ));
    const failure = await Effect.runPromise(
      validateCloudDeploymentReleaseEvidence(input, partial).pipe(Effect.flip),
    );
    const qualified = await Effect.runPromise(validateCloudDeploymentReleaseEvidence(
      input,
      deploymentEvidence(cloudDeploymentReleaseCheckIds.map(releaseCheck)),
    ));

    expect(parsed.checks).toHaveLength(1);
    expect(failure).toMatchObject({field: "checks", reason: "invalid_evidence"});
    expect(qualified.checks).toHaveLength(cloudDeploymentReleaseCheckIds.length);
  });

  test("rejects evidence for the wrong tool, impossible timestamps, and credential locations", async () => {
    const input = await Effect.runPromise(parseCloudDeploymentInput(awsInput()));
    const secret = "evidence-secret-value";
    const cases = [
      deploymentEvidence([releaseCheck("clean-apply")], {
        tool: {
          name: "alchemy",
          providerPackages: {"@pulumi/aws": "7.0.0"},
          version: "3.200.0",
        },
      }),
      deploymentEvidence([{
        completedAt: "2026-08-14T10:00:00.000Z",
        evidenceLocation: "project/evidence/aws-clean-apply.json",
        id: "clean-apply",
        result: "pass",
        startedAt: "2026-08-14T11:00:00.000Z",
      }]),
      deploymentEvidence([{
        ...releaseCheck("clean-apply"),
        evidenceLocation: `https://evidence.example.com/${secret}`,
      }]),
    ];

    const failures = await Promise.all(cases.map((evidence) => Effect.runPromise(
      parseCloudDeploymentEvidence(input, evidence, {
        knownSecrets: [Redacted.make(secret)],
      }).pipe(Effect.flip),
    )));

    expect(failures.map((failure) => failure.reason)).toEqual([
      "invalid_evidence",
      "invalid_evidence",
      "secret_output",
    ]);
    expect(JSON.stringify(failures)).not.toContain(secret);
  });

  test("rejects duplicate release checks and unknown evidence fields", async () => {
    const input = await Effect.runPromise(parseCloudDeploymentInput(awsInput()));
    const duplicate = releaseCheck("clean-apply");
    const cases = [
      deploymentEvidence([duplicate, duplicate]),
      deploymentEvidence([duplicate], {rawProviderResponse: "not allowed"}),
    ];

    const failures = await Promise.all(cases.map((evidence) => Effect.runPromise(
      parseCloudDeploymentEvidence(input, evidence).pipe(Effect.flip),
    )));

    expect(failures).toHaveLength(2);
    expect(failures.every((failure) => failure.reason === "invalid_evidence"))
      .toBe(true);
  });
});

function sharedInput(
  overrides: CloudDeploymentDocument = {},
): CloudDeploymentDocument {
  return {
    applicationDomain: "artifacts.example.com",
    backupRetentionDays: 14,
    bootstrapAdministratorEmail: "admin@example.com",
    capacity: {
      cpu: 1,
      maximumInstances: 4,
      memoryMiB: 1_024,
      minimumInstances: 1,
    },
    contentDomain: "artifact-content.example.net",
    databasePlan: "standard",
    deletionProtection: true,
    dnsZoneIds: {
      application: "zone-artifacts",
      content: "zone-content",
    },
    environment: "production",
    ingress: "public",
    installationName: "team-artifacts",
    region: "us-west-2",
    ...overrides,
  };
}

function awsInput(
  overrides: CloudDeploymentDocument = {},
): CloudDeploymentDocument {
  return sharedInput({
    imageReference,
    secretsProvider: "awskms://alias/artifact-server",
    stackName: "production",
    stateBackendUrl: "s3://artifact-server-pulumi-state/aws-production",
    target: "aws",
    ...overrides,
  });
}

function gcpInput(): CloudDeploymentDocument {
  return sharedInput({
    existingNetwork: {
      privateServiceConnection: "google-managed-services-artifacts",
      vpcEgressConfiguration: "all-traffic",
      vpcName: "artifact-server",
    },
    imageReference,
    region: "us-west1",
    secretsProvider: "gcpkms://projects/example/locations/global/keyRings/iac",
    stackName: "production",
    stateBackendUrl: "https://api.pulumi.com/example-team",
    target: "gcp",
  });
}

function cloudflareInput(
  overrides: CloudDeploymentDocument = {},
): CloudDeploymentDocument {
  return sharedInput({
    cloudflareAccountId: "cloudflare-account-id",
    compatibilityDate: "2026-08-14",
    region: "global",
    stage: "production",
    stateStore: "cloudflare",
    target: "cloudflare",
    ...overrides,
  });
}

function deploymentOutput(
  overrides: CloudDeploymentDocument = {},
): CloudDeploymentDocument {
  return {
    applicationUrl: "https://artifacts.example.com",
    contentDomain: "artifact-content.example.net",
    databaseResourceId: "artifact-server-database",
    healthUrl: "https://artifacts.example.com/health",
    imageDigest: digest,
    installationId: "inst_team_artifacts",
    logDestination: "artifact-server-logs",
    mcpUrl: "https://artifacts.example.com/mcp",
    networkResourceIds: {vpc: "artifact-server-network"},
    objectStorageResourceId: "artifact-server-objects",
    readinessUrl: "https://artifacts.example.com/ready",
    runtimeResourceId: "artifact-server-runtime",
    secretResourceIds: {
      apiToken: "artifact-server-api-token-secret",
      databaseUrl: "artifact-server-database-url-secret",
    },
    stateBackend: "s3://artifact-server-pulumi-state/aws-production",
    supportManifestLocation: "s3://artifact-server-support/manifest.json",
    workloadIdentityResourceId: "artifact-server-task-role",
    ...overrides,
  };
}

function releaseCheck(
  id: typeof cloudDeploymentReleaseCheckIds[number],
): CloudDeploymentDocument {
  return {
    completedAt: "2026-08-14T10:01:00.000Z",
    evidenceLocation: `project/evidence/aws-${id}.json`,
    id,
    result: "pass",
    startedAt: "2026-08-14T10:00:00.000Z",
  };
}

function deploymentEvidence(
  checks: readonly CloudDeploymentDocument[],
  overrides: CloudDeploymentDocument = {},
): CloudDeploymentDocument {
  return {
    artifactServerVersion: "0.1.0",
    checks,
    configurationFingerprint: `sha256:${"b".repeat(64)}`,
    environment: "production",
    outputs: deploymentOutput(),
    realizedResourceSizes: {
      database: "db.t4g.small",
      runtime: "1 vCPU, 1024 MiB",
    },
    recordedAt: "2026-08-14T10:02:00.000Z",
    region: "us-west-2",
    schemaVersion: 1,
    sourceRevision: "0123456789abcdef",
    target: "aws",
    testRevision: "fedcba9876543210",
    tool: {
      name: "pulumi",
      providerPackages: {"@pulumi/aws": "7.0.0"},
      version: "3.200.0",
    },
    ...overrides,
  };
}
