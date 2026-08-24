#!/usr/bin/env bash

set -euo pipefail

readonly minio_image="minio/minio@sha256:14cea493d9a34af32f524e538b8346cf79f3321eff8e708c1e2960462bd8936e"
readonly container_name="artifact-server-minio-${$}-${RANDOM}"
readonly volume_name="${container_name}-data"
readonly access_key="artifactserver"
readonly secret_key="artifactserver-integration-only"

cleanup() {
  docker rm --force "${container_name}" >/dev/null 2>&1 || true
  docker volume rm --force "${volume_name}" >/dev/null 2>&1 || true
}
trap cleanup EXIT INT TERM

docker volume create "${volume_name}" >/dev/null
docker run --detach \
  --name "${container_name}" \
  --env "MINIO_ROOT_USER=${access_key}" \
  --env "MINIO_ROOT_PASSWORD=${secret_key}" \
  --publish 127.0.0.1::9000 \
  --volume "${volume_name}:/data" \
  "${minio_image}" \
  server /data >/dev/null

port="$(docker port "${container_name}" 9000/tcp | sed -n 's/^127\.0\.0\.1://p' | head -n 1)"
if [[ -z "${port}" ]]; then
  echo "MinIO did not publish an IPv4 test port." >&2
  exit 1
fi

endpoint="http://127.0.0.1:${port}"
for _ in $(seq 1 60); do
  if curl --fail --silent "${endpoint}/minio/health/ready" >/dev/null; then
    break
  fi
  sleep 0.25
done

if ! curl --fail --silent "${endpoint}/minio/health/ready" >/dev/null; then
  echo "MinIO did not become ready." >&2
  exit 1
fi

ARTIFACT_SERVER_S3_ENDPOINT="${endpoint}" \
ARTIFACT_SERVER_S3_ACCESS_KEY="${access_key}" \
ARTIFACT_SERVER_S3_SECRET_KEY="${secret_key}" \
ARTIFACT_SERVER_MINIO_CONTAINER="${container_name}" \
ARTIFACT_SERVER_MINIO_IMAGE="${minio_image}" \
ARTIFACT_SERVER_MINIO_VOLUME="${volume_name}" \
NODE_OPTIONS="${NODE_OPTIONS:+${NODE_OPTIONS} }--max-old-space-size=4096" \
pnpm exec vitest run --coverage --config vitest.integration.config.ts \
  --reporter=default \
  --reporter=json \
  --outputFile=evidence/s3-minio.json
