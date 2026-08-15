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
import type {ApiOAuthResourceConfiguration} from "../http/create-http-app.js";
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
import type {RuntimeLifecycle} from "../lifecycle/runtime-readiness.js";

interface ExternalObjectStorageConfigBase {
  readonly bucket: string;
  readonly endpoint?: string;
  readonly forcePathStyle?: boolean;
  readonly region: string;
}

/** S3 settings using either a static pair or the AWS SDK credential chain. */
export type ExternalObjectStorageConfig = ExternalObjectStorageConfigBase & (
  | {
    readonly accessKeyId: string;
    readonly secretAccessKey: Redacted.Redacted;
  }
  | {
    readonly accessKeyId?: never;
    readonly secretAccessKey?: never;
  }
);

/** Configuration for one stateless Artifact Server process. */
export interface ExternalStorageRuntimeConfig {
  readonly apiToken: Redacted.Redacted;
  readonly apiOAuthResource?: ApiOAuthResourceConfiguration;
  readonly applicationOrigin?: string;
  readonly bootstrapAdministratorEmail: string;
  readonly clock?: Clock;
  readonly completedRequestLogSampleRate?: number;
  readonly contentDomain: string;
  readonly databaseUrl: Redacted.Redacted;
  readonly externalApiBearerVerifier?: BearerCredentialVerifier;
  readonly externalMcpBearerVerifier?: BearerCredentialVerifier;
  readonly installationId: string;
  readonly interactiveIdentityProvider?: InteractiveIdentityProvider;
  readonly localBootstrapCredential?: Redacted.Redacted;
  readonly objectStorage: ExternalObjectStorageConfig;
  readonly runtimeLifecycle?: RuntimeLifecycle;
  readonly serviceVersion?: string;
}

/** One ready external-storage runtime and its protocol adapter. */
export interface ExternalStorageRuntime {
  readonly app: ReturnType<typeof createHttpApp>;
  close(): Promise<void>;
}

/** Connect external providers, validate migrations, verify readiness, and build the app. */
export async function createExternalStorageRuntime(
  config: ExternalStorageRuntimeConfig,
): Promise<ExternalStorageRuntime> {
  const database = await PostgresDatabase.open({
    applicationName: `artifact-server:${config.installationId}`,
    maxConnections: 10,
    url: config.databaseUrl,
  }, "validate");
  const client = new S3Client(createS3ClientConfig(config.objectStorage));
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
      externalApiBearerVerifier: config.externalApiBearerVerifier ?? null,
      externalMcpBearerVerifier: config.externalMcpBearerVerifier ?? null,
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
      deploymentMode: "external-storage",
      installationId: config.installationId,
      serviceVersion: config.serviceVersion ?? "0.0.0",
    }).pipe(Layer.provideMerge(structuredLoggingLayer));
    applicationRuntime = ManagedRuntime.make(
      Layer.mergeAll(applicationLayer, resources, telemetry),
    );
    await applicationRuntime.context();
    const readyRuntime = applicationRuntime;
    const appDependenciesWithoutOAuth = {
        applicationRuntime: readyRuntime,
        blobs,
        completedRequestLogSampleRate:
          config.completedRequestLogSampleRate ??
            defaultCompletedRequestLogSampleRate,
        contentDomain: config.contentDomain,
        readiness: () => externalStorageReadiness(database, client, config.objectStorage.bucket),
        trustedApplicationOrigin: config.applicationOrigin ?? null,
    };
    const appDependencies = config.apiOAuthResource === undefined
      ? appDependenciesWithoutOAuth
      : {
        ...appDependenciesWithoutOAuth,
        apiOAuthResource: config.apiOAuthResource,
      };
    return {
      app: createHttpApp(config.runtimeLifecycle === undefined
        ? appDependencies
        : {...appDependencies, runtimeLifecycle: config.runtimeLifecycle}),
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

async function externalStorageReadiness(
  database: PostgresDatabase,
  client: S3Client,
  bucket: string,
) {
  const [databaseResult, migrationResult, objectStorageResult] = await Promise.all([
    readinessComponent(() => database.health()),
    readinessComponent(async () => {
      const migrations = await database.migrationStatus();
      if (migrations.compatibility !== "current") {
        throw new Error("The database schema is not compatible with this build.");
      }
    }),
    readinessComponent(async (signal) => {
      await client.send(
        new HeadBucketCommand({Bucket: bucket}),
        {abortSignal: signal},
      );
    }),
  ]);
  const status = databaseResult.status === "ready"
    && migrationResult.status === "ready"
    && objectStorageResult.status === "ready"
    ? "ready" as const
    : "not_ready" as const;
  return {
    components: {
      configuration: readyComponent,
      database: databaseResult,
      migrations: migrationResult,
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

/** Build an AWS SDK client configuration for one parsed object-store adapter. */
export function createS3ClientConfig(
  config: ExternalObjectStorageConfig,
): S3ClientConfig {
  const base: S3ClientConfig = {
    forcePathStyle: config.forcePathStyle ?? false,
    region: config.region,
  };
  if (config.accessKeyId !== undefined) {
    base.credentials = {
      accessKeyId: config.accessKeyId,
      secretAccessKey: Redacted.value(config.secretAccessKey),
    };
  }
  if (config.endpoint !== undefined) base.endpoint = config.endpoint;
  return base;
}
