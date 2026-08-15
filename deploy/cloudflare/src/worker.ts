import {Layer, ManagedRuntime, Redacted} from "effect";

import type {ApplicationRuntime} from "../../../src/application/application-runtime.js";
import {SystemClock, SystemIdGenerator} from "../../../src/core/system.js";
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

interface WorkerEnvironment {
  readonly ARTIFACT_SERVER_API_TOKEN: string;
  readonly ARTIFACT_SERVER_BOOTSTRAP_ADMIN_EMAIL: string;
  readonly ARTIFACT_SERVER_CONTENT_DOMAIN: string;
  readonly ARTIFACT_SERVER_D1_DATABASE: D1Database;
  readonly ARTIFACT_SERVER_INSTALLATION_ID: string;
  readonly ARTIFACT_SERVER_ORIGIN: string;
  readonly ARTIFACT_SERVER_QUALIFICATION_MODE?: "enabled";
  readonly ARTIFACT_SERVER_R2_BUCKET: R2Bucket;
  readonly ARTIFACT_SERVER_REQUEST_LOG_SAMPLE_RATE?: string | number;
}

interface CloudflareRuntime {
  readonly app: ReturnType<typeof createHttpApp>;
  readonly applicationHostname: string;
  readonly contentDomain: string;
  readonly qualificationMode: boolean;
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
};

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
  const applicationLayer = createApplicationLayer({
    apiToken: Redacted.make(environment.ARTIFACT_SERVER_API_TOKEN, {
      label: "cloudflare-api-token",
    }),
    blobs,
    bootstrapAdministratorEmail:
      environment.ARTIFACT_SERVER_BOOTSTRAP_ADMIN_EMAIL,
    clock: new SystemClock(),
    externalApiBearerVerifier: null,
    externalMcpBearerVerifier: null,
    ids: new SystemIdGenerator(),
    identityRepository,
    installationId: environment.ARTIFACT_SERVER_INSTALLATION_ID,
    interactiveIdentityProvider: null,
    localBootstrapCredential: null,
    repository,
    staging,
  });
  const applicationRuntime: ApplicationRuntime = ManagedRuntime.make(
    Layer.mergeAll(applicationLayer, structuredLoggingLayer),
  );
  await applicationRuntime.context();
  const origin = new URL(environment.ARTIFACT_SERVER_ORIGIN);
  const app = createHttpApp({
    applicationRuntime,
    blobs,
    completedRequestLogSampleRate: requestLogSampleRate(environment),
    contentDomain: environment.ARTIFACT_SERVER_CONTENT_DOMAIN,
    readiness: () => readiness(environment),
    trustedApplicationOrigin: origin.origin,
  });
  return {
    app,
    applicationHostname: origin.hostname,
    contentDomain: environment.ARTIFACT_SERVER_CONTENT_DOMAIN,
    qualificationMode:
      environment.ARTIFACT_SERVER_QUALIFICATION_MODE === "enabled",
  };
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
