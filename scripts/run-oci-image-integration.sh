#!/usr/bin/env bash
set -euo pipefail

artifactserver_repository=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
artifactserver_version=$(node -p \
  "JSON.parse(require('node:fs').readFileSync(process.argv[1], 'utf8')).version" \
  "$artifactserver_repository/package.json")
artifactserver_revision=$(git -C "$artifactserver_repository" rev-parse HEAD)
artifactserver_run_id="${$}-${RANDOM}"
artifactserver_test_image="artifact-server-oci-test:${artifactserver_version}-${artifactserver_run_id}"
artifactserver_archive="$artifactserver_repository/release/artifact-server-${artifactserver_version}.oci.tar"
artifactserver_manifest="${artifactserver_archive}.manifest.json"

cleanup() {
  docker image rm --force \
    "$artifactserver_test_image" >/dev/null 2>&1 || true
}
trap cleanup EXIT INT TERM

cd "$artifactserver_repository"
pnpm build
ARTIFACT_SERVER_IMAGE_TAG="$artifactserver_test_image" pnpm package:oci
docker load --input "$artifactserver_archive" >/dev/null

export ARTIFACT_SERVER_OCI_AMD64_IMAGE="$artifactserver_test_image"
export ARTIFACT_SERVER_OCI_ARCHIVE="$artifactserver_archive"
export ARTIFACT_SERVER_OCI_ARM64_IMAGE="$artifactserver_test_image"
export ARTIFACT_SERVER_OCI_MANIFEST="$artifactserver_manifest"
export ARTIFACT_SERVER_OCI_REVISION="$artifactserver_revision"

bash scripts/with-external-storage-test-providers.sh \
  pnpm exec vitest run \
    --config vitest.oci.config.ts \
    --reporter=default \
    --reporter=json \
    --outputFile.json=evidence/oci-image.json
