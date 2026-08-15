import {createHash} from "node:crypto";

import * as azure from "@pulumi/azure-native";
import * as pulumi from "@pulumi/pulumi";
import * as random from "@pulumi/random";

import type {
  AzureCloudDeploymentInput,
  CloudDeploymentOutput,
} from "../../../src/deployment/cloud-deployment-contract.js";
import {defineAzureNetwork} from "./network.js";
import type {AzureDeploymentPlan} from "./plan.js";
import {
  parseDnsZoneId,
  parseKeyVaultSecretId,
  type ParsedAzureResourceId,
  type ParsedKeyVaultSecretId,
  relativeDnsName,
  requireDnsZoneId,
  requireTlsCertificateSecretId,
} from "./resource-identifiers.js";

const applicationPort = 8_787;
const databaseName = "artifactserver";
const databaseUsername = "artifactadmin";
const storageBlobDataContributor = "ba92f5b4-2d11-453d-a403-e96b0029c9fe";
const keyVaultSecretsUser = "4633458b-17de-408a-b874-0445c86b69e6";

/** Validated values accepted by the Azure resource graph. */
export interface AzureStackConfiguration {
  readonly input: AzureCloudDeploymentInput;
  readonly plan: AzureDeploymentPlan;
  readonly subscriptionId: string;
  readonly tenantId: string;
}

/** Stable, secret-free output returned by the Azure project. */
export interface AzureStackOutputs {
  readonly deployment: pulumi.Output<CloudDeploymentOutput>;
}

interface AzureDeploymentValues {
  readonly databaseResourceId: pulumi.Input<string>;
  readonly installationId: pulumi.Input<string>;
  readonly logDestination: pulumi.Input<string>;
  readonly networkResourceIds: pulumi.Input<Readonly<Record<string, string>>>;
  readonly objectStorageResourceId: pulumi.Input<string>;
  readonly runtimeResourceId: pulumi.Input<string>;
  readonly secretResourceIds: pulumi.Input<Readonly<Record<string, string>>>;
  readonly supportManifestLocation: pulumi.Input<string>;
  readonly workloadIdentityResourceId: pulumi.Input<string>;
}

interface AzurePublicEdge {
  readonly applicationDomain: azure.cdn.AFDCustomDomain;
  readonly contentDomain: azure.cdn.AFDCustomDomain;
  readonly endpoint: azure.cdn.AFDEndpoint;
  readonly origin: azure.cdn.Origin;
  readonly originGroup: azure.cdn.OriginGroup;
  readonly profile: azure.cdn.Profile;
  readonly route: azure.cdn.Route;
}

interface AzureTags {
  readonly [key: string]: string;
}

/** Define the complete first-party public Azure deployment. */
export function defineAzureStack(
  configuration: AzureStackConfiguration,
): AzureStackOutputs {
  const {input, plan, subscriptionId, tenantId} = configuration;
  const name = `${input.installationName}-${input.environment}`;
  const hash = createHash("sha256").update(name).digest("hex").slice(0, 12);
  const physicalName = `as-${hash}`;
  const compactName = `as${hash}`;
  const tags = azureTags(input);
  const certificateSecretId = requireTlsCertificateSecretId(input);
  const certificateSecret = parseKeyVaultSecretId(certificateSecretId);
  const applicationZone = parseDnsZoneId(requireDnsZoneId(input, "application"));
  const contentZone = parseDnsZoneId(requireDnsZoneId(input, "content"));

  const resourceGroup = new azure.resources.ResourceGroup(`${name}-resources`, {
    location: input.region,
    resourceGroupName: `${physicalName}-resources`,
    tags,
  }, {protect: input.deletionProtection});
  const installationId = new random.RandomUuid4(`${name}-installation`);
  const apiToken = new random.RandomPassword(`${name}-api-token`, {
    length: 48,
    special: false,
  });
  const databasePassword = new random.RandomPassword(`${name}-database-password`, {
    length: 32,
    special: false,
  });

  const network = defineAzureNetwork({
    deployment: input,
    location: input.region,
    name,
    resourceGroupName: resourceGroup.name,
    tags,
  });
  const workloadIdentity = new azure.managedidentity.UserAssignedIdentity(
    `${name}-application`,
    {
      location: input.region,
      resourceGroupName: resourceGroup.name,
      resourceName: `${physicalName}-application`,
      tags,
    },
    {protect: input.deletionProtection},
  );

  const storageAccount = new azure.storage.StorageAccount(`${name}-artifacts`, {
    accountName: compactName,
    allowBlobPublicAccess: false,
    allowCrossTenantReplication: false,
    allowSharedKeyAccess: false,
    defaultToOAuthAuthentication: true,
    enableHttpsTrafficOnly: true,
    kind: "StorageV2",
    location: input.region,
    minimumTlsVersion: "TLS1_2",
    publicNetworkAccess: "Enabled",
    resourceGroupName: resourceGroup.name,
    sku: {name: input.databasePlan === "high-availability" ? "Standard_GZRS" : "Standard_ZRS"},
    tags,
  }, {protect: input.deletionProtection});
  const blobService = new azure.storage.BlobServiceProperties(`${name}-artifacts`, {
    accountName: storageAccount.name,
    blobServicesName: "default",
    containerDeleteRetentionPolicy: {
      days: input.backupRetentionDays,
      enabled: true,
    },
    deleteRetentionPolicy: {
      days: input.backupRetentionDays,
      enabled: true,
    },
    isVersioningEnabled: true,
    resourceGroupName: resourceGroup.name,
  });
  const artifactContainer = new azure.storage.BlobContainer(`${name}-artifacts`, {
    accountName: storageAccount.name,
    containerName: "artifacts",
    publicAccess: "None",
    resourceGroupName: resourceGroup.name,
  }, {dependsOn: [blobService], protect: input.deletionProtection});
  const objectAccess = defineRoleAssignment({
    name: `${name}-objects`,
    principalId: workloadIdentity.principalId,
    roleDefinitionId: storageBlobDataContributor,
    scope: artifactContainer.id,
    subscriptionId,
  });

  const database = new azure.dbforpostgresql.Server(`${name}-database`, {
    administratorLogin: databaseUsername,
    administratorLoginPassword: pulumi.secret(databasePassword.result),
    authConfig: {activeDirectoryAuth: "Disabled", passwordAuth: "Enabled"},
    backup: {
      backupRetentionDays: input.backupRetentionDays,
      geoRedundantBackup: input.databasePlan === "high-availability" ? "Enabled" : "Disabled",
    },
    createMode: "Create",
    highAvailability: {mode: plan.database.highAvailabilityMode},
    location: input.region,
    network: {
      delegatedSubnetResourceId: network.postgresSubnetId,
      privateDnsZoneArmResourceId: network.privateDnsZoneId,
      publicNetworkAccess: "Disabled",
    },
    resourceGroupName: resourceGroup.name,
    serverName: `${physicalName}-database`,
    sku: {name: plan.database.skuName, tier: plan.database.tier},
    storage: {autoGrow: "Enabled", storageSizeGB: plan.database.storageSizeGiB},
    tags,
    version: "17",
  }, {protect: input.deletionProtection});
  const applicationDatabase = new azure.dbforpostgresql.Database(
    `${name}-application`,
    {
      charset: "UTF8",
      collation: "en_US.utf8",
      databaseName,
      resourceGroupName: resourceGroup.name,
      serverName: database.name,
    },
  );

  const vault = new azure.keyvault.Vault(`${name}-runtime`, {
    location: input.region,
    properties: {
      enablePurgeProtection: input.deletionProtection,
      enableRbacAuthorization: true,
      enableSoftDelete: true,
      publicNetworkAccess: "Enabled",
      sku: {family: "A", name: "standard"},
      softDeleteRetentionInDays: Math.min(90, input.backupRetentionDays),
      tenantId,
    },
    resourceGroupName: resourceGroup.name,
    tags,
    vaultName: `${compactName}kv`,
  }, {protect: input.deletionProtection});
  const runtimeSecretAccess = defineRoleAssignment({
    name: `${name}-runtime-secrets`,
    principalId: workloadIdentity.principalId,
    roleDefinitionId: keyVaultSecretsUser,
    scope: vault.id,
    subscriptionId,
  });
  const certificateAccess = defineRoleAssignment({
    name: `${name}-certificate`,
    principalId: workloadIdentity.principalId,
    roleDefinitionId: keyVaultSecretsUser,
    scope: certificateSecret.vaultId,
    subscriptionId,
  });
  const apiTokenSecret = new azure.keyvault.Secret(`${name}-api-token`, {
    properties: {
      attributes: {enabled: true},
      contentType: "text/plain",
      value: pulumi.secret(apiToken.result),
    },
    resourceGroupName: resourceGroup.name,
    secretName: "artifact-server-api-token",
    tags,
    vaultName: vault.name,
  }, {protect: input.deletionProtection});
  const databaseUrl = pulumi.secret(pulumi.all([
    database.fullyQualifiedDomainName,
    databasePassword.result,
  ]).apply(([hostname, password]) =>
    `postgresql://${databaseUsername}:${encodeURIComponent(password)}` +
    `@${hostname}:5432/${databaseName}?sslmode=verify-full`
  ));
  const databaseUrlSecret = new azure.keyvault.Secret(`${name}-database-url`, {
    properties: {
      attributes: {enabled: true},
      contentType: "text/plain",
      value: databaseUrl,
    },
    resourceGroupName: resourceGroup.name,
    secretName: "artifact-server-database-url",
    tags,
    vaultName: vault.name,
  }, {dependsOn: [applicationDatabase], protect: input.deletionProtection});
  const apiTokenSecretUrl = pulumi.interpolate`https://${vault.name}.vault.azure.net/secrets/artifact-server-api-token`;
  const databaseUrlSecretUrl = pulumi.interpolate`https://${vault.name}.vault.azure.net/secrets/artifact-server-database-url`;

  const logWorkspace = new azure.operationalinsights.Workspace(`${name}-logs`, {
    location: input.region,
    publicNetworkAccessForIngestion: "Enabled",
    publicNetworkAccessForQuery: "Enabled",
    resourceGroupName: resourceGroup.name,
    retentionInDays: 30,
    sku: {name: "PerGB2018"},
    tags,
    workspaceName: `${physicalName}-logs`,
  }, {protect: input.deletionProtection});
  const logKeys = azure.operationalinsights.getSharedKeysOutput({
    resourceGroupName: resourceGroup.name,
    workspaceName: logWorkspace.name,
  }, {dependsOn: [logWorkspace]});
  const managedEnvironment = new azure.app.ManagedEnvironment(`${name}-application`, {
    appLogsConfiguration: {
      destination: "log-analytics",
      logAnalyticsConfiguration: {
        customerId: logWorkspace.customerId,
        dynamicJsonColumns: true,
        sharedKey: pulumi.secret(logKeys.primarySharedKey),
      },
    },
    environmentName: `${physicalName}-application`,
    location: input.region,
    publicNetworkAccess: "Enabled",
    resourceGroupName: resourceGroup.name,
    tags,
    vnetConfiguration: {
      infrastructureSubnetId: network.containerAppsSubnetId,
      internal: false,
    },
    zoneRedundant: input.databasePlan === "high-availability",
  }, {protect: input.deletionProtection});
  const applicationCertificate = new azure.app.Certificate(`${name}-edge`, {
    certificateName: `${physicalName}-edge`,
    environmentName: managedEnvironment.name,
    location: input.region,
    properties: {
      certificateKeyVaultProperties: {
        identity: workloadIdentity.id,
        keyVaultUrl: certificateSecret.secretUrl,
      },
      certificateType: "ServerSSLCertificate",
    },
    resourceGroupName: resourceGroup.name,
    tags,
  }, {dependsOn: [certificateAccess]});

  const appSecrets: azure.types.input.app.SecretArgs[] = [
    {
      identity: workloadIdentity.id,
      keyVaultUrl: apiTokenSecretUrl,
      name: "api-token",
    },
    {
      identity: workloadIdentity.id,
      keyVaultUrl: databaseUrlSecretUrl,
      name: "database-url",
    },
  ];
  const secretResourceIds = input.workosApiKeySecretRef === undefined
    ? {
      apiToken: apiTokenSecret.id,
      databaseUrl: databaseUrlSecret.id,
      tlsCertificate: certificateSecretId,
    }
    : {
      apiToken: apiTokenSecret.id,
      databaseUrl: databaseUrlSecret.id,
      tlsCertificate: certificateSecretId,
      workosApiKey: input.workosApiKeySecretRef,
    };
  if (input.workosApiKeySecretRef !== undefined) {
    const workosSecret = parseKeyVaultSecretId(input.workosApiKeySecretRef);
    const workosSecretAccess = defineRoleAssignment({
      name: `${name}-workos-secret`,
      principalId: workloadIdentity.principalId,
      roleDefinitionId: keyVaultSecretsUser,
      scope: workosSecret.vaultId,
      subscriptionId,
    });
    appSecrets.push({
      identity: workloadIdentity.id,
      keyVaultUrl: workosSecret.secretUrl,
      name: "workos-api-key",
    });
    void workosSecretAccess;
  }
  const environment = azureRuntimeEnvironment(
    input,
    installationId.result,
    storageAccount.name,
  );
  environment.push(
    {name: "ARTIFACT_SERVER_API_TOKEN", secretRef: "api-token"},
    {name: "ARTIFACT_SERVER_DATABASE_URL", secretRef: "database-url"},
  );
  if (input.workosClientId !== undefined) {
    environment.push(
      {name: "ARTIFACT_SERVER_WORKOS_API_KEY", secretRef: "workos-api-key"},
      {name: "ARTIFACT_SERVER_WORKOS_CLIENT_ID", value: input.workosClientId},
    );
  }
  const runtime = new azure.app.ContainerApp(`${name}-application`, {
    configuration: {
      activeRevisionsMode: "Single",
      ingress: {
        allowInsecure: false,
        customDomains: [
          {
            bindingType: "SniEnabled",
            certificateId: applicationCertificate.id,
            name: input.applicationDomain,
          },
          {
            bindingType: "SniEnabled",
            certificateId: applicationCertificate.id,
            name: `*.${input.contentDomain}`,
          },
        ],
        external: true,
        targetPort: applicationPort,
        traffic: [{latestRevision: true, weight: 100}],
        transport: "Auto",
      },
      maxInactiveRevisions: 10,
      secrets: appSecrets,
    },
    containerAppName: physicalName,
    environmentId: managedEnvironment.id,
    identity: {
      type: "UserAssigned",
      userAssignedIdentities: [workloadIdentity.id],
    },
    location: input.region,
    resourceGroupName: resourceGroup.name,
    tags,
    template: {
      containers: [{
        args: [
          "node dist/cli/main.js migrate apply && exec node dist/cli/main.js start-external-storage --host 0.0.0.0 --port 8787",
        ],
        command: ["/bin/sh", "-c"],
        env: environment,
        image: input.imageReference,
        name: "artifact-server",
        probes: [
          {
            failureThreshold: 24,
            httpGet: {path: "/health", port: applicationPort, scheme: "HTTP"},
            periodSeconds: 5,
            timeoutSeconds: 3,
            type: "Startup",
          },
          {
            failureThreshold: 3,
            httpGet: {path: "/health", port: applicationPort, scheme: "HTTP"},
            periodSeconds: 30,
            timeoutSeconds: 3,
            type: "Liveness",
          },
          {
            failureThreshold: 3,
            httpGet: {path: "/ready", port: applicationPort, scheme: "HTTP"},
            periodSeconds: 10,
            timeoutSeconds: 3,
            type: "Readiness",
          },
        ],
        resources: {cpu: plan.cpu, memory: plan.memory},
      }],
      scale: {
        maxReplicas: input.capacity.maximumInstances,
        minReplicas: input.capacity.minimumInstances,
        rules: [{
          http: {metadata: {concurrentRequests: "80"}},
          name: "http-concurrency",
        }],
      },
      terminationGracePeriodSeconds: 30,
    },
  }, {
    dependsOn: [objectAccess, runtimeSecretAccess],
    protect: input.deletionProtection,
  });

  const edge = defineAzurePublicEdge({
    applicationZone,
    certificateSecret,
    contentZone,
    input,
    name,
    physicalName,
    resourceGroupName: resourceGroup.name,
    runtime,
    subscriptionId,
    tags,
  });
  const applicationUrl = `https://${input.applicationDomain}`;
  const supportManifestKey = installationId.result.apply((value) =>
    `support/${value}/installation.json`
  );
  const values: AzureDeploymentValues = {
    databaseResourceId: database.id,
    installationId: installationId.result,
    logDestination: logWorkspace.id,
    networkResourceIds: resolveResourceIds({
      ...network.resourceIds,
      frontDoorApplicationDomain: edge.applicationDomain.id,
      frontDoorContentDomain: edge.contentDomain.id,
      frontDoorEndpoint: edge.endpoint.id,
      frontDoorOrigin: edge.origin.id,
      frontDoorOriginGroup: edge.originGroup.id,
      frontDoorProfile: edge.profile.id,
      frontDoorRoute: edge.route.id,
      resourceGroup: resourceGroup.id,
    }),
    objectStorageResourceId: artifactContainer.id,
    runtimeResourceId: runtime.id,
    secretResourceIds: resolveResourceIds(secretResourceIds),
    supportManifestLocation: pulumi.interpolate`https://${storageAccount.name}.blob.core.windows.net/artifacts/${supportManifestKey}`,
    workloadIdentityResourceId: workloadIdentity.id,
  };
  const deployment = pulumi.output(values).apply((resolved): CloudDeploymentOutput => ({
    applicationUrl,
    contentDomain: input.contentDomain,
    databaseResourceId: resolved.databaseResourceId,
    healthUrl: `${applicationUrl}/health`,
    imageDigest: extractImageDigest(input.imageReference),
    installationId: resolved.installationId,
    logDestination: resolved.logDestination,
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
  const supportManifest = new azure.storage.Blob(`${name}-support-manifest`, {
    accountName: storageAccount.name,
    blobName: supportManifestKey,
    containerName: artifactContainer.name,
    contentType: "application/json",
    resourceGroupName: resourceGroup.name,
    source: deployment.apply((value) =>
      new pulumi.asset.StringAsset(JSON.stringify(value))
    ),
    type: "Block",
  }, {dependsOn: [objectAccess]});
  void supportManifest;
  return {deployment};
}

function defineAzurePublicEdge(input: {
  readonly applicationZone: ParsedAzureResourceId;
  readonly certificateSecret: ParsedKeyVaultSecretId;
  readonly contentZone: ParsedAzureResourceId;
  readonly input: AzureCloudDeploymentInput;
  readonly name: string;
  readonly physicalName: string;
  readonly resourceGroupName: pulumi.Input<string>;
  readonly runtime: azure.app.ContainerApp;
  readonly subscriptionId: string;
  readonly tags: Readonly<Record<string, string>>;
}): AzurePublicEdge {
  const profile = new azure.cdn.Profile(`${input.name}-edge`, {
    identity: {type: "SystemAssigned"},
    location: "global",
    originResponseTimeoutSeconds: 60,
    profileName: `${input.physicalName}-edge`,
    resourceGroupName: input.resourceGroupName,
    sku: {name: "Standard_AzureFrontDoor"},
    tags: input.tags,
  });
  const profilePrincipalId = profile.identity.apply((identity) => {
    if (identity?.principalId === undefined) {
      throw new Error("Azure Front Door returned no system-assigned principal ID.");
    }
    return identity.principalId;
  });
  const edgeCertificateAccess = defineRoleAssignment({
    name: `${input.name}-edge-certificate`,
    principalId: profilePrincipalId,
    roleDefinitionId: keyVaultSecretsUser,
    scope: input.certificateSecret.vaultId,
    subscriptionId: input.subscriptionId,
  });
  const edgeCertificate = new azure.cdn.Secret(`${input.name}-edge`, {
    parameters: {
      secretSource: {id: input.certificateSecret.vaultId + `/secrets/${input.certificateSecret.secretName}`},
      type: "CustomerCertificate",
      useLatestVersion: true,
    },
    profileName: profile.name,
    resourceGroupName: input.resourceGroupName,
    secretName: `${input.physicalName}-edge`,
  }, {dependsOn: [edgeCertificateAccess]});
  const endpoint = new azure.cdn.AFDEndpoint(`${input.name}-edge`, {
    enabledState: "Enabled",
    endpointName: input.physicalName,
    location: "global",
    profileName: profile.name,
    resourceGroupName: input.resourceGroupName,
    tags: input.tags,
  });
  const origin = new azure.cdn.Origin(`${input.name}-application`, {
    enabled: true,
    endpointName: endpoint.name,
    hostName: input.runtime.latestRevisionFqdn,
    httpPort: 80,
    httpsPort: 443,
    originName: "application",
    priority: 1,
    profileName: profile.name,
    resourceGroupName: input.resourceGroupName,
    weight: 1_000,
  });
  const originGroup = new azure.cdn.OriginGroup(`${input.name}-application`, {
    endpointName: endpoint.name,
    healthProbeSettings: {
      probeIntervalInSeconds: 30,
      probePath: "/ready",
      probeProtocol: "Https",
      probeRequestType: "HEAD",
    },
    originGroupName: "application",
    origins: [{id: origin.id}],
    profileName: profile.name,
    resourceGroupName: input.resourceGroupName,
  });
  const applicationDomain = new azure.cdn.AFDCustomDomain(
    `${input.name}-application`,
    {
      azureDnsZone: {id: requireDnsZoneId(input.input, "application")},
      customDomainName: `${input.physicalName}-application`,
      hostName: input.input.applicationDomain,
      profileName: profile.name,
      resourceGroupName: input.resourceGroupName,
      tlsSettings: {
        certificateType: "CustomerCertificate",
        minimumTlsVersion: "TLS12",
        secret: {id: edgeCertificate.id},
      },
    },
  );
  const contentDomain = new azure.cdn.AFDCustomDomain(`${input.name}-content`, {
    azureDnsZone: {id: requireDnsZoneId(input.input, "content")},
    customDomainName: `${input.physicalName}-content`,
    hostName: `*.${input.input.contentDomain}`,
    profileName: profile.name,
    resourceGroupName: input.resourceGroupName,
    tlsSettings: {
      certificateType: "CustomerCertificate",
      minimumTlsVersion: "TLS12",
      secret: {id: edgeCertificate.id},
    },
  });
  const route = new azure.cdn.Route(`${input.name}-application`, {
    cacheConfiguration: {
      compressionSettings: {
        contentTypesToCompress: [
          "application/javascript",
          "application/json",
          "application/wasm",
          "image/svg+xml",
          "text/css",
          "text/html",
          "text/javascript",
          "text/plain",
        ],
        isCompressionEnabled: true,
      },
      queryStringCachingBehavior: "UseQueryString",
    },
    customDomains: [{id: applicationDomain.id}, {id: contentDomain.id}],
    enabledState: "Enabled",
    endpointName: endpoint.name,
    forwardingProtocol: "HttpsOnly",
    httpsRedirect: "Enabled",
    linkToDefaultDomain: "Disabled",
    originGroup: {id: originGroup.id},
    patternsToMatch: ["/*"],
    profileName: profile.name,
    resourceGroupName: input.resourceGroupName,
    routeName: "application",
    supportedProtocols: ["Http", "Https"],
  }, {dependsOn: [origin]});
  const applicationRecord = new azure.dns.RecordSet(`${input.name}-application`, {
    cnameRecord: {cname: endpoint.hostName},
    recordType: "CNAME",
    relativeRecordSetName: relativeDnsName(
      input.input.applicationDomain,
      input.applicationZone.name,
    ),
    resourceGroupName: input.applicationZone.resourceGroupName,
    ttl: 300,
    zoneName: input.applicationZone.name,
  });
  const contentRecord = new azure.dns.RecordSet(`${input.name}-content`, {
    cnameRecord: {cname: endpoint.hostName},
    recordType: "CNAME",
    relativeRecordSetName: relativeDnsName(
      `*.${input.input.contentDomain}`,
      input.contentZone.name,
    ),
    resourceGroupName: input.contentZone.resourceGroupName,
    ttl: 300,
    zoneName: input.contentZone.name,
  });
  void applicationRecord;
  void contentRecord;
  void route;
  return {
    applicationDomain,
    contentDomain,
    endpoint,
    origin,
    originGroup,
    profile,
    route,
  };
}

function azureRuntimeEnvironment(
  input: AzureCloudDeploymentInput,
  installationId: pulumi.Input<string>,
  storageAccountName: pulumi.Input<string>,
): azure.types.input.app.EnvironmentVarArgs[] {
  const environment: azure.types.input.app.EnvironmentVarArgs[] = [
    {name: "ARTIFACT_SERVER_AZURE_BLOB_ACCOUNT_URL", value: pulumi.interpolate`https://${storageAccountName}.blob.core.windows.net`},
    {name: "ARTIFACT_SERVER_AZURE_BLOB_CONTAINER", value: "artifacts"},
    {name: "ARTIFACT_SERVER_BOOTSTRAP_ADMIN_EMAIL", value: input.bootstrapAdministratorEmail},
    {name: "ARTIFACT_SERVER_CONTENT_DOMAIN", value: input.contentDomain},
    {name: "ARTIFACT_SERVER_INSTALLATION_ID", value: installationId},
    {name: "ARTIFACT_SERVER_OBJECT_STORAGE_PROVIDER", value: "azure-blob"},
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

function defineRoleAssignment(input: {
  readonly name: string;
  readonly principalId: pulumi.Input<string>;
  readonly roleDefinitionId: string;
  readonly scope: pulumi.Input<string>;
  readonly subscriptionId: string;
}): azure.authorization.RoleAssignment {
  return new azure.authorization.RoleAssignment(input.name, {
    description: `Artifact Server ${input.name}`,
    principalId: input.principalId,
    principalType: "ServicePrincipal",
    roleAssignmentName: deterministicGuid(
      `${input.subscriptionId}:${input.name}:${input.roleDefinitionId}`,
    ),
    roleDefinitionId: `/subscriptions/${input.subscriptionId}/providers/Microsoft.Authorization/roleDefinitions/${input.roleDefinitionId}`,
    scope: input.scope,
  });
}

function azureTags(input: AzureCloudDeploymentInput): AzureTags {
  return {
    ...input.resourceTags,
    environment: input.environment,
    installation: input.installationName,
    "managed-by": "pulumi",
  };
}

function deterministicGuid(value: string): string {
  const digest = createHash("sha256").update(value).digest("hex").slice(0, 32);
  return `${digest.slice(0, 8)}-${digest.slice(8, 12)}-${digest.slice(12, 16)}-${digest.slice(16, 20)}-${digest.slice(20)}`;
}

function extractImageDigest(reference: string): string {
  const digest = reference.split("@")[1];
  if (digest === undefined) throw new Error("The parsed image reference has no digest.");
  return digest;
}

function resolveResourceIds(
  resources: Readonly<Record<string, pulumi.Input<string>>>,
): pulumi.Output<Readonly<Record<string, string>>> {
  const entries = Object.entries(resources);
  return pulumi.all(entries.map(([, value]) => value)).apply((values) =>
    Object.fromEntries(entries.map(([key], index) => [key, values[index] ?? ""]))
  );
}
