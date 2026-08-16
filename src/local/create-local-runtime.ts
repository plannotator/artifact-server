import { mkdir } from "node:fs/promises";
import path from "node:path";

import { Effect, Layer, ManagedRuntime, Redacted } from "effect";
import type { ApplicationRuntime } from "../application/application-runtime.js";
import type {
  BearerCredentialVerifier,
  ExternalMcpBearerVerifier,
} from "../application/authentication.js";
import type { InteractiveIdentityProvider } from "../application/interactive-login.js";
import type { Clock } from "../core/ports.js";
import { SystemClock, SystemIdGenerator } from "../core/system.js";
import { createHttpApp } from "../http/create-http-app.js";
import type {
  ApiOAuthResourceConfiguration,
  HttpAppDependencies,
  McpOAuthResourceConfiguration,
} from "../http/create-http-app.js";
import {
  defaultCompletedRequestLogSampleRate,
  otlpLayer,
  silentLoggingLayer,
  structuredLoggingLayer,
} from "../observability/application-observability.js";
import { LocalBlobStore } from "../storage/local-blob-store.js";
import { LocalStagingStore } from "../storage/local-staging-store.js";
import { SqliteArtifactRepository } from "../storage/sqlite-artifact-repository.js";
import { SqliteIdentityRepository } from "../storage/sqlite-identity-repository.js";
import { createLocalApplicationLayer } from "./create-local-application-layer.js";
import type {RuntimeLifecycle} from "../lifecycle/runtime-readiness.js";
import {
  defaultStagingCleanupPolicy,
  runStagingCleanupPass,
  startStagingCleanupSchedule,
  type StagingCleanupPolicy,
} from "../lifecycle/staging-cleanup.js";
import type {ExpiredStagingCleanupReport} from
  "../application/expired-staging-cleanup.js";
import {createNodeWebAssetStore} from "../http/node-web-assets.js";

export interface LocalRuntimeConfig {
  readonly apiToken: string;
  readonly apiOAuthResource?: ApiOAuthResourceConfiguration;
  readonly applicationOrigin?: string;
  readonly bootstrapAdministratorEmail?: string;
  readonly clock?: Clock;
  readonly completedRequestLogSampleRate?: number;
  readonly contentDomain: string;
  readonly dataDirectory: string;
  readonly externalApiBearerVerifier?: BearerCredentialVerifier;
  readonly externalMcpBearerVerifier?: BearerCredentialVerifier;
  readonly externalMcpOAuthVerifier?: ExternalMcpBearerVerifier;
  readonly interactiveIdentityProvider?: InteractiveIdentityProvider;
  readonly localBootstrapToken?: string;
  readonly mcpOAuthResource?: McpOAuthResourceConfiguration;
  readonly observability?: boolean;
  readonly runtimeLifecycle?: RuntimeLifecycle;
  readonly installationId?: string;
  readonly serviceVersion?: string;
  readonly stagingCleanupPolicy?: StagingCleanupPolicy;
}

export interface LocalRuntime {
  readonly app: ReturnType<typeof createHttpApp>;
  cleanupStaging(limit: number): Promise<ExpiredStagingCleanupReport>;
  close(): Promise<void>;
}

export async function createLocalRuntime(
  config: LocalRuntimeConfig,
): Promise<LocalRuntime> {
  await mkdir(config.dataDirectory, {recursive: true, mode: 0o700});
  const blobs = new LocalBlobStore(path.join(config.dataDirectory, "blobs"));
  const staging = new LocalStagingStore(path.join(config.dataDirectory, "staging"));
  const databasePath = path.join(config.dataDirectory, "artifact-server.db");
  const installationId = config.installationId ?? "local";
  const stagingCleanupPolicy = config.stagingCleanupPolicy ??
    defaultStagingCleanupPolicy;
  const repository = new SqliteArtifactRepository(databasePath, installationId);
  const identityRepository = new SqliteIdentityRepository(databasePath);
  const resourceLayer = Layer.effectDiscard(
    Effect.acquireRelease(
      Effect.succeed({identityRepository, repository}),
      (owned) => Effect.sync(() => {
        owned.identityRepository.close();
        owned.repository.close();
      }),
    ),
  );
  const applicationLayer = createLocalApplicationLayer({
    apiToken: Redacted.make(config.apiToken, {label: "local-api-token"}),
    blobs,
    bootstrapAdministratorEmail: config.bootstrapAdministratorEmail ??
      "local-administrator@artifactserver.invalid",
    clock: config.clock ?? new SystemClock(),
    externalApiBearerVerifier: config.externalApiBearerVerifier ?? null,
    externalMcpBearerVerifier: config.externalMcpBearerVerifier ?? null,
    externalMcpOAuthVerifier: config.externalMcpOAuthVerifier ?? null,
    ids: new SystemIdGenerator(),
    identityRepository,
    installationId,
    interactiveIdentityProvider: config.interactiveIdentityProvider ?? null,
    localBootstrapCredential: config.localBootstrapToken === undefined
      ? null
      : Redacted.make(config.localBootstrapToken, {
        label: "local-browser-bootstrap",
      }),
    repository,
    staging,
    stagingCleanupPolicy,
  });
  const telemetryLayer = config.observability === true
    ? otlpLayer({
      deploymentMode: "local",
      installationId,
      serviceVersion: config.serviceVersion ?? "0.0.0",
    }).pipe(Layer.provideMerge(structuredLoggingLayer))
    : silentLoggingLayer;
  const applicationRuntime: ApplicationRuntime = ManagedRuntime.make(
    Layer.mergeAll(applicationLayer, resourceLayer, telemetryLayer),
  );
  try {
    await applicationRuntime.context();
    const appDependenciesWithoutOAuth = {
      applicationRuntime,
      blobs,
      completedRequestLogSampleRate:
        config.completedRequestLogSampleRate ??
          defaultCompletedRequestLogSampleRate,
      contentDomain: config.contentDomain,
      trustedApplicationOrigin: config.applicationOrigin ?? null,
      webAssets: createNodeWebAssetStore(),
    };
    let appDependencies: HttpAppDependencies = appDependenciesWithoutOAuth;
    if (config.apiOAuthResource !== undefined) {
      appDependencies = {
        ...appDependencies,
        apiOAuthResource: config.apiOAuthResource,
      };
    }
    if (config.mcpOAuthResource !== undefined) {
      appDependencies = {
        ...appDependencies,
        mcpOAuthResource: config.mcpOAuthResource,
      };
    }
    const app = createHttpApp(config.runtimeLifecycle === undefined
      ? appDependencies
      : {...appDependencies, runtimeLifecycle: config.runtimeLifecycle});

    const closeCleanupSchedule = stagingCleanupPolicy.schedule === "background"
      ? startStagingCleanupSchedule(applicationRuntime, stagingCleanupPolicy)
      : null;
    return {
      app,
      cleanupStaging: (limit) => runStagingCleanupPass(applicationRuntime, limit),
      close: async () => {
        if (closeCleanupSchedule !== null) await closeCleanupSchedule();
        await applicationRuntime.dispose();
      },
    };
  } catch (error) {
    await applicationRuntime.dispose();
    throw error;
  }
}
