#!/usr/bin/env bash

set -euo pipefail

artifactserver_script_directory=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=compact-compose-lib.sh
source "$artifactserver_script_directory/compact-compose-lib.sh"

artifactserver_require_image

if [[ $# -ne 1 ]]; then
  printf 'Usage: %s NEW_BACKUP_DIRECTORY\n' "$0" >&2
  exit 64
fi

artifactserver_backup_directory=$1
if [[ -e "$artifactserver_backup_directory" ]]; then
  printf 'Backup target already exists: %s\n' "$artifactserver_backup_directory" >&2
  exit 65
fi

mkdir -m 700 -- "$artifactserver_backup_directory"
artifactserver_archive="$artifactserver_backup_directory/data.tar"
artifactserver_checksum="$artifactserver_backup_directory/data.tar.sha256"
artifactserver_support="$artifactserver_backup_directory/support-manifest.json"
artifactserver_incomplete="$artifactserver_backup_directory/INCOMPLETE"
printf 'Backup did not complete. Do not restore this directory.\n' > "$artifactserver_incomplete"

artifactserver_was_running=false
if artifactserver_compact_is_running; then
  artifactserver_was_running=true
  artifactserver_compose stop --timeout 20 artifact-server >/dev/null
fi

artifactserver_restart() {
  if [[ "$artifactserver_was_running" == "true" ]]; then
    artifactserver_compose up --detach --wait artifact-server >/dev/null
  fi
}
trap artifactserver_restart EXIT

artifactserver_compose run --rm --no-deps --quiet-pull artifact-server \
  support manifest --mode compact --data /var/lib/artifact-server/data \
  > "$artifactserver_support"

artifactserver_compose run --rm --no-deps --quiet-pull \
  --entrypoint /bin/tar artifact-server \
  -C /var/lib/artifact-server -cf - data > "$artifactserver_archive"

artifactserver_archive_digest=$(artifactserver_sha256 "$artifactserver_archive")
printf '%s  data.tar\n' "$artifactserver_archive_digest" > "$artifactserver_checksum"
rm -- "$artifactserver_incomplete"
artifactserver_restart
artifactserver_was_running=false
trap - EXIT

printf 'Compact backup created: %s\n' "$artifactserver_backup_directory"
