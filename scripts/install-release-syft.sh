#!/usr/bin/env bash
set -euo pipefail

artifactserver_destination=${1:?Pass the directory where Syft should be installed.}
artifactserver_syft_version=1.51.1
artifactserver_system=$(uname -s)
artifactserver_machine=$(uname -m)
case "$artifactserver_system:$artifactserver_machine" in
  Darwin:arm64)
    artifactserver_syft_platform=darwin_arm64
    artifactserver_syft_sha256=ac063af3b9874769deb7ea1e6d76841e68f9e3bb50cd654226fc977de65532c1
    ;;
  Darwin:x86_64)
    artifactserver_syft_platform=darwin_amd64
    artifactserver_syft_sha256=0e186ce1d4351ec276126851ca3ff258ed070e93e73574ed64858d4fc2339867
    ;;
  Linux:aarch64|Linux:arm64)
    artifactserver_syft_platform=linux_arm64
    artifactserver_syft_sha256=a7fd2b784e6664acd44719270574f6cd8c6864fc2b1700bf9099bd1cccda7d7f
    ;;
  Linux:x86_64)
    artifactserver_syft_platform=linux_amd64
    artifactserver_syft_sha256=8fcb33017a0dc1058298c923c436d19dfa68ae93968e0b423248542e3afb9fc3
    ;;
  *)
    printf 'Syft is not pinned for %s on %s.\n' \
      "$artifactserver_machine" "$artifactserver_system" >&2
    exit 1
    ;;
esac
artifactserver_syft_archive="syft_${artifactserver_syft_version}_${artifactserver_syft_platform}.tar.gz"
artifactserver_stage=$(mktemp -d "${TMPDIR:-/tmp}/artifact-server-syft.XXXXXX")

cleanup() {
  case "$artifactserver_stage" in
    "${TMPDIR:-/tmp}"/artifact-server-syft.*)
      rm -rf -- "$artifactserver_stage"
      ;;
    *)
      printf 'Refusing to remove unexpected Syft staging path: %s\n' \
        "$artifactserver_stage" >&2
      ;;
  esac
}
trap cleanup EXIT

curl --fail --location --silent --show-error \
  "https://github.com/anchore/syft/releases/download/v${artifactserver_syft_version}/${artifactserver_syft_archive}" \
  --output "$artifactserver_stage/$artifactserver_syft_archive"
if command -v sha256sum >/dev/null 2>&1; then
  artifactserver_actual_sha256=$(sha256sum \
    "$artifactserver_stage/$artifactserver_syft_archive" | awk '{print $1}')
else
  artifactserver_actual_sha256=$(shasum -a 256 \
    "$artifactserver_stage/$artifactserver_syft_archive" | awk '{print $1}')
fi
if [[ "$artifactserver_actual_sha256" != "$artifactserver_syft_sha256" ]]; then
  printf 'Syft archive checksum was %s; expected %s.\n' \
    "$artifactserver_actual_sha256" "$artifactserver_syft_sha256" >&2
  exit 1
fi

mkdir -p -- "$artifactserver_destination"
tar -xzf "$artifactserver_stage/$artifactserver_syft_archive" \
  -C "$artifactserver_destination" syft
chmod 0755 "$artifactserver_destination/syft"
"$artifactserver_destination/syft" version
