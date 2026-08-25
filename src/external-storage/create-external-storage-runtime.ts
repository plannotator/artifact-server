import {Effect, Layer, ManagedRuntime, type Redacted} from "effect";

import type {ApplicationRuntime} from "../application/application-runtime.js";
import type {
  BearerCredentialVerifier,
  ExternalMcpBearerVerifier,
} from "../application/authentication.js";
import type {InteractiveIdentityProvider} from "../application/interactive-login.js";
import type {Clock} from "../core/ports.js";
import type {BrowserAccess} from "../core/browser-access.js";
import {SystemClock, SystemIdGenerator} from "../core/system.js";
import {createHttpApp} from "../http/create-http-app.js";
import type {
  ApiOAuthResourceConfiguration,
  HttpAppDependencies,
  McpOAuthResourceConfiguration,
} from "../http/create-http-app.js";
import {
  defaultCompletedRequestLogSampleRate,
  otlpLayer,
  structuredLoggingLayer,
} from "../observability/application-observability.js";
import {createApplicationLayer} from "../local/create-local-application-layer.js";
import {PostgresArtifactRepository} from "../storage/postgres-artifact-repository.js";
import {PostgresDatabase} from "../storage/postgres-database.js";
import {PostgresIdentityRepository} from "../storage/postgres-identity-repository.js";
import type {
  ObjectStorageProvider,
  ObjectStorageProviderFactory,
} from "../storage/object-storage-provider.js";
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
import {ensureBootstrapManagedApiKey} from
  "../application/bootstrap-managed-api-key.js";
import {
  configuredNodeGitHistory,
  offNodeGitHistoryConfiguration,
  type NodeGitHistoryConfiguration,
} from "../git-history/node-git-history-configuration.js";
import {fixedGitHistoryCapabilityReader} from
  "../git-history/git-history-capability.js";
import type {GitHistoryProviderHealthProbe} from
  "../git-history/git-history-provider-health.js";
import {CloudflareArtifactsRestHealthProbe} from
  "../git-history/cloudflare-artifacts-rest-health-probe.js";
import {
  startGitHistoryCapabilityMonitor,
  type GitHistoryCapabilityMonitor,
} from "../git-history/git-history-capability-monitor.js";
import {PostgresGitHistoryProviderIdentityStore} from
  "../storage/postgres-git-history-provider-identity-store.js";
import {
  type GitHistoryProvider,
  startGitHistoryMirrorWorker,
} from "../git-history/git-history-mirror.js";
import {CloudflareArtifactsGitHistoryProvider} from
  "../git-history/cloudflare-artifacts-git-history-provider.js";

/** Configuration for one stateless Artifact Server process. */
export interface ExternalStorageRuntimeConfig {
  readonly apiToken: Redacted.Redacted;
  readonly apiOAuthResource?: ApiOAuthResourceConfiguration;
  readonly applicationOrigin?: string;
  readonly bootstrapAdministratorEmail: string;
  readonly browserAccess: Extract<BrowserAccess, {readonly mode: "private_team"}>;
  readonly clock?: Clock;
  readonly completedRequestLogSampleRate?: number;
  readonly contentDomain: string;
  readonly databaseUrl: Redacted.Redacted;
  readonly externalApiBearerVerifier?: BearerCredentialVerifier;
  readonly externalMcpBearerVerifier?: BearerCredentialVerifier;
  readonly externalMcpOAuthVerifier?: ExternalMcpBearerVerifier;
  readonly gitHistory?: NodeGitHistoryConfiguration;
  /** Optional provider seam for real-boundary tests; production composes REST. */
  readonly gitHistoryHealthProbe?: GitHistoryProviderHealthProbe;
  /** Complete provider seam for conformance tests; production composes REST and Git. */
  readonly gitHistoryProvider?: GitHistoryProvider;
  readonly installationId: string;
  readonly interactiveIdentityProvider?: InteractiveIdentityProvider;
  readonly localBootstrapCredential?: Redacted.Redacted;
  readonly mcpOAuthResource?: McpOAuthResourceConfiguration;
  readonly objectStorage: ObjectStorageProviderFactory;
  readonly postgresMaxConnections?: number;
  readonly runtimeLifecycle?: RuntimeLifecycle;
  readonly serviceVersion?: string;
  readonly stagingCleanupPolicy?: StagingCleanupPolicy;
}

/** One ready external-storage runtime and its protocol adapter. */
export interface ExternalStorageRuntime {
  readonly app: ReturnType<typeof createHttpApp>;
  cleanupStaging(limit: number): Promise<ExpiredStagingCleanupReport>;
  close(): Promise<void>;
}

/** Connect external providers, validate migrations, verify readiness, and build the app. */
export async function createExternalStorageRuntime(
  config: ExternalStorageRuntimeConfig,
): Promise<ExternalStorageRuntime> {
  const runtimeClock = config.clock ?? new SystemClock();
  const stagingCleanupPolicy = config.stagingCleanupPolicy ??
    defaultStagingCleanupPolicy;
  const gitHistory = config.gitHistory ?? offNodeGitHistoryConfiguration();
  let applicationGitHistory = fixedGitHistoryCapabilityReader(
    gitHistory.capability,
  );
  const database = await PostgresDatabase.open({
    applicationName: `artifact-server:${config.installationId}`,
    maxConnections: config.postgresMaxConnections ?? 10,
    url: config.databaseUrl,
  }, "validate");
  let objectStorage: ObjectStorageProvider | null = null;
  let applicationRuntime: ApplicationRuntime | null = null;
  let gitHistoryMonitor: GitHistoryCapabilityMonitor | null = null;
  let gitHistoryWorker: Awaited<ReturnType<typeof startGitHistoryMirrorWorker>> | null = null;
  try {
    const connectedObjectStorage = config.objectStorage.create(
      config.installationId,
    );
    objectStorage = connectedObjectStorage;
    await Promise.all([
      database.health(),
      connectedObjectStorage.readiness(AbortSignal.timeout(3_000)),
    ]);
    const repository = await PostgresArtifactRepository.open(
      database,
      config.installationId,
    );
    const identityRepository = new PostgresIdentityRepository(
      database,
      config.installationId,
    );
    const configuredGitHistory = configuredNodeGitHistory(gitHistory);
    const gitHistoryProvider = configuredGitHistory === null
      ? null
      : config.gitHistoryProvider ?? new CloudflareArtifactsGitHistoryProvider({
        apiToken: configuredGitHistory.apiToken,
        identity: configuredGitHistory.identity,
      });
    const gitHistoryIdentityStore = configuredGitHistory === null
      ? null
      : new PostgresGitHistoryProviderIdentityStore(
        database,
        config.installationId,
      );
    await ensureBootstrapManagedApiKey({
      credential: config.apiToken,
      installationId: config.installationId,
      now: runtimeClock.now(),
      repository: identityRepository,
    });
    const {blobs, staging} = connectedObjectStorage;
    const applicationAdapters: Parameters<typeof createApplicationLayer>[0] = {
      apiToken: null,
      blobs,
      bootstrapAdministratorEmail: config.bootstrapAdministratorEmail,
      clock: runtimeClock,
      dispatches: repository,
      externalApiBearerVerifier: config.externalApiBearerVerifier ?? null,
      externalMcpBearerVerifier: config.externalMcpBearerVerifier ?? null,
      externalMcpOAuthVerifier: config.externalMcpOAuthVerifier ?? null,
      ids: new SystemIdGenerator(),
      identityRepository,
      installationId: config.installationId,
      gitHistory: {read: () => applicationGitHistory.read()},
      interactiveIdentityProvider: config.interactiveIdentityProvider ?? null,
      localBootstrapCredential: config.localBootstrapCredential ?? null,
      protectBootstrapAdministrator: false,
      repository,
      staging,
      stagingCleanupPolicy,
    };
    if (gitHistoryProvider !== null) {
      Object.assign(applicationAdapters, {gitHistoryProvider});
    }
    const applicationLayer = createApplicationLayer(applicationAdapters);
    const resources = Layer.effectDiscard(Effect.acquireRelease(
      Effect.void,
      () => Effect.promise(async () => {
        await Promise.all([connectedObjectStorage.close(), database.close()]);
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
    if (
      configuredGitHistory !== null &&
      gitHistoryIdentityStore !== null &&
      gitHistoryProvider !== null
    ) {
      gitHistoryMonitor = startGitHistoryCapabilityMonitor(readyRuntime, {
        clock: runtimeClock,
        identity: configuredGitHistory.identity,
        identityStore: gitHistoryIdentityStore,
        initialCapability: configuredGitHistory.capability,
        providerHealth: config.gitHistoryHealthProbe ??
          new CloudflareArtifactsRestHealthProbe({
            apiToken: configuredGitHistory.apiToken,
            identity: configuredGitHistory.identity,
          }),
      });
      applicationGitHistory = gitHistoryMonitor.reader;
      gitHistoryWorker = await startGitHistoryMirrorWorker({
        blobs,
        capability: applicationGitHistory,
        installationId: config.installationId,
        provider: gitHistoryProvider,
        store: repository,
      });
    }
    const appDependenciesWithoutOAuth = {
      applicationRuntime: readyRuntime,
      blobs,
      browserAccess: config.browserAccess,
      completedRequestLogSampleRate:
        config.completedRequestLogSampleRate ??
          defaultCompletedRequestLogSampleRate,
      contentDomain: config.contentDomain,
      gitHistory: gitHistoryMonitor?.reader ??
        fixedGitHistoryCapabilityReader(gitHistory.capability),
      readiness: () => externalStorageReadiness(database, connectedObjectStorage),
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
    const closeCleanupSchedule = stagingCleanupPolicy.schedule === "background"
      ? startStagingCleanupSchedule(readyRuntime, stagingCleanupPolicy)
      : null;
    return {
      app: createHttpApp(config.runtimeLifecycle === undefined
        ? appDependencies
        : {...appDependencies, runtimeLifecycle: config.runtimeLifecycle}),
      cleanupStaging: (limit) => runStagingCleanupPass(readyRuntime, limit),
      close: async () => {
        if (closeCleanupSchedule !== null) await closeCleanupSchedule();
        if (gitHistoryWorker !== null) await gitHistoryWorker.close();
        if (gitHistoryMonitor !== null) await gitHistoryMonitor.close();
        await readyRuntime.dispose();
      },
    };
  } catch (cause) {
    if (gitHistoryWorker !== null) await gitHistoryWorker.close();
    if (gitHistoryMonitor !== null) await gitHistoryMonitor.close();
    if (applicationRuntime === null) {
      await Promise.all([
        objectStorage?.close() ?? Promise.resolve(),
        database.close(),
      ]);
    } else {
      await applicationRuntime.dispose();
    }
    throw cause;
  }
}

async function externalStorageReadiness(
  database: PostgresDatabase,
  objectStorage: ObjectStorageProvider,
) {
  const [databaseResult, migrationResult, objectStorageResult] = await Promise.all([
    readinessComponent(() => database.health()),
    readinessComponent(async () => {
      const migrations = await database.migrationStatus();
      if (migrations.compatibility !== "current") {
        throw new Error("The database schema is not compatible with this build.");
      }
    }),
    readinessComponent((signal) => objectStorage.readiness(signal)),
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
