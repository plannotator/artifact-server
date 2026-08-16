# GCP deployment findings

## 2026-08-15 minimum public deployment qualification

The public Cloud Run, Cloud SQL, native GCS, Cloud CDN, DNS, and TLS stack ran
in the isolated `artifact-server-qual` project. The product, bounded concurrency,
upgrade and rollback, API-secret rotation, and exact Pulumi checkpoint recovery
checks passed.

The minimum recovery check also passed:

- an on-demand Cloud SQL backup restored into a temporary private Cloud SQL
  instance, which was `RUNNABLE` and contained the expected `artifactserver`
  database;
- all 29 current GCS objects, totaling 5,809 bytes, copied to a temporary bucket
  with identical object names, sizes, and CRC32C checksums; and
- both temporary recovery resources were deleted after verification.

This proves the provider operations and data-copy path. It does not create an
automated disaster-recovery system, prove cross-region failover, or run the
application against a second restored stack. Those are not part of the minimum
qualification.

A brief live removal of the service account's bucket role did not immediately
change readiness because IAM revocation is eventually consistent. The role was
restored and the service remained healthy. We did not add heavier network fault
injection solely to force this result; storage failure and readiness behavior
remain covered by the real adapter integration suite.

The first destroy attempt removed Cloud Run and Cloud SQL, then Google rejected
immediate deletion of the private-services connection because Cloud SQL retains
producer-side resources for up to four days. The package uses the provider's
`ABANDON` deletion policy for that connection, which is Google's documented
workaround for declarative destroys during the recovery window. This does not
retain the database or application data; it lets Google finish removing its
temporary producer-side networking while Pulumi deletes the customer stack.

The qualification destroy removed Cloud Run, Cloud SQL, the load balancer,
public DNS records, secrets, service identity, and the explicitly emptied
artifact bucket. Cloud Run initially retained one serverless subnet address.
After Google released it, the same Pulumi destroy removed the subnet, VPC,
certificate DNS authorizations, Pulumi service-enablement records, and generated
identifiers. The `gcp-qualification` stack now contains zero resources.

An independent inventory found no qualification Cloud Run service or job,
Cloud SQL instance, VPC, subnet, address, forwarding rule, backend service, URL
map, certificate authorization, certificate, application secret, or application
service account. The qualification project deliberately retains the versioned
Pulumi state bucket and the digest-pinned Artifact Registry repository used to
reproduce the tests. Those prerequisites are outside the deployment stack and
contain no published artifact data. Provider APIs remain enabled in the isolated
qualification project, and its default network and default Compute Engine
service account remain outside the stack; none is a running Artifact Server
deployment.

The public-ingress GCP package has now passed its minimum create-to-delete gate.
The broader GCP target remains `implementing`, not fully supported, because the
product specification also requires a qualified private-ingress option. The
current package intentionally rejects private ingress. The positive two-human
ownership-transfer check is tracked with hosted authentication and was not part
of this cleanup pass.
