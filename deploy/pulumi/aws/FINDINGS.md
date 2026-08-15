# AWS deployment findings

## 2026-08-15 local qualification

The AWS project passed its type check, provider-resource tests, and a live
Pulumi preview while the AWS CLI was authenticated to a real account in
`us-east-1`. The successful preview used Pulumi CLI 3.257.0, Node.js 24.15.0,
AWS provider 7.42.0, and Random provider 4.21.1. It planned 67 resources and
performed no infrastructure writes.

The provider-resource tests use Pulumi's runtime mocks. They validate the real
serialized resource inputs and shared outputs without replacing application
modules. The live preview then validates the program against the installed
Pulumi engine, current AWS provider schema, and authenticated AWS data sources.

The preview found and closed two issues before release:

- AWS limits a generated S3 bucket prefix to 37 characters. Physical names
  now use a short hash while tags retain the full installation name.
- Application Load Balancer and target-group names have 32-character limits.
  Both now use the same bounded physical-name scheme.

The project has its own pinned TypeScript 6 compiler and `ts-node` runtime.
Artifact Server currently uses TypeScript 7, while Pulumi 3.257 declares support
through TypeScript 6. Keeping the infrastructure compiler inside this directory
prevents the Pulumi runtime from silently using the unsupported root compiler.

Pulumi's Node language host emitted a Node.js `fs.Stats` deprecation warning.
It did not affect the preview and originates outside this repository. Keep it in
the upgrade watch list; do not suppress it in application code.

## 2026-08-15 real public deployment qualification

The corrected image and 70-resource public stack ran in the isolated
`aws-qualification` stack in `us-east-1`. The following real-cloud checks passed:

- clean apply and a no-change repeat preview;
- file and complete-site publication, two immutable versions, public delivery,
  private access enforcement, MCP discovery, and unauthenticated MCP rejection;
- one and two ECS tasks with bounded 1/10/25/50/100-user reads;
- S3 outage detection through readiness and recovery after access returned;
- deletion of the local Pulumi checkpoint, exact import from the versioned S3
  backend, stable identity for all 70 resources, and a no-change preview;
- coordinated quiescing, an RDS snapshot, an object copy, restore into a clean
  RDS instance and bucket, integrity verification for 21 objects, and cleanup
  of all temporary restore resources.

The secret-free records are in `evidence/aws-deployment-product.json`,
`evidence/aws-deployment-horizontal.json`, `evidence/aws-provider-outage.json`,
`evidence/aws-state-recovery.json`, and `evidence/aws-coordinated-restore.json`.

`DEP-008` remains implementing, not verified. Private ingress, workload-identity
and secret rotation, explicit application upgrade and rollback, safe destroy,
and separately confirmed permanent deletion still require evidence.

## 2026-08-15 first real apply finding

The first isolated apply created the network, RDS, S3, IAM, TLS, DNS, and ECS
resources, but the application task failed before migration. A diagnostic task
proved the exact failure was `SELF_SIGNED_CERT_IN_CHAIN`: the slim Node.js image
did not include Amazon's RDS CA roots. The connection reached RDS and did not
fail on DNS, routing, credentials, or security groups.

The release image now adds Amazon's official global RDS CA bundle by HTTPS with
an exact SHA-256 checksum. Only the AWS deployment enables it through
`NODE_EXTRA_CA_CERTS`, and the generated database URL explicitly requests
`sslmode=verify-full`. The corrected image subsequently passed the real-cloud
checks recorded above; this entry preserves the failed attempt and its cause.
