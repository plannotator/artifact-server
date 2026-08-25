#!/usr/bin/env bash
set -euo pipefail

repository_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
stack_name=${ARTIFACT_SERVER_GCP_QUALIFICATION_STACK:-gcp-qualification}
evidence_path=${ARTIFACT_SERVER_GCP_STATE_EVIDENCE:-project/evidence/gcp-state-recovery.json}

if [[ -z "${PULUMI_BACKEND_URL:-}" ]]; then
  echo "PULUMI_BACKEND_URL must identify the existing qualification backend." >&2
  exit 2
fi
if [[ "$PULUMI_BACKEND_URL" != gs://* ]]; then
  echo "The GCP qualification backend must be a GCS URL." >&2
  exit 2
fi

cd "$repository_root"
pulumi login "$PULUMI_BACKEND_URL" >/dev/null
export_before=$(mktemp)
export_after=$(mktemp)
identities_before=$(mktemp)
identities_after=$(mktemp)

cleanup() {
  rm -f "$export_before" "$export_after" "$identities_before" "$identities_after"
}
trap cleanup EXIT

started_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)
pulumi stack export \
  --stack "$stack_name" \
  --cwd deploy/pulumi/gcp \
  --file "$export_before"
resource_count=$(jq -er '.deployment.resources | length | select(. > 0)' \
  "$export_before")
jq -S '[.deployment.resources[] | {custom, delete, id, parent, provider, type, urn}]' \
  "$export_before" > "$identities_before"

pulumi stack import \
  --non-interactive \
  --stack "$stack_name" \
  --cwd deploy/pulumi/gcp \
  --file "$export_before"
pulumi stack export \
  --stack "$stack_name" \
  --cwd deploy/pulumi/gcp \
  --file "$export_after"
jq -S '[.deployment.resources[] | {custom, delete, id, parent, provider, type, urn}]' \
  "$export_after" > "$identities_after"
cmp "$identities_before" "$identities_after"
pulumi preview \
  --non-interactive \
  --expect-no-changes \
  --stack "$stack_name" \
  --cwd deploy/pulumi/gcp >/dev/null

backend_without_scheme=${PULUMI_BACKEND_URL#gs://}
backend_bucket=${backend_without_scheme%%/*}
versioning_enabled=$(gcloud storage buckets describe "gs://$backend_bucket" \
  --format='value(versioning_enabled)')
if [[ "$versioning_enabled" != "True" ]]; then
  echo "The Pulumi state bucket must have versioning enabled." >&2
  exit 1
fi

identity_checksum=$(shasum -a 256 "$identities_after" | awk '{print $1}')
completed_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)
jq -n \
  --arg completedAt "$completed_at" \
  --arg identityChecksum "$identity_checksum" \
  --arg startedAt "$started_at" \
  --argjson resourceCount "$resource_count" \
  '{
    schemaVersion: 1,
    startedAt: $startedAt,
    completedAt: $completedAt,
    target: "gcp",
    stateBackend: "gcs",
    backendVersioning: "enabled",
    resourceCount: $resourceCount,
    resourceIdentityChecksum: $identityChecksum,
    exactStateImport: "passed",
    postImportPreview: "no_changes"
  }' > "$evidence_path"
