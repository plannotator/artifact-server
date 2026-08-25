#!/usr/bin/env bash

set -euo pipefail

readonly gcs_image="fsouza/fake-gcs-server@sha256:3730da0e31f7e5186a90ec4899dc2c336104e7599df400411392ef17e684c31f"
readonly azure_image="mcr.microsoft.com/azure-storage/azurite@sha256:647c63a91102a9d8e8000aab803436e1fc85fbb285e7ce830a82ee5d6661cf37"
readonly run_id="${$}-${RANDOM}"
readonly gcs_container="artifact-server-gcs-${run_id}"
readonly azure_container="artifact-server-azure-blob-${run_id}"

cleanup() {
  docker rm --force "${gcs_container}" "${azure_container}" >/dev/null 2>&1 || true
}
trap cleanup EXIT INT TERM

docker run --detach \
  --name "${gcs_container}" \
  --publish 127.0.0.1::4443 \
  "${gcs_image}" \
  -scheme http -port 4443 -backend memory >/dev/null

docker run --detach \
  --name "${azure_container}" \
  --publish 127.0.0.1::10000 \
  "${azure_image}" \
  azurite-blob \
  --blobHost 0.0.0.0 \
  --blobPort 10000 \
  --disableTelemetry \
  --inMemoryPersistence \
  --silent \
  --skipApiVersionCheck >/dev/null

gcs_port="$(docker port "${gcs_container}" 4443/tcp | sed -n 's/^127\.0\.0\.1://p' | head -n 1)"
azure_port="$(docker port "${azure_container}" 10000/tcp | sed -n 's/^127\.0\.0\.1://p' | head -n 1)"
if [[ -z "${gcs_port}" || -z "${azure_port}" ]]; then
  echo "Native storage emulators did not publish IPv4 test ports." >&2
  exit 1
fi

readonly gcs_endpoint="http://127.0.0.1:${gcs_port}"
readonly azure_endpoint="http://127.0.0.1:${azure_port}/devstoreaccount1"

for _ in $(seq 1 80); do
  gcs_status="$(curl --silent --output /dev/null --write-out '%{http_code}' "${gcs_endpoint}/storage/v1/b" || true)"
  azure_status="$(curl --silent --output /dev/null --write-out '%{http_code}' "${azure_endpoint}?comp=list" || true)"
  if [[ "${gcs_status}" != "000" && "${azure_status}" != "000" ]]; then
    break
  fi
  sleep 0.25
done

if [[ "${gcs_status:-000}" == "000" || "${azure_status:-000}" == "000" ]]; then
  echo "Native storage emulators did not become reachable." >&2
  docker logs --tail 80 "${gcs_container}" >&2 || true
  docker logs --tail 80 "${azure_container}" >&2 || true
  exit 1
fi

ARTIFACT_SERVER_TEST_GCS_ENDPOINT="${gcs_endpoint}" \
ARTIFACT_SERVER_TEST_AZURE_BLOB_ENDPOINT="${azure_endpoint}" \
  pnpm exec vitest run --coverage \
    --config tests/configs/vitest.native-storage.config.ts \
    --reporter=default \
    --reporter=json \
    --outputFile=project/evidence/native-cloud-storage.json
