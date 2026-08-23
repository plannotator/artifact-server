# AWS deployment

This Pulumi project creates the default AWS Artifact Server stack. It uses ECS
Fargate for the application, RDS PostgreSQL for records, S3 for artifact files,
Secrets Manager for application credentials, an Application Load Balancer for
HTTPS, CloudFront in front of the load balancer for public ingress, Route 53
for DNS, and CloudWatch for logs.

For public ingress, CloudFront serves both the application host and the
wildcard content host. Its cache policy honors the application's `Cache-Control`
headers and caches nothing without origin instruction, so `private, no-store`
management and API responses are never cached. The cache key includes the host,
the query string, and the `Authorization` header, and the managed
`Managed-AllViewer` origin request policy forwards every viewer header, cookie,
and query string to the application. The origin read timeout is 60 seconds
because the agent long-poll route holds requests for up to 25 seconds. The
CloudFront viewer certificate is a separate DNS-validated ACM certificate that
this project creates in `us-east-1`, covering both names; the regional load
balancer certificates are unchanged. The load balancer stays internet-facing as
the CloudFront origin, but its security group accepts HTTPS only from the AWS
managed CloudFront origin-facing prefix list, and both Route 53 aliases point
at the distribution.

It does not create Kubernetes or EKS. A team with an existing EKS cluster uses
the application-only Helm chart in `packaging/helm/artifact-server` instead.

## Before deployment

You need:

- AWS credentials with permission to create the resources listed above;
- Node.js and pnpm versions from the repository root `package.json`;
- Pulumi CLI 3.257 or newer;
- an existing Pulumi state backend or Pulumi Cloud account;
- an existing Pulumi secrets provider;
- two Route 53 zones, one for the application domain and one for the separate
  content domain; and
- an Artifact Server OCI image pinned by SHA-256 digest with an ARM64 image.

The stack never creates the storage holding its own Pulumi state.

## Configure and preview

From the repository root:

```sh
pnpm install --frozen-lockfile
cd deploy/pulumi/aws
pulumi login s3://replace-with-existing-pulumi-state/artifact-server
pulumi stack init production \
  --secrets-provider 'awskms://alias/artifact-server?region=us-east-1'
cp Pulumi.production.example.yaml Pulumi.production.yaml
```

Replace every example value. The `stateBackendUrl`, `secretsProvider`, and
`stackName` values record the native Pulumi choices and must match the active
backend and stack. Set `aws:region` to the same value as
`artifact-server-aws:region`.

Run the read-only plan:

```sh
pulumi preview --stack production
```

The program rejects unsafe configuration before defining resources. Preview
must show no generated credential in resource inputs or outputs.

## Deploy

```sh
pulumi up --stack production
pulumi stack output deployment --json
```

Each Fargate task applies compatible database migrations under the shared
Postgres advisory lock before it opens the server. The ECS deployment circuit
breaker rolls back tasks that never become ready.

AWS tasks verify the RDS server certificate with Amazon's global RDS CA bundle.
The release image pins the exact bundle bytes, and the AWS task enables that
bundle through `NODE_EXTRA_CA_CERTS`. Database URLs require `verify-full`, so a
connection with an untrusted certificate or wrong hostname fails closed.

The output is the shared, secret-free deployment record. Application secrets
remain in Secrets Manager. ECS injects them into the process without storing
their values in the task definition or stack outputs. The Fargate task receives
temporary AWS credentials through its task role and can use only this
installation's S3 prefix.

EventBridge starts one separate Fargate maintenance task every 15 minutes. It
runs `artifactserver maintenance cleanup-staging --once` with the same task
role, private subnets, security group, database Secret, and S3 prefix as the
application. The task role can delete only named staging objects inside that
installation prefix. Serving tasks disable their internal cleanup loop, so the
scheduled task is the only trigger in this deployment.

## Network choices

Without `existingNetwork`, the stack creates:

- two public load-balancer subnets;
- two private application subnets;
- two isolated database subnets;
- one NAT gateway outside production and two in production; and
- security groups that allow only HTTPS to the load balancer (from the
  CloudFront origin-facing prefix list when ingress is public), load-balancer
  traffic to the application, and application traffic to PostgreSQL.

To use an existing VPC, set all of these values:

```yaml
artifact-server-aws:existingNetwork:
  vpcId: vpc-replace
  loadBalancerSubnetIds: [subnet-lb-a, subnet-lb-b]
  applicationSubnetIds: [subnet-app-a, subnet-app-b]
  databaseSubnetIds: [subnet-db-a, subnet-db-b]
```

The supplied application subnets must already have outbound access to the OCI
registry, S3, Secrets Manager, WorkOS when enabled, and the telemetry endpoint
when configured. Database subnets must not be publicly routed. The project
checks that every supplied subnet belongs to the VPC and that each tier spans
at least two availability zones before it defines resources.

For private ingress, set `ingress: private` and `tlsCertificateArn` to an
existing ACM certificate covering the application name and wildcard content
name. Private ingress creates no CloudFront distribution; callers reach the
internal load balancer directly. Supply `dnsZoneIds` when Pulumi should create private Route 53 aliases.
If they are omitted, the operator creates private DNS records pointing both
names to the returned internal load balancer.

By default, private HTTPS accepts callers from the VPC CIDR. Set
`privateIngressCidrs` to the IPv4 CIDRs used by a VPN, transit gateway, peered
network, or on-premises network when those callers do not retain a VPC source
address.

The stack validates the selected database plan against the worst supported
rolling deployment: the maximum configured tasks plus a second generation of
replacement tasks. It rejects a replica count that can exhaust the plan's
database connection budget.

## Safety and current qualification

Production requires deletion protection, at least one running task, and at
least 14 days of RDS backups. RDS, S3, and their Secrets Manager values are
Pulumi-protected when deletion protection is enabled. Removing them requires a
separate deliberate unprotect and permanent-deletion procedure.

Run the local resource and contract gate with:

```sh
pnpm test:aws-pulumi
```

That test proves configuration rejection, resource construction, workload
identity, migration startup, and secret-free outputs. It is not real-cloud
release evidence. The default public stack has separately passed clean and
repeated apply, runtime behavior, scaling, upgrade, rollback, outage, state
recovery, backup, restore, bounded performance, and safe destroy in an isolated
AWS account. The private-ingress variant remains unqualified until it passes
the same live lifecycle gate.

The reusable live qualification scripts live at the repository root. Upgrade
and rollback require a different immutable multi-architecture image digest;
secret rotation never prints either credential:

```sh
ARTIFACT_SERVER_AWS_UPGRADE_IMAGE=repository@sha256:replace \
  scripts/run-aws-upgrade-rollback-qualification.sh
scripts/run-aws-secret-rotation-qualification.sh
```
