import {Effect, Layer, ManagedRuntime, Redacted} from "effect";

import type {ApplicationRuntime} from "../../../src/application/application-runtime.js";
import {ExpiredStagingCleanupService} from
  "../../../src/application/expired-staging-cleanup.js";
import {SystemClock, SystemIdGenerator} from "../../../src/core/system.js";
import {
  browserLoginKinds,
  privateTeamBrowserAccess,
} from "../../../src/core/browser-access.js";
import {
  createHttpApp,
  type ReadinessComponent,
  type ReadinessReport,
} from "../../../src/http/create-http-app.js";
import {createApplicationLayer} from "../../../src/local/create-local-application-layer.js";
import {
  defaultCompletedRequestLogSampleRate,
  structuredLoggingLayer,
} from "../../../src/observability/application-observability.js";
import {createD1ArtifactRepository} from "./d1-artifact-repository.js";
import {createD1IdentityRepository} from "./d1-identity-repository.js";
import {migrateD1, requiredD1SchemaVersion} from "./d1-migrations.js";
import {createR2ObjectStorageAdapters} from "./r2-object-storage.js";
import {
  ArtifactsBindingGitHistoryProvider,
  type ArtifactsBinding,
} from "./artifacts-binding-git-history-provider.js";
import {D1GitHistoryProviderIdentityStore} from
  "./d1-git-history-provider-identity-store.js";
import {
  defaultGitHistoryFileCopyBytes,
  defaultGitHistoryVersionCopyBytes,
  disabledGitHistoryCapability,
  type GitHistoryCapabilityReader,
} from "../../../src/git-history/git-history-capability.js";
import {resolveGitHistoryProviderState} from
  "../../../src/git-history/git-history-capability-monitor.js";
import {makeGitHistoryMirrorWorker} from
  "../../../src/git-history/git-history-mirror.js";
import {
  createOidcIdentityProvider,
  defaultOidcScopes,
  type OidcIdentityProvider,
} from "../../../src/identity/oidc-identity-provider.js";
import {createWorkOsHostedAuthentication} from
  "../../../src/identity/workos-hosted-authentication.js";

/** Bindings and variables the deployed Artifact Server worker reads. */
export interface WorkerEnvironment {
  readonly ASSETS: Fetcher;
  readonly ARTIFACTS?: ArtifactsBinding;
  readonly ARTIFACT_SERVER_API_TOKEN: string;
  readonly ARTIFACT_SERVER_BOOTSTRAP_ADMIN_EMAIL: string;
  readonly ARTIFACT_SERVER_CONTENT_DOMAIN: string;
  readonly ARTIFACT_SERVER_CLOUDFLARE_ARTIFACTS_ACCOUNT_ID?: string;
  readonly ARTIFACT_SERVER_CLOUDFLARE_ARTIFACTS_NAMESPACE?: string;
  readonly ARTIFACT_SERVER_D1_DATABASE: D1Database;
  readonly ARTIFACT_SERVER_INSTALLATION_ID: string;
  readonly ARTIFACT_SERVER_OIDC_CLIENT_ID?: string;
  readonly ARTIFACT_SERVER_OIDC_CLIENT_SECRET?: string;
  readonly ARTIFACT_SERVER_OIDC_ISSUER?: string;
  readonly ARTIFACT_SERVER_OIDC_SCOPES?: string;
  readonly ARTIFACT_SERVER_ORIGIN: string;
  readonly ARTIFACT_SERVER_QUALIFICATION_MODE?: "enabled";
  readonly ARTIFACT_SERVER_R2_BUCKET: R2Bucket;
  readonly ARTIFACT_SERVER_REQUEST_LOG_SAMPLE_RATE?: string | number;
  readonly ARTIFACT_SERVER_WORKOS_API_KEY?: string;
  readonly ARTIFACT_SERVER_WORKOS_CLIENT_ID?: string;
  readonly ARTIFACT_SERVER_WORKOS_ISSUER?: string;
}

interface CloudflareRuntime {
  readonly app: ReturnType<typeof createHttpApp>;
  readonly applicationHostname: string;
  readonly contentDomain: string;
  readonly qualificationMode: boolean;
  cleanupStaging(): Promise<void>;
  drainGitHistory(): Promise<void>;
}

interface WorkerErrorResponse {
  readonly error: string;
  readonly message: string;
}

let runtimePromise: Promise<CloudflareRuntime> | null = null;

export default {
  async fetch(
    request: Request,
    environment: WorkerEnvironment,
    context: ExecutionContext,
  ): Promise<Response> {
    try {
      const runtime = await getRuntime(environment);
      const prepared = prepareRequest(request, runtime);
      if (prepared === null) {
        return jsonResponse(421, {
          error: "unrecognized_artifact_server_host",
          message: "This hostname is not assigned to this Artifact Server.",
        });
      }
      if (!["GET", "HEAD", "OPTIONS"].includes(prepared.method)) {
        context.waitUntil(runtime.drainGitHistory());
      }
      return runtime.app.fetch(prepared, environment, context);
    } catch (cause) {
      runtimePromise = null;
      console.error(JSON.stringify({
        error: "cloudflare_runtime_initialization_failed",
        message: cause instanceof Error ? cause.message : "Unknown initialization failure.",
      }));
      return jsonResponse(503, {
        error: "artifact_server_not_ready",
        message: "Artifact Server could not initialize its Cloudflare dependencies.",
      });
    }
  },
  scheduled(
    _controller: ScheduledController,
    environment: WorkerEnvironment,
    context: ExecutionContext,
  ): void {
    context.waitUntil(runScheduledCleanup(environment));
  },
};

async function runScheduledCleanup(
  environment: WorkerEnvironment,
): Promise<void> {
  const runtime = await getRuntime(environment);
  await Promise.all([runtime.cleanupStaging(), runtime.drainGitHistory()]);
}

function getRuntime(environment: WorkerEnvironment): Promise<CloudflareRuntime> {
  runtimePromise ??= createCloudflareRuntime(environment);
  return runtimePromise;
}

async function createCloudflareRuntime(
  environment: WorkerEnvironment,
): Promise<CloudflareRuntime> {
  validateEnvironment(environment);
  await migrateD1(
    environment.ARTIFACT_SERVER_D1_DATABASE,
    environment.ARTIFACT_SERVER_INSTALLATION_ID,
  );
  const repository = createD1ArtifactRepository(
    environment.ARTIFACT_SERVER_D1_DATABASE,
    environment.ARTIFACT_SERVER_INSTALLATION_ID,
  );
  const identityRepository = createD1IdentityRepository(
    environment.ARTIFACT_SERVER_D1_DATABASE,
  );
  const {blobs, staging} = createR2ObjectStorageAdapters(
    environment.ARTIFACT_SERVER_R2_BUCKET,
    environment.ARTIFACT_SERVER_INSTALLATION_ID,
  );
  const gitHistory = await initializeGitHistory(environment, repository, blobs);
  const oidcIdentityProvider = oidcAuthentication(environment);
  const hostedAuthentication = await workOsAuthentication(environment);
  const browserAccess = hostedAuthentication !== null
    ? privateTeamBrowserAccess(browserLoginKinds.workOs)
    : oidcIdentityProvider !== null
    ? privateTeamBrowserAccess(browserLoginKinds.oidc)
    : missingIdentityProvider();
  const applicationAdapters: Parameters<typeof createApplicationLayer>[0] = {
    apiToken: Redacted.make(environment.ARTIFACT_SERVER_API_TOKEN, {
      label: "cloudflare-api-token",
    }),
    blobs,
    bootstrapAdministratorEmail:
      environment.ARTIFACT_SERVER_BOOTSTRAP_ADMIN_EMAIL,
    clock: new SystemClock(),
    dispatches: repository,
    externalApiBearerVerifier: null,
    externalMcpBearerVerifier: null,
    externalMcpOAuthVerifier:
      hostedAuthentication?.externalMcpOAuthVerifier ?? null,
    ids: new SystemIdGenerator(),
    identityRepository,
    installationId: environment.ARTIFACT_SERVER_INSTALLATION_ID,
    gitHistory: gitHistory.capability,
    interactiveIdentityProvider: oidcIdentityProvider ??
      hostedAuthentication?.interactiveIdentityProvider ?? null,
    localBootstrapCredential: null,
    protectBootstrapAdministrator: false,
    repository,
    staging,
  };
  if (gitHistory.provider !== null) {
    Object.assign(applicationAdapters, {gitHistoryProvider: gitHistory.provider});
  }
  const applicationLayer = createApplicationLayer(applicationAdapters);
  const applicationRuntime: ApplicationRuntime = ManagedRuntime.make(
    Layer.mergeAll(applicationLayer, structuredLoggingLayer),
  );
  await applicationRuntime.context();
  const origin = new URL(environment.ARTIFACT_SERVER_ORIGIN);
  const appDependencies = {
    applicationRuntime,
    blobs,
    browserAccess,
    completedRequestLogSampleRate: requestLogSampleRate(environment),
    contentDomain: environment.ARTIFACT_SERVER_CONTENT_DOMAIN,
    gitHistory: gitHistory.capability,
    readiness: () => readiness(environment),
    trustedApplicationOrigin: origin.origin,
    webAssets: {
      fetch: async (assetPath: string, method: "GET" | "HEAD") => {
        const response = await environment.ASSETS.fetch(
          new Request(new URL(assetPath, origin), {method}),
        );
        return response.status === 404 ? null : response;
      },
    },
  };
  const app = createHttpApp(hostedAuthentication === null
    ? appDependencies
    : {
      ...appDependencies,
      mcpOAuthResource: hostedAuthentication.mcpOAuthResource,
    });
  return {
    app,
    applicationHostname: origin.hostname,
    cleanupStaging: async () => {
      const report = await applicationRuntime.runPromise(
        ExpiredStagingCleanupService.use((cleanup) =>
          cleanup.runPass({limit: 100})),
      );
      if (report.failed > 0) {
        throw new Error("One or more expired staging uploads could not be removed.");
      }
    },
    drainGitHistory: gitHistory.drain,
    contentDomain: environment.ARTIFACT_SERVER_CONTENT_DOMAIN,
    qualificationMode:
      environment.ARTIFACT_SERVER_QUALIFICATION_MODE === "enabled",
  };
}

async function initializeGitHistory(
  environment: WorkerEnvironment,
  repository: ReturnType<typeof createD1ArtifactRepository>,
  blobs: ReturnType<typeof createR2ObjectStorageAdapters>["blobs"],
): Promise<{
  readonly capability: GitHistoryCapabilityReader;
  readonly drain: () => Promise<void>;
  readonly provider: ArtifactsBindingGitHistoryProvider | null;
}> {
  if (environment.ARTIFACTS === undefined) {
    return {
      capability: {read: disabledGitHistoryCapability},
      drain: async () => undefined,
      provider: null,
    };
  }
  const accountId = requireEnvironmentValue(
    environment.ARTIFACT_SERVER_CLOUDFLARE_ARTIFACTS_ACCOUNT_ID,
  );
  const namespace = requireEnvironmentValue(
    environment.ARTIFACT_SERVER_CLOUDFLARE_ARTIFACTS_NAMESPACE,
  );
  const identity = {
    accountId,
    namespace,
    provider: "cloudflare-artifacts" as const,
  };
  const provider = new ArtifactsBindingGitHistoryProvider(environment.ARTIFACTS);
  const identityStore = new D1GitHistoryProviderIdentityStore(
    environment.ARTIFACT_SERVER_D1_DATABASE,
    environment.ARTIFACT_SERVER_INSTALLATION_ID,
  );
  const providerState = await Effect.runPromise(resolveGitHistoryProviderState({
    clock: new SystemClock(),
    identity,
    identityStore,
    providerHealth: {
      check: () => Effect.promise(async () => {
        const health = await provider.health();
        return health.healthy
          ? {state: "available" as const}
          : {
            reason: "provider_unavailable" as const,
            state: "degraded" as const,
          };
      }),
    },
  }));
  const capability: GitHistoryCapabilityReader = {
    read: () => ({
      limits: {
        fileCopyBytes: defaultGitHistoryFileCopyBytes,
        logicalCopiedBytes: 0,
        logicalReservedBytes: 0,
        storageBudgetBytes: null,
        versionCopyBytes: defaultGitHistoryVersionCopyBytes,
      },
      provider: "cloudflare-artifacts",
      providerState,
    }),
  };
  const worker = makeGitHistoryMirrorWorker({
    blobs,
    capability,
    installationId: environment.ARTIFACT_SERVER_INSTALLATION_ID,
    provider,
    store: repository,
  });
  const drainPasses = async (remaining: number): Promise<void> => {
    if (remaining === 0) return;
    const result = await Effect.runPromise(worker.runPass());
    if (
      result.outcome === "idle" ||
      result.outcome === "retry" ||
      result.outcome === "budget-limited"
    ) return;
    await drainPasses(remaining - 1);
  };
  let activeDrain: Promise<void> | null = null;
  const drain = (): Promise<void> => {
    activeDrain ??= drainPasses(8).finally(() => {
      activeDrain = null;
    });
    return activeDrain;
  };
  return {
    capability,
    drain,
    provider,
  };
}

function workOsValues(
  environment: WorkerEnvironment,
): readonly (string | undefined)[] {
  return [
    environment.ARTIFACT_SERVER_WORKOS_API_KEY,
    environment.ARTIFACT_SERVER_WORKOS_CLIENT_ID,
    environment.ARTIFACT_SERVER_WORKOS_ISSUER,
  ];
}

function oidcValues(
  environment: WorkerEnvironment,
): readonly (string | undefined)[] {
  return [
    environment.ARTIFACT_SERVER_OIDC_CLIENT_ID,
    environment.ARTIFACT_SERVER_OIDC_CLIENT_SECRET,
    environment.ARTIFACT_SERVER_OIDC_ISSUER,
    environment.ARTIFACT_SERVER_OIDC_SCOPES,
  ];
}

async function workOsAuthentication(
  environment: WorkerEnvironment,
) {
  const values = workOsValues(environment);
  const configured = values.filter((value) => value !== undefined).length;
  if (configured === 0) return null;
  if (configured !== values.length) {
    throw new Error(
      "Hosted WorkOS authentication requires an API key, client ID, and issuer.",
    );
  }
  return createWorkOsHostedAuthentication({
    apiKey: Redacted.make(requireEnvironmentValue(
      environment.ARTIFACT_SERVER_WORKOS_API_KEY,
    )),
    applicationOrigin: environment.ARTIFACT_SERVER_ORIGIN,
    clientId: requireEnvironmentValue(
      environment.ARTIFACT_SERVER_WORKOS_CLIENT_ID,
    ),
    issuer: requireEnvironmentValue(
      environment.ARTIFACT_SERVER_WORKOS_ISSUER,
    ),
  });
}

function oidcAuthentication(
  environment: WorkerEnvironment,
): OidcIdentityProvider | null {
  if (oidcValues(environment).every((value) => value === undefined)) return null;
  const required = [
    environment.ARTIFACT_SERVER_OIDC_CLIENT_ID,
    environment.ARTIFACT_SERVER_OIDC_ISSUER,
  ];
  if (required.some((value) => value === undefined)) {
    throw new Error(
      "Generic OIDC authentication requires an issuer and client ID.",
    );
  }
  const secret = environment.ARTIFACT_SERVER_OIDC_CLIENT_SECRET;
  return createOidcIdentityProvider({
    applicationOrigin: environment.ARTIFACT_SERVER_ORIGIN,
    clientId: requireEnvironmentValue(
      environment.ARTIFACT_SERVER_OIDC_CLIENT_ID,
    ),
    clientSecret: secret === undefined ? null : Redacted.make(secret),
    issuer: requireEnvironmentValue(environment.ARTIFACT_SERVER_OIDC_ISSUER),
    scopes: environment.ARTIFACT_SERVER_OIDC_SCOPES ?? defaultOidcScopes,
  });
}

function requireEnvironmentValue(value: string | undefined): string {
  if (value === undefined) {
    throw new Error("A required hosted authentication value is missing.");
  }
  return value;
}

function missingIdentityProvider(): never {
  throw new Error(
    "A private-team server requires exactly one OIDC or WorkOS browser-login provider.",
  );
}

function prepareRequest(
  request: Request,
  runtime: CloudflareRuntime,
): Request | null {
  const url = new URL(request.url);
  if (
    url.hostname === runtime.applicationHostname ||
    url.hostname.endsWith(`.${runtime.contentDomain}`)
  ) return request;
  if (
    runtime.qualificationMode && (
      url.hostname.endsWith(".workers.dev") ||
      url.hostname === "localhost" ||
      url.hostname === "127.0.0.1" ||
      url.hostname === "[::1]"
    )
  ) {
    url.hostname = runtime.applicationHostname;
    return new Request(url, request);
  }
  return null;
}

function validateEnvironment(environment: WorkerEnvironment): void {
  if (environment.ARTIFACT_SERVER_API_TOKEN.length < 32) {
    throw new Error("ARTIFACT_SERVER_API_TOKEN must contain at least 32 characters.");
  }
  if (environment.ARTIFACT_SERVER_INSTALLATION_ID.trim() === "") {
    throw new Error("ARTIFACT_SERVER_INSTALLATION_ID is required.");
  }
  const origin = new URL(environment.ARTIFACT_SERVER_ORIGIN);
  if (origin.protocol !== "https:" || origin.pathname !== "/") {
    throw new Error("ARTIFACT_SERVER_ORIGIN must be an HTTPS origin.");
  }
  if (environment.ARTIFACT_SERVER_CONTENT_DOMAIN.trim() === "") {
    throw new Error("ARTIFACT_SERVER_CONTENT_DOMAIN is required.");
  }
  if (
    workOsValues(environment).some((value) => value !== undefined) &&
    oidcValues(environment).some((value) => value !== undefined)
  ) {
    throw new Error(
      "One installation has one browser-login provider: configure ARTIFACT_SERVER_WORKOS_* or ARTIFACT_SERVER_OIDC_*, not both.",
    );
  }
}

async function readiness(environment: WorkerEnvironment): Promise<ReadinessReport> {
  const [database, migrations, objectStorage] = await Promise.all([
    readinessComponent(async () => {
      await environment.ARTIFACT_SERVER_D1_DATABASE.prepare("SELECT 1").first();
    }),
    readinessComponent(async () => {
      const current = await environment.ARTIFACT_SERVER_D1_DATABASE.prepare(`
        SELECT version FROM artifact_server_schema WHERE component = 'runtime'
      `).first<number>("version");
      if (current !== requiredD1SchemaVersion) {
        throw new Error("The D1 schema is not current.");
      }
    }),
    readinessComponent(async () => {
      await environment.ARTIFACT_SERVER_R2_BUCKET.list({limit: 1});
    }),
  ]);
  return {
    components: {
      configuration: readyComponent,
      database,
      migrations,
      objectStorage,
    },
    status: database.status === "ready" && migrations.status === "ready" &&
      objectStorage.status === "ready"
      ? "ready"
      : "not_ready",
  };
}

async function readinessComponent(
  check: () => Promise<void>,
): Promise<ReadinessComponent> {
  const startedAt = performance.now();
  try {
    await check();
    return {
      latencyMilliseconds: performance.now() - startedAt,
      status: "ready",
    };
  } catch {
    return {
      latencyMilliseconds: performance.now() - startedAt,
      status: "unavailable",
    };
  }
}

function requestLogSampleRate(environment: WorkerEnvironment): number {
  const configured = Number(
    environment.ARTIFACT_SERVER_REQUEST_LOG_SAMPLE_RATE ??
      defaultCompletedRequestLogSampleRate,
  );
  return Number.isFinite(configured)
    ? Math.min(1, Math.max(0, configured))
    : defaultCompletedRequestLogSampleRate;
}

const readyComponent = {
  latencyMilliseconds: 0,
  status: "ready" as const,
};

function jsonResponse(status: number, body: WorkerErrorResponse): Response {
  return Response.json(body, {
    status,
    headers: {"cache-control": "private, no-store"},
  });
}
