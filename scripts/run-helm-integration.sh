#!/usr/bin/env bash
set -euo pipefail

artifactserver_repository=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
readonly artifactserver_repository
artifactserver_version=$(node -p \
  "JSON.parse(require('node:fs').readFileSync(process.argv[1], 'utf8')).version" \
  "$artifactserver_repository/package.json")
readonly artifactserver_version
artifactserver_revision=$(git -C "$artifactserver_repository" rev-parse HEAD)
readonly artifactserver_revision
readonly artifactserver_run_id="${$}-${RANDOM}"
readonly artifactserver_cluster_name="artifact-server-helm-${artifactserver_run_id}"
readonly artifactserver_image_repository="artifact-server-helm-test"
readonly artifactserver_image_tag="${artifactserver_version}-${artifactserver_run_id}"
readonly artifactserver_test_image="${artifactserver_image_repository}:${artifactserver_image_tag}"
readonly artifactserver_archive="$artifactserver_repository/release/artifact-server-${artifactserver_version}.oci.tar"
readonly artifactserver_postgres_container="${artifactserver_cluster_name}-postgres"
readonly artifactserver_minio_container="${artifactserver_cluster_name}-minio"
readonly artifactserver_postgres_volume="${artifactserver_postgres_container}-data"
readonly artifactserver_minio_volume="${artifactserver_minio_container}-data"

cleanup() {
  docker unpause "$artifactserver_postgres_container" "$artifactserver_minio_container" >/dev/null 2>&1 || true
  kind delete cluster --name "$artifactserver_cluster_name" >/dev/null 2>&1 || true
  docker rm --force "$artifactserver_postgres_container" "$artifactserver_minio_container" >/dev/null 2>&1 || true
  docker volume rm --force "$artifactserver_postgres_volume" "$artifactserver_minio_volume" >/dev/null 2>&1 || true
  docker image rm --force "$artifactserver_test_image" >/dev/null 2>&1 || true
}
trap cleanup EXIT INT TERM

cd "$artifactserver_repository"
pnpm build
ARTIFACT_SERVER_IMAGE_TAG="$artifactserver_test_image" pnpm package:oci
docker load --input "$artifactserver_archive" >/dev/null

export ARTIFACT_SERVER_HELM_CHART="$artifactserver_repository/packaging/helm/artifact-server"
export ARTIFACT_SERVER_HELM_CLUSTER_NAME="$artifactserver_cluster_name"
export ARTIFACT_SERVER_HELM_IMAGE="$artifactserver_test_image"
export ARTIFACT_SERVER_HELM_IMAGE_REPOSITORY="$artifactserver_image_repository"
export ARTIFACT_SERVER_HELM_IMAGE_TAG="$artifactserver_image_tag"
export ARTIFACT_SERVER_HELM_KIND_CONFIG="$artifactserver_repository/tests/fixtures/kind.helm.yaml"
export ARTIFACT_SERVER_HELM_REVISION="$artifactserver_revision"
export ARTIFACT_SERVER_HELM_POSTGRES_CONTAINER="$artifactserver_postgres_container"
export ARTIFACT_SERVER_HELM_POSTGRES_VOLUME="$artifactserver_postgres_volume"
export ARTIFACT_SERVER_HELM_MINIO_CONTAINER="$artifactserver_minio_container"
export ARTIFACT_SERVER_HELM_MINIO_VOLUME="$artifactserver_minio_volume"

pnpm exec vitest run \
  --config tests/configs/vitest.helm.config.ts \
  --reporter=default \
  --reporter=json \
  --outputFile.json=project/evidence/helm-kubernetes.json
