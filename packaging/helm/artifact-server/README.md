# Artifact Server Helm chart

This chart runs Artifact Server on Kubernetes. It installs the application only.
Postgres, object storage, DNS, TLS certificates, and an Ingress or Gateway must
already exist.

## Supported versions

- Helm 4.2.x is the release baseline.
- Kubernetes 1.34, 1.35, and 1.36 are supported by this chart version.
- The chart uses stable chart API `v2`. Chart API `v3` is still experimental.

The chart may render with other versions, but that is not a support claim.

## Required setup

Create one namespace Secret with the API token and Postgres URL. Add the S3 keys
only when the deployment does not use workload identity.

```sh
kubectl --namespace artifact-server create secret generic artifact-server-runtime \
  --from-file=api-token=/secure/artifact-server/api-token \
  --from-file=database-url=/secure/artifact-server/database-url \
  --from-file=s3-access-key-id=/secure/artifact-server/s3-access-key-id \
  --from-file=s3-secret-access-key=/secure/artifact-server/s3-secret-access-key
```

Keep credentials out of Helm values. Set `secret.name` and the key names instead.
If an external secret manager changes the Secret, update
`secret.rolloutChecksum` to its non-secret version or checksum so the Deployment
restarts in a controlled rollout.

Create a values file containing the installation identity, origins, bucket,
region, released image repository and digest, and Secret reference:

```yaml
image:
  repository: ghcr.io/artifactserver/artifact-server
  digest: sha256:replace_with_release_digest

configuration:
  installationId: team-example
  bootstrapAdministratorEmail: admin@example.com
  applicationOrigin: https://artifacts.example.com
  contentDomain: content.example.net
  postgresConnectionBudget: 22
  s3:
    bucket: artifact-server-team-example
    region: us-east-1

secret:
  name: artifact-server-runtime
  rolloutChecksum: secret-version-1
  keys:
    s3AccessKeyId: s3-access-key-id
    s3SecretAccessKey: s3-secret-access-key
```

Install with Helm 4:

```sh
helm upgrade --install artifact-server ./packaging/helm/artifact-server \
  --namespace artifact-server \
  --create-namespace \
  --values artifact-server-values.yaml \
  --rollback-on-failure \
  --wait

helm test artifact-server --namespace artifact-server --logs
```

The pre-install and pre-upgrade migration Job must succeed before the
Deployment changes. Successful migration Jobs are removed. Failed Jobs remain
for inspection and are removed before the next Helm attempt.

The chart also creates a `CronJob` that runs one bounded expired-staging cleanup
pass every 15 minutes. It uses the same image, Secret, service account, workload
identity, Postgres database, and object-store configuration as the application.
Serving Pods set the cleanup schedule to `external`, so they do not run a
second background loop. Configure or disable this trigger under `cleanup` in
the values file. Disabling it is safe only when an operator runs the same
`artifactserver maintenance cleanup-staging --once` command elsewhere.

## Routing

The Service is private `ClusterIP`. Choose one routing path:

- Enable the included Ingress and provide application and wildcard-content TLS
  Secret names.
- Leave it disabled and point an existing Ingress or Gateway at the Service.
- On a managed cluster, leave it disabled and use the provider load balancer or
  edge configuration.

Both `artifacts.example.com` and `*.content.example.net` route to the same
Service. An enabled Ingress requires the application origin to have no path or
explicit port. The two hosts remain separate registrable domains for browser
isolation.

## Workload identity

Static S3 keys are optional. For a cloud workload identity, leave both S3 key
names empty, add the provider annotations under `serviceAccount.annotations`,
and set `serviceAccount.automountServiceAccountToken` only when that identity
mechanism requires the projected Kubernetes token.

## NetworkPolicy

NetworkPolicy is disabled by default. Standard Kubernetes policies cannot allow
external services by DNS name, so the chart cannot safely invent rules for a
managed database, bucket, WorkOS, or an OTLP collector. Operators can enable the
template and provide exact native `ingress` and `egress` rules for their CNI and
network. An empty enabled rule set is default-deny.

## Scaling and resources

The default is two replicas with a PodDisruptionBudget and preferred spreading
across nodes. Each serving replica has a bounded ten-connection Postgres pool;
the migration Job and cleanup CronJob each require one additional connection.
The chart rejects a replica count that exceeds
`configuration.postgresConnectionBudget`. Horizontal autoscaling is
intentionally not included until measured capacity defines safe thresholds.

The default request is `100m` CPU and `256Mi` memory. Treat it as a starting
request, observe the workload, and adjust `resources`. The chart does not set a
CPU limit by default.

## Uninstall and durable state

`helm uninstall` removes Artifact Server workloads. It does not remove the
external Secret, Postgres database, bucket, DNS, or TLS certificates. Back up
Postgres and the complete object prefix as one installation before destructive
provider operations.
