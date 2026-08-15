#!/usr/bin/env bash
set -euo pipefail

repository_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
stack_name=${ARTIFACT_SERVER_GCP_QUALIFICATION_STACK:-gcp-qualification}
evidence_path=${ARTIFACT_SERVER_GCP_QUALIFICATION_EVIDENCE:-evidence/gcp-deployment-product.json}

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
api_secret_resource=$(jq -er '.secretResourceIds.apiToken' <<<"$deployment")
api_secret_path=${api_secret_resource#projects/}
api_secret_project=${api_secret_path%%/*}
api_secret_id=${api_secret_resource##*/}
export ARTIFACT_SERVER_URL
ARTIFACT_SERVER_URL=$(jq -er '.applicationUrl' <<<"$deployment")
export ARTIFACT_SERVER_API_TOKEN
ARTIFACT_SERVER_API_TOKEN=$(gcloud secrets versions access latest \
  --project "$api_secret_project" \
  --secret "$api_secret_id")
export CLOUD_QUALIFICATION_TARGET=gcp
export CLOUD_QUALIFICATION_EVIDENCE_PATH="$evidence_path"

cleanup() {
  unset ARTIFACT_SERVER_API_TOKEN
}
trap cleanup EXIT

pnpm build >/dev/null
node --import tsx scripts/qualify-deployed-product.ts
