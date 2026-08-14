#!/usr/bin/env bash
set -euo pipefail

if [[ "$#" -eq 0 ]]; then
  echo "Usage: scripts/with-kubernetes-test-tools.sh <command> [arguments...]" >&2
  exit 64
fi

artifactserver_repository=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
readonly artifactserver_repository
readonly artifactserver_helm_version="4.2.3"
readonly artifactserver_kind_version="0.32.0"

case "$(uname -s)" in
  Darwin) artifactserver_os="darwin" ;;
  Linux) artifactserver_os="linux" ;;
  *)
    echo "Kubernetes release tests support macOS and Linux." >&2
    exit 69
    ;;
esac

case "$(uname -m)" in
  arm64 | aarch64) artifactserver_arch="arm64" ;;
  x86_64 | amd64) artifactserver_arch="amd64" ;;
  *)
    echo "Kubernetes release tests support amd64 and arm64." >&2
    exit 69
    ;;
esac

case "${artifactserver_os}-${artifactserver_arch}" in
  darwin-arm64)
    artifactserver_helm_sha="048ecf5ad3160f83d918f9fe945238d2132b079640f7b106175331c25f242c64"
    artifactserver_kind_sha="dca67911095a110c2b5c36e26df6cac860c602033e456c0db47be498cdef1ebb"
    ;;
  darwin-amd64)
    artifactserver_helm_sha="ff3ac86755a45f3422473bc1200776aac0fe04c5766abe6ca66699f7b564b23b"
    artifactserver_kind_sha="295ac6d0d634c9819c9907df45e3017d1f13166bd13c3404c45e79f7faa47498"
    ;;
  linux-amd64)
    artifactserver_helm_sha="e9b88b4ee95b18c706839c28d3a0220e5bc470e9cd9262410c90793c45ff8b7c"
    artifactserver_kind_sha="50030de23cf40a18505f20426f6a8506bedf13c6e509244bd1fa9463721b0f54"
    ;;
  linux-arm64)
    artifactserver_helm_sha="21abd9354d39b2cd79a8d76be6912cd137a983cbf997193503fb8a6a6e2f2785"
    artifactserver_kind_sha="b92cd615e97585de8ddade28ed5cd7feb4248d717c233eea5b03c37298900f5d"
    ;;
esac

readonly artifactserver_tools_directory="$artifactserver_repository/release/tools/helm-${artifactserver_helm_version}-kind-${artifactserver_kind_version}-${artifactserver_os}-${artifactserver_arch}"
readonly artifactserver_helm="$artifactserver_tools_directory/helm"
readonly artifactserver_kind="$artifactserver_tools_directory/kind"

verify_sha256() {
  local artifactserver_expected=$1
  local artifactserver_file=$2
  local artifactserver_actual
  if command -v sha256sum >/dev/null 2>&1; then
    artifactserver_actual=$(sha256sum "$artifactserver_file" | awk '{print $1}')
  else
    artifactserver_actual=$(shasum -a 256 "$artifactserver_file" | awk '{print $1}')
  fi
  if [[ "$artifactserver_actual" != "$artifactserver_expected" ]]; then
    echo "Checksum mismatch for $artifactserver_file" >&2
    return 1
  fi
}

install_tools() {
  local artifactserver_stage
  artifactserver_stage=$(mktemp -d "${TMPDIR:-/tmp}/artifact-server-kubernetes-tools.XXXXXX")
  cleanup_tools_stage() {
    case "$artifactserver_stage" in
      "${TMPDIR:-/tmp}"/artifact-server-kubernetes-tools.*)
        rm -rf -- "$artifactserver_stage"
        ;;
      *)
        echo "Refusing to remove unexpected tools staging path: $artifactserver_stage" >&2
        ;;
    esac
  }
  trap cleanup_tools_stage RETURN

  local artifactserver_helm_archive="$artifactserver_stage/helm.tar.gz"
  local artifactserver_kind_binary="$artifactserver_stage/kind"
  curl --fail --location --silent --show-error \
    "https://get.helm.sh/helm-v${artifactserver_helm_version}-${artifactserver_os}-${artifactserver_arch}.tar.gz" \
    --output "$artifactserver_helm_archive"
  curl --fail --location --silent --show-error \
    "https://github.com/kubernetes-sigs/kind/releases/download/v${artifactserver_kind_version}/kind-${artifactserver_os}-${artifactserver_arch}" \
    --output "$artifactserver_kind_binary"
  verify_sha256 "$artifactserver_helm_sha" "$artifactserver_helm_archive"
  verify_sha256 "$artifactserver_kind_sha" "$artifactserver_kind_binary"

  mkdir -p -- "$artifactserver_tools_directory"
  tar -xzf "$artifactserver_helm_archive" -C "$artifactserver_stage"
  install -m 0755 \
    "$artifactserver_stage/${artifactserver_os}-${artifactserver_arch}/helm" \
    "$artifactserver_helm"
  install -m 0755 "$artifactserver_kind_binary" "$artifactserver_kind"
}

if [[ ! -x "$artifactserver_helm" || ! -x "$artifactserver_kind" ]]; then
  install_tools
fi

export PATH="$artifactserver_tools_directory:$PATH"
exec "$@"
