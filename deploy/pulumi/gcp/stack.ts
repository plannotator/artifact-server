import {createHash} from "node:crypto";

import * as gcp from "@pulumi/gcp";
import * as pulumi from "@pulumi/pulumi";
import * as random from "@pulumi/random";

import type {
  CloudDeploymentOutput,
  GcpCloudDeploymentInput,
} from "../../../src/deployment/cloud-deployment-contract.js";
import {defineGcpNetwork} from "./network.js";
import type {GcpDeploymentPlan} from "./plan.js";

const applicationPort = 8_787;
const databaseName = "artifactserver";
const databaseUsername = "artifactadmin";
const enabledServices = [
  "certificatemanager.googleapis.com",
  "compute.googleapis.com",
  "dns.googleapis.com",
  "run.googleapis.com",
  "secretmanager.googleapis.com",
  "servicenetworking.googleapis.com",
  "sqladmin.googleapis.com",
  "storage.googleapis.com",
] as const;

/** Validated values accepted by the GCP resource graph. */
export interface GcpStackConfiguration {
  readonly input: GcpCloudDeploymentInput;
  readonly plan: GcpDeploymentPlan;
  readonly projectId: string;
}

/** Stable, secret-free output returned by the GCP project. */
export interface GcpStackOutputs {
  readonly deployment: pulumi.Output<CloudDeploymentOutput>;
}

interface GcpDeploymentValues {
  readonly databaseResourceId: pulumi.Input<string>;
  readonly installationId: pulumi.Input<string>;
  readonly networkResourceIds: pulumi.Input<Readonly<Record<string, string>>>;
  readonly objectStorageResourceId: pulumi.Input<string>;
  readonly runtimeResourceId: pulumi.Input<string>;
  readonly secretResourceIds: pulumi.Input<Readonly<Record<string, string>>>;
  readonly supportManifestLocation: pulumi.Input<string>;
  readonly workloadIdentityResourceId: pulumi.Input<string>;
}

interface GcpPublicEdge {
  readonly address: gcp.compute.GlobalAddress;
  readonly backend: gcp.compute.BackendService;
  readonly forwardingRule: gcp.compute.GlobalForwardingRule;
}

interface GcpLabels {
  [key: string]: string;
}

/** Define the complete first-party public GCP deployment. */
export function defineGcpStack(
  configuration: GcpStackConfiguration,
): GcpStackOutputs {
  const {input, plan, projectId} = configuration;
  const name = `${input.installationName}-${input.environment}`;
  const physicalName = `as-${createHash("sha256").update(name).digest("hex").slice(0, 12)}`;
  const labels = gcpLabels(input);
  const services = enabledServices.map((service) => new gcp.projects.Service(
    `${name}-${service.split(".")[0]}`,
    {
      disableDependentServices: false,
      disableOnDestroy: false,
      project: projectId,
      service,
    },
  ));
  const installationId = new random.RandomUuid4(`${name}-installation`);
  const bucketSuffix = new random.RandomString(`${name}-bucket-suffix`, {
    length: 8,
    lower: true,
    numeric: true,
    special: false,
    upper: false,
  });
  const apiToken = new random.RandomPassword(`${name}-api-token`, {
    length: 48,
    special: false,
  });
  const databasePassword = new random.RandomPassword(`${name}-database-password`, {
    length: 32,
    special: false,
  });

  const network = defineGcpNetwork({deployment: input, name, projectId});
  const bucket = new gcp.storage.Bucket(`${name}-artifacts`, {
    forceDestroy: false,
    labels,
    location: input.region,
    name: pulumi.interpolate`${physicalName}-${bucketSuffix.result}`,
    project: projectId,
    publicAccessPrevention: "enforced",
    softDeletePolicy: {retentionDurationSeconds: input.backupRetentionDays * 86_400},
    storageClass: "STANDARD",
    uniformBucketLevelAccess: true,
    versioning: {enabled: true},
  }, {dependsOn: services, protect: input.deletionProtection});

  const serviceAccount = new gcp.serviceaccount.Account(`${name}-application`, {
    accountId: `${physicalName}-app`,
    description: "Artifact Server Cloud Run workload identity",
    displayName: `${input.installationName} ${input.environment}`,
    project: projectId,
  }, {dependsOn: services});
  const workloadMember = pulumi.interpolate`serviceAccount:${serviceAccount.email}`;
  const objectAccess = new gcp.storage.BucketIAMMember(`${name}-objects`, {
    bucket: bucket.name,
    member: workloadMember,
    role: "roles/storage.objectAdmin",
  });
  const bucketInspection = new gcp.storage.BucketIAMMember(`${name}-bucket-inspection`, {
    bucket: bucket.name,
    member: workloadMember,
    role: "roles/storage.legacyBucketReader",
  });
  const cloudSqlAccess = new gcp.projects.IAMMember(`${name}-cloud-sql`, {
    member: workloadMember,
    project: projectId,
    role: "roles/cloudsql.client",
  });

  const database = new gcp.sql.DatabaseInstance(`${name}-database`, {
    databaseVersion: "POSTGRES_17",
    deletionProtection: input.deletionProtection,
    name: `${physicalName}-database`,
    project: projectId,
    region: input.region,
    settings: {
      availabilityType: plan.database.availabilityType,
      backupConfiguration: {
        backupRetentionSettings: {
          retainedBackups: input.backupRetentionDays,
          retentionUnit: "COUNT",
        },
        enabled: true,
        pointInTimeRecoveryEnabled: true,
        startTime: "03:00",
        transactionLogRetentionDays: Math.min(input.backupRetentionDays, 7),
      },
      deletionProtectionEnabled: input.deletionProtection,
      diskAutoresize: true,
      diskSize: plan.database.diskSizeGiB,
      diskType: "PD_SSD",
      edition: "ENTERPRISE",
      finalBackupConfig: {enabled: true, retentionDays: input.backupRetentionDays},
      insightsConfig: {
        queryInsightsEnabled: true,
        queryPlansPerMinute: 5,
        recordApplicationTags: true,
      },
      ipConfiguration: {
        enablePrivatePathForGoogleCloudServices: true,
        ipv4Enabled: false,
        privateNetwork: network.networkId,
        sslMode: "ENCRYPTED_ONLY",
      },
      retainBackupsOnDelete: true,
      tier: plan.database.tier,
      userLabels: labels,
    },
  }, {
    dependsOn: [
      ...services,
      ...(network.serviceConnection === undefined ? [] : [network.serviceConnection]),
    ],
    protect: input.deletionProtection,
  });
  const databaseUser = new gcp.sql.User(`${name}-database`, {
    instance: database.name,
    name: databaseUsername,
    password: pulumi.secret(databasePassword.result),
    project: projectId,
  });
  const applicationDatabase = new gcp.sql.Database(`${name}-application`, {
    instance: database.name,
    name: databaseName,
    project: projectId,
  });

  const apiTokenSecret = new gcp.secretmanager.Secret(`${name}-api-token`, {
    labels,
    project: projectId,
    replication: {auto: {}},
    secretId: `${physicalName}-api-token`,
  }, {dependsOn: services, protect: input.deletionProtection});
  const apiTokenVersion = new gcp.secretmanager.SecretVersion(`${name}-api-token`, {
    enabled: true,
    secret: apiTokenSecret.id,
    secretData: pulumi.secret(apiToken.result),
  });
  const databaseUrlSecret = new gcp.secretmanager.Secret(`${name}-database-url`, {
    labels,
    project: projectId,
    replication: {auto: {}},
    secretId: `${physicalName}-database-url`,
  }, {dependsOn: services, protect: input.deletionProtection});
  const databaseUrl = pulumi.secret(pulumi.all([
    database.connectionName,
    databasePassword.result,
  ]).apply(([connectionName, password]) => {
    const socket = encodeURIComponent(`/cloudsql/${connectionName}`);
    return `postgresql://${databaseUsername}:${encodeURIComponent(password)}` +
      `@localhost/${databaseName}?host=${socket}`;
  }));
  const databaseUrlVersion = new gcp.secretmanager.SecretVersion(
    `${name}-database-url`,
    {
      enabled: true,
      secret: databaseUrlSecret.id,
      secretData: databaseUrl,
    },
    {dependsOn: [applicationDatabase, databaseUser]},
  );
  const apiTokenAccess = new gcp.secretmanager.SecretIamMember(
    `${name}-api-token-access`,
    {
      member: workloadMember,
      project: projectId,
      role: "roles/secretmanager.secretAccessor",
      secretId: apiTokenSecret.id,
    },
  );
  const databaseUrlAccess = new gcp.secretmanager.SecretIamMember(
    `${name}-database-url-access`,
    {
      member: workloadMember,
      project: projectId,
      role: "roles/secretmanager.secretAccessor",
      secretId: databaseUrlSecret.id,
    },
  );

  const runtimeEnvironment = gcpRuntimeEnvironment(
    input,
    installationId.result,
    bucket.name,
    projectId,
  );
  if (input.workosClientId !== undefined) {
    runtimeEnvironment.push({
      name: "ARTIFACT_SERVER_WORKOS_CLIENT_ID",
      value: input.workosClientId,
    });
  }
  const secretEnvironment: gcp.types.input.cloudrunv2.ServiceTemplateContainerEnv[] = [
    {
      name: "ARTIFACT_SERVER_API_TOKEN",
      valueSource: {secretKeyRef: {secret: apiTokenSecret.secretId, version: "latest"}},
    },
    {
      name: "ARTIFACT_SERVER_DATABASE_URL",
      valueSource: {secretKeyRef: {secret: databaseUrlSecret.secretId, version: "latest"}},
    },
  ];
  if (input.workosApiKeySecretRef !== undefined) {
    secretEnvironment.push({
      name: "ARTIFACT_SERVER_WORKOS_API_KEY",
      valueSource: {
        secretKeyRef: {secret: input.workosApiKeySecretRef, version: "latest"},
      },
    });
  }
  const runtime = new gcp.cloudrunv2.Service(`${name}-application`, {
    defaultUriDisabled: true,
    deletionProtection: input.deletionProtection,
    description: "Artifact Server application and artifact content runtime",
    ingress: "INGRESS_TRAFFIC_INTERNAL_LOAD_BALANCER",
    invokerIamDisabled: true,
    labels,
    location: input.region,
    name: physicalName,
    project: projectId,
    scaling: {
      maxInstanceCount: input.capacity.maximumInstances,
      minInstanceCount: input.capacity.minimumInstances,
    },
    template: {
      containers: [{
        args: [
          "node dist/cli/main.js migrate apply && exec node dist/cli/main.js start-external-storage --host 0.0.0.0 --port 8787",
        ],
        commands: ["/bin/sh", "-c"],
        envs: [...runtimeEnvironment, ...secretEnvironment],
        image: input.imageReference,
        livenessProbe: {
          failureThreshold: 3,
          httpGet: {path: "/health", port: applicationPort},
          periodSeconds: 30,
          timeoutSeconds: 3,
        },
        name: "artifact-server",
        ports: {containerPort: applicationPort, name: "http1"},
        readinessProbe: {
          failureThreshold: 3,
          httpGet: {path: "/ready", port: applicationPort},
          periodSeconds: 10,
          timeoutSeconds: 3,
        },
        resources: {
          cpuIdle: true,
          limits: {cpu: plan.cpu, memory: plan.memory},
          startupCpuBoost: true,
        },
        startupProbe: {
          failureThreshold: 24,
          httpGet: {path: "/health", port: applicationPort},
          periodSeconds: 5,
          timeoutSeconds: 3,
        },
        volumeMounts: [{mountPath: "/cloudsql", name: "cloudsql"}],
      }],
      executionEnvironment: "EXECUTION_ENVIRONMENT_GEN2",
      maxInstanceRequestConcurrency: 80,
      serviceAccount: serviceAccount.email,
      timeout: "300s",
      volumes: [{
        cloudSqlInstance: {instances: [database.connectionName]},
        name: "cloudsql",
      }],
      vpcAccess: {
        egress: "PRIVATE_RANGES_ONLY",
        networkInterfaces: [{
          network: network.networkName,
          subnetwork: network.subnetworkId,
        }],
      },
    },
    traffics: [{percent: 100, type: "TRAFFIC_TARGET_ALLOCATION_TYPE_LATEST"}],
  }, {
    dependsOn: [
      ...services,
      apiTokenAccess,
      apiTokenVersion,
      bucketInspection,
      cloudSqlAccess,
      databaseUrlAccess,
      databaseUrlVersion,
      objectAccess,
    ],
    protect: input.deletionProtection,
  });

  const edge = defineGcpPublicEdge({input, labels, name, projectId, runtime, services});
  const imageDigest = extractImageDigest(input.imageReference);
  const applicationUrl = `https://${input.applicationDomain}`;
  const supportManifestKey = installationId.result.apply((value) =>
    `support/${value}/installation.json`
  );
  const secretResourceIds = input.workosApiKeySecretRef === undefined
    ? {
      apiToken: apiTokenSecret.id,
      databaseUrl: databaseUrlSecret.id,
    }
    : {
      apiToken: apiTokenSecret.id,
      databaseUrl: databaseUrlSecret.id,
      workosApiKey: input.workosApiKeySecretRef,
    };
  const values: GcpDeploymentValues = {
    databaseResourceId: database.id,
    installationId: installationId.result,
    networkResourceIds: resolveResourceIds({
      ...network.resourceIds,
      globalAddress: edge.address.id,
      httpsForwardingRule: edge.forwardingRule.id,
      loadBalancerBackend: edge.backend.id,
    }),
    objectStorageResourceId: bucket.id,
    runtimeResourceId: runtime.id,
    secretResourceIds: resolveResourceIds(secretResourceIds),
    supportManifestLocation: pulumi.interpolate`gs://${bucket.name}/${supportManifestKey}`,
    workloadIdentityResourceId: serviceAccount.id,
  };
  const deployment = pulumi.output(values).apply((resolved): CloudDeploymentOutput => ({
    applicationUrl,
    contentDomain: input.contentDomain,
    databaseResourceId: resolved.databaseResourceId,
    healthUrl: `${applicationUrl}/health`,
    imageDigest,
    installationId: resolved.installationId,
    logDestination: `logging.googleapis.com/projects/${projectId}`,
    mcpUrl: `${applicationUrl}/mcp`,
    networkResourceIds: resolved.networkResourceIds,
    objectStorageResourceId: resolved.objectStorageResourceId,
    readinessUrl: `${applicationUrl}/ready`,
    runtimeResourceId: resolved.runtimeResourceId,
    secretResourceIds: resolved.secretResourceIds,
    stateBackend: input.stateBackendUrl,
    supportManifestLocation: resolved.supportManifestLocation,
    workloadIdentityResourceId: resolved.workloadIdentityResourceId,
  }));
  const supportManifest = new gcp.storage.BucketObject(`${name}-support-manifest`, {
    bucket: bucket.name,
    content: pulumi.jsonStringify(deployment),
    contentType: "application/json",
    name: supportManifestKey,
  }, {dependsOn: [objectAccess]});
  void supportManifest;
  return {deployment};
}

function defineGcpPublicEdge(input: {
  readonly input: GcpCloudDeploymentInput;
  readonly labels: Readonly<Record<string, string>>;
  readonly name: string;
  readonly projectId: string;
  readonly runtime: gcp.cloudrunv2.Service;
  readonly services: readonly gcp.projects.Service[];
}): GcpPublicEdge {
  const zones = input.input.dnsZoneIds;
  if (zones === undefined) {
    throw new pulumi.RunError("Public GCP ingress requires two existing Cloud DNS managed-zone names.");
  }
  const applicationAuthorization = defineDnsAuthorization({
    domain: input.input.applicationDomain,
    labels: input.labels,
    managedZone: zones.application,
    name: `${input.name}-application`,
    projectId: input.projectId,
  });
  const contentAuthorization = defineDnsAuthorization({
    domain: input.input.contentDomain,
    labels: input.labels,
    managedZone: zones.content,
    name: `${input.name}-content`,
    projectId: input.projectId,
  });
  const certificate = new gcp.certificatemanager.Certificate(`${input.name}-edge`, {
    labels: input.labels,
    location: "global",
    managed: {
      dnsAuthorizations: [applicationAuthorization.id, contentAuthorization.id],
      domains: [input.input.applicationDomain, `*.${input.input.contentDomain}`],
    },
    project: input.projectId,
  }, {dependsOn: [...input.services]});
  const certificateMap = new gcp.certificatemanager.CertificateMap(`${input.name}-edge`, {
    labels: input.labels,
    project: input.projectId,
  }, {dependsOn: [...input.services]});
  const applicationEntry = new gcp.certificatemanager.CertificateMapEntry(
    `${input.name}-application`,
    {
      certificates: [certificate.id],
      hostname: input.input.applicationDomain,
      map: certificateMap.name,
      project: input.projectId,
    },
  );
  const contentEntry = new gcp.certificatemanager.CertificateMapEntry(
    `${input.name}-content`,
    {
      certificates: [certificate.id],
      hostname: `*.${input.input.contentDomain}`,
      map: certificateMap.name,
      project: input.projectId,
    },
  );
  const neg = new gcp.compute.RegionNetworkEndpointGroup(`${input.name}-application`, {
    cloudRun: {service: input.runtime.name},
    name: `${input.name}-application`,
    networkEndpointType: "SERVERLESS",
    project: input.projectId,
    region: input.input.region,
  }, {dependsOn: [...input.services]});
  const backend = new gcp.compute.BackendService(`${input.name}-application`, {
    backends: [{group: neg.id}],
    cdnPolicy: {
      cacheMode: "USE_ORIGIN_HEADERS",
      negativeCaching: false,
      serveWhileStale: 0,
    },
    compressionMode: "AUTOMATIC",
    enableCdn: true,
    loadBalancingScheme: "EXTERNAL_MANAGED",
    project: input.projectId,
    protocol: "HTTP",
  }, {dependsOn: [...input.services]});
  const urlMap = new gcp.compute.URLMap(`${input.name}-application`, {
    defaultService: backend.id,
    project: input.projectId,
  });
  const proxy = new gcp.compute.TargetHttpsProxy(`${input.name}-application`, {
    certificateMap: pulumi.interpolate`//certificatemanager.googleapis.com/${certificateMap.id}`,
    project: input.projectId,
    quicOverride: "ENABLE",
    urlMap: urlMap.id,
  }, {dependsOn: [applicationEntry, contentEntry]});
  const address = new gcp.compute.GlobalAddress(`${input.name}-application`, {
    addressType: "EXTERNAL",
    ipVersion: "IPV4",
    project: input.projectId,
  }, {dependsOn: [...input.services]});
  const forwardingRule = new gcp.compute.GlobalForwardingRule(
    `${input.name}-application`,
    {
      ipAddress: address.id,
      loadBalancingScheme: "EXTERNAL_MANAGED",
      portRange: "443",
      project: input.projectId,
      target: proxy.id,
    },
  );
  const applicationRecord = new gcp.dns.RecordSet(`${input.name}-application`, {
    managedZone: zones.application,
    name: `${input.input.applicationDomain}.`,
    project: input.projectId,
    rrdatas: [address.address],
    ttl: 300,
    type: "A",
  });
  const contentRecord = new gcp.dns.RecordSet(`${input.name}-content`, {
    managedZone: zones.content,
    name: `*.${input.input.contentDomain}.`,
    project: input.projectId,
    rrdatas: [address.address],
    ttl: 300,
    type: "A",
  });
  void applicationRecord;
  void contentRecord;
  return {address, backend, forwardingRule};
}

function defineDnsAuthorization(input: {
  readonly domain: string;
  readonly labels: Readonly<Record<string, string>>;
  readonly managedZone: string;
  readonly name: string;
  readonly projectId: string;
}): gcp.certificatemanager.DnsAuthorization {
  const authorization = new gcp.certificatemanager.DnsAuthorization(input.name, {
    domain: input.domain,
    labels: input.labels,
    location: "global",
    project: input.projectId,
    type: "FIXED_RECORD",
  });
  const validation = new gcp.dns.RecordSet(`${input.name}-validation`, {
    managedZone: input.managedZone,
    name: authorization.dnsResourceRecords.apply((records) => requireFirst(records).name),
    project: input.projectId,
    rrdatas: [authorization.dnsResourceRecords.apply((records) => requireFirst(records).data)],
    ttl: 300,
    type: authorization.dnsResourceRecords.apply((records) => requireFirst(records).type),
  });
  void validation;
  return authorization;
}

function gcpRuntimeEnvironment(
  input: GcpCloudDeploymentInput,
  installationId: pulumi.Input<string>,
  bucket: pulumi.Input<string>,
  projectId: string,
): gcp.types.input.cloudrunv2.ServiceTemplateContainerEnv[] {
  const environment: gcp.types.input.cloudrunv2.ServiceTemplateContainerEnv[] = [
    {name: "ARTIFACT_SERVER_BOOTSTRAP_ADMIN_EMAIL", value: input.bootstrapAdministratorEmail},
    {name: "ARTIFACT_SERVER_CONTENT_DOMAIN", value: input.contentDomain},
    {name: "ARTIFACT_SERVER_GCS_BUCKET", value: bucket},
    {name: "ARTIFACT_SERVER_GCS_PROJECT_ID", value: projectId},
    {name: "ARTIFACT_SERVER_INSTALLATION_ID", value: installationId},
    {name: "ARTIFACT_SERVER_OBJECT_STORAGE_PROVIDER", value: "gcs"},
    {name: "ARTIFACT_SERVER_ORIGIN", value: `https://${input.applicationDomain}`},
    {name: "ARTIFACT_SERVER_READINESS_WITHDRAWAL_MS", value: "1000"},
    {name: "ARTIFACT_SERVER_REQUEST_LOG_SAMPLE_RATE", value: String(input.requestLogSampleRate)},
    {name: "ARTIFACT_SERVER_SHUTDOWN_DEADLINE_MS", value: "10000"},
    {name: "NODE_ENV", value: "production"},
  ];
  if (input.otlpEndpoint !== undefined) {
    environment.push(
      {name: "OTEL_EXPORTER_OTLP_ENDPOINT", value: input.otlpEndpoint},
      {name: "OTEL_LOGS_EXPORTER", value: "otlp"},
      {name: "OTEL_METRICS_EXPORTER", value: "otlp"},
      {name: "OTEL_TRACES_EXPORTER", value: "otlp"},
    );
  }
  return environment;
}

function gcpLabels(input: GcpCloudDeploymentInput): GcpLabels {
  const labels: GcpLabels = {
    environment: input.environment,
    installation: input.installationName,
    managed_by: "pulumi",
  };
  for (const [key, value] of Object.entries(input.resourceTags)) {
    const normalizedKey = normalizeLabel(key);
    if (normalizedKey !== "") labels[normalizedKey] = normalizeLabel(value).slice(0, 63);
  }
  return labels;
}

function normalizeLabel(value: string): string {
  return value.toLowerCase().replaceAll(/[^a-z0-9_-]/gu, "_").slice(0, 63);
}

function extractImageDigest(reference: string): string {
  const digest = reference.split("@")[1];
  if (digest === undefined) throw new Error("The parsed image reference has no digest.");
  return digest;
}

function requireFirst<T>(values: readonly T[]): T {
  const value = values[0];
  if (value === undefined) throw new Error("Google returned no DNS authorization record.");
  return value;
}

function resolveResourceIds(
  resources: Readonly<Record<string, pulumi.Input<string>>>,
): pulumi.Output<Readonly<Record<string, string>>> {
  const entries = Object.entries(resources);
  return pulumi.all(entries.map(([, value]) => value)).apply((values) =>
    Object.fromEntries(entries.map(([key], index) => [key, values[index] ?? ""]))
  );
}
