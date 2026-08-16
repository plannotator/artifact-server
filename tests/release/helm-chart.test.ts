import {execFile} from "node:child_process";
import {randomBytes, randomUUID} from "node:crypto";
import {mkdtemp, rm, writeFile} from "node:fs/promises";
import {request} from "node:http";
import {tmpdir} from "node:os";
import path from "node:path";

import {CreateBucketCommand, S3Client} from "@aws-sdk/client-s3";
import {afterAll, beforeAll, describe, expect, test} from "vitest";
import {z} from "zod";

const repositoryRoot = path.resolve(import.meta.dirname, "../..");
const chartPath = requiredEnvironment("ARTIFACT_SERVER_HELM_CHART");
const clusterName = requiredEnvironment("ARTIFACT_SERVER_HELM_CLUSTER_NAME");
const image = requiredEnvironment("ARTIFACT_SERVER_HELM_IMAGE");
const imageRepository = requiredEnvironment(
  "ARTIFACT_SERVER_HELM_IMAGE_REPOSITORY",
);
const imageTag = requiredEnvironment("ARTIFACT_SERVER_HELM_IMAGE_TAG");
const kindConfig = requiredEnvironment("ARTIFACT_SERVER_HELM_KIND_CONFIG");
const imageRevision = requiredEnvironment("ARTIFACT_SERVER_HELM_REVISION");
const postgresContainer = requiredEnvironment(
  "ARTIFACT_SERVER_HELM_POSTGRES_CONTAINER",
);
const postgresVolume = requiredEnvironment(
  "ARTIFACT_SERVER_HELM_POSTGRES_VOLUME",
);
const minioContainer = requiredEnvironment(
  "ARTIFACT_SERVER_HELM_MINIO_CONTAINER",
);
const minioVolume = requiredEnvironment("ARTIFACT_SERVER_HELM_MINIO_VOLUME");

const kindNodeImage = "kindest/node:v1.36.1@sha256:3489c7674813ba5d8b1a9977baea8a6e553784dab7b84759d1014dbd78f7ebd5";
const postgresImage = "postgres@sha256:ef257d85f76e48da1c64832459b59fcaba1a4dac97bf5d7450c77753542eee94";
const minioImage = "minio/minio@sha256:14cea493d9a34af32f524e538b8346cf79f3321eff8e708c1e2960462bd8936e";
const postgresUser = "artifactserver";
const postgresPassword = "artifactserver-helm-integration-only";
const postgresDatabase = "artifactserver";
const minioAccessKey = "artifactserver";
const minioSecretKey = "artifactserver-helm-minio-integration-only";
const namespace = "artifact-server";
const release = "artifact-server";
const secretName = "artifact-server-runtime";
const applicationOrigin = "https://artifacts.example.test";
const contentDomain = "content.example.net";
const bucket = `artifact-server-helm-${randomUUID()}`;
const apiToken = randomBytes(32).toString("base64url");

const publicationSchema = z.object({
  artifact: z.object({
    accessSetting: z.enum(["account_required", "public_link"]),
    id: z.string().min(1),
    name: z.string().min(1),
  }),
  links: z.object({
    artifact: z.string().url(),
    version: z.string().url(),
  }),
  version: z.object({
    id: z.string().min(1),
    manifestDigest: z.string().min(1),
    number: z.number().int().positive(),
  }),
});
const podListSchema = z.object({
  items: z.array(z.object({
    metadata: z.object({
      name: z.string(),
      uid: z.string(),
    }),
    spec: z.object({
      nodeName: z.string().optional(),
      volumes: z.array(z.object({name: z.string()})).optional(),
    }),
    status: z.object({
      conditions: z.array(z.object({
        status: z.string(),
        type: z.string(),
      })).optional(),
    }),
  })),
});
const deploymentSchema = z.object({
  spec: z.object({
    replicas: z.number().int(),
    strategy: z.object({
      rollingUpdate: z.object({
        maxSurge: z.union([z.string(), z.number()]),
        maxUnavailable: z.union([z.string(), z.number()]),
      }),
      type: z.literal("RollingUpdate"),
    }),
    template: z.object({
      spec: z.object({
        automountServiceAccountToken: z.boolean(),
        containers: z.array(z.object({
          image: z.string(),
          securityContext: z.object({
            allowPrivilegeEscalation: z.boolean(),
            capabilities: z.object({drop: z.array(z.string())}),
            readOnlyRootFilesystem: z.boolean(),
          }),
          volumeMounts: z.array(z.object({mountPath: z.string()})),
        })),
        securityContext: z.object({
          runAsNonRoot: z.boolean(),
          seccompProfile: z.object({type: z.string()}),
        }),
        volumes: z.array(z.object({name: z.string()})),
      }),
    }),
  }),
});
const disruptionBudgetSchema = z.object({
  spec: z.object({
    maxUnavailable: z.union([z.string(), z.number()]),
    unhealthyPodEvictionPolicy: z.string(),
  }),
});
const eventListSchema = z.object({items: z.array(z.object({reason: z.string()}))});
const commandErrorSchema = z.object({
  code: z.number().optional(),
  killed: z.boolean().optional(),
  stderr: z.string().optional(),
  stdout: z.string().optional(),
});
const contentBootstrapSchema = z.object({bootstrapUrl: z.url()});
const jsonValueSchema = z.json();

type JsonValue = z.infer<typeof jsonValueSchema>;

interface CommandResult {
  readonly exitCode: number;
  readonly stderr: string;
  readonly stdout: string;
}

interface PortForward {
  readonly baseUrl: string;
  readonly stop: () => Promise<void>;
}

interface PublishedContentResponse {
  readonly body: string;
  readonly setCookie: string | null;
  readonly statusCode: number;
}

interface ReadBaseline {
  readonly completedRequests: number;
  readonly elapsedMilliseconds: number;
  readonly p95Milliseconds: number;
  readonly requestsPerSecond: number;
}

let fixtureDirectory: string;
let valuesPath: string;
let postgresIp: string;
let minioIp: string;
let minioHostEndpoint: string;
let providerReadyMilliseconds = 0;
let clusterReadyMilliseconds = 0;
let helmVersion = "";
let kubernetesVersion = "";
let kindVersion = "";
let s3Client: S3Client;

beforeAll(async () => {
  fixtureDirectory = await mkdtemp(path.join(tmpdir(), "artifact-server-helm-"));
  const clusterStartedAt = performance.now();
  await command("kind", [
    "create", "cluster",
    "--name", clusterName,
    "--image", kindNodeImage,
    "--config", kindConfig,
    "--wait", "240s",
  ]);
  clusterReadyMilliseconds = performance.now() - clusterStartedAt;
  await command("kind", ["load", "docker-image", image, "--name", clusterName]);

  const providerStartedAt = performance.now();
  await Promise.all([
    command("docker", ["volume", "create", postgresVolume]),
    command("docker", ["volume", "create", minioVolume]),
  ]);
  await command("docker", [
    "run", "--detach",
    "--name", postgresContainer,
    "--env", `POSTGRES_USER=${postgresUser}`,
    "--env", `POSTGRES_PASSWORD=${postgresPassword}`,
    "--env", `POSTGRES_DB=${postgresDatabase}`,
    "--network", "kind",
    "--volume", `${postgresVolume}:/var/lib/postgresql/data`,
    postgresImage,
  ]);
  await command("docker", [
    "run", "--detach",
    "--name", minioContainer,
    "--env", `MINIO_ROOT_USER=${minioAccessKey}`,
    "--env", `MINIO_ROOT_PASSWORD=${minioSecretKey}`,
    "--network", "kind",
    "--publish", "127.0.0.1::9000",
    "--volume", `${minioVolume}:/data`,
    minioImage,
    "server", "/data",
  ]);
  await waitForPostgres();
  minioHostEndpoint = `http://127.0.0.1:${await publishedPort(minioContainer, "9000/tcp")}`;
  await waitForHttp(`${minioHostEndpoint}/minio/health/ready`, 200, 60_000);
  [postgresIp, minioIp] = await Promise.all([
    containerIp(postgresContainer),
    containerIp(minioContainer),
  ]);
  providerReadyMilliseconds = performance.now() - providerStartedAt;

  s3Client = new S3Client({
    credentials: {
      accessKeyId: minioAccessKey,
      secretAccessKey: minioSecretKey,
    },
    endpoint: minioHostEndpoint,
    forcePathStyle: true,
    region: "us-east-1",
  });
  await s3Client.send(new CreateBucketCommand({Bucket: bucket}));

  valuesPath = path.join(fixtureDirectory, "values.json");
  await writeValues(valuesPath, "initial");
  await createRuntimeSecret(namespace, secretName, databaseUrl(postgresIp));

  helmVersion = (await command("helm", ["version", "--short"])).stdout.trim();
  kindVersion = (await command("kind", ["version"])).stdout.trim();
  kubernetesVersion = (await command(
    "kubectl",
    ["version", "--output=json"],
  )).stdout;
});

afterAll(async () => {
  s3Client?.destroy();
  await Promise.all([
    command("docker", ["unpause", postgresContainer], true),
    command("docker", ["unpause", minioContainer], true),
  ]);
  await command("kind", ["delete", "cluster", "--name", clusterName], true);
  await Promise.all([
    command("docker", ["rm", "--force", postgresContainer, minioContainer], true),
    rm(fixtureDirectory, {force: true, recursive: true}),
  ]);
  await Promise.all([
    command("docker", ["volume", "rm", "--force", postgresVolume], true),
    command("docker", ["volume", "rm", "--force", minioVolume], true),
  ]);
});

describe.sequential("Artifact Server Helm release", () => {
  test("DEP-017-F: a failed migration or missing Secret blocks installation and creates no serving Deployment", async () => {
    const failureNamespace = "artifact-server-migration-failure";
    const failureSecret = "artifact-server-failure-runtime";
    const failureValues = path.join(fixtureDirectory, "failure-values.json");
    await createRuntimeSecret(
      failureNamespace,
      failureSecret,
      "postgresql://artifactserver:invalid@203.0.113.1:5432/artifactserver",
    );
    await writeValues(failureValues, "migration-failure", {
      migrationDeadlineSeconds: 10,
      namespaceSecret: failureSecret,
    });
    const failed = await helm([
      "install", "migration-failure", chartPath,
      "--namespace", failureNamespace,
      "--values", failureValues,
      "--wait",
      "--timeout", "30s",
    ], true);
    expect(failed.exitCode).not.toBe(0);
    const deployment = await kubectl([
      "--namespace", failureNamespace,
      "get", "deployment",
      "--selector", "app.kubernetes.io/instance=migration-failure",
      "--output", "name",
    ]);
    expect(deployment.stdout.trim()).toBe("");
    await helm([
      "uninstall", "migration-failure",
      "--namespace", failureNamespace,
    ], true);
    await kubectl(["delete", "namespace", failureNamespace, "--wait=false"], true);

    const missingSecretNamespace = "artifact-server-missing-secret";
    const missingSecretValues = path.join(
      fixtureDirectory,
      "missing-secret-values.json",
    );
    await kubectl(["create", "namespace", missingSecretNamespace]);
    await writeValues(missingSecretValues, "missing-secret", {
      migrationDeadlineSeconds: 10,
      namespaceSecret: "missing-runtime-secret",
    });
    const missingSecret = await helm([
      "install", "missing-secret", chartPath,
      "--namespace", missingSecretNamespace,
      "--values", missingSecretValues,
      "--wait",
      "--timeout", "30s",
    ], true);
    expect(missingSecret.exitCode).not.toBe(0);
    const missingSecretDeployment = await kubectl([
      "--namespace", missingSecretNamespace,
      "get", "deployment",
      "--selector", "app.kubernetes.io/instance=missing-secret",
      "--output", "name",
    ]);
    expect(missingSecretDeployment.stdout.trim()).toBe("");
    await helm([
      "uninstall", "missing-secret",
      "--namespace", missingSecretNamespace,
    ], true);
    await kubectl([
      "delete", "namespace", missingSecretNamespace, "--wait=false",
    ], true);
  });

  test("DEP-006-B DEP-006-F DEP-017-B: the chart preserves exact state through rollout, pod loss, provider outage, node drain, and reinstall", async () => {
    const installationStartedAt = performance.now();
    await helm([
      "upgrade", "--install", release, chartPath,
      "--namespace", namespace,
      "--values", valuesPath,
      "--rollback-on-failure",
      "--wait",
      "--timeout", "240s",
    ]);
    const startupMilliseconds = performance.now() - installationStartedAt;
    await helm(["test", release, "--namespace", namespace, "--logs"]);

    const deployment = deploymentSchema.parse(JSON.parse((await kubectl([
      "--namespace", namespace,
      "get", "deployment", release,
      "--output", "json",
    ])).stdout));
    expect(deployment.spec).toMatchObject({
      replicas: 2,
      strategy: {
        rollingUpdate: {maxSurge: 1, maxUnavailable: 0},
        type: "RollingUpdate",
      },
    });
    const podTemplate = deployment.spec.template.spec;
    expect(podTemplate.automountServiceAccountToken).toBe(false);
    expect(podTemplate.securityContext).toMatchObject({
      runAsNonRoot: true,
      seccompProfile: {type: "RuntimeDefault"},
    });
    const applicationContainer = requiredItem(
      podTemplate.containers,
      0,
      "application container",
    );
    expect(applicationContainer).toMatchObject({
      image,
      securityContext: {
        allowPrivilegeEscalation: false,
        capabilities: {drop: ["ALL"]},
        readOnlyRootFilesystem: true,
      },
    });
    expect(applicationContainer.volumeMounts.some((mount) =>
      mount.mountPath.startsWith("/var/lib/artifact-server")
    )).toBe(false);
    expect(podTemplate.volumes.map((volume) => volume.name).toSorted()).toEqual([
      "runtime-secrets",
      "temporary",
    ]);

    const initialPods = await readyPods();
    expect(initialPods).toHaveLength(2);
    expect(new Set(initialPods.map((pod) => pod.spec.nodeName)).size).toBe(2);
    for (const pod of initialPods) {
      expect(pod.spec.volumes?.some((volume) =>
        volume.name.startsWith("kube-api-access")
      )).toBe(false);
    }

    const firstPublication = await publishFile("first stable Kubernetes version");
    const firstSnapshot = await stateSnapshot(firstPublication);
    expect(await readPublishedContent(firstPublication.links.version)).toBe(
      "first stable Kubernetes version",
    );
    const privatePublication = await publishFile(
      "private Kubernetes version",
      "account_required",
    );
    const privateSnapshot = await stateSnapshot(privatePublication);
    expect(privatePublication.artifact.accessSetting).toBe("account_required");
    expect(await publishedContentStatus(privatePublication.links.version)).toBe(401);
    expect(await readPrivatePublishedContent(privatePublication)).toBe(
      "private Kubernetes version",
    );

    const rolloutValues = path.join(fixtureDirectory, "rollout-values.json");
    await writeValues(rolloutValues, "rollout-one");
    const rolloutStartedAt = performance.now();
    let rolloutComplete = false;
    const rollout = helm([
      "upgrade", release, chartPath,
      "--namespace", namespace,
      "--values", rolloutValues,
      "--rollback-on-failure",
      "--wait",
      "--timeout", "240s",
    ]).finally(() => {
      rolloutComplete = true;
    });
    const [, rolloutActivity] = await Promise.all([
      rollout,
      exerciseServiceDuringRollout(
        firstPublication,
        () => rolloutComplete,
        Date.now() + 240_000,
      ),
    ]);
    const rolloutMilliseconds = performance.now() - rolloutStartedAt;
    expect(rolloutActivity.successfulPublications).toBeGreaterThan(0);
    expect(rolloutActivity.successfulReads).toBeGreaterThan(0);

    // Helm can return after the Deployment reports available while the pod
    // list is still between terminating and replacement snapshots. Require
    // the same bounded steady-state condition used after explicit pod loss.
    await waitForDeployment();
    const rolledPods = await readyPods();
    expect(rolledPods).toHaveLength(2);
    expect(intersection(podUids(initialPods), podUids(rolledPods))).toEqual([]);
    expect(await stateSnapshot(firstPublication)).toEqual(firstSnapshot);
    expect(await stateSnapshot(privatePublication)).toEqual(privateSnapshot);
    expect(await readPrivatePublishedContent(privatePublication)).toBe(
      "private Kubernetes version",
    );

    await kubectl([
      "--namespace", namespace,
      "delete", "pod",
      "--selector", `app.kubernetes.io/instance=${release}`,
      "--wait=false",
    ]);
    const replacementStartedAt = performance.now();
    await waitForDeployment();
    const replacementMilliseconds = performance.now() - replacementStartedAt;
    const replacementPods = await readyPods();
    expect(replacementPods).toHaveLength(2);
    expect(intersection(podUids(rolledPods), podUids(replacementPods))).toEqual([]);
    expect(await stateSnapshot(firstPublication)).toEqual(firstSnapshot);
    expect(await readPublishedContent(firstPublication.links.version)).toBe(
      "first stable Kubernetes version",
    );
    expect(await readPrivatePublishedContent(privatePublication)).toBe(
      "private Kubernetes version",
    );

    await command("docker", ["pause", minioContainer]);
    await waitUntil(async () => (await readyPods()).length === 0, 60_000);
    const unavailablePod = requiredItem(await allApplicationPods(), 0, "unready pod");
    const healthCheck = await kubectl([
      "--namespace", namespace,
      "exec", unavailablePod.metadata.name,
      "--", "node", "-e",
      "Promise.all([fetch('http://127.0.0.1:8787/health'), fetch('http://127.0.0.1:8787/ready')]).then(([health, ready]) => { if (health.status !== 200 || ready.status !== 503) process.exit(1); })",
    ]);
    expect(healthCheck.exitCode).toBe(0);
    await command("docker", ["unpause", minioContainer]);
    await waitForDeployment();

    const budget = disruptionBudgetSchema.parse(JSON.parse((await kubectl([
      "--namespace", namespace,
      "get", "poddisruptionbudget", release,
      "--output", "json",
    ])).stdout));
    expect(budget.spec).toEqual({
      maxUnavailable: 1,
      unhealthyPodEvictionPolicy: "AlwaysAllow",
    });
    const disruptionCalculationFailures = eventListSchema.parse(JSON.parse(
      (await kubectl([
        "--namespace", namespace,
        "get", "events",
        "--field-selector", "reason=CalculateExpectedPodCountFailed",
        "--output", "json",
      ])).stdout,
    ));
    expect(disruptionCalculationFailures.items).toEqual([]);
    const beforeDrain = await readyPods();
    expect(beforeDrain).toHaveLength(2);
    const drainedNode = requiredNode(requiredItem(beforeDrain, 0, "pod before drain"));
    await kubectl([
      "drain", drainedNode,
      "--ignore-daemonsets",
      "--delete-emptydir-data",
      "--force",
      "--timeout", "180s",
    ]);
    await waitForDeployment();
    const podsAfterDrain = await readyPods();
    expect(podsAfterDrain).toHaveLength(2);
    expect(podsAfterDrain.every((pod) => pod.spec.nodeName !== drainedNode)).toBe(true);
    await kubectl(["uncordon", drainedNode]);
    expect(await stateSnapshot(firstPublication)).toEqual(firstSnapshot);

    const readBaseline = await measureReads(firstPublication.links.version);
    await helm(["uninstall", release, "--namespace", namespace, "--wait"]);
    await waitUntil(async () => (await allApplicationPods()).length === 0, 60_000);
    expect((await allApplicationPods()).length).toBe(0);
    expect((await command("docker", ["inspect", postgresContainer])).exitCode).toBe(0);
    expect((await command("docker", ["inspect", minioContainer])).exitCode).toBe(0);

    const reinstallValues = path.join(fixtureDirectory, "reinstall-values.json");
    await writeValues(reinstallValues, "reinstall");
    await helm([
      "upgrade", "--install", release, chartPath,
      "--namespace", namespace,
      "--values", reinstallValues,
      "--rollback-on-failure",
      "--wait",
      "--timeout", "240s",
    ]);
    expect(await stateSnapshot(firstPublication)).toEqual(firstSnapshot);
    expect(await readPublishedContent(firstPublication.links.version)).toBe(
      "first stable Kubernetes version",
    );
    expect(await stateSnapshot(privatePublication)).toEqual(privateSnapshot);
    expect(await readPrivatePublishedContent(privatePublication)).toBe(
      "private Kubernetes version",
    );

    await writeFile(
      path.join(repositoryRoot, "evidence/helm-kubernetes-runtime-baseline.json"),
      `${JSON.stringify({
        clusterReadyMilliseconds,
        helmVersion,
        imageRevision,
        kindNodeImage,
        kindVersion,
        kubernetesVersion: JSON.parse(kubernetesVersion),
        measuredAt: new Date().toISOString(),
        providerReadyMilliseconds,
        readBaseline,
        replacementMilliseconds,
        replicas: 2,
        rolloutMilliseconds,
        startupMilliseconds,
      }, null, 2)}\n`,
    );
  });
});

async function createRuntimeSecret(
  targetNamespace: string,
  targetSecret: string,
  configuredDatabaseUrl: string,
): Promise<void> {
  await kubectl(["create", "namespace", targetNamespace], true);
  await kubectl([
    "--namespace", targetNamespace,
    "create", "secret", "generic", targetSecret,
    "--from-literal", `api-token=${apiToken}`,
    "--from-literal", `database-url=${configuredDatabaseUrl}`,
    "--from-literal", `s3-access-key-id=${minioAccessKey}`,
    "--from-literal", `s3-secret-access-key=${minioSecretKey}`,
  ]);
}

async function writeValues(
  targetPath: string,
  rolloutRevision: string,
  options: {
    readonly migrationDeadlineSeconds?: number;
    readonly namespaceSecret?: string;
  } = {},
): Promise<void> {
  const values = {
    configuration: {
      applicationOrigin,
      bootstrapAdministratorEmail: "admin@example.test",
      contentDomain,
      installationId: "helm-integration",
      postgresConnectionBudget: 22,
      readinessWithdrawalMilliseconds: 0,
      requestLogSampleRate: 0,
      s3: {
        bucket,
        endpoint: `http://${minioIp}:9000`,
        forcePathStyle: true,
        region: "us-east-1",
      },
      shutdownDeadlineMilliseconds: 5_000,
    },
    deployment: {
      minReadySeconds: 5,
      revisionHistoryLimit: 3,
      rolloutRevision,
    },
    image: {
      allowMutableTag: true,
      digest: "",
      pullPolicy: "IfNotPresent",
      repository: imageRepository,
      tag: imageTag,
    },
    migration: {
      activeDeadlineSeconds: options.migrationDeadlineSeconds ?? 60,
      backoffLimit: 0,
      enabled: true,
    },
    probes: {
      liveness: {failureThreshold: 3, periodSeconds: 5, timeoutSeconds: 1},
      readiness: {failureThreshold: 1, periodSeconds: 1, timeoutSeconds: 1},
      startup: {failureThreshold: 60, periodSeconds: 1, timeoutSeconds: 1},
    },
    secret: {
      keys: {
        apiToken: "api-token",
        databaseUrl: "database-url",
        localBootstrapToken: "",
        s3AccessKeyId: "s3-access-key-id",
        s3SecretAccessKey: "s3-secret-access-key",
        workosApiKey: "",
      },
      name: options.namespaceSecret ?? secretName,
      rolloutChecksum: rolloutRevision,
    },
    terminationGracePeriodSeconds: 15,
  };
  await writeFile(targetPath, `${JSON.stringify(values, null, 2)}\n`);
}

function databaseUrl(host: string): string {
  return `postgresql://${postgresUser}:${postgresPassword}@${host}:5432/${postgresDatabase}`;
}

async function publishFile(
  text: string,
  accessSetting: "account_required" | "public_link" = "public_link",
): Promise<z.infer<typeof publicationSchema>> {
  const fixture = path.join(fixtureDirectory, `${randomUUID()}.txt`);
  const token = path.join(fixtureDirectory, "api-token");
  await Promise.all([
    writeFile(fixture, text),
    writeFile(token, `${apiToken}\n`, {mode: 0o600}),
  ]);
  return withPortForward(async (forward) => {
    const publishArguments = [
      path.join(repositoryRoot, "dist/cli/main.js"),
      "publish", fixture,
      "--server", forward.baseUrl,
      "--token-file", token,
      "--tag", "helm-proof",
    ];
    if (accessSetting === "public_link") publishArguments.push("--public");
    const published = await command("node", publishArguments);
    return publicationSchema.parse(JSON.parse(published.stdout));
  });
}

async function stateSnapshot(
  publication: z.infer<typeof publicationSchema>,
): Promise<readonly unknown[]> {
  return withPortForward(async (forward) => {
    const paths = [
      `/api/v1/artifacts/${publication.artifact.id}`,
      `/api/v1/artifacts/${publication.artifact.id}/versions`,
      `/api/v1/artifacts/${publication.artifact.id}/actions`,
      `/api/v1/artifacts/${publication.artifact.id}/versions/${publication.version.id}`,
    ];
    return Promise.all(paths.map(async (resourcePath) => {
      const response = await fetch(`${forward.baseUrl}${resourcePath}`, {
        headers: {Authorization: `Bearer ${apiToken}`},
      });
      expect(response.status).toBe(200);
      return withoutDerivedLinks(jsonValueSchema.parse(await response.json()));
    }));
  });
}

function withoutDerivedLinks(value: JsonValue): JsonValue {
  const serialized = JSON.stringify(value, (key, nestedValue: JsonValue) =>
    key === "links" ? undefined : nestedValue
  );
  return jsonValueSchema.parse(JSON.parse(serialized));
}

function readPublishedContent(link: string): Promise<string> {
  return withPortForward((forward) => requestPublishedContent(forward, new URL(link)));
}

function publishedContentStatus(link: string): Promise<number> {
  return withPortForward(async (forward) =>
    (await requestPublishedContentResponse(forward, new URL(link))).statusCode
  );
}

function readPrivatePublishedContent(
  publication: z.infer<typeof publicationSchema>,
): Promise<string> {
  return withPortForward(async (forward) => {
    const bootstrapResponse = await fetch(
      `${forward.baseUrl}/api/v1/artifacts/${publication.artifact.id}/versions/${publication.version.id}/content-sessions`,
      {
        headers: {Authorization: `Bearer ${apiToken}`},
        method: "POST",
      },
    );
    if (bootstrapResponse.status !== 201) {
      throw new Error(
        `Private-content bootstrap returned HTTP ${bootstrapResponse.status}.`,
      );
    }
    const bootstrap = contentBootstrapSchema.parse(await bootstrapResponse.json());
    const exchange = await requestPublishedContentResponse(
      forward,
      new URL(bootstrap.bootstrapUrl),
    );
    if (exchange.statusCode !== 303 || exchange.setCookie === null) {
      throw new Error(
        `Private-content exchange returned HTTP ${exchange.statusCode} without a cookie.`,
      );
    }
    const cookie = exchange.setCookie.split(";", 1)[0];
    if (cookie === undefined) {
      throw new Error("Private-content exchange returned an empty cookie.");
    }
    return requestPublishedContent(
      forward,
      new URL(publication.links.version),
      cookie,
    );
  });
}

async function requestPublishedContent(
  forward: PortForward,
  target: URL,
  cookie?: string,
): Promise<string> {
  const response = await requestPublishedContentResponse(forward, target, cookie);
  if (response.statusCode !== 200) {
    throw new Error(`Published content returned HTTP ${response.statusCode}.`);
  }
  return response.body;
}

function requestPublishedContentResponse(
  forward: PortForward,
  target: URL,
  cookie?: string,
): Promise<PublishedContentResponse> {
  const forwardUrl = new URL(forward.baseUrl);
  const headers = cookie === undefined
    ? {host: target.host}
    : {cookie, host: target.host};
  return new Promise((resolve, reject) => {
    const outgoing = request({
      headers,
      host: forwardUrl.hostname,
      method: "GET",
      path: `${target.pathname}${target.search}`,
      port: forwardUrl.port,
    }, (incoming) => {
      const chunks: Uint8Array[] = [];
      incoming.on("data", (chunk: Buffer) => chunks.push(chunk));
      incoming.once("error", reject);
      incoming.once("end", () => {
        resolve({
          body: Buffer.concat(chunks).toString("utf8"),
          setCookie: incoming.headers["set-cookie"]?.[0] ?? null,
          statusCode: incoming.statusCode ?? 0,
        });
      });
    });
    outgoing.once("error", reject);
    outgoing.end();
  });
}

async function measureReads(link: string): Promise<ReadBaseline> {
  const count = 40;
  return withPortForward(async (forward) => {
    const target = new URL(link);
    const latencies: number[] = [];
    const startedAt = performance.now();
    await Promise.all(Array.from({length: count}, async () => {
      const requestStartedAt = performance.now();
      await requestPublishedContent(forward, target);
      latencies.push(performance.now() - requestStartedAt);
    }));
    const elapsedMilliseconds = performance.now() - startedAt;
    const sortedLatencies = latencies.toSorted((left, right) => left - right);
    return {
      completedRequests: count,
      elapsedMilliseconds,
      p95Milliseconds: requiredItem(
        sortedLatencies,
        Math.max(0, Math.ceil(count * 0.95) - 1),
        "p95 latency",
      ),
      requestsPerSecond: count / (elapsedMilliseconds / 1_000),
    };
  });
}

async function withPortForward<T>(
  use: (forward: PortForward) => Promise<T>,
): Promise<T> {
  const forward = await startPortForward();
  try {
    return await use(forward);
  } finally {
    await forward.stop();
  }
}

function startPortForward(): Promise<PortForward> {
  return new Promise((resolve, reject) => {
    const child = execFile("kubectl", [
      "--namespace", namespace,
      "port-forward", `service/${release}`,
      "0:80",
      "--address", "127.0.0.1",
    ]);
    let output = "";
    let settled = false;
    const inspect = (chunk: string): void => {
      output += chunk;
      const match = /Forwarding from 127\.0\.0\.1:(\d+) -> 8787/u.exec(output);
      const port = match?.[1];
      if (settled || port === undefined) return;
      settled = true;
      resolve({
        baseUrl: `http://127.0.0.1:${port}`,
        stop: async () => {
          if (child.exitCode !== null) return;
          child.kill("SIGTERM");
          await new Promise<void>((stopped) => child.once("exit", () => stopped()));
        },
      });
    };
    child.stdout?.on("data", (chunk: Buffer) => inspect(chunk.toString()));
    child.stderr?.on("data", (chunk: Buffer) => inspect(chunk.toString()));
    child.once("error", reject);
    child.once("exit", (code) => {
      if (settled) return;
      settled = true;
      reject(new Error(`kubectl port-forward exited with ${code}: ${output}`));
    });
  });
}

async function readyPods(): Promise<z.infer<typeof podListSchema>["items"]> {
  const pods = await allApplicationPods();
  return pods.filter((pod) => pod.status.conditions?.some((condition) =>
    condition.type === "Ready" && condition.status === "True"
  ));
}

async function allApplicationPods(): Promise<z.infer<typeof podListSchema>["items"]> {
  const result = await kubectl([
    "--namespace", namespace,
    "get", "pods",
    "--selector", `app.kubernetes.io/instance=${release},app.kubernetes.io/name=artifact-server`,
    "--output", "json",
  ], true);
  if (result.exitCode !== 0) return [];
  return podListSchema.parse(JSON.parse(result.stdout)).items.filter((pod) =>
    !pod.metadata.name.endsWith("-test-ready")
  );
}

async function waitForDeployment(): Promise<void> {
  await kubectl([
    "--namespace", namespace,
    "rollout", "status", `deployment/${release}`,
    "--timeout", "180s",
  ]);
  await waitUntil(async () => (await readyPods()).length === 2, 60_000);
}

async function waitForPostgres(): Promise<void> {
  await waitUntil(async () => (await command("docker", [
    "exec", postgresContainer,
    "pg_isready",
    "--username", postgresUser,
    "--dbname", postgresDatabase,
  ], true)).exitCode === 0, 60_000);
}

async function waitForHttp(
  url: string,
  status: number,
  timeoutMilliseconds: number,
): Promise<void> {
  await waitUntil(async () => {
    try {
      return (await fetch(url)).status === status;
    } catch {
      return false;
    }
  }, timeoutMilliseconds);
}

async function waitUntil(
  predicate: () => Promise<boolean>,
  timeoutMilliseconds: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMilliseconds;
  const poll = async (): Promise<void> => {
    if (await predicate()) return;
    if (Date.now() >= deadline) {
      throw new Error(
        `Condition did not become true within ${timeoutMilliseconds} ms.`,
      );
    }
    await delay(250);
    return poll();
  };
  return poll();
}

async function exerciseServiceDuringRollout(
  publication: z.infer<typeof publicationSchema>,
  rolloutIsComplete: () => boolean,
  deadline: number,
  successfulPublications = 0,
  successfulReads = 0,
): Promise<{
  readonly successfulPublications: number;
  readonly successfulReads: number;
}> {
  let nextSuccessfulPublications = successfulPublications;
  let nextSuccessfulReads = successfulReads;
  try {
    await publishFile(`rollout publication ${successfulPublications + 1}`);
    nextSuccessfulPublications += 1;
    const content = await readPublishedContent(publication.links.version);
    if (content !== "first stable Kubernetes version") {
      throw new Error("An immutable version changed during the rolling update.");
    }
    nextSuccessfulReads += 1;
  } catch {
    // A port-forward selects one Pod. Reconnect while that Pod is replaced; the
    // Service remains available through its other endpoint.
  }
  if (rolloutIsComplete() && nextSuccessfulPublications > 0) {
    return {
      successfulPublications: nextSuccessfulPublications,
      successfulReads: nextSuccessfulReads,
    };
  }
  if (Date.now() >= deadline) {
    throw new Error("The rolling update did not finish with a successful publication.");
  }
  await delay(100);
  return exerciseServiceDuringRollout(
    publication,
    rolloutIsComplete,
    deadline,
    nextSuccessfulPublications,
    nextSuccessfulReads,
  );
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function publishedPort(container: string, port: string): Promise<number> {
  const result = await command("docker", ["port", container, port]);
  const match = /127\.0\.0\.1:(\d+)/u.exec(result.stdout);
  const value = match?.[1];
  if (value === undefined) throw new Error(`No loopback port was published for ${container}.`);
  return z.coerce.number().int().positive().parse(value);
}

async function containerIp(container: string): Promise<string> {
  const result = await command("docker", [
    "inspect", "--format",
    "{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}",
    container,
  ]);
  return z.ipv4().parse(result.stdout.trim());
}

function podUids(pods: z.infer<typeof podListSchema>["items"]): readonly string[] {
  return pods.map((pod) => pod.metadata.uid).toSorted();
}

function intersection(
  left: readonly string[],
  right: readonly string[],
): readonly string[] {
  const rightValues = new Set(right);
  return left.filter((value) => rightValues.has(value)).toSorted();
}

function requiredNode(pod: z.infer<typeof podListSchema>["items"][number]): string {
  if (pod.spec.nodeName === undefined) {
    throw new Error(`Pod ${pod.metadata.name} is not scheduled.`);
  }
  return pod.spec.nodeName;
}

function requiredItem<T>(
  items: readonly T[],
  index: number,
  description: string,
): T {
  const item = items[index];
  if (item === undefined) throw new Error(`Missing ${description}.`);
  return item;
}

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.length === 0) {
    throw new Error(`${name} is required.`);
  }
  return value;
}

function helm(args: readonly string[], allowFailure = false): Promise<CommandResult> {
  return command("helm", args, allowFailure);
}

function kubectl(args: readonly string[], allowFailure = false): Promise<CommandResult> {
  return command("kubectl", args, allowFailure);
}

function command(
  executable: string,
  args: readonly string[],
  allowFailure = false,
): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    execFile(
      executable,
      args,
      {env: process.env, maxBuffer: 16 * 1024 * 1024},
      (error, stdout, stderr) => {
        if (error === null) {
          resolve({exitCode: 0, stderr, stdout});
          return;
        }
        const parsed = commandErrorSchema.safeParse(error);
        const result = {
          exitCode: parsed.success ? parsed.data.code ?? 1 : 1,
          stderr: parsed.success ? parsed.data.stderr ?? stderr : stderr,
          stdout: parsed.success ? parsed.data.stdout ?? stdout : stdout,
        };
        if (allowFailure) {
          resolve(result);
          return;
        }
        reject(new Error(
          `${executable} ${args.join(" ")} failed (${result.exitCode}): ${result.stderr}`,
        ));
      },
    );
  });
}
