import {
  HeadBucketCommand,
  S3Client,
  type S3ClientConfig,
} from "@aws-sdk/client-s3";
import {Effect, Layer, ManagedRuntime, Redacted} from "effect";

import type {ApplicationRuntime} from "../application/application-runtime.js";
import type {BearerCredentialVerifier} from "../application/authentication.js";
import type {InteractiveIdentityProvider} from "../application/interactive-login.js";
import type {Clock} from "../core/ports.js";
import {SystemClock, SystemIdGenerator} from "../core/system.js";
import {createHttpApp} from "../http/create-http-app.js";
import {
  defaultCompletedRequestLogSampleRate,
  otlpLayer,
  structuredLoggingLayer,
} from "../observability/application-observability.js";
import {createApplicationLayer} from "../local/create-local-application-layer.js";
import {PostgresArtifactRepository} from "../storage/postgres-artifact-repository.js";
import {PostgresDatabase} from "../storage/postgres-database.js";
import {PostgresIdentityRepository} from "../storage/postgres-identity-repository.js";
import {createS3ObjectStorageAdapters} from "../storage/s3-object-storage.js";

/** S3-compatible provider settings parsed by the shared composition root. */
export interface SharedObjectStorageConfig {
  readonly accessKeyId: string;
  readonly bucket: string;
  readonly endpoint?: string;
  readonly forcePathStyle?: boolean;
  readonly region: string;
  readonly secretAccessKey: Redacted.Redacted;
}

/** Configuration for one stateless Artifact Server process. */
export interface SharedRuntimeConfig {
  readonly apiToken: Redacted.Redacted;
  readonly applicationOrigin?: string;
  readonly bootstrapAdministratorEmail: string;
  readonly clock?: Clock;
  readonly completedRequestLogSampleRate?: number;
  readonly contentDomain: string;
  readonly databaseUrl: Redacted.Redacted;
  readonly externalBearerVerifier?: BearerCredentialVerifier;
  readonly installationId: string;
  readonly interactiveIdentityProvider?: InteractiveIdentityProvider;
  readonly localBootstrapCredential?: Redacted.Redacted;
  readonly objectStorage: SharedObjectStorageConfig;
}

/** One ready shared runtime and its protocol adapter. */
export interface SharedRuntime {
  readonly app: ReturnType<typeof createHttpApp>;
  close(): Promise<void>;
}

/** Connect shared providers, run migrations, verify readiness, and build the app. */
export async function createSharedRuntime(
  config: SharedRuntimeConfig,
): Promise<SharedRuntime> {
  const database = await PostgresDatabase.open({
    applicationName: `artifact-server:${config.installationId}`,
    maxConnections: 10,
    url: config.databaseUrl,
  });
  const client = new S3Client(s3ClientConfig(config.objectStorage));
  let applicationRuntime: ApplicationRuntime | null = null;
  try {
    await Promise.all([
      database.health(),
      client.send(new HeadBucketCommand({Bucket: config.objectStorage.bucket})),
    ]);
    const repository = await PostgresArtifactRepository.open(
      database,
      config.installationId,
    );
    const identityRepository = new PostgresIdentityRepository(
      database,
      config.installationId,
    );
    const {blobs, staging} = createS3ObjectStorageAdapters({
      bucket: config.objectStorage.bucket,
      client,
      installationId: config.installationId,
    });
    const applicationLayer = createApplicationLayer({
      apiToken: config.apiToken,
      blobs,
      bootstrapAdministratorEmail: config.bootstrapAdministratorEmail,
      clock: config.clock ?? new SystemClock(),
      externalBearerVerifier: config.externalBearerVerifier ?? null,
      ids: new SystemIdGenerator(),
      identityRepository,
      installationId: config.installationId,
      interactiveIdentityProvider: config.interactiveIdentityProvider ?? null,
      localBootstrapCredential: config.localBootstrapCredential ?? null,
      repository,
      staging,
    });
    const resources = Layer.effectDiscard(Effect.acquireRelease(
      Effect.void,
      () => Effect.promise(async () => {
        client.destroy();
        await database.close();
      }),
    ));
    const telemetry = otlpLayer({
      deploymentMode: "shared",
      installationId: config.installationId,
      serviceVersion: "0.0.0",
    }).pipe(Layer.provideMerge(structuredLoggingLayer));
    applicationRuntime = ManagedRuntime.make(
      Layer.mergeAll(applicationLayer, resources, telemetry),
    );
    await applicationRuntime.context();
    const readyRuntime = applicationRuntime;
    return {
      app: createHttpApp({
        applicationRuntime: readyRuntime,
        blobs,
        completedRequestLogSampleRate:
          config.completedRequestLogSampleRate ??
            defaultCompletedRequestLogSampleRate,
        contentDomain: config.contentDomain,
        readiness: () => sharedReadiness(database, client, config.objectStorage.bucket),
        trustedApplicationOrigin: config.applicationOrigin ?? null,
      }),
      close: () => readyRuntime.dispose(),
    };
  } catch (cause) {
    if (applicationRuntime === null) {
      client.destroy();
      await database.close();
    } else {
      await applicationRuntime.dispose();
    }
    throw cause;
  }
}

async function sharedReadiness(
  database: PostgresDatabase,
  client: S3Client,
  bucket: string,
) {
  const [databaseResult, objectStorageResult] = await Promise.all([
    readinessComponent(() => database.health()),
    readinessComponent(async (signal) => {
      await client.send(
        new HeadBucketCommand({Bucket: bucket}),
        {abortSignal: signal},
      );
    }),
  ]);
  const status = databaseResult.status === "ready"
    && objectStorageResult.status === "ready"
    ? "ready" as const
    : "not_ready" as const;
  return {
    components: {
      configuration: readyComponent,
      database: databaseResult,
      migrations: readyComponent,
      objectStorage: objectStorageResult,
    },
    status,
  };
}

const readyComponent = {
  latencyMilliseconds: 0,
  status: "ready" as const,
};

async function readinessComponent(
  probe: (signal: AbortSignal) => Promise<void>,
): Promise<{readonly latencyMilliseconds: number; readonly status: "ready" | "unavailable"}> {
  const startedAt = performance.now();
  const controller = new AbortController();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      probe(controller.signal),
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => {
          controller.abort();
          reject(new Error("Readiness probe timed out."));
        }, 3_000);
      }),
    ]);
    return {
      latencyMilliseconds: performance.now() - startedAt,
      status: "ready",
    };
  } catch {
    return {
      latencyMilliseconds: performance.now() - startedAt,
      status: "unavailable",
    };
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

function s3ClientConfig(
  config: SharedObjectStorageConfig,
): S3ClientConfig {
  const base = {
    credentials: {
      accessKeyId: config.accessKeyId,
      secretAccessKey: Redacted.value(config.secretAccessKey),
    },
    forcePathStyle: config.forcePathStyle ?? false,
    region: config.region,
  };
  return config.endpoint === undefined
    ? base
    : {...base, endpoint: config.endpoint};
}
