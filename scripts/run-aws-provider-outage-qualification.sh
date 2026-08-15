#!/usr/bin/env bash
set -euo pipefail

repository_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
stack_name=${ARTIFACT_SERVER_AWS_QUALIFICATION_STACK:-aws-qualification}
evidence_path=${ARTIFACT_SERVER_AWS_OUTAGE_EVIDENCE:-evidence/aws-provider-outage.json}

if [[ -z "${PULUMI_BACKEND_URL:-}" ]]; then
  echo "PULUMI_BACKEND_URL must identify the existing qualification backend." >&2
  exit 2
fi

cd "$repository_root"
deployment=$(pulumi stack output deployment \
  --stack "$stack_name" \
  --cwd deploy/pulumi/aws \
  --json)
bucket_arn=$(jq -er '.objectStorageResourceId' <<<"$deployment")
bucket_name=${bucket_arn#arn:aws:s3:::}
readiness_url=$(jq -er '.readinessUrl' <<<"$deployment")
started_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)
original_policy_file=$(mktemp)
outage_policy_file=$(mktemp)
outage_response_file=$(mktemp)
recovery_response_file=$(mktemp)
policy_changed=0

restore_provider() {
  if (( policy_changed == 1 )); then
    aws s3api put-bucket-policy \
      --bucket "$bucket_name" \
      --policy "file://$original_policy_file" >/dev/null 2>&1 || true
    policy_changed=0
  fi
}

cleanup() {
  restore_provider
  rm -f \
    "$original_policy_file" \
    "$outage_policy_file" \
    "$outage_response_file" \
    "$recovery_response_file"
}
trap cleanup EXIT

aws s3api get-bucket-policy \
  --bucket "$bucket_name" \
  --query Policy \
  --output text > "$original_policy_file"
jq -e '.Version == "2012-10-17" and (.Statement | type == "array")' \
  "$original_policy_file" >/dev/null

jq --arg bucket "$bucket_arn" '.Statement += [{
    Sid: "QualificationProviderOutage",
    Effect: "Deny",
    Principal: "*",
    Action: [
      "s3:GetBucketLocation",
      "s3:GetObject",
      "s3:ListBucket",
      "s3:PutObject"
    ],
    Resource: [$bucket, ($bucket + "/*")]
  }]' "$original_policy_file" > "$outage_policy_file"
aws s3api put-bucket-policy \
  --bucket "$bucket_name" \
  --policy "file://$outage_policy_file"
policy_changed=1

outage_deadline=$((SECONDS + 120))
outage_status=0
while (( SECONDS < outage_deadline )); do
  outage_status=$(curl -sS -o "$outage_response_file" \
    -w '%{http_code}' \
    --max-time 10 \
    "$readiness_url" || true)
  if [[ "$outage_status" == "503" ]] &&
    jq -e '.status == "not_ready" and .components.objectStorage.status == "unavailable"' \
      "$outage_response_file" >/dev/null; then
    break
  fi
  sleep 2
done
if [[ "$outage_status" != "503" ]]; then
  echo "Object-storage outage did not withdraw readiness within 120 seconds." >&2
  exit 1
fi

restore_provider
recovery_deadline=$((SECONDS + 120))
recovery_status=0
while (( SECONDS < recovery_deadline )); do
  recovery_status=$(curl -sS -o "$recovery_response_file" \
    -w '%{http_code}' \
    --max-time 10 \
    "$readiness_url" || true)
  if [[ "$recovery_status" == "200" ]] &&
    jq -e '.status == "ready" and .components.objectStorage.status == "ready"' \
      "$recovery_response_file" >/dev/null; then
    break
  fi
  sleep 2
done
if [[ "$recovery_status" != "200" ]]; then
  echo "Object storage did not recover within 120 seconds." >&2
  exit 1
fi

completed_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)
jq -n \
  --arg completedAt "$completed_at" \
  --arg startedAt "$started_at" \
  '{
    schemaVersion: 1,
    startedAt: $startedAt,
    completedAt: $completedAt,
    target: "aws",
    provider: "s3",
    outage: {readinessStatus: 503, componentStatus: "unavailable"},
    recovery: {readinessStatus: 200, componentStatus: "ready"}
  }' > "$evidence_path"
