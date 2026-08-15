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

## Not yet qualified

No AWS resource has been created by this work. `DEP-008` remains implementing,
not verified. Release qualification still requires an isolated real deployment
and the lifecycle gates in the README: repeated apply, application behavior,
scale, upgrade, rollback, provider outage, state recovery, backup, restore,
private ingress, performance, safe destroy, and separately confirmed permanent
deletion.
