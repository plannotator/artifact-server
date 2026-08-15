import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Output from "alchemy/Output";
import * as Effect from "effect/Effect";

import type { CloudflareDeploymentInput } from "./deployment-input.ts";
import {
  buildCloudflareDeploymentManifest,
  type CloudflareDeploymentManifest,
} from "./deployment-manifest.ts";

const WORKER_ENTRYPOINT = new URL("./worker.ts", import.meta.url).pathname;

export type CloudflareZoneResolver =
  typeof Cloudflare.Zone.resolveZoneId;

const accountMismatch = (
  expectedAccountId: string,
  actualAccountId: string,
) =>
  expectedAccountId === actualAccountId
    ? Effect.void
    : Effect.die(
        new Error(
          "cloudflareAccountId does not match the authenticated Alchemy account",
        ),
      );

const validatePublicDnsZone = Effect.fn("validatePublicDnsZone")(
  function* (
    input: CloudflareDeploymentInput,
    accountId: string,
    resolveZoneId: CloudflareZoneResolver,
  ) {
    if (input.ingress !== "public") {
      return;
    }
    const configuredZoneId = input.dnsZoneId;
    if (configuredZoneId === undefined) {
      yield* Effect.die(
        new Error("public ingress requires dnsZoneId"),
      );
      return;
    }
    const inferredZoneIds = yield* Effect.all([
      resolveZoneId({
        accountId,
        hostname: input.applicationDomain,
        zone: undefined,
      }).pipe(Effect.orDie),
      resolveZoneId({
        accountId,
        hostname: input.contentDomain,
        zone: undefined,
      }).pipe(Effect.orDie),
    ]);
    if (
      inferredZoneIds.some(
        (inferredZoneId) =>
          inferredZoneId !== configuredZoneId,
      )
    ) {
      yield* Effect.die(
        new Error(
          "dnsZoneId does not match a domain zone inferred by Cloudflare",
        ),
      );
    }
  },
);

const defineDurableResources = Effect.fn("defineDurableResources")(
  function* (manifest: CloudflareDeploymentManifest) {
    const database = yield* Cloudflare.D1.Database("Records", {
      name: manifest.resourceNames.database,
      readReplication: { mode: "disabled" },
    }).pipe(Alchemy.RemovalPolicy.retain());

    const bucket = yield* Cloudflare.R2.Bucket("Objects", {
      name: manifest.resourceNames.bucket,
      lifecycleRules: [
        {
          id: "abort-incomplete-uploads",
          abortMultipartUploadsTransition: {
            condition: {
              type: "Age",
              maxAge: 7 * 24 * 60 * 60,
            },
          },
        },
      ],
    }).pipe(Alchemy.RemovalPolicy.retain());

    return { database, bucket };
  },
);

export const defineCloudflareFoundation = Effect.fn(
  "defineCloudflareFoundation",
)(function* (
  input: CloudflareDeploymentInput,
  resolveZoneId: CloudflareZoneResolver =
    Cloudflare.Zone.resolveZoneId,
) {
  const manifest = buildCloudflareDeploymentManifest(input);
  const credentials = yield* yield* Cloudflare.CloudflareEnvironment;
  yield* accountMismatch(
    input.cloudflareAccountId,
    credentials.accountId,
  );
  yield* validatePublicDnsZone(
    input,
    credentials.accountId,
    resolveZoneId,
  );

  const { database, bucket } = yield* defineDurableResources(manifest);

  const workerProps: Cloudflare.WorkerProps = {
    name: manifest.resourceNames.worker,
    main: WORKER_ENTRYPOINT,
    compatibility: {
      date: input.compatibilityDate,
    },
    workersDev: false,
    env: {
      ...manifest.runtimeConfiguration,
      ARTIFACT_SERVER_INSTALLATION_ID:
        `${input.installationName}:${input.environment}`,
      ARTIFACT_SERVER_D1_DATABASE: database,
      ARTIFACT_SERVER_R2_BUCKET: bucket,
    },
    observability: {
      enabled: true,
      logs: {
        enabled: true,
        invocationLogs: true,
        headSamplingRate: input.requestLogSampleRate ?? 0.01,
      },
    },
    tags: [...manifest.workerTags],
  };
  if (input.ingress === "public") {
    workerProps.domain = {
      name: input.applicationDomain,
      aliases: [input.contentDomain],
    };
  }
  const worker = yield* Cloudflare.Worker(
    "Application",
    workerProps,
  );

  const applicationUrl = manifest.applicationOrigin;
  const bundleDigest = Output.map(
    worker.hash,
    (hash) =>
      `sha256:${hash?.bundle ?? "0".repeat(64)}`,
  );
  const supportManifestLocation = Output.interpolate`r2://${bucket.bucketName}/support/installation-manifest.json`;
  const output = {
    installationId: `${input.installationName}:${input.environment}`,
    applicationUrl,
    contentDomain: input.contentDomain,
    mcpUrl: `${applicationUrl}/mcp`,
    healthUrl: `${applicationUrl}/health`,
    readinessUrl: `${applicationUrl}/ready`,
    imageDigest: bundleDigest,
    runtimeResourceId: worker.workerId,
    databaseResourceId: database.databaseId,
    objectStorageResourceId: bucket.bucketName,
    workloadIdentityResourceId: worker.workerId,
    secretResourceIds: {
      alchemyStateStore:
        "cloudflare-secrets-store://alchemy-state-store",
    },
    networkResourceIds:
      input.dnsZoneId === undefined
        ? {}
        : { dnsZoneId: input.dnsZoneId },
    logDestination: Output.interpolate`cloudflare-workers://${worker.workerName}`,
    stateBackend: "cloudflare:alchemy-state-store",
    supportManifestLocation,
  };

  return output;
});
