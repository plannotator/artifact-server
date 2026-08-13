import {Duration, Effect, Layer, Logger, Metric} from "effect";
import {FetchHttpClient} from "effect/unstable/http";
import {
  Otlp,
  OtlpSerialization,
} from "effect/unstable/observability";

const requestCount = Metric.counter("artifact_server_http_requests_total", {
  description: "Completed Artifact Server HTTP requests.",
  incremental: true,
});
const requestDuration = Metric.timer("artifact_server_http_request_duration", {
  description: "Artifact Server HTTP request duration in milliseconds.",
  boundaries: [1, 2, 5, 10, 25, 50, 100, 250, 500, 1_000, 2_500, 5_000, 10_000],
});
/** Default fraction of normal completed requests written to process logs. */
export const defaultCompletedRequestLogSampleRate = 0.01;
const slowRequestThresholdMilliseconds = 1_000;

/** Bounded attributes recorded for one completed HTTP request. */
export interface HttpRequestObservation {
  readonly completedRequestLogSampleRate: number;
  readonly durationMilliseconds: number;
  readonly method: string;
  readonly protocol: "http" | "mcp";
  readonly requestId: string;
  readonly route: string;
  readonly status: number;
}

/** Resource identity shared by structured logs, metrics, and exported spans. */
export interface ObservabilityResource {
  readonly deploymentMode: "local" | "shared";
  readonly installationId: string;
  readonly serviceVersion: string;
}

/** Record one safe, low-cardinality HTTP request observation in Effect. */
export function observeHttpRequest(
  observation: HttpRequestObservation,
): Effect.Effect<void> {
  const attributes = {
    http_method: observation.method,
    http_route: observation.route,
    http_status: String(observation.status),
    http_status_class: `${Math.floor(observation.status / 100)}xx`,
    protocol: observation.protocol,
  };
  return Effect.gen(function*() {
    yield* Metric.update(Metric.withAttributes(requestCount, attributes), 1);
    yield* Metric.update(
      Metric.withAttributes(requestDuration, attributes),
      Duration.millis(observation.durationMilliseconds),
    );
    if (shouldLogCompletedRequest(observation)) {
      yield* Effect.logInfo("http.request.completed").pipe(
        Effect.annotateLogs({
          ...attributes,
          duration_ms: observation.durationMilliseconds,
          request_id: observation.requestId,
        }),
      );
    }
  });
}

function shouldLogCompletedRequest(
  observation: HttpRequestObservation,
): boolean {
  if (
    observation.status >= 500 ||
    observation.durationMilliseconds >= slowRequestThresholdMilliseconds
  ) return true;
  const sampleRate = Math.min(
    1,
    Math.max(
      0,
      observation.completedRequestLogSampleRate,
    ),
  );
  if (sampleRate === 0) return false;
  if (sampleRate === 1) return true;
  const requestSample = Number.parseInt(
    observation.requestId.slice(0, 8),
    16,
  ) / 0x1_0000_0000;
  return Number.isFinite(requestSample) && requestSample < sampleRate;
}

/** Effect layer that writes structured JSON logs to standard output. */
export const structuredLoggingLayer: Layer.Layer<never> = Logger.layer([
  Logger.consoleJson,
]);

/** Effect layer that deliberately suppresses logs in in-process test runtimes. */
export const silentLoggingLayer: Layer.Layer<never> = Logger.layer([]);

/** Optional OTLP exporter layer controlled by the standard OpenTelemetry environment. */
export function otlpLayer(
  resource: ObservabilityResource,
): Layer.Layer<never> {
  const resourceConfiguration = {
    attributes: {
      "deployment.mode": resource.deploymentMode,
      "service.instance.id": resource.installationId,
    },
    serviceName: "artifact-server",
    serviceVersion: resource.serviceVersion,
  };
  return Otlp.layerFromConfig({
    loggerMergeWithExisting: true,
    resource: resourceConfiguration,
  }).pipe(
    Layer.provide(OtlpSerialization.layerJson),
    Layer.provide(FetchHttpClient.layer),
  );
}
