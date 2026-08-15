#!/usr/bin/env bash
set -euo pipefail

repository_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
stack_name=${ARTIFACT_SERVER_GCP_QUALIFICATION_STACK:-gcp-qualification}
candidate_image=${ARTIFACT_SERVER_GCP_UPGRADE_IMAGE:-}
evidence_path=${ARTIFACT_SERVER_GCP_UPGRADE_EVIDENCE:-evidence/gcp-upgrade-rollback.json}
upgrade_evidence=${ARTIFACT_SERVER_GCP_UPGRADE_PRODUCT_EVIDENCE:-evidence/gcp-upgrade.json}
rollback_evidence=${ARTIFACT_SERVER_GCP_ROLLBACK_PRODUCT_EVIDENCE:-evidence/gcp-rollback.json}

if [[ -z "${PULUMI_BACKEND_URL:-}" ]]; then
  echo "PULUMI_BACKEND_URL must identify the existing qualification backend." >&2
  exit 2
fi
if [[ ! "$candidate_image" =~ @sha256:[a-f0-9]{64}$ ]]; then
  echo "ARTIFACT_SERVER_GCP_UPGRADE_IMAGE must be an immutable image digest reference." >&2
  exit 2
fi

cd "$repository_root"
pulumi login "$PULUMI_BACKEND_URL" >/dev/null
original_image=$(pulumi config get imageReference \
  --stack "$stack_name" \
  --cwd deploy/pulumi/gcp)
if [[ ! "$original_image" =~ @sha256:[a-f0-9]{64}$ ]]; then
  echo "The deployed imageReference is not an immutable digest reference." >&2
  exit 2
fi
if [[ "$candidate_image" == "$original_image" ]]; then
  echo "The qualification image must differ from the deployed image." >&2
  exit 2
fi

before_file=$(mktemp)
upgrade_file=$(mktemp)
rollback_file=$(mktemp)
original_restored=0

stack_output() {
  pulumi stack output deployment \
    --stack "$stack_name" \
    --cwd deploy/pulumi/gcp \
    --json
}

apply_image() {
  local image_reference=$1
  pulumi config set imageReference "$image_reference" \
    --stack "$stack_name" \
    --cwd deploy/pulumi/gcp
  pulumi up \
    --stack "$stack_name" \
    --cwd deploy/pulumi/gcp \
    --yes \
    --skip-preview \
    --non-interactive
}

restore_original() {
  if (( original_restored == 0 )); then
    pulumi config set imageReference "$original_image" \
      --stack "$stack_name" \
      --cwd deploy/pulumi/gcp >/dev/null 2>&1 || true
    pulumi up \
      --stack "$stack_name" \
      --cwd deploy/pulumi/gcp \
      --yes \
      --skip-preview \
      --non-interactive >/dev/null 2>&1 || true
  fi
}

cleanup() {
  restore_original
  rm -f "$before_file" "$upgrade_file" "$rollback_file"
}
trap cleanup EXIT

started_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)
stack_output > "$before_file"

apply_image "$candidate_image"
stack_output > "$upgrade_file"
ARTIFACT_SERVER_GCP_QUALIFICATION_EVIDENCE="$upgrade_evidence" \
  scripts/run-gcp-deployment-product-qualification.sh

apply_image "$original_image"
original_restored=1
stack_output > "$rollback_file"
ARTIFACT_SERVER_GCP_QUALIFICATION_EVIDENCE="$rollback_evidence" \
  scripts/run-gcp-deployment-product-qualification.sh

for field in installationId databaseResourceId objectStorageResourceId; do
  before_value=$(jq -er --arg field "$field" '.[$field]' "$before_file")
  upgrade_value=$(jq -er --arg field "$field" '.[$field]' "$upgrade_file")
  rollback_value=$(jq -er --arg field "$field" '.[$field]' "$rollback_file")
  if [[ "$before_value" != "$upgrade_value" ]] ||
    [[ "$before_value" != "$rollback_value" ]]; then
    echo "The $field identity changed during upgrade or rollback." >&2
    exit 1
  fi
done

completed_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)
jq -n \
  --arg candidateImage "$candidate_image" \
  --arg completedAt "$completed_at" \
  --arg originalImage "$original_image" \
  --arg rollbackEvidence "$rollback_evidence" \
  --arg startedAt "$started_at" \
  --arg upgradeEvidence "$upgrade_evidence" \
  '{
    schemaVersion: 1,
    startedAt: $startedAt,
    completedAt: $completedAt,
    target: "gcp",
    originalImage: $originalImage,
    candidateImage: $candidateImage,
    upgrade: {productEvidence: $upgradeEvidence, stableResourceIdentity: true},
    rollback: {productEvidence: $rollbackEvidence, stableResourceIdentity: true}
  }' > "$evidence_path"
