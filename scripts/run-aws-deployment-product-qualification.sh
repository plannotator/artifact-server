#!/usr/bin/env bash
set -euo pipefail

repository_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
stack_name=${ARTIFACT_SERVER_AWS_QUALIFICATION_STACK:-aws-qualification}
aws_region=${AWS_REGION:-us-east-1}
evidence_path=${ARTIFACT_SERVER_AWS_QUALIFICATION_EVIDENCE:-project/evidence/aws-deployment-product.json}

if [[ -z "${PULUMI_BACKEND_URL:-}" ]]; then
  echo "PULUMI_BACKEND_URL must identify the existing qualification backend." >&2
  exit 2
fi

cd "$repository_root"
deployment=$(pulumi stack output deployment \
  --stack "$stack_name" \
  --cwd deploy/pulumi/aws \
  --json)
api_secret_arn=$(jq -er '.secretResourceIds.apiToken' <<<"$deployment")
export ARTIFACT_SERVER_URL
ARTIFACT_SERVER_URL=$(jq -er '.applicationUrl' <<<"$deployment")
export ARTIFACT_SERVER_API_TOKEN
ARTIFACT_SERVER_API_TOKEN=$(aws secretsmanager get-secret-value \
  --region "$aws_region" \
  --secret-id "$api_secret_arn" \
  --query SecretString \
  --output text)
export CLOUD_QUALIFICATION_TARGET=aws
export CLOUD_QUALIFICATION_EVIDENCE_PATH="$evidence_path"

cleanup() {
  unset ARTIFACT_SERVER_API_TOKEN
}
trap cleanup EXIT

pnpm build >/dev/null
node --import tsx scripts/qualify-deployed-product.ts
