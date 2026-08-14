#!/usr/bin/env bash

set -euo pipefail

artifactserver_script_directory=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=compact-compose-lib.sh
source "$artifactserver_script_directory/compact-compose-lib.sh"

artifactserver_require_image

if [[ $# -ne 1 ]]; then
  printf 'Usage: %s BACKUP_DIRECTORY\n' "$0" >&2
  exit 64
fi

artifactserver_backup_directory=$1
artifactserver_archive="$artifactserver_backup_directory/data.tar"
artifactserver_checksum="$artifactserver_backup_directory/data.tar.sha256"
artifactserver_support="$artifactserver_backup_directory/support-manifest.json"

for artifactserver_required_path in \
  "$artifactserver_archive" \
  "$artifactserver_checksum" \
  "$artifactserver_support"
do
  if [[ ! -f "$artifactserver_required_path" ]]; then
    printf 'Compact backup is incomplete: %s is missing.\n' \
      "$artifactserver_required_path" >&2
    exit 66
  fi
done
if [[ -e "$artifactserver_backup_directory/INCOMPLETE" ]]; then
  printf 'Compact backup is marked incomplete.\n' >&2
  exit 66
fi
if artifactserver_compact_is_running; then
  printf 'Stop the target Compact Compose service before restoring.\n' >&2
  exit 65
fi

read -r artifactserver_expected_digest artifactserver_expected_name \
  < "$artifactserver_checksum"
if [[ "$artifactserver_expected_name" != "data.tar" ]]; then
  printf 'Compact backup checksum names an unexpected file.\n' >&2
  exit 66
fi
artifactserver_actual_digest=$(artifactserver_sha256 "$artifactserver_archive")
if [[ "$artifactserver_actual_digest" != "$artifactserver_expected_digest" ]]; then
  printf 'Compact backup checksum does not match data.tar.\n' >&2
  exit 66
fi
if ! tar -tvf "$artifactserver_archive" \
  | awk 'substr($1, 1, 1) != "-" && substr($1, 1, 1) != "d" {exit 1}'
then
  printf 'Compact backup contains a link or unsupported filesystem entry.\n' >&2
  exit 66
fi

while IFS= read -r artifactserver_archive_entry; do
  case "$artifactserver_archive_entry" in
    data | data/*) ;;
    *)
      printf 'Compact backup contains an unexpected path: %s\n' \
        "$artifactserver_archive_entry" >&2
      exit 66
      ;;
  esac
  case "/$artifactserver_archive_entry/" in
    */../* | */./*)
      printf 'Compact backup contains an unsafe path: %s\n' \
        "$artifactserver_archive_entry" >&2
      exit 66
      ;;
  esac
done < <(tar -tf "$artifactserver_archive")

artifactserver_compose run --rm --no-deps --quiet-pull --no-TTY \
  --entrypoint /bin/sh artifact-server -c \
  'set -eu
   if [ -n "$(find /var/lib/artifact-server -mindepth 1 -maxdepth 1 -print -quit)" ]; then
     printf "The target compact volume is not empty.\n" >&2
     exit 65
   fi
   mkdir -m 700 /var/lib/artifact-server/data
   printf "Restore has not passed its integrity check.\n" \
     > /var/lib/artifact-server/data/.restore-incomplete
   tar --no-same-owner -C /var/lib/artifact-server -xf -' \
  < "$artifactserver_archive"

artifactserver_compose run --rm --no-deps --quiet-pull artifact-server \
  integrity check --mode compact --data /var/lib/artifact-server/data

artifactserver_compose run --rm --no-deps --quiet-pull \
  --entrypoint /bin/rm artifact-server \
  /var/lib/artifact-server/data/.restore-incomplete

printf 'Compact backup restored and verified. Start the service with docker compose up.\n'
