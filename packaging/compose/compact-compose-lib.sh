#!/usr/bin/env bash

set -euo pipefail

artifactserver_compose_directory=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
artifactserver_compose_file="$artifactserver_compose_directory/compose.yaml"

artifactserver_compose() {
  docker compose --file "$artifactserver_compose_file" "$@"
}

artifactserver_sha256() {
  local artifactserver_checksum_path=$1
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$artifactserver_checksum_path" | awk '{print $1}'
    return
  fi
  if command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$artifactserver_checksum_path" | awk '{print $1}'
    return
  fi
  printf 'A SHA-256 tool is required (sha256sum or shasum).\n' >&2
  return 69
}

artifactserver_compact_is_running() {
  artifactserver_compose ps --status running --services \
    | grep -Fxq artifact-server
}

artifactserver_require_image() {
  if [[ -z "${ARTIFACT_SERVER_IMAGE:-}" ]]; then
    printf 'ARTIFACT_SERVER_IMAGE must name an immutable release digest.\n' >&2
    return 64
  fi
  if [[ "$ARTIFACT_SERVER_IMAGE" != *@sha256:* \
    && "${ARTIFACT_SERVER_ALLOW_TEST_IMAGE_TAG:-false}" != "true" ]]; then
    printf 'ARTIFACT_SERVER_IMAGE must use an immutable sha256 digest.\n' >&2
    return 64
  fi
}
