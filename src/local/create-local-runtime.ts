import { mkdir } from "node:fs/promises";
import path from "node:path";

import { Effect, Layer, ManagedRuntime, Redacted } from "effect";
import type { ApplicationRuntime } from "../application/application-runtime.js";
import type { BearerCredentialVerifier } from "../application/authentication.js";
import type { InteractiveIdentityProvider } from "../application/interactive-login.js";
import type { Clock } from "../core/ports.js";
import { SystemClock, SystemIdGenerator } from "../core/system.js";
import { createHttpApp } from "../http/create-http-app.js";
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

export interface LocalRuntimeConfig {
  readonly apiToken: string;
  readonly applicationOrigin?: string;
  readonly bootstrapAdministratorEmail?: string;
  readonly clock?: Clock;
  readonly completedRequestLogSampleRate?: number;
  readonly contentDomain: string;
  readonly dataDirectory: string;
  readonly externalBearerVerifier?: BearerCredentialVerifier;
  readonly interactiveIdentityProvider?: InteractiveIdentityProvider;
  readonly localBootstrapToken?: string;
  readonly observability?: boolean;
  readonly runtimeLifecycle?: RuntimeLifecycle;
  readonly installationId?: string;
  readonly serviceVersion?: string;
}

export interface LocalRuntime {
  readonly app: ReturnType<typeof createHttpApp>;
  close(): Promise<void>;
}

export async function createLocalRuntime(
  config: LocalRuntimeConfig,
): Promise<LocalRuntime> {
  await mkdir(config.dataDirectory, {recursive: true, mode: 0o700});
  const blobs = new LocalBlobStore(path.join(config.dataDirectory, "blobs"));
  const staging = new LocalStagingStore(path.join(config.dataDirectory, "staging"));
  const databasePath = path.join(config.dataDirectory, "artifact-server.db");
  const repository = new SqliteArtifactRepository(databasePath);
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
    externalBearerVerifier: config.externalBearerVerifier ?? null,
    ids: new SystemIdGenerator(),
    identityRepository,
    installationId: config.installationId ?? "local",
    interactiveIdentityProvider: config.interactiveIdentityProvider ?? null,
    localBootstrapCredential: config.localBootstrapToken === undefined
      ? null
      : Redacted.make(config.localBootstrapToken, {
        label: "local-browser-bootstrap",
      }),
    repository,
    staging,
  });
  const telemetryLayer = config.observability === true
    ? otlpLayer({
      deploymentMode: "local",
      installationId: config.installationId ?? "local",
      serviceVersion: config.serviceVersion ?? "0.0.0",
    }).pipe(Layer.provideMerge(structuredLoggingLayer))
    : silentLoggingLayer;
  const applicationRuntime: ApplicationRuntime = ManagedRuntime.make(
    Layer.mergeAll(applicationLayer, resourceLayer, telemetryLayer),
  );
  try {
    await applicationRuntime.context();
    const appDependencies = {
      applicationRuntime,
      blobs,
      completedRequestLogSampleRate:
        config.completedRequestLogSampleRate ??
          defaultCompletedRequestLogSampleRate,
      contentDomain: config.contentDomain,
      trustedApplicationOrigin: config.applicationOrigin ?? null,
    };
    const app = createHttpApp(config.runtimeLifecycle === undefined
      ? appDependencies
      : {...appDependencies, runtimeLifecycle: config.runtimeLifecycle});

    return {
      app,
      close: () => applicationRuntime.dispose(),
    };
  } catch (error) {
    await applicationRuntime.dispose();
    throw error;
  }
}
