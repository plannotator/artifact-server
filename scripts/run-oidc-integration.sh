#!/usr/bin/env bash

set -euo pipefail

readonly keycloak_image="quay.io/keycloak/keycloak@sha256:09a381c715ab0b111835b70f2905955274843a219c6f27efb348e4d9f4086858"
readonly container_name="artifact-server-keycloak-${$}-${RANDOM}"
readonly admin_user="artifactserver"
readonly admin_password="artifactserver-keycloak-integration-only"

cleanup() {
  docker rm --force "${container_name}" >/dev/null 2>&1 || true
}
trap cleanup EXIT INT TERM

if ! docker image inspect "${keycloak_image}" >/dev/null 2>&1; then
  pulled=false
  for _ in 1 2 3; do
    if docker pull "${keycloak_image}" >/dev/null 2>&1; then
      pulled=true
      break
    fi
    sleep 5
  done
  if [[ "${pulled}" != true ]]; then
    echo "The pinned Keycloak image could not be pulled." >&2
    exit 1
  fi
fi

pnpm build

keycloak_url=""
for attempt in 1 2; do
  docker run --detach \
    --name "${container_name}" \
    --env "KC_BOOTSTRAP_ADMIN_USERNAME=${admin_user}" \
    --env "KC_BOOTSTRAP_ADMIN_PASSWORD=${admin_password}" \
    --env "KEYCLOAK_ADMIN=${admin_user}" \
    --env "KEYCLOAK_ADMIN_PASSWORD=${admin_password}" \
    --publish 127.0.0.1::8080 \
    "${keycloak_image}" \
    start-dev >/dev/null

  port="$(docker port "${container_name}" 8080/tcp | sed -n 's/^127\.0\.0\.1://p' | head -n 1)"
  if [[ -z "${port}" ]]; then
    echo "Keycloak did not publish an IPv4 test port." >&2
    docker rm --force "${container_name}" >/dev/null 2>&1 || true
    continue
  fi

  candidate_url="http://127.0.0.1:${port}"
  for _ in $(seq 1 240); do
    if curl --fail --silent \
      "${candidate_url}/realms/master/.well-known/openid-configuration" >/dev/null; then
      keycloak_url="${candidate_url}"
      break
    fi
    sleep 0.5
  done
  if [[ -n "${keycloak_url}" ]]; then
    break
  fi

  echo "Keycloak did not become ready on attempt ${attempt}." >&2
  docker logs --tail 80 "${container_name}" >&2 || true
  docker rm --force "${container_name}" >/dev/null 2>&1 || true
done

if [[ -z "${keycloak_url}" ]]; then
  echo "Keycloak did not become ready." >&2
  exit 1
fi

ARTIFACT_SERVER_TEST_KEYCLOAK_ADMIN_PASSWORD="${admin_password}" \
ARTIFACT_SERVER_TEST_KEYCLOAK_ADMIN_USER="${admin_user}" \
ARTIFACT_SERVER_TEST_KEYCLOAK_CONTAINER="${container_name}" \
ARTIFACT_SERVER_TEST_KEYCLOAK_IMAGE="${keycloak_image}" \
ARTIFACT_SERVER_TEST_KEYCLOAK_URL="${keycloak_url}" \
pnpm exec vitest run --config vitest.oidc.config.ts \
  --reporter=default \
  --reporter=json \
  --outputFile.json=evidence/oidc-keycloak.json
