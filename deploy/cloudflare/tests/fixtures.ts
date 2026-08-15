import {
  CLOUDFLARE_COMPATIBILITY_DATE,
  CLOUDFLARE_REGION,
  type CloudflareDeploymentInput,
} from "../src/deployment-input.js";
import type {
  CloudDeploymentOutput,
} from "../../../src/deployment/index.js";

export const validDeploymentInput = {
  installationName: "review",
  environment: "development",
  region: CLOUDFLARE_REGION,
  applicationDomain: "artifacts.example.com",
  contentDomain: "artifact-content.example.net",
  bootstrapAdministratorEmail: "administrator@example.com",
  ingress: "public",
  capacity: {
    minimumInstances: 0,
    maximumInstances: 1,
    cpu: 1,
    memoryMiB: 128,
  },
  databasePlan: "small",
  backupRetentionDays: 7,
  deletionProtection: false,
  dnsZoneIds: {
    application: "0123456789abcdef0123456789abcdef",
    content: "fedcba9876543210fedcba9876543210",
  },
  requestLogSampleRate: 0.01,
  resourceTags: {
    owner: "artifact-server-review",
  },
  stage: "review-foundation",
  cloudflareAccountId: "abcdef0123456789abcdef0123456789",
  compatibilityDate: CLOUDFLARE_COMPATIBILITY_DATE,
  stateStore: "cloudflare",
  target: "cloudflare",
} satisfies CloudflareDeploymentInput;

export const validDeploymentOutput = {
  installationId: "review:development",
  applicationUrl: "https://artifacts.example.com",
  contentDomain: "artifact-content.example.net",
  mcpUrl: "https://artifacts.example.com/mcp",
  healthUrl: "https://artifacts.example.com/health",
  readinessUrl: "https://artifacts.example.com/ready",
  imageDigest:
    "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
  runtimeResourceId: "worker-id",
  databaseResourceId: "database-id",
  objectStorageResourceId: "bucket-name",
  workloadIdentityResourceId: "worker-id",
  secretResourceIds: {
    alchemyStateStore:
      "cloudflare-secrets-store://alchemy-state-store",
  },
  networkResourceIds: {
    applicationDnsZoneId: "0123456789abcdef0123456789abcdef",
    contentWildcardDnsRecordId: "content-wildcard-dns-record-id",
    contentDnsZoneId: "fedcba9876543210fedcba9876543210",
  },
  logDestination: "cloudflare-workers://review-worker",
  stateBackend: "cloudflare:alchemy-state-store",
  supportManifestLocation:
    "r2://review-bucket/support/installation-manifest.json",
} satisfies CloudDeploymentOutput;
