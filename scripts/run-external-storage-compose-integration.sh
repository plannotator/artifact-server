#!/usr/bin/env bash
set -euo pipefail

artifactserver_repository=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
artifactserver_version=$(node -p \
  "JSON.parse(require('node:fs').readFileSync(process.argv[1], 'utf8')).version" \
  "$artifactserver_repository/package.json")
artifactserver_revision=$(git -C "$artifactserver_repository" rev-parse HEAD)
artifactserver_run_id="${$}-${RANDOM}"
artifactserver_test_image="artifact-server-external-compose-test:${artifactserver_version}-${artifactserver_run_id}"
artifactserver_archive="$artifactserver_repository/release/artifact-server-${artifactserver_version}.oci.tar"

cleanup() {
  docker image rm --force "$artifactserver_test_image" >/dev/null 2>&1 || true
}
trap cleanup EXIT INT TERM

cd "$artifactserver_repository"
pnpm build
ARTIFACT_SERVER_IMAGE_TAG="$artifactserver_test_image" pnpm package:oci
docker load --input "$artifactserver_archive" >/dev/null

export ARTIFACT_SERVER_EXTERNAL_COMPOSE_BASE_FILE="$artifactserver_repository/packaging/compose/compose.yaml"
export ARTIFACT_SERVER_EXTERNAL_COMPOSE_FILE="$artifactserver_repository/packaging/compose/compose.external-storage.yaml"
export ARTIFACT_SERVER_EXTERNAL_COMPOSE_S3_SECRETS_FILE="$artifactserver_repository/packaging/compose/compose.external-storage.s3-credentials.yaml.example"
export ARTIFACT_SERVER_EXTERNAL_COMPOSE_TEST_FILE="$artifactserver_repository/tests/fixtures/compose.external-storage.test.yaml"
export ARTIFACT_SERVER_EXTERNAL_COMPOSE_IMAGE="$artifactserver_test_image"
export ARTIFACT_SERVER_EXTERNAL_COMPOSE_REVISION="$artifactserver_revision"

exec "$artifactserver_repository/scripts/with-external-storage-test-providers.sh" \
  pnpm exec vitest run \
    --config tests/configs/vitest.external-storage-compose.config.ts \
    --reporter=default \
    --reporter=json \
    --outputFile.json=project/evidence/external-storage-compose.json
