#!/usr/bin/env bash
set -euo pipefail

artifactserver_repository=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
artifactserver_output=${1:-"$artifactserver_repository/release"}
artifactserver_version=$(node -p \
  "JSON.parse(require('node:fs').readFileSync(process.argv[1], 'utf8')).version" \
  "$artifactserver_repository/package.json")
artifactserver_revision=$(git -C "$artifactserver_repository" rev-parse HEAD)
artifactserver_created=$(git -C "$artifactserver_repository" show -s --format=%cI HEAD)
artifactserver_source=${ARTIFACT_SERVER_IMAGE_SOURCE:-}
artifactserver_image_tag=${ARTIFACT_SERVER_IMAGE_TAG:-"ghcr.io/plannotator/artifact-server:$artifactserver_version"}
artifactserver_sbom_scanner="docker.io/docker/buildkit-syft-scanner:stable-1@sha256:79e7b013cbec16bbb436f312819a49a4a57752b2270c1a9332ae1a10fcc82a68"
artifactserver_source_tree_clean=true
if [[ -n "$(git -C "$artifactserver_repository" status --porcelain --untracked-files=normal)" ]]; then
  artifactserver_source_tree_clean=false
fi
artifactserver_archive="$artifactserver_output/artifact-server-$artifactserver_version.oci.tar"
artifactserver_manifest="$artifactserver_archive.manifest.json"
artifactserver_stage=$(mktemp -d "${TMPDIR:-/tmp}/artifact-server-oci.XXXXXX")
artifactserver_staged_archive="$artifactserver_stage/image.oci.tar"
artifactserver_layout="$artifactserver_stage/layout"

cleanup() {
  case "$artifactserver_stage" in
    "${TMPDIR:-/tmp}"/artifact-server-oci.*)
      rm -rf -- "$artifactserver_stage"
      ;;
    *)
      printf 'Refusing to remove unexpected OCI staging path: %s\n' \
        "$artifactserver_stage" >&2
      ;;
  esac
}
trap cleanup EXIT

mkdir -p -- "$artifactserver_output" "$artifactserver_layout"

docker buildx build \
  --file "$artifactserver_repository/packaging/oci/Dockerfile" \
  --platform linux/amd64,linux/arm64 \
  --build-arg "IMAGE_CREATED=$artifactserver_created" \
  --build-arg "IMAGE_REVISION=$artifactserver_revision" \
  --build-arg "IMAGE_SOURCE=$artifactserver_source" \
  --build-arg "IMAGE_SOURCE_TREE_CLEAN=$artifactserver_source_tree_clean" \
  --build-arg "IMAGE_VERSION=$artifactserver_version" \
  --build-arg "SOURCE_DATE_EPOCH=$(git -C "$artifactserver_repository" show -s --format=%ct HEAD)" \
  --provenance=mode=max \
  --attest "type=sbom,generator=$artifactserver_sbom_scanner" \
  --tag "$artifactserver_image_tag" \
  --output "type=oci,dest=$artifactserver_staged_archive" \
  "$artifactserver_repository"

tar -xf "$artifactserver_staged_archive" -C "$artifactserver_layout"
mv -- "$artifactserver_staged_archive" "$artifactserver_archive"
node "$artifactserver_repository/scripts/oci-image-metadata.mjs" \
  "$artifactserver_archive" \
  "$artifactserver_layout" \
  "$artifactserver_manifest" \
  "$artifactserver_version" \
  "$artifactserver_revision" \
  "$artifactserver_source_tree_clean"

printf '%s\n' "$artifactserver_archive"
