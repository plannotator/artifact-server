import {createHash} from "node:crypto";

import * as aws from "@pulumi/aws";
import * as pulumi from "@pulumi/pulumi";
import * as random from "@pulumi/random";

import type {
  AwsCloudDeploymentInput,
  CloudDeploymentOutput,
} from "../../../src/deployment/cloud-deployment-contract.js";
import {defineAwsNetwork} from "./network.js";
import type {AwsDeploymentPlan} from "./plan.js";

const applicationPort = 8_787;
const databaseName = "artifactserver";
const databaseUsername = "artifactadmin";
const postgresEngineVersion = "17.10";

export interface AwsStackConfiguration {
  readonly input: AwsCloudDeploymentInput;
  readonly plan: AwsDeploymentPlan;
}

export interface AwsStackOutputs {
  readonly deployment: pulumi.Output<CloudDeploymentOutput>;
}

interface AwsCertificateSet {
  readonly contentArn?: pulumi.Input<string>;
  readonly primaryArn: pulumi.Input<string>;
}

interface AwsResourceIds {
  [name: string]: pulumi.Input<string>;
}

interface AwsDeploymentValues {
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

/** Define the complete default AWS deployment. */
export async function defineAwsStack(
  configuration: AwsStackConfiguration,
): Promise<AwsStackOutputs> {
  const {input, plan} = configuration;
  const name = `${input.installationName}-${input.environment}`;
  const resourceNameHash = createHash("sha256").update(name).digest("hex").slice(0, 12);
  const physicalName = `as-${resourceNameHash}`;
  const tags = {
    ...input.resourceTags,
    "artifactserver.com/environment": input.environment,
    "artifactserver.com/installation": input.installationName,
    "artifactserver.com/managed-by": "pulumi",
  };
  const network = await defineAwsNetwork({input, name, plan, tags});
  const installationId = new random.RandomUuid4(`${name}-installation`);
  const apiToken = new random.RandomPassword(`${name}-api-token`, {
    length: 48,
    special: false,
  });
  const databasePassword = new random.RandomPassword(`${name}-database-password`, {
    length: 32,
    special: false,
  });
  const artifactBucket = new aws.s3.Bucket(`${name}-artifacts`, {
    bucketPrefix: `${physicalName}-artifacts-`,
    forceDestroy: false,
    tags,
  }, {protect: input.deletionProtection});
  const bucketPublicAccess = new aws.s3.BucketPublicAccessBlock(`${name}-artifacts`, {
    blockPublicAcls: true,
    blockPublicPolicy: true,
    bucket: artifactBucket.id,
    ignorePublicAcls: true,
    restrictPublicBuckets: true,
  });
  const bucketOwnership = new aws.s3.BucketOwnershipControls(`${name}-artifacts`, {
    bucket: artifactBucket.id,
    rule: {objectOwnership: "BucketOwnerEnforced"},
  });
  const bucketEncryption = new aws.s3.BucketServerSideEncryptionConfiguration(
    `${name}-artifacts`,
    {
      bucket: artifactBucket.id,
      rules: [{applyServerSideEncryptionByDefault: {sseAlgorithm: "AES256"}}],
    },
  );
  const bucketVersioning = new aws.s3.BucketVersioning(`${name}-artifacts`, {
    bucket: artifactBucket.id,
    versioningConfiguration: {status: "Enabled"},
  });
  const bucketLifecycle = new aws.s3.BucketLifecycleConfiguration(
    `${name}-artifacts`,
    {
    bucket: artifactBucket.id,
    rules: [{
      abortIncompleteMultipartUpload: {daysAfterInitiation: 7},
      id: "abort-incomplete-multipart-uploads",
      status: "Enabled",
    }],
    },
    {dependsOn: [bucketVersioning]},
  );
  const bucketTransportPolicy = new aws.s3.BucketPolicy(`${name}-require-tls`, {
    bucket: artifactBucket.id,
    policy: pulumi.jsonStringify({
      Statement: [{
        Action: "s3:*",
        Condition: {Bool: {"aws:SecureTransport": "false"}},
        Effect: "Deny",
        Principal: "*",
        Resource: [artifactBucket.arn, pulumi.interpolate`${artifactBucket.arn}/*`],
        Sid: "DenyInsecureTransport",
      }],
      Version: "2012-10-17",
    }),
  }, {dependsOn: [bucketPublicAccess]});

  const loadBalancerSecurityGroup = new aws.ec2.SecurityGroup(`${name}-load-balancer`, {
    description: "Artifact Server HTTPS load balancer",
    egress: [],
    ingress: [{
      cidrBlocks: input.ingress === "public"
        ? ["0.0.0.0/0"]
        : input.privateIngressCidrs === undefined
        ? [network.vpcCidrBlock]
        : [...input.privateIngressCidrs],
      description: "HTTPS",
      fromPort: 443,
      protocol: "tcp",
      toPort: 443,
    }],
    tags,
    vpcId: network.vpcId,
  });
  const applicationSecurityGroup = new aws.ec2.SecurityGroup(`${name}-application`, {
    description: "Artifact Server Fargate tasks",
    egress: [{
      cidrBlocks: ["0.0.0.0/0"],
      description: "Database, object storage, identity, and telemetry",
      fromPort: 0,
      protocol: "-1",
      toPort: 0,
    }],
    ingress: [{
      description: "Application load balancer",
      fromPort: applicationPort,
      protocol: "tcp",
      securityGroups: [loadBalancerSecurityGroup.id],
      toPort: applicationPort,
    }],
    tags,
    vpcId: network.vpcId,
  });
  const loadBalancerEgress = new aws.ec2.SecurityGroupRule(
    `${name}-load-balancer-egress`,
    {
    description: "Artifact Server targets",
    fromPort: applicationPort,
    protocol: "tcp",
    securityGroupId: loadBalancerSecurityGroup.id,
    sourceSecurityGroupId: applicationSecurityGroup.id,
    toPort: applicationPort,
    type: "egress",
    },
  );
  const databaseSecurityGroup = new aws.ec2.SecurityGroup(`${name}-database`, {
    description: "Artifact Server PostgreSQL",
    egress: [],
    ingress: [{
      description: "Artifact Server Fargate tasks",
      fromPort: 5_432,
      protocol: "tcp",
      securityGroups: [applicationSecurityGroup.id],
      toPort: 5_432,
    }],
    tags,
    vpcId: network.vpcId,
  });

  const databaseSubnetGroup = new aws.rds.SubnetGroup(`${name}-database`, {
    subnetIds: network.databaseSubnetIds,
    tags,
  });
  const databaseParameterGroup = new aws.rds.ParameterGroup(`${name}-postgres`, {
    family: "postgres17",
    parameters: [{name: "rds.force_ssl", value: "1"}],
    tags,
  });
  const insights = plan.database.performanceInsights
    ? {performanceInsightsEnabled: true, performanceInsightsRetentionPeriod: 7}
    : {performanceInsightsEnabled: false};
  const database = new aws.rds.Instance(`${name}-database`, {
    allocatedStorage: plan.database.allocatedStorageGiB,
    applyImmediately: input.environment !== "production",
    autoMinorVersionUpgrade: true,
    backupRetentionPeriod: input.backupRetentionDays,
    backupWindow: "03:00-04:00",
    copyTagsToSnapshot: true,
    dbName: databaseName,
    dbSubnetGroupName: databaseSubnetGroup.name,
    deletionProtection: input.deletionProtection,
    enabledCloudwatchLogsExports: ["postgresql", "upgrade"],
    engine: "postgres",
    engineVersion: postgresEngineVersion,
    finalSnapshotIdentifier: `${physicalName}-final-snapshot`,
    identifier: `${physicalName}-database`,
    instanceClass: plan.database.instanceClass,
    maintenanceWindow: "sun:05:00-sun:06:00",
    maxAllocatedStorage: plan.database.maximumStorageGiB,
    multiAz: plan.database.multiAz,
    parameterGroupName: databaseParameterGroup.name,
    password: pulumi.secret(databasePassword.result),
    port: 5_432,
    publiclyAccessible: false,
    skipFinalSnapshot: false,
    storageEncrypted: true,
    storageType: "gp3",
    tags,
    username: databaseUsername,
    vpcSecurityGroupIds: [databaseSecurityGroup.id],
    ...insights,
  }, {protect: input.deletionProtection});

  const apiTokenSecret = new aws.secretsmanager.Secret(`${name}-api-token`, {
    description: "Artifact Server fallback automation token",
    recoveryWindowInDays: input.environment === "production" ? 30 : 7,
    tags,
  }, {protect: input.deletionProtection});
  const apiTokenSecretVersion = new aws.secretsmanager.SecretVersion(
    `${name}-api-token`,
    {
    secretId: apiTokenSecret.id,
    secretString: pulumi.secret(apiToken.result),
    },
  );

  const databaseUrlSecret = new aws.secretsmanager.Secret(`${name}-database-url`, {
    description: "Artifact Server PostgreSQL connection URL",
    recoveryWindowInDays: input.environment === "production" ? 30 : 7,
    tags,
  }, {protect: input.deletionProtection});
  const databaseUrl = pulumi.secret(pulumi.all([
    database.endpoint,
    databasePassword.result,
  ]).apply(([endpoint, password]) =>
    `postgresql://${databaseUsername}:${encodeURIComponent(password)}@${endpoint}/${databaseName}?sslmode=require`
  ));
  const databaseUrlSecretVersion = new aws.secretsmanager.SecretVersion(
    `${name}-database-url`,
    {
    secretId: databaseUrlSecret.id,
    secretString: databaseUrl,
    },
  );

  const logGroup = new aws.cloudwatch.LogGroup(`${name}-application`, {
    namePrefix: `/artifact-server/${name}/`,
    retentionInDays: input.environment === "production" ? 90 : 30,
    tags,
  });
  const cluster = new aws.ecs.Cluster(`${name}-cluster`, {
    settings: [{name: "containerInsights", value: "enabled"}],
    tags,
  });
  const taskExecutionRole = new aws.iam.Role(`${name}-execution`, {
    assumeRolePolicy: ecsAssumeRolePolicy,
    name: `${physicalName}-execution`,
    tags,
  });
  const partition = aws.getPartitionOutput();
  const executionRoleAttachment = new aws.iam.RolePolicyAttachment(
    `${name}-execution`,
    {
    policyArn: pulumi.interpolate`arn:${partition.partition}:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy`,
    role: taskExecutionRole.name,
    },
  );
  const secretArns: pulumi.Input<string>[] = [
    apiTokenSecret.arn,
    databaseUrlSecret.arn,
  ];
  if (input.workosApiKeySecretRef !== undefined) {
    secretArns.push(input.workosApiKeySecretRef);
  }
  const executionSecretPolicy = new aws.iam.RolePolicy(`${name}-execution-secrets`, {
    policy: pulumi.jsonStringify({
      Statement: [{
        Action: ["secretsmanager:GetSecretValue"],
        Effect: "Allow",
        Resource: secretArns,
      }],
      Version: "2012-10-17",
    }),
    role: taskExecutionRole.id,
  });

  const taskRole = new aws.iam.Role(`${name}-task`, {
    assumeRolePolicy: ecsAssumeRolePolicy,
    name: `${physicalName}-task`,
    tags,
  });
  const installationNamespace = installationId.result.apply((value) =>
    createHash("sha256").update(value).digest("hex")
  );
  const installationPrefix = pulumi.interpolate`installations/${installationNamespace}/*`;
  const objectStoragePolicy = new aws.iam.RolePolicy(`${name}-object-storage`, {
    policy: pulumi.jsonStringify({
      Statement: [
        {
          Action: ["s3:GetBucketLocation", "s3:ListBucket"],
          Effect: "Allow",
          Resource: artifactBucket.arn,
        },
        {
          Action: [
            "s3:AbortMultipartUpload",
            "s3:GetObject",
            "s3:ListMultipartUploadParts",
            "s3:PutObject",
          ],
          Effect: "Allow",
          Resource: pulumi.interpolate`${artifactBucket.arn}/${installationPrefix}`,
        },
      ],
      Version: "2012-10-17",
    }),
    role: taskRole.id,
  });

  const environment = runtimeEnvironment(input, installationId.result, artifactBucket.id);
  const secrets: Array<{
    readonly name: string;
    readonly valueFrom: pulumi.Input<string>;
  }> = [
    {name: "ARTIFACT_SERVER_API_TOKEN", valueFrom: apiTokenSecret.arn},
    {name: "ARTIFACT_SERVER_DATABASE_URL", valueFrom: databaseUrlSecret.arn},
  ];
  if (
    input.workosApiKeySecretRef !== undefined && input.workosClientId !== undefined
  ) {
    environment.push({name: "ARTIFACT_SERVER_WORKOS_CLIENT_ID", value: input.workosClientId});
    secrets.push({
      name: "ARTIFACT_SERVER_WORKOS_API_KEY",
      valueFrom: input.workosApiKeySecretRef,
    });
  }
  const taskDefinition = new aws.ecs.TaskDefinition(`${name}-application`, {
    containerDefinitions: pulumi.jsonStringify([{
      command: [
        "node dist/cli/main.js migrate apply && exec node dist/cli/main.js start-external-storage --host 0.0.0.0 --port 8787",
      ],
      entryPoint: ["/bin/sh", "-c"],
      environment,
      essential: true,
      image: input.imageReference,
      linuxParameters: {initProcessEnabled: true},
      logConfiguration: {
        logDriver: "awslogs",
        options: {
          "awslogs-group": logGroup.name,
          "awslogs-region": input.region,
          "awslogs-stream-prefix": "application",
        },
      },
      name: "artifact-server",
      portMappings: [{
        appProtocol: "http",
        containerPort: applicationPort,
        hostPort: applicationPort,
        name: "http",
        protocol: "tcp",
      }],
      secrets,
      stopTimeout: 15,
    }]),
    cpu: String(plan.cpuUnits),
    executionRoleArn: taskExecutionRole.arn,
    family: name,
    memory: String(plan.memoryMiB),
    networkMode: "awsvpc",
    requiresCompatibilities: ["FARGATE"],
    runtimePlatform: {
      cpuArchitecture: "ARM64",
      operatingSystemFamily: "LINUX",
    },
    taskRoleArn: taskRole.arn,
    tags,
  });

  const loadBalancer = new aws.lb.LoadBalancer(`${name}-application`, {
    dropInvalidHeaderFields: true,
    enableDeletionProtection: input.deletionProtection,
    internal: input.ingress === "private",
    loadBalancerType: "application",
    name: `${physicalName}-alb`,
    securityGroups: [loadBalancerSecurityGroup.id],
    subnets: network.loadBalancerSubnetIds,
    tags,
  });
  const targetGroup = new aws.lb.TargetGroup(`${name}-application`, {
    deregistrationDelay: 30,
    healthCheck: {
      enabled: true,
      healthyThreshold: 2,
      interval: 15,
      matcher: "200",
      path: "/ready",
      port: "traffic-port",
      protocol: "HTTP",
      timeout: 5,
      unhealthyThreshold: 3,
    },
    name: `${physicalName}-target`,
    port: applicationPort,
    protocol: "HTTP",
    targetType: "ip",
    tags,
    vpcId: network.vpcId,
  });
  const certificates = defineCertificates(input, name, tags);
  const listener = new aws.lb.Listener(`${name}-https`, {
    certificateArn: certificates.primaryArn,
    defaultActions: [{targetGroupArn: targetGroup.arn, type: "forward"}],
    loadBalancerArn: loadBalancer.arn,
    port: 443,
    protocol: "HTTPS",
    sslPolicy: "ELBSecurityPolicy-TLS13-1-2-2021-06",
    tags,
  });
  let contentListenerCertificate: aws.lb.ListenerCertificate | undefined;
  if (certificates.contentArn !== undefined) {
    contentListenerCertificate = new aws.lb.ListenerCertificate(`${name}-content`, {
      certificateArn: certificates.contentArn,
      listenerArn: listener.arn,
    });
  }
  const dnsAliases = defineDnsAliases(input, name, loadBalancer);

  const service = new aws.ecs.Service(`${name}-application`, {
    cluster: cluster.arn,
    deploymentCircuitBreaker: {enable: true, rollback: true},
    deploymentMaximumPercent: 200,
    deploymentMinimumHealthyPercent: 100,
    desiredCount: plan.desiredCount,
    enableEcsManagedTags: true,
    enableExecuteCommand: false,
    healthCheckGracePeriodSeconds: 120,
    launchType: "FARGATE",
    loadBalancers: [{
      containerName: "artifact-server",
      containerPort: applicationPort,
      targetGroupArn: targetGroup.arn,
    }],
    networkConfiguration: {
      assignPublicIp: false,
      securityGroups: [applicationSecurityGroup.id],
      subnets: network.applicationSubnetIds,
    },
    propagateTags: "SERVICE",
    taskDefinition: taskDefinition.arn,
    waitForSteadyState: true,
    tags,
  }, {
    dependsOn: [
      apiTokenSecretVersion,
      databaseUrlSecretVersion,
      executionRoleAttachment,
      executionSecretPolicy,
      listener,
      loadBalancerEgress,
      objectStoragePolicy,
    ],
    ignoreChanges: ["desiredCount"],
  });
  const scalingTarget = new aws.appautoscaling.Target(`${name}-application`, {
    maxCapacity: input.capacity.maximumInstances,
    minCapacity: input.capacity.minimumInstances,
    resourceId: pulumi.interpolate`service/${cluster.name}/${service.name}`,
    scalableDimension: "ecs:service:DesiredCount",
    serviceNamespace: "ecs",
  });
  const cpuScalingPolicy = new aws.appautoscaling.Policy(`${name}-cpu`, {
    policyType: "TargetTrackingScaling",
    resourceId: scalingTarget.resourceId,
    scalableDimension: scalingTarget.scalableDimension,
    serviceNamespace: scalingTarget.serviceNamespace,
    targetTrackingScalingPolicyConfiguration: {
      predefinedMetricSpecification: {
        predefinedMetricType: "ECSServiceAverageCPUUtilization",
      },
      scaleInCooldown: 120,
      scaleOutCooldown: 60,
      targetValue: 60,
    },
  });
  const memoryScalingPolicy = new aws.appautoscaling.Policy(`${name}-memory`, {
    policyType: "TargetTrackingScaling",
    resourceId: scalingTarget.resourceId,
    scalableDimension: scalingTarget.scalableDimension,
    serviceNamespace: scalingTarget.serviceNamespace,
    targetTrackingScalingPolicyConfiguration: {
      predefinedMetricSpecification: {
        predefinedMetricType: "ECSServiceAverageMemoryUtilization",
      },
      scaleInCooldown: 120,
      scaleOutCooldown: 60,
      targetValue: 70,
    },
  });

  const imageDigest = extractImageDigest(input.imageReference);
  const applicationUrl = `https://${input.applicationDomain}`;
  const secretResourceIds: AwsResourceIds = {
    apiToken: apiTokenSecret.arn,
    databaseUrl: databaseUrlSecret.arn,
  };
  if (input.workosApiKeySecretRef !== undefined) {
    secretResourceIds["workosApiKey"] = input.workosApiKeySecretRef;
  }
  const networkResourceIds = {
    ...network.resourceIds,
    applicationSecurityGroup: applicationSecurityGroup.id,
    databaseSecurityGroup: databaseSecurityGroup.id,
    loadBalancer: loadBalancer.arn,
    loadBalancerSecurityGroup: loadBalancerSecurityGroup.id,
  };
  const supportManifestKey = installationId.result.apply((value) =>
    `support/${value}/installation.json`
  );
  const deploymentValues: AwsDeploymentValues = {
    databaseResourceId: database.arn,
    installationId: installationId.result,
    logDestination: logGroup.arn,
    networkResourceIds: resolveResourceIds(networkResourceIds),
    objectStorageResourceId: artifactBucket.arn,
    runtimeResourceId: service.id,
    secretResourceIds: resolveResourceIds(secretResourceIds),
    supportManifestLocation: pulumi.interpolate`s3://${artifactBucket.id}/${supportManifestKey}`,
    workloadIdentityResourceId: taskRole.arn,
  };
  const deployment = pulumi.output(deploymentValues).apply(
    (values): CloudDeploymentOutput => ({
    applicationUrl,
    contentDomain: input.contentDomain,
    databaseResourceId: values.databaseResourceId,
    healthUrl: `${applicationUrl}/health`,
    imageDigest,
    installationId: values.installationId,
    logDestination: values.logDestination,
    mcpUrl: `${applicationUrl}/mcp`,
    networkResourceIds: values.networkResourceIds,
    objectStorageResourceId: values.objectStorageResourceId,
    readinessUrl: `${applicationUrl}/ready`,
    runtimeResourceId: values.runtimeResourceId,
    secretResourceIds: values.secretResourceIds,
    stateBackend: input.stateBackendUrl,
    supportManifestLocation: values.supportManifestLocation,
    workloadIdentityResourceId: values.workloadIdentityResourceId,
    }),
  );
  const supportManifestObject = new aws.s3.BucketObjectv2(
    `${name}-support-manifest`,
    {
    bucket: artifactBucket.id,
    content: pulumi.jsonStringify(deployment),
    contentType: "application/json",
    key: supportManifestKey,
    serverSideEncryption: "AES256",
    },
    {
      dependsOn: [
        bucketEncryption,
        bucketLifecycle,
        bucketOwnership,
        bucketTransportPolicy,
        bucketVersioning,
      ],
    },
  );

  void contentListenerCertificate;
  void cpuScalingPolicy;
  void dnsAliases;
  void memoryScalingPolicy;
  void supportManifestObject;

  return {deployment};
}

const ecsAssumeRolePolicy = JSON.stringify({
  Statement: [{
    Action: "sts:AssumeRole",
    Effect: "Allow",
    Principal: {Service: "ecs-tasks.amazonaws.com"},
  }],
  Version: "2012-10-17",
});

function runtimeEnvironment(
  input: AwsCloudDeploymentInput,
  installationId: pulumi.Input<string>,
  bucket: pulumi.Input<string>,
): Array<{readonly name: string; readonly value: pulumi.Input<string>}> {
  const environment: Array<{
    readonly name: string;
    readonly value: pulumi.Input<string>;
  }> = [
    {name: "ARTIFACT_SERVER_BOOTSTRAP_ADMIN_EMAIL", value: input.bootstrapAdministratorEmail},
    {name: "ARTIFACT_SERVER_CONTENT_DOMAIN", value: input.contentDomain},
    {name: "ARTIFACT_SERVER_INSTALLATION_ID", value: installationId},
    {name: "ARTIFACT_SERVER_OBJECT_STORAGE_PROVIDER", value: "s3"},
    {name: "ARTIFACT_SERVER_ORIGIN", value: `https://${input.applicationDomain}`},
    {name: "ARTIFACT_SERVER_READINESS_WITHDRAWAL_MS", value: "1000"},
    {name: "ARTIFACT_SERVER_REQUEST_LOG_SAMPLE_RATE", value: String(input.requestLogSampleRate)},
    {name: "ARTIFACT_SERVER_S3_BUCKET", value: bucket},
    {name: "ARTIFACT_SERVER_S3_FORCE_PATH_STYLE", value: "false"},
    {name: "ARTIFACT_SERVER_S3_REGION", value: input.region},
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

function defineCertificates(
  input: AwsCloudDeploymentInput,
  name: string,
  tags: Readonly<Record<string, string>>,
): AwsCertificateSet {
  if (input.tlsCertificateArn !== undefined) {
    return {primaryArn: input.tlsCertificateArn};
  }
  const zones = requireDnsZones(input);
  const applicationCertificate = defineValidatedCertificate({
    domain: input.applicationDomain,
    name: `${name}-application`,
    tags,
    zoneId: zones.application,
  });
  const contentCertificate = defineValidatedCertificate({
    domain: `*.${input.contentDomain}`,
    name: `${name}-content`,
    tags,
    zoneId: zones.content,
  });
  return {
    contentArn: contentCertificate,
    primaryArn: applicationCertificate,
  };
}

function defineValidatedCertificate(options: {
  readonly domain: string;
  readonly name: string;
  readonly tags: Readonly<Record<string, string>>;
  readonly zoneId: string;
}): pulumi.Output<string> {
  const certificate = new aws.acm.Certificate(options.name, {
    domainName: options.domain,
    validationMethod: "DNS",
    tags: options.tags,
  });
  const validationRecord = new aws.route53.Record(`${options.name}-validation`, {
    allowOverwrite: true,
    name: certificate.domainValidationOptions.apply((values) =>
      requireCertificateValidationOption(values).resourceRecordName
    ),
    records: [certificate.domainValidationOptions.apply((values) =>
      requireCertificateValidationOption(values).resourceRecordValue
    )],
    ttl: 60,
    type: certificate.domainValidationOptions.apply((values) =>
      requireCertificateValidationOption(values).resourceRecordType
    ),
    zoneId: options.zoneId,
  });
  const validation = new aws.acm.CertificateValidation(options.name, {
    certificateArn: certificate.arn,
    validationRecordFqdns: [validationRecord.fqdn],
  });
  return validation.certificateArn;
}

function requireCertificateValidationOption(
  values: readonly aws.types.output.acm.CertificateDomainValidationOption[],
): aws.types.output.acm.CertificateDomainValidationOption {
  const value = values[0];
  if (value === undefined) {
    throw new Error("ACM returned no DNS validation record.");
  }
  return value;
}

function defineDnsAliases(
  input: AwsCloudDeploymentInput,
  name: string,
  loadBalancer: aws.lb.LoadBalancer,
): readonly aws.route53.Record[] {
  const zones = input.dnsZoneIds;
  if (zones === undefined) return [];
  const aliases = [
    {domain: input.applicationDomain, name: `${name}-application`, zoneId: zones.application},
    {domain: `*.${input.contentDomain}`, name: `${name}-content`, zoneId: zones.content},
  ];
  return aliases.map((alias) => new aws.route53.Record(alias.name, {
      aliases: [{
        evaluateTargetHealth: true,
        name: loadBalancer.dnsName,
        zoneId: loadBalancer.zoneId,
      }],
      name: alias.domain,
      type: "A",
      zoneId: alias.zoneId,
    }));
}

function requireDnsZones(input: AwsCloudDeploymentInput): {
  readonly application: string;
  readonly content: string;
} {
  if (input.dnsZoneIds === undefined) {
    throw new Error("Public AWS certificate creation requires both DNS zone IDs.");
  }
  return input.dnsZoneIds;
}

function extractImageDigest(reference: string): string {
  const digest = reference.split("@")[1];
  if (digest === undefined) {
    throw new Error("The parsed image reference has no digest.");
  }
  return digest;
}

function resolveResourceIds(
  resources: Readonly<Record<string, pulumi.Input<string>>>,
): pulumi.Output<Record<string, string>> {
  const entries = Object.entries(resources);
  return pulumi.all(entries.map(([key, value]) =>
    pulumi.output(value).apply(
      (resolved): readonly [string, string] => [key, resolved],
    )
  )).apply((resolved) => Object.fromEntries(resolved));
}
