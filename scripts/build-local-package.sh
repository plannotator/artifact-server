#!/usr/bin/env bash
set -euo pipefail

artifactserver_repository=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
artifactserver_output=${1:-"$artifactserver_repository/release"}
artifactserver_stage_parent=$(mktemp -d "${TMPDIR:-/tmp}/artifact-server-local-package.XXXXXX")
artifactserver_stage="$artifactserver_stage_parent/artifactserver"
artifactserver_tmp_root=${TMPDIR:-/tmp}
artifactserver_stage_prefix="${artifactserver_tmp_root%/}/artifact-server-local-package."

cleanup() {
  if [[ "$artifactserver_stage_parent" == "$artifactserver_stage_prefix"* ]]; then
    rm -rf -- "$artifactserver_stage_parent"
    return
  fi
  printf 'Refusing to remove unexpected package staging path: %s\n' \
    "$artifactserver_stage_parent" >&2
}
trap cleanup EXIT

mkdir -p -- "$artifactserver_stage" "$artifactserver_output"

pnpm --dir "$artifactserver_repository" build

cp -- "$artifactserver_repository/package.json" "$artifactserver_stage/package.json"
cp -- "$artifactserver_repository/pnpm-lock.yaml" "$artifactserver_stage/pnpm-lock.yaml"

pnpm --dir "$artifactserver_stage" install \
  --config.node-linker=hoisted \
  --frozen-lockfile \
  --ignore-scripts \
  --offline \
  --prod

cp -R -- "$artifactserver_repository/dist" "$artifactserver_stage/dist"
cp -- "$artifactserver_repository/README.md" "$artifactserver_stage/README.md"
mkdir -p -- "$artifactserver_stage/bin"
cp -- "$artifactserver_repository/packaging/local/artifactserver" \
  "$artifactserver_stage/bin/artifactserver"
cp -- "$artifactserver_repository/packaging/local/artifactserver.cmd" \
  "$artifactserver_stage/bin/artifactserver.cmd"
chmod 0755 "$artifactserver_stage/bin/artifactserver"

find "$artifactserver_stage/dist" \
  \( -name '*.d.ts' -o -name '*.d.ts.map' \) -delete
find "$artifactserver_stage/node_modules" -type d -name .bin -prune \
  -exec rm -rf -- {} +
find "$artifactserver_stage/node_modules" -type d \
  -path '*/node_modules/msgpackr-extract' -prune -exec rm -rf -- {} +
find "$artifactserver_stage/node_modules" -type d \
  -path '*/node_modules/@msgpackr-extract' -prune -exec rm -rf -- {} +
find "$artifactserver_stage/node_modules" -type d \
  -path '*/node_modules/node-gyp-build-optional-packages' -prune \
  -exec rm -rf -- {} +
rm -rf -- "$artifactserver_stage/node_modules/.pnpm"
rm -f -- \
  "$artifactserver_stage/node_modules/.modules.yaml" \
  "$artifactserver_stage/node_modules/.pnpm-workspace-state-v1.json"
rm -- "$artifactserver_stage/pnpm-lock.yaml"
node "$artifactserver_repository/scripts/local-package-metadata.mjs" prepare \
  "$artifactserver_repository/package.json" \
  "$artifactserver_stage/package.json"

if find "$artifactserver_stage/node_modules" -type l -print -quit | grep -q .; then
  printf 'The local package contains a symbolic dependency link.\n' >&2
  exit 1
fi
if find "$artifactserver_stage/node_modules" -type f -name '*.node' \
  -print -quit | grep -q .; then
  printf 'The local package contains a platform-specific native dependency.\n' >&2
  exit 1
fi

node "$artifactserver_stage/dist/cli/main.js" --version >/dev/null

artifactserver_version=$(node -p \
  "JSON.parse(require('node:fs').readFileSync(process.argv[1], 'utf8')).version" \
  "$artifactserver_repository/package.json")
artifactserver_archive="$artifactserver_output/artifact-server-${artifactserver_version}-node.tar.gz"

tar -czf "$artifactserver_archive" \
  -C "$artifactserver_stage_parent" artifactserver
node "$artifactserver_repository/scripts/local-package-metadata.mjs" manifest \
  "$artifactserver_archive" \
  "$artifactserver_stage/package.json" \
  "$artifactserver_archive.manifest.json"

printf '%s\n' "$artifactserver_archive"
