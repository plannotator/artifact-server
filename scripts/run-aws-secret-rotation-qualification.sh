#!/usr/bin/env bash
set -euo pipefail

repository_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
stack_name=${ARTIFACT_SERVER_AWS_QUALIFICATION_STACK:-aws-qualification}
aws_region=${AWS_REGION:-us-east-1}
evidence_path=${ARTIFACT_SERVER_AWS_ROTATION_EVIDENCE:-project/evidence/aws-secret-rotation.json}
product_evidence=${ARTIFACT_SERVER_AWS_ROTATION_PRODUCT_EVIDENCE:-project/evidence/aws-secret-rotation-product.json}

if [[ -z "${PULUMI_BACKEND_URL:-}" ]]; then
  echo "PULUMI_BACKEND_URL must identify the existing qualification backend." >&2
  exit 2
fi

cd "$repository_root"
deployment=$(pulumi stack output deployment \
  --stack "$stack_name" \
  --cwd deploy/pulumi/aws \
  --json)
application_url=$(jq -er '.applicationUrl' <<<"$deployment")
api_secret_arn=$(jq -er '.secretResourceIds.apiToken' <<<"$deployment")
runtime_arn=$(jq -er '.runtimeResourceId' <<<"$deployment")
service_path=${runtime_arn#*:service/}
cluster_name=${service_path%%/*}
service_name=${service_path#*/}

workspace=$(mktemp -d)
original_token_file="$workspace/original-token"
candidate_token_file="$workspace/candidate-token"
original_curl_file="$workspace/original.curl"
candidate_curl_file="$workspace/candidate.curl"
secret_restored=0
chmod 0700 "$workspace"

task_arn() {
  aws ecs list-tasks \
    --region "$aws_region" \
    --cluster "$cluster_name" \
    --service-name "$service_name" \
    --desired-status RUNNING \
    --query 'taskArns[0]' \
    --output text
}

force_deployment() {
  aws ecs update-service \
    --region "$aws_region" \
    --cluster "$cluster_name" \
    --service "$service_name" \
    --force-new-deployment >/dev/null
  aws ecs wait services-stable \
    --region "$aws_region" \
    --cluster "$cluster_name" \
    --services "$service_name"
}

put_token() {
  local token_file=$1
  aws secretsmanager put-secret-value \
    --region "$aws_region" \
    --secret-id "$api_secret_arn" \
    --secret-string "file://$token_file" >/dev/null
}

authentication_status() {
  local curl_file=$1
  curl --silent --show-error \
    --config "$curl_file" \
    --output /dev/null \
    --write-out '%{http_code}' \
    "$application_url/api/v1/projects?limit=1"
}

restore_original() {
  if (( secret_restored == 0 )); then
    put_token "$original_token_file" || true
    force_deployment || true
    secret_restored=1
  fi
}

cleanup() {
  restore_original
  rm -rf -- "$workspace"
}
trap cleanup EXIT

original_token=$(aws secretsmanager get-secret-value \
  --region "$aws_region" \
  --secret-id "$api_secret_arn" \
  --query SecretString \
  --output text)
printf '%s' "$original_token" > "$original_token_file"
unset original_token
openssl rand -hex 32 | tr -d '\n' > "$candidate_token_file"
chmod 0600 "$original_token_file" "$candidate_token_file"
printf 'header = "Authorization: Bearer %s"\n' \
  "$(<"$original_token_file")" > "$original_curl_file"
printf 'header = "Authorization: Bearer %s"\n' \
  "$(<"$candidate_token_file")" > "$candidate_curl_file"
chmod 0600 "$original_curl_file" "$candidate_curl_file"

started_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)
original_task=$(task_arn)
put_token "$candidate_token_file"
force_deployment
rotated_task=$(task_arn)
if [[ "$original_task" == "$rotated_task" ]]; then
  echo "ECS did not replace the running task after secret rotation." >&2
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

ARTIFACT_SERVER_AWS_QUALIFICATION_EVIDENCE="$product_evidence" \
  scripts/run-aws-deployment-product-qualification.sh

put_token "$original_token_file"
force_deployment
secret_restored=1
restored_task=$(task_arn)
if [[ "$rotated_task" == "$restored_task" ]]; then
  echo "ECS did not replace the running task while restoring the credential." >&2
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

completed_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)
jq -n \
  --arg completedAt "$completed_at" \
  --arg productEvidence "$product_evidence" \
  --arg startedAt "$started_at" \
  '{
    schemaVersion: 1,
    startedAt: $startedAt,
    completedAt: $completedAt,
    target: "aws",
    secretRotation: {
      newCredentialAccepted: true,
      previousCredentialRejected: true,
      originalCredentialRestored: true,
      qualificationCredentialRejectedAfterRestore: true
    },
    workloadIdentity: {
      taskReplacementObserved: true,
      providerChainProductEvidence: $productEvidence
    }
  }' > "$evidence_path"
