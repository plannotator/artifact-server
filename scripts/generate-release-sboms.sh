#!/usr/bin/env bash
set -euo pipefail

artifactserver_syft=${1:?Pass the Syft executable path.}
artifactserver_input=${2:?Pass the release input directory.}
artifactserver_output=${3:?Pass the SBOM output directory.}
artifactserver_version=${4:?Pass the release version.}
artifactserver_mode=${5:?Pass packages, image, or all.}
artifactserver_stage=$(mktemp -d "${TMPDIR:-/tmp}/artifact-server-sbom.XXXXXX")

cleanup() {
  case "$artifactserver_stage" in
    "${TMPDIR:-/tmp}"/artifact-server-sbom.*)
      rm -rf -- "$artifactserver_stage"
      ;;
    *)
      printf 'Refusing to remove unexpected SBOM staging path: %s\n' \
        "$artifactserver_stage" >&2
      ;;
  esac
}
trap cleanup EXIT

mkdir -p -- "$artifactserver_output"

generate_file_sbom() {
  local artifactserver_file=${1:?Pass an artifact file.}
  local artifactserver_name=${2:?Pass an SBOM base name.}
  local artifactserver_extract="$artifactserver_stage/$artifactserver_name"
  local artifactserver_scan_root="$artifactserver_extract"
  mkdir -p -- "$artifactserver_extract"
  tar -xzf "$artifactserver_file" -C "$artifactserver_extract"
  if [[ -d "$artifactserver_extract/artifactserver/node_modules" ]]; then
    artifactserver_scan_root="$artifactserver_extract/artifactserver"
    (
      cd -- "$artifactserver_scan_root"
      npm shrinkwrap --package-lock-only --ignore-scripts >/dev/null
    )
    mv -- \
      "$artifactserver_scan_root/npm-shrinkwrap.json" \
      "$artifactserver_scan_root/package-lock.json"
  fi
  "$artifactserver_syft" scan "dir:$artifactserver_scan_root" \
    --source-name "$artifactserver_name" \
    --source-version "$artifactserver_version" \
    --output "spdx-json=$artifactserver_output/$artifactserver_name.spdx.json"
}

case "$artifactserver_mode" in
  packages|all)
    generate_file_sbom \
      "$artifactserver_input/artifact-server-$artifactserver_version-node.tar.gz" \
      "artifact-server-$artifactserver_version-node"
    generate_file_sbom \
      "$artifactserver_input/plannotator-artifact-server-pi-$artifactserver_version.tgz" \
      "plannotator-artifact-server-pi-$artifactserver_version"
    generate_file_sbom \
      "$artifactserver_input/plannotator-artifact-server-opencode-$artifactserver_version.tgz" \
      "plannotator-artifact-server-opencode-$artifactserver_version"
    generate_file_sbom \
      "$artifactserver_input/plannotator-artifact-server-claude-channel-$artifactserver_version.tgz" \
      "plannotator-artifact-server-claude-channel-$artifactserver_version"
    ;;
  image)
    ;;
  *)
    printf 'SBOM mode must be packages, image, or all.\n' >&2
    exit 1
    ;;
esac

case "$artifactserver_mode" in
  image|all)
    artifactserver_oci_layout="$artifactserver_stage/oci-layout"
    mkdir -p -- "$artifactserver_oci_layout"
    tar -xf \
      "$artifactserver_input/artifact-server-$artifactserver_version.oci.tar" \
      -C "$artifactserver_oci_layout"
    node "$(dirname -- "${BASH_SOURCE[0]}")/extract-oci-sboms.mjs" \
      "$artifactserver_oci_layout" \
      "$artifactserver_output" \
      "$artifactserver_version"
    ;;
  packages)
    ;;
esac
