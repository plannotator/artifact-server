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
import type {BrowserAccess} from "../core/browser-access.js";
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
import {
  createLocalApplicationLayer,
  type LinkedApplicationAdapters,
} from "./create-local-application-layer.js";
import {
  canonicalizeLinkPath,
  canonicalizeLinkRoots,
  captureSource,
  checkLinkRoots,
  checkSelfProtection,
  openVerifiedSource,
  refreshFreshness,
} from "./linked-source-engine.js";
import { mediaTypeForPath } from "../client/file-publication-client.js";
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
import {browserAccessModes} from "../core/browser-access.js";
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
import {SqliteGitHistoryProviderIdentityStore} from
  "../storage/sqlite-git-history-provider-identity-store.js";
import {
  type GitHistoryProvider,
  startGitHistoryMirrorWorker,
} from "../git-history/git-history-mirror.js";
import {CloudflareArtifactsGitHistoryProvider} from
  "../git-history/cloudflare-artifacts-git-history-provider.js";

export interface LocalRuntimeConfig {
  readonly apiToken: string;
  readonly apiOAuthResource?: ApiOAuthResourceConfiguration;
  readonly applicationOrigin?: string;
  readonly bootstrapAdministratorEmail?: string;
  readonly browserAccess: BrowserAccess;
  readonly clock?: Clock;
  readonly completedRequestLogSampleRate?: number;
  readonly contentDomain: string;
  readonly dataDirectory: string;
  /** Server-only credential shared with a co-launched development proxy. */
  readonly developmentProxyCredential?: string;
  readonly externalApiBearerVerifier?: BearerCredentialVerifier;
  readonly externalMcpBearerVerifier?: BearerCredentialVerifier;
  readonly externalMcpOAuthVerifier?: ExternalMcpBearerVerifier;
  readonly gitHistory?: NodeGitHistoryConfiguration;
  /** Optional provider seam for real-boundary tests; production composes REST. */
  readonly gitHistoryHealthProbe?: GitHistoryProviderHealthProbe;
  /** Complete provider seam for conformance tests; production composes REST and Git. */
  readonly gitHistoryProvider?: GitHistoryProvider;
  readonly interactiveIdentityProvider?: InteractiveIdentityProvider;
  /** Linked-artifact capability switch; absent or "off" leaves it disabled. */
  readonly linkedFiles?: "off" | "on";
  /** Canonical roots linked source paths must resolve inside. */
  readonly linkRoots?: readonly string[];
  readonly localBootstrapToken?: string;
  readonly mcpOAuthResource?: McpOAuthResourceConfiguration;
  readonly observability?: boolean;
  readonly runtimeLifecycle?: RuntimeLifecycle;
  readonly installationId?: string;
  readonly serviceVersion?: string;
  readonly stagingCleanupPolicy?: StagingCleanupPolicy;
  /** Overrides the compiled web bundle directory; used by tests. */
  readonly webAssetsRoot?: string;
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
  const runtimeClock = config.clock ?? new SystemClock();
  const stagingCleanupPolicy = config.stagingCleanupPolicy ??
    defaultStagingCleanupPolicy;
  const gitHistory = config.gitHistory ?? offNodeGitHistoryConfiguration();
  let applicationGitHistory = fixedGitHistoryCapabilityReader(
    gitHistory.capability,
  );
  const repository = new SqliteArtifactRepository(databasePath, installationId);
  const identityRepository = new SqliteIdentityRepository(databasePath);
  const configuredGitHistory = configuredNodeGitHistory(gitHistory);
  const gitHistoryProvider = configuredGitHistory === null
    ? null
    : config.gitHistoryProvider ?? new CloudflareArtifactsGitHistoryProvider({
      apiToken: configuredGitHistory.apiToken,
      identity: configuredGitHistory.identity,
    });
  const apiToken = Redacted.make(config.apiToken, {label: "local-api-token"});
  if (config.browserAccess.mode === browserAccessModes.privateTeam) {
    try {
      await ensureBootstrapManagedApiKey({
        credential: apiToken,
        installationId,
        now: runtimeClock.now(),
        repository: identityRepository,
      });
    } catch (cause) {
      identityRepository.close();
      repository.close();
      throw cause;
    }
  }
  let gitHistoryIdentityStore: SqliteGitHistoryProviderIdentityStore | null;
  try {
    gitHistoryIdentityStore = configuredGitHistory === null
      ? null
      : new SqliteGitHistoryProviderIdentityStore(databasePath, installationId);
  } catch (cause) {
    identityRepository.close();
    repository.close();
    throw cause;
  }
  const linkedFilesEnabled = config.linkedFiles === "on";
  const selfProtectedPaths = {
    databasePath,
    dataDirectory: config.dataDirectory,
  };
  const linkedAdapters: LinkedApplicationAdapters | undefined =
    linkedFilesEnabled
      ? {
        bindings: repository,
        configuration: {
          linkRoots: config.linkRoots ?? [],
          spoolDirectory: path.join(config.dataDirectory, "capture-spool"),
        },
        engine: {
          canonicalizeLinkPath,
          canonicalizeLinkRoots,
          captureSource: (canonicalPath, spoolDirectory) =>
            captureSource(canonicalPath, spoolDirectory),
          checkLinkRoots,
          checkSelfProtection: (canonicalPath) =>
            checkSelfProtection(canonicalPath, selfProtectedPaths),
          mediaTypeForPath,
          openVerifiedSource: (canonicalPath) =>
            openVerifiedSource(canonicalPath),
          refreshFreshness,
        },
      }
      : undefined;
  const resourceLayer = Layer.effectDiscard(
    Effect.acquireRelease(
      Effect.succeed({
        gitHistoryIdentityStore,
        identityRepository,
        repository,
      }),
      (owned) => Effect.sync(() => {
        owned.gitHistoryIdentityStore?.close();
        owned.identityRepository.close();
        owned.repository.close();
      }),
    ),
  );
  let applicationAdapters: Parameters<typeof createLocalApplicationLayer>[0] = {
    apiToken: config.browserAccess.mode === browserAccessModes.localOwner
      ? apiToken
      : null,
    blobs,
    bootstrapAdministratorEmail: config.bootstrapAdministratorEmail ??
      "local-administrator@artifactserver.invalid",
    clock: runtimeClock,
    dispatches: repository,
    externalApiBearerVerifier: config.externalApiBearerVerifier ?? null,
    externalMcpBearerVerifier: config.externalMcpBearerVerifier ?? null,
    externalMcpOAuthVerifier: config.externalMcpOAuthVerifier ?? null,
    ids: new SystemIdGenerator(),
    identityRepository,
    installationId,
    gitHistory: {read: () => applicationGitHistory.read()},
    interactiveIdentityProvider: config.interactiveIdentityProvider ?? null,
    localBootstrapCredential: config.localBootstrapToken === undefined
      ? null
      : Redacted.make(config.localBootstrapToken, {
        label: "local-browser-bootstrap",
      }),
    protectBootstrapAdministrator:
      config.browserAccess.mode === browserAccessModes.localOwner,
    repository,
    staging,
    stagingCleanupPolicy,
  };
  if (gitHistoryProvider !== null) {
    Object.assign(applicationAdapters, {gitHistoryProvider});
  }
  if (linkedAdapters !== undefined) {
    applicationAdapters = {...applicationAdapters, linked: linkedAdapters};
  }
  const applicationLayer = createLocalApplicationLayer(applicationAdapters);
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
  let gitHistoryMonitor: GitHistoryCapabilityMonitor | null = null;
  let gitHistoryWorker: Awaited<ReturnType<typeof startGitHistoryMirrorWorker>> | null = null;
  try {
    await applicationRuntime.context();
    if (
      configuredGitHistory !== null &&
      gitHistoryIdentityStore !== null &&
      gitHistoryProvider !== null
    ) {
      gitHistoryMonitor = startGitHistoryCapabilityMonitor(applicationRuntime, {
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
        installationId,
        provider: gitHistoryProvider,
        store: repository,
      });
    }
    let appDependenciesWithoutOAuth: HttpAppDependencies = {
      applicationRuntime,
      blobs,
      browserAccess: config.browserAccess,
      completedRequestLogSampleRate:
        config.completedRequestLogSampleRate ??
          defaultCompletedRequestLogSampleRate,
      contentDomain: config.contentDomain,
      gitHistory: gitHistoryMonitor?.reader ??
        fixedGitHistoryCapabilityReader(gitHistory.capability),
      linkedArtifacts: linkedFilesEnabled,
      trustedApplicationOrigin: config.applicationOrigin ?? null,
      webAssets: createNodeWebAssetStore(config.webAssetsRoot),
    };
    if (config.developmentProxyCredential !== undefined) {
      appDependenciesWithoutOAuth = {
        ...appDependenciesWithoutOAuth,
        developmentProxyCredential: Redacted.make(
          config.developmentProxyCredential,
          {label: "development-proxy"},
        ),
      };
    }
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
        if (gitHistoryWorker !== null) await gitHistoryWorker.close();
        if (gitHistoryMonitor !== null) await gitHistoryMonitor.close();
        await applicationRuntime.dispose();
      },
    };
  } catch (error) {
    if (gitHistoryWorker !== null) await gitHistoryWorker.close();
    if (gitHistoryMonitor !== null) await gitHistoryMonitor.close();
    await applicationRuntime.dispose();
    throw error;
  }
}
