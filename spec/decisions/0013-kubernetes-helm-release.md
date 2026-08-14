# ADR 0013: Helm packages one stateless Kubernetes workload

Status: accepted

## Decision

Artifact Server ships one application-only Helm chart for Kubernetes. The chart
runs the existing external-storage runtime and does not install Postgres, object
storage, an ingress controller, DNS, certificates, a metrics server, or a
secret-management system.

The first chart is a stable chart API `v2` package. Helm 4.2 is the development
and release baseline. Chart API `v3` remains experimental and is not used. The
supported Kubernetes window is the three upstream-maintained minors at the time
of this decision: 1.34, 1.35, and 1.36. Static rendering covers all three;
release behavior runs in a pinned Kubernetes 1.36 kind cluster. A later release
must move this window deliberately rather than silently claiming forward
compatibility.

The default workload has two replicas, a zero-unavailable rolling strategy, a
PodDisruptionBudget with `maxUnavailable: 1`, preferred node spreading, HTTP
startup/liveness/readiness probes, a finite drain period, resource requests,
and the Kubernetes Restricted security posture. Pods are non-root, use a
read-only root filesystem and memory-backed `/tmp`, drop every Linux capability,
and do not mount a service-account token by default. Workload identity can
explicitly enable the token and add service-account annotations.

One existing Secret supplies the required API token and Postgres URL and may
also supply S3, local-bootstrap, and WorkOS credentials. Secret keys are mounted
as read-only files; durable credentials are not accepted as chart values. A
non-secret `secret.rolloutChecksum` value gives external secret managers a
portable way to request a controlled rollout when secret contents change.

The chart runs `artifactserver migrate apply` as a blocking Helm pre-install and
pre-upgrade Job. The same released image performs migration and serving. The Job
has a finite deadline and no retry storm. Serving pods continue to validate the
schema and never apply migrations or fall back to local storage.

The Service is private `ClusterIP`. Ingress is disabled by default. When enabled,
one standard `networking.k8s.io/v1` Ingress routes the application host and the
wildcard content host to the same Service and references operator-supplied TLS
Secrets. A cluster that uses Gateway API or a managed provider edge leaves this
template disabled and routes the Service itself.

NetworkPolicy is also disabled by default. Standard Kubernetes NetworkPolicy
cannot express DNS-name egress rules for managed Postgres, S3, R2, WorkOS, or an
OTLP collector. Enabling a generic default-deny policy without exact cluster
addresses would make the package look secure while breaking or accidentally
opening required traffic. Operators may enable the template and provide native
ingress and egress rules for their CNI and network topology. Provider-specific
installers may generate those rules when they own the network addresses.

Horizontal autoscaling is not included yet. Two replicas are the default and
manual replica changes are supported. Each server uses a bounded ten-connection
Postgres pool and the migration Job uses one connection. The chart rejects a
replica count that exceeds its declared Postgres connection budget. HPA
thresholds wait for measured service capacity and an automatic way to preserve
that budget.

## Why

Kubernetes should change process placement, rollout, identity, and routing—not
Artifact Server's product or storage contracts. Reusing the external-storage
composition prevents a Kubernetes-only code path and keeps every pod disposable.

Chart API `v2` works with Helm 4 and retained Helm 3 installations, while chart
API `v3` would add an experimental release dependency. Supporting only currently
maintained Kubernetes minors keeps the compatibility claim narrow enough to
prove.

Existing Secrets avoid storing production credentials in Helm release values.
An explicit rollout checksum is predictable across External Secrets, Sealed
Secrets, cloud secret CSI drivers, and ordinary Secrets; using Helm `lookup` to
hash live secret bytes would make rendering nondeterministic and expose secret
material to the Helm client.

An application-only chart prevents Artifact Server from becoming the operator
for databases, buckets, ingress controllers, and certificate authorities that
customers already run differently in every cluster.

## Verification

The static gate uses pinned Helm 4.2 tooling to lint, package, and render the
chart for Kubernetes 1.34, 1.35, and 1.36. It fails on mutable release images,
ordinary-value credentials, incomplete S3 credentials, invalid drain timing,
and incomplete ingress TLS configuration.

The release gate creates a pinned Kubernetes 1.36 kind cluster with two worker
nodes and independently managed Postgres and S3-compatible providers. It loads
the exact production image, proves a failed migration blocks installation,
installs two replicas, runs the chart test, publishes through the Service,
rolls every pod, removes pods, causes and recovers from a provider outage,
drains a worker under the disruption budget, uninstalls and reinstalls the
chart, and compares stable IDs, records, pointers, manifests, and bytes.

The test records Helm, Kubernetes, kind, image revision, startup, rollout,
replacement, and bounded read measurements. The numbers are regression
baselines, not production capacity claims.
