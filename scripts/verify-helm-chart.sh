#!/usr/bin/env bash
set -euo pipefail

artifactserver_repository=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
readonly artifactserver_repository
readonly artifactserver_chart="$artifactserver_repository/packaging/helm/artifact-server"
readonly artifactserver_digest="sha256:0000000000000000000000000000000000000000000000000000000000000000"

artifactserver_values=(
  --set "image.digest=$artifactserver_digest"
  --set "configuration.installationId=static-verification"
  --set "configuration.bootstrapAdministratorEmail=admin@example.test"
  --set "configuration.applicationOrigin=https://artifacts.example.test"
  --set "configuration.contentDomain=content.example.net"
  --set "configuration.s3.bucket=artifact-server-static-verification"
  --set "configuration.s3.region=us-east-1"
  --set "identity.oidcClientId=artifact-server"
  --set "identity.oidcIssuer=https://idp.example.test"
  --set "secret.name=artifact-server-runtime"
)

helm lint "$artifactserver_chart" --strict "${artifactserver_values[@]}"

for artifactserver_kubernetes_version in 1.34.0 1.35.0 1.36.0; do
  helm template artifact-server "$artifactserver_chart" \
    --kube-version "$artifactserver_kubernetes_version" \
    "${artifactserver_values[@]}" >/dev/null
done

helm template artifact-server "$artifactserver_chart" \
  --kube-version 1.36.0 \
  "${artifactserver_values[@]}" \
  --set ingress.enabled=true \
  --set ingress.className=nginx \
  --set ingress.applicationTlsSecretName=artifact-server-application-tls \
  --set ingress.contentTlsSecretName=artifact-server-content-tls >/dev/null

artifactserver_group_roles=$(helm template artifact-server "$artifactserver_chart" \
  --kube-version 1.36.0 \
  "${artifactserver_values[@]}" \
  --set 'identity.oidcMemberGroups={artifact-users,engineering}' \
  --set 'identity.oidcAdministratorGroups={artifact-admins}')
if [[ "$artifactserver_group_roles" != *'value: "artifact-users,engineering"'* ||
  "$artifactserver_group_roles" != *'value: "artifact-admins"'* ]]; then
  echo "Helm did not render the OIDC group-role settings." >&2
  exit 1
fi

artifactserver_directory_sync=$(helm template artifact-server "$artifactserver_chart" \
  --kube-version 1.36.0 \
  "${artifactserver_values[@]}" \
  --set identity.oidcIssuer=https://idp.example.test/realms/main \
  --set 'identity.oidcMemberGroups={artifact-users}' \
  --set identity.oidcDirectoryClientId=artifact-server-directory \
  --set secret.keys.oidcDirectoryClientSecret=oidc-directory-client-secret \
  --set configuration.postgresConnectionBudget=23)
if [[ "$artifactserver_directory_sync" != *"name: artifact-server-sync-directory"* ||
  "$artifactserver_directory_sync" != *"- sync-directory"* ||
  "$artifactserver_directory_sync" != *"path: oidc-directory-client-secret"* ]]; then
  echo "Helm did not render the directory sync CronJob." >&2
  exit 1
fi
if [[ "$(helm template artifact-server "$artifactserver_chart" --kube-version 1.36.0 \
  "${artifactserver_values[@]}")" == *"sync-directory"* ]]; then
  echo "Helm rendered a directory sync CronJob without a directory client." >&2
  exit 1
fi

expect_render_failure() {
  local artifactserver_expected=$1
  shift
  local artifactserver_output
  if artifactserver_output=$(helm template artifact-server "$artifactserver_chart" \
    --kube-version 1.36.0 "$@" 2>&1); then
    echo "Expected Helm rendering to fail with: $artifactserver_expected" >&2
    exit 1
  fi
  if [[ "$artifactserver_output" != *"$artifactserver_expected"* ]]; then
    echo "Helm failed for an unexpected reason: $artifactserver_output" >&2
    exit 1
  fi
}

expect_render_failure "image.digest is required" \
  --set configuration.installationId=static-verification \
  --set configuration.bootstrapAdministratorEmail=admin@example.test \
  --set configuration.applicationOrigin=https://artifacts.example.test \
  --set configuration.contentDomain=content.example.net \
  --set configuration.s3.bucket=artifact-server-static-verification \
  --set configuration.s3.region=us-east-1 \
  --set identity.oidcClientId=artifact-server \
  --set identity.oidcIssuer=https://idp.example.test \
  --set secret.name=artifact-server-runtime

expect_render_failure "must be configured together" \
  "${artifactserver_values[@]}" \
  --set secret.keys.s3AccessKeyId=s3-access-key-id

expect_render_failure "identity.oidcClientId and identity.oidcIssuer must be configured together" \
  "${artifactserver_values[@]}" \
  --set identity.oidcIssuer=

expect_render_failure "identity.oidcScopes and secret.keys.oidcClientSecret require" \
  "${artifactserver_values[@]}" \
  --set identity.oidcClientId= \
  --set identity.oidcIssuer= \
  --set identity.oidcScopes="openid email profile"

expect_render_failure "identity.oidcAdministratorGroups require identity.oidcClientId and identity.oidcIssuer" \
  "${artifactserver_values[@]}" \
  --set identity.oidcClientId= \
  --set identity.oidcIssuer= \
  --set 'identity.oidcAdministratorGroups={artifact-admins}'

expect_render_failure "identity.oidcGroupsClaim requires identity.oidcMemberGroups or identity.oidcAdministratorGroups" \
  "${artifactserver_values[@]}" \
  --set identity.oidcGroupsClaim=groups

expect_render_failure "does not match pattern" \
  "${artifactserver_values[@]}" \
  --set 'identity.oidcMemberGroups={artifact-users\,engineering}'

expect_render_failure "secret.keys.oidcDirectoryClientSecret require identity.oidcClientId, identity.oidcIssuer, and identity.oidcMemberGroups" \
  "${artifactserver_values[@]}" \
  --set identity.oidcDirectoryClientId=artifact-server-directory \
  --set secret.keys.oidcDirectoryClientSecret=oidc-directory-client-secret

expect_render_failure "identity.oidcDirectoryClientId and secret.keys.oidcDirectoryClientSecret must be configured together" \
  "${artifactserver_values[@]}" \
  --set 'identity.oidcMemberGroups={artifact-users}' \
  --set identity.oidcDirectoryClientId=artifact-server-directory \
  --set configuration.postgresConnectionBudget=23

expect_render_failure "for 2 replicas and the enabled migration, cleanup, and directory sync Jobs" \
  "${artifactserver_values[@]}" \
  --set 'identity.oidcMemberGroups={artifact-users}' \
  --set identity.oidcDirectoryClientId=artifact-server-directory \
  --set secret.keys.oidcDirectoryClientSecret=oidc-directory-client-secret

expect_render_failure "one installation has one browser-login provider" \
  "${artifactserver_values[@]}" \
  --set identity.workosClientId=client_workos \
  --set identity.workosIssuer=https://auth.example.test \
  --set secret.keys.workosApiKey=workos-api-key

expect_render_failure "private-team deployments require exactly one browser-login provider" \
  "${artifactserver_values[@]}" \
  --set identity.oidcClientId= \
  --set identity.oidcIssuer=

expect_render_failure "terminationGracePeriodSeconds must be longer" \
  "${artifactserver_values[@]}" \
  --set terminationGracePeriodSeconds=5

expect_render_failure "postgresConnectionBudget must be at least 32" \
  "${artifactserver_values[@]}" \
  --set replicaCount=3

expect_render_failure "ingress.applicationTlsSecretName is required" \
  "${artifactserver_values[@]}" \
  --set ingress.enabled=true

expect_render_failure "application origin with no path or explicit port" \
  "${artifactserver_values[@]}" \
  --set configuration.applicationOrigin=https://artifacts.example.test:8443 \
  --set ingress.enabled=true \
  --set ingress.applicationTlsSecretName=artifact-server-application-tls \
  --set ingress.contentTlsSecretName=artifact-server-content-tls

expect_render_failure "podLabels cannot replace the chart-owned label" \
  "${artifactserver_values[@]}" \
  --set-string podLabels.app\\.kubernetes\\.io/component=other

mkdir -p -- "$artifactserver_repository/release"
helm package "$artifactserver_chart" \
  --destination "$artifactserver_repository/release" >/dev/null
