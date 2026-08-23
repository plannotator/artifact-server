import {
  Effect,
  Redacted,
  Result,
  Schema,
  type Redacted as RedactedType,
} from "effect";

import type {GitHistoryProviderIdentity} from
  "./git-history-provider-identity.js";
import type {
  GitHistoryProviderHealth,
  GitHistoryProviderHealthProbe,
} from "./git-history-provider-health.js";

const cloudflareApiOrigin = new URL("https://api.cloudflare.com");
const maximumHealthResponseBytes = 16 * 1024;
const healthCheckTimeout = "3 seconds";

const cloudflareEnvelope = Schema.Struct({success: Schema.Boolean});
interface CloudflareEnvelope extends Schema.Schema.Type<
  typeof cloudflareEnvelope
> {}

class CloudflareArtifactsHealthRequestFailure extends
  Schema.TaggedError<CloudflareArtifactsHealthRequestFailure>()(
    "CloudflareArtifactsHealthRequestFailure",
    {
      cause: Schema.Defect(),
      operation: Schema.Literal("request"),
    },
  ) {}

/** Construction inputs for the namespace-scoped Cloudflare REST health probe. */
export interface CloudflareArtifactsRestHealthProbeConfig {
  /** Optional loopback origin used by real-boundary integration tests. */
  readonly apiOrigin?: URL;
  readonly apiToken: RedactedType.Redacted;
  readonly identity: GitHistoryProviderIdentity;
}

/** Read-only Cloudflare Artifacts REST adapter used for provider availability. */
export class CloudflareArtifactsRestHealthProbe implements
  GitHistoryProviderHealthProbe {
  readonly #apiToken: RedactedType.Redacted;
  readonly #endpoint: URL;

  constructor(config: CloudflareArtifactsRestHealthProbeConfig) {
    const origin = config.apiOrigin ?? cloudflareApiOrigin;
    assertSafeApiOrigin(origin);
    this.#apiToken = config.apiToken;
    this.#endpoint = namespaceEndpoint(origin, config.identity);
  }

  /** Check access to exactly the configured namespace without listing repositories. */
  check(): Effect.Effect<GitHistoryProviderHealth> {
    return checkCloudflareArtifactsNamespace(this.#endpoint, this.#apiToken);
  }
}

const checkCloudflareArtifactsNamespace = Effect.fn(
  "GitHistory.CloudflareArtifactsRestHealthProbe.check",
)(function*(
  endpoint: URL,
  apiToken: RedactedType.Redacted,
): Effect.fn.Return<GitHistoryProviderHealth> {
  const health = yield* Effect.tryPromise({
    try: async (signal) => {
      const response = await fetch(endpoint, {
        headers: {
          Accept: "application/json",
          Authorization: `Bearer ${Redacted.value(apiToken)}`,
        },
        method: "GET",
        redirect: "error",
        signal,
      });
      const statusHealth = healthFromStatus(response.status);
      if (statusHealth !== null) return statusHealth;
      try {
        const payload = await readBoundedCloudflareEnvelope(response, signal);
        return payload.success
          ? {state: "available" as const}
          : {
            reason: "invalid_response" as const,
            state: "degraded" as const,
          };
      } catch (cause) {
        if (signal.aborted) throw cause;
        return {
          reason: "invalid_response" as const,
          state: "degraded" as const,
        };
      }
    },
    catch: (cause) => new CloudflareArtifactsHealthRequestFailure({
      cause,
      operation: "request",
    }),
  }).pipe(
    Effect.timeoutOrElse({
      duration: healthCheckTimeout,
      orElse: () => Effect.fail(new CloudflareArtifactsHealthRequestFailure({
        cause: new Error("Cloudflare Artifacts health check timed out."),
        operation: "request",
      })),
    }),
    Effect.result,
  );
  if (Result.isFailure(health)) {
    return {reason: "transport_failure", state: "degraded"};
  }
  return health.success;
});

function healthFromStatus(status: number): GitHistoryProviderHealth | null {
  if (status >= 200 && status < 300) return null;
  if (status === 401 || status === 403) {
    return {reason: "access_rejected", state: "misconfigured"};
  }
  if (status === 404) {
    return {reason: "namespace_missing", state: "misconfigured"};
  }
  if (status === 408 || status === 429) {
    return {
      reason: status === 429 ? "rate_limited" : "provider_unavailable",
      state: "degraded",
    };
  }
  if (status >= 400 && status < 500) {
    return {reason: "access_rejected", state: "misconfigured"};
  }
  return {reason: "provider_unavailable", state: "degraded"};
}

function namespaceEndpoint(
  origin: URL,
  identity: GitHistoryProviderIdentity,
): URL {
  return new URL(
    `/client/v4/accounts/${encodeURIComponent(identity.accountId)}` +
      `/artifacts/namespaces/${encodeURIComponent(identity.namespace)}`,
    origin,
  );
}

function assertSafeApiOrigin(origin: URL): void {
  if (origin.username !== "" || origin.password !== "") {
    throw new Error("The Cloudflare API origin cannot contain credentials.");
  }
  if (origin.origin === cloudflareApiOrigin.origin) return;
  const loopback = origin.hostname === "127.0.0.1" ||
    origin.hostname === "[::1]";
  if (!loopback) {
    throw new Error(
      "A non-Cloudflare Artifacts health origin must be exact loopback.",
    );
  }
}

async function readBoundedCloudflareEnvelope(
  response: Response,
  signal: AbortSignal,
): Promise<CloudflareEnvelope> {
  const reader = response.body?.getReader();
  if (reader === undefined) throw new Error("The health response body is absent.");
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  const cancel = (): void => {
    void reader.cancel();
  };
  signal.addEventListener("abort", cancel, {once: true});
  try {
    while (true) {
      // This loop is bounded by the provider response body, byte limit, and
      // enclosing request deadline.
      // eslint-disable-next-line no-await-in-loop
      const next = await reader.read();
      if (next.done) break;
      totalBytes += next.value.byteLength;
      if (totalBytes > maximumHealthResponseBytes) {
        // Sequential cancellation terminates the bounded stream before failure.
        // eslint-disable-next-line no-await-in-loop
        await reader.cancel();
        throw new Error("The health response exceeded its byte limit.");
      }
      chunks.push(next.value);
    }
  } finally {
    signal.removeEventListener("abort", cancel);
    reader.releaseLock();
  }
  signal.throwIfAborted();
  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  const decoded: unknown = JSON.parse(new TextDecoder().decode(bytes));
  return Schema.decodeUnknownSync(cloudflareEnvelope)(decoded);
}
