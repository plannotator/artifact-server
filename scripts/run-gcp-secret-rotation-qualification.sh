#!/usr/bin/env bash
set -euo pipefail

repository_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
stack_name=${ARTIFACT_SERVER_GCP_QUALIFICATION_STACK:-gcp-qualification}
evidence_path=${ARTIFACT_SERVER_GCP_ROTATION_EVIDENCE:-evidence/gcp-secret-rotation.json}
product_evidence=${ARTIFACT_SERVER_GCP_ROTATION_PRODUCT_EVIDENCE:-evidence/gcp-secret-rotation-product.json}

if [[ -z "${PULUMI_BACKEND_URL:-}" ]]; then
  echo "PULUMI_BACKEND_URL must identify the existing qualification backend." >&2
  exit 2
fi

cd "$repository_root"
pulumi login "$PULUMI_BACKEND_URL" >/dev/null
deployment=$(pulumi stack output deployment \
  --stack "$stack_name" \
  --cwd deploy/pulumi/gcp \
  --json)
application_url=$(jq -er '.applicationUrl' <<<"$deployment")
api_secret_resource=$(jq -er '.secretResourceIds.apiToken' <<<"$deployment")
runtime_resource=$(jq -er '.runtimeResourceId' <<<"$deployment")
api_secret_path=${api_secret_resource#projects/}
project_id=${api_secret_path%%/*}
api_secret_id=${api_secret_resource##*/}
runtime_path=${runtime_resource#projects/}
runtime_path=${runtime_path#*/locations/}
region=${runtime_path%%/*}
service_name=${runtime_resource##*/}

workspace=$(mktemp -d)
original_token_file="$workspace/original-token"
candidate_token_file="$workspace/candidate-token"
original_curl_file="$workspace/original.curl"
candidate_curl_file="$workspace/candidate.curl"
candidate_version=""
original_restored=0
original_token_loaded=0
cleanup_required=1
chmod 0700 "$workspace"

latest_revision() {
  gcloud run services describe "$service_name" \
    --project "$project_id" \
    --region "$region" \
    --format='value(status.latestReadyRevisionName)'
}

rollout() {
  local nonce=$1
  gcloud run services update "$service_name" \
    --project "$project_id" \
    --region "$region" \
    --update-env-vars "ARTIFACT_SERVER_SECRET_ROTATION_NONCE=$nonce" \
    --quiet >/dev/null
}

add_secret_version() {
  local token_file=$1
  gcloud secrets versions add "$api_secret_id" \
    --project "$project_id" \
    --data-file "$token_file" \
    --format='value(name)'
}

authentication_status() {
  local curl_file=$1
  curl --silent --show-error \
    --config "$curl_file" \
    --output /dev/null \
    --write-out '%{http_code}' \
    "$application_url/api/v1/projects?limit=1"
}

reconcile_pulumi() {
  gcloud run services update "$service_name" \
    --project "$project_id" \
    --region "$region" \
    --remove-env-vars ARTIFACT_SERVER_SECRET_ROTATION_NONCE \
    --quiet >/dev/null
  pulumi up \
    --stack "$stack_name" \
    --cwd deploy/pulumi/gcp \
    --yes \
    --skip-preview \
    --non-interactive >/dev/null
}

verify_no_drift() {
  pulumi preview \
    --stack "$stack_name" \
    --cwd deploy/pulumi/gcp \
    --expect-no-changes \
    --non-interactive >/dev/null
}

destroy_candidate_version() {
  if [[ -n "$candidate_version" ]]; then
    gcloud secrets versions destroy "${candidate_version##*/}" \
      --secret "$api_secret_id" \
      --project "$project_id" \
      --quiet >/dev/null || true
    candidate_version=""
  fi
}

restore_original() {
  if (( original_token_loaded == 1 && original_restored == 0 )); then
    add_secret_version "$original_token_file" >/dev/null || true
    rollout "restore-$(date +%s)-$RANDOM" || true
    original_restored=1
  fi
  destroy_candidate_version
  reconcile_pulumi || true
}

cleanup() {
  if (( cleanup_required == 1 )); then
    restore_original
  fi
  rm -rf -- "$workspace"
}
trap cleanup EXIT

gcloud secrets versions access latest \
  --project "$project_id" \
  --secret "$api_secret_id" > "$original_token_file"
original_token_loaded=1
openssl rand -hex 32 | tr -d '\n' > "$candidate_token_file"
chmod 0600 "$original_token_file" "$candidate_token_file"
printf 'header = "Authorization: Bearer %s"\n' \
  "$(<"$original_token_file")" > "$original_curl_file"
printf 'header = "Authorization: Bearer %s"\n' \
  "$(<"$candidate_token_file")" > "$candidate_curl_file"
chmod 0600 "$original_curl_file" "$candidate_curl_file"

started_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)
original_revision=$(latest_revision)
candidate_version=$(add_secret_version "$candidate_token_file")
rollout "candidate-$(date +%s)-$RANDOM"
rotated_revision=$(latest_revision)
if [[ "$original_revision" == "$rotated_revision" ]]; then
  echo "Cloud Run did not create a revision after secret rotation." >&2
  exit 1
fi
if [[ "$(authentication_status "$candidate_curl_file")" != "200" ]]; then
  echo "The rotated API credential was not accepted." >&2
  exit 1
fi
if [[ "$(authentication_status "$original_curl_file")" != "401" ]]; then
  echo "The previous API credential remained active after rotation." >&2
  exit 1
fi

ARTIFACT_SERVER_GCP_QUALIFICATION_EVIDENCE="$product_evidence" \
  scripts/run-gcp-deployment-product-qualification.sh

add_secret_version "$original_token_file" >/dev/null
rollout "restore-$(date +%s)-$RANDOM"
original_restored=1
restored_revision=$(latest_revision)
if [[ "$rotated_revision" == "$restored_revision" ]]; then
  echo "Cloud Run did not create a revision while restoring the credential." >&2
  exit 1
fi
if [[ "$(authentication_status "$original_curl_file")" != "200" ]]; then
  echo "The original API credential was not restored." >&2
  exit 1
fi
if [[ "$(authentication_status "$candidate_curl_file")" != "401" ]]; then
  echo "The qualification credential remained active after restoration." >&2
  exit 1
fi
destroy_candidate_version
reconcile_pulumi
verify_no_drift
cleanup_required=0

completed_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)
jq -n \
  --arg completedAt "$completed_at" \
  --arg productEvidence "$product_evidence" \
  --arg startedAt "$started_at" \
  '{
    schemaVersion: 1,
    startedAt: $startedAt,
    completedAt: $completedAt,
    target: "gcp",
    secretRotation: {
      newCredentialAccepted: true,
      previousCredentialRejected: true,
      originalCredentialRestored: true,
      qualificationCredentialRejectedAfterRestore: true,
      qualificationSecretVersionDestroyed: true
    },
    workloadIdentity: {
      revisionReplacementObserved: true,
      providerChainProductEvidence: $productEvidence
    },
    reconciliation: {
      temporaryRolloutMarkerRemoved: true,
      pulumiNoChanges: true
    }
  }' > "$evidence_path"
