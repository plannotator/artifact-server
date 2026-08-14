#!/usr/bin/env bash
set -euo pipefail

artifactserver_repository=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
artifactserver_region="${ARTIFACT_SERVER_AWS_S3_PROBE_REGION:-$(aws configure get region)}"
if [[ -z "$artifactserver_region" ]]; then
  echo "Configure an AWS region or set ARTIFACT_SERVER_AWS_S3_PROBE_REGION." >&2
  exit 64
fi

artifactserver_account_id=$(aws sts get-caller-identity --query Account --output text)
artifactserver_run_id="$(date -u +%Y%m%d%H%M%S)-${RANDOM}"
artifactserver_bucket="artifact-server-probe-${artifactserver_account_id}-${artifactserver_run_id}"
artifactserver_created=false

cleanup() {
  if [[ "$artifactserver_created" == true && "$artifactserver_bucket" =~ ^artifact-server-probe-[0-9]+-[0-9]+-[0-9]+$ ]]; then
    while IFS=$'\t' read -r artifactserver_object_key artifactserver_upload_id; do
      if [[ -n "$artifactserver_object_key" && -n "$artifactserver_upload_id" ]]; then
        aws s3api abort-multipart-upload \
          --bucket "$artifactserver_bucket" \
          --key "$artifactserver_object_key" \
          --upload-id "$artifactserver_upload_id" >/dev/null 2>&1 || true
      fi
    done < <(aws s3api list-multipart-uploads \
      --bucket "$artifactserver_bucket" \
      --query 'Uploads[].[Key,UploadId]' \
      --output text 2>/dev/null || true)
    aws s3 rm "s3://${artifactserver_bucket}" --recursive >/dev/null 2>&1 || true
    aws s3api delete-bucket \
      --bucket "$artifactserver_bucket" \
      --region "$artifactserver_region" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT INT TERM

if [[ "$artifactserver_region" == "us-east-1" ]]; then
  aws s3api create-bucket \
    --bucket "$artifactserver_bucket" \
    --region "$artifactserver_region" >/dev/null
else
  aws s3api create-bucket \
    --bucket "$artifactserver_bucket" \
    --region "$artifactserver_region" \
    --create-bucket-configuration "LocationConstraint=${artifactserver_region}" \
    >/dev/null
fi
artifactserver_created=true

aws s3api put-public-access-block \
  --bucket "$artifactserver_bucket" \
  --region "$artifactserver_region" \
  --public-access-block-configuration \
    'BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true'
aws s3api put-bucket-encryption \
  --bucket "$artifactserver_bucket" \
  --region "$artifactserver_region" \
  --server-side-encryption-configuration \
    '{"Rules":[{"ApplyServerSideEncryptionByDefault":{"SSEAlgorithm":"AES256"}}]}'

cd "$artifactserver_repository"
ARTIFACT_SERVER_AWS_S3_PROBE_BUCKET="$artifactserver_bucket" \
ARTIFACT_SERVER_AWS_S3_PROBE_REGION="$artifactserver_region" \
pnpm exec vitest run \
  --config vitest.aws-s3-probe.config.ts \
  --reporter=default \
  --reporter=json \
  --outputFile.json=evidence/s3-aws-probe.json
