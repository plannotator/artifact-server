#!/usr/bin/env bash

set -euo pipefail

if [[ "$#" -eq 0 ]]; then
  echo "Usage: scripts/with-shared-test-providers.sh <command> [arguments...]" >&2
  exit 64
fi

readonly postgres_image="postgres@sha256:ef257d85f76e48da1c64832459b59fcaba1a4dac97bf5d7450c77753542eee94"
readonly minio_image="minio/minio@sha256:14cea493d9a34af32f524e538b8346cf79f3321eff8e708c1e2960462bd8936e"
readonly run_id="${$}-${RANDOM}"
readonly postgres_container="artifact-server-postgres-${run_id}"
readonly postgres_volume="${postgres_container}-data"
readonly minio_container="artifact-server-minio-shared-${run_id}"
readonly minio_volume="${minio_container}-data"
readonly postgres_user="artifactserver"
readonly postgres_password="artifactserver-postgres-integration-only"
readonly postgres_database="artifactserver"
readonly minio_access_key="artifactserver"
readonly minio_secret_key="artifactserver-minio-integration-only"
readonly provider_started_at="$(node -e 'process.stdout.write(String(Date.now()))')"

cleanup() {
  docker rm --force "${postgres_container}" "${minio_container}" >/dev/null 2>&1 || true
  docker volume rm --force "${postgres_volume}" "${minio_volume}" >/dev/null 2>&1 || true
}
trap cleanup EXIT INT TERM

docker volume create "${postgres_volume}" >/dev/null
docker volume create "${minio_volume}" >/dev/null

docker run --detach \
  --name "${postgres_container}" \
  --env "POSTGRES_USER=${postgres_user}" \
  --env "POSTGRES_PASSWORD=${postgres_password}" \
  --env "POSTGRES_DB=${postgres_database}" \
  --publish 127.0.0.1::5432 \
  --volume "${postgres_volume}:/var/lib/postgresql/data" \
  "${postgres_image}" >/dev/null

docker run --detach \
  --name "${minio_container}" \
  --env "MINIO_ROOT_USER=${minio_access_key}" \
  --env "MINIO_ROOT_PASSWORD=${minio_secret_key}" \
  --publish 127.0.0.1::9000 \
  --volume "${minio_volume}:/data" \
  "${minio_image}" \
  server /data >/dev/null

postgres_port="$(docker port "${postgres_container}" 5432/tcp | sed -n 's/^127\.0\.0\.1://p' | head -n 1)"
minio_port="$(docker port "${minio_container}" 9000/tcp | sed -n 's/^127\.0\.0\.1://p' | head -n 1)"
if [[ -z "${postgres_port}" || -z "${minio_port}" ]]; then
  echo "A shared-runtime provider did not publish an IPv4 test port." >&2
  exit 1
fi

postgres_ready_streak=0
for _ in $(seq 1 120); do
  if docker exec "${postgres_container}" pg_isready \
    --username "${postgres_user}" \
    --dbname "${postgres_database}" >/dev/null 2>&1; then
    postgres_ready_streak="$((postgres_ready_streak + 1))"
    if [[ "${postgres_ready_streak}" -ge 4 ]]; then
      break
    fi
  else
    postgres_ready_streak=0
  fi
  sleep 0.25
done
if [[ "${postgres_ready_streak}" -lt 4 ]] || ! docker exec "${postgres_container}" pg_isready \
  --username "${postgres_user}" \
  --dbname "${postgres_database}" >/dev/null 2>&1; then
  echo "Postgres did not become ready." >&2
  docker logs --tail 80 "${postgres_container}" >&2 || true
  exit 1
fi

readonly minio_endpoint="http://127.0.0.1:${minio_port}"
for _ in $(seq 1 120); do
  if curl --fail --silent "${minio_endpoint}/minio/health/ready" >/dev/null; then
    break
  fi
  sleep 0.25
done
if ! curl --fail --silent "${minio_endpoint}/minio/health/ready" >/dev/null; then
  echo "MinIO did not become ready." >&2
  docker logs --tail 80 "${minio_container}" >&2 || true
  exit 1
fi

readonly provider_ready_at="$(node -e 'process.stdout.write(String(Date.now()))')"

export ARTIFACT_SERVER_TEST_DATABASE_URL="postgresql://${postgres_user}:${postgres_password}@127.0.0.1:${postgres_port}/${postgres_database}"
export ARTIFACT_SERVER_TEST_MINIO_IMAGE="${minio_image}"
export ARTIFACT_SERVER_TEST_POSTGRES_CONTAINER="${postgres_container}"
export ARTIFACT_SERVER_TEST_POSTGRES_IMAGE="${postgres_image}"
export ARTIFACT_SERVER_TEST_POSTGRES_USER="${postgres_user}"
export ARTIFACT_SERVER_TEST_PROVIDER_READY_MILLISECONDS="$((provider_ready_at - provider_started_at))"
export ARTIFACT_SERVER_TEST_S3_ACCESS_KEY="${minio_access_key}"
export ARTIFACT_SERVER_TEST_S3_ENDPOINT="${minio_endpoint}"
export ARTIFACT_SERVER_TEST_S3_SECRET_KEY="${minio_secret_key}"

"$@"
