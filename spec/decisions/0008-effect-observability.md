# Decision 0008: Use one Effect-native observability boundary

Status: accepted for the external-storage-runtime foundation

## Decision

Artifact Server uses Effect's tracing, metrics, and structured logging at the
application boundary. HTTP creates one server span and attaches one
server-issued request ID to that span, its structured log, and its nested
application Effect spans. MCP carries the same request ID into its authentication
and tool operations. Named `Effect.fn` application operations remain child
spans. Low-cardinality HTTP metrics record request count, duration, method,
matched route, status class, and protocol.

Deployed processes count and trace every request. They emit a sampled JSON
completion record for normal requests and an unsampled record for server errors
and requests that take at least one second. This prevents access logs from
becoming a scaling bottleneck while retaining complete metrics and trace
sampling control at the collector. Unexpected adapter failures are always
logged. Operators may additionally export the same Effect logs, metrics, and
spans through OTLP by setting a standard OTLP endpoint. The OTLP exporter is an
adapter selected by the composition root; application services do not depend on
a telemetry vendor.

External-storage deployments expose separate process-health and dependency-readiness
routes. Process health proves only that the process can answer HTTP. Readiness
reports already-validated configuration and migrations, checks Postgres and
object storage at request time, and returns stable,
machine-readable component states. A failed readiness check returns 503 without
stopping a live process.

## Safe fields

Telemetry may include:

- request ID, protocol, method, matched route, status, and duration;
- stable operation and typed failure tags;
- deployment mode and installation identifier as resource attributes; and
- provider kind, component name, and readiness result.

Telemetry never records raw request bodies, response bodies, query strings,
cookies, authorization headers, bearer credentials, upload URLs, content
tokens, bootstrap tokens, or provider connection strings. Request IDs supplied
by callers are not trusted or reused; the server generates one for every
request.

## Cardinality boundary

Metrics and sampled request logs use registered route patterns such as
`/api/v1/artifacts/:artifactId`, never concrete artifact IDs or unmatched raw
paths. Status is grouped by exact HTTP status and status class. Domain IDs may
appear only in an explicitly designed diagnostic or audit record, not as metric
attributes.

## Adapter reuse audit

The existing application runtime already owns Effect layers and resources, and
the existing `Effect.fn` operations already provide named trace boundaries.
This decision extends that runtime rather than introducing a second telemetry
service. Hono remains the HTTP adapter. Postgres and S3 remain concrete outbound
adapters and expose narrow readiness functions to the composition root.

## Deliberate exclusions

This phase does not:

- select a hosted observability vendor;
- make OTLP export required for local or self-hosted operation;
- expose unauthenticated Prometheus metrics;
- log successful request or artifact payloads;
- add artifact IDs, user IDs, tags, filenames, or tokens to metric labels; or
- claim managed-provider, Kubernetes, or cross-region capacity.

## Verification

The boundary is accepted when:

- every HTTP response carries a valid server-generated request ID;
- request metrics use bounded route patterns and record normal and failure
  outcomes;
- JSON logs contain the request ID and safe operational fields but no supplied
  bearer credential or query string;
- external-storage readiness reports configuration, migrations, Postgres, and object
  storage separately and changes
  to 503 when either dependency cannot be reached; and
- correctness, lint, type, build, smoke, bounded performance, and external-storage-runtime
  gates continue to pass.
