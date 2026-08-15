#!/usr/bin/env bash
set -euo pipefail

repository_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
stack_name=${ARTIFACT_SERVER_AWS_QUALIFICATION_STACK:-aws-qualification}
aws_region=${AWS_REGION:-us-east-1}

if [[ -z "${PULUMI_BACKEND_URL:-}" ]]; then
  echo "PULUMI_BACKEND_URL must identify the existing qualification backend." >&2
  exit 2
fi

cd "$repository_root"
deployment=$(pulumi stack output deployment \
  --stack "$stack_name" \
  --cwd deploy/pulumi/aws \
  --json)
runtime_arn=$(jq -er '.runtimeResourceId' <<<"$deployment")
service_path=${runtime_arn#*:service/}
cluster_name=${service_path%%/*}
service_name=${service_path#*/}
resource_id="service/$cluster_name/$service_name"

service=$(aws ecs describe-services \
  --region "$aws_region" \
  --cluster "$cluster_name" \
  --services "$service_name")
original_desired=$(jq -er '.services[0].desiredCount' <<<"$service")
scaling_target=$(aws application-autoscaling describe-scalable-targets \
  --region "$aws_region" \
  --service-namespace ecs \
  --resource-ids "$resource_id" \
  --scalable-dimension ecs:service:DesiredCount)
original_minimum=$(jq -er '.ScalableTargets[0].MinCapacity' <<<"$scaling_target")
original_maximum=$(jq -er '.ScalableTargets[0].MaxCapacity' <<<"$scaling_target")

restore_capacity() {
  aws application-autoscaling register-scalable-target \
    --region "$aws_region" \
    --service-namespace ecs \
    --resource-id "$resource_id" \
    --scalable-dimension ecs:service:DesiredCount \
    --min-capacity "$original_minimum" \
    --max-capacity "$original_maximum" >/dev/null
  aws ecs update-service \
    --region "$aws_region" \
    --cluster "$cluster_name" \
    --service "$service_name" \
    --desired-count "$original_desired" >/dev/null
  aws ecs wait services-stable \
    --region "$aws_region" \
    --cluster "$cluster_name" \
    --services "$service_name"
}
trap restore_capacity EXIT

aws application-autoscaling register-scalable-target \
  --region "$aws_region" \
  --service-namespace ecs \
  --resource-id "$resource_id" \
  --scalable-dimension ecs:service:DesiredCount \
  --min-capacity 2 \
  --max-capacity 2 >/dev/null
aws ecs update-service \
  --region "$aws_region" \
  --cluster "$cluster_name" \
  --service "$service_name" \
  --desired-count 2 >/dev/null
aws ecs wait services-stable \
  --region "$aws_region" \
  --cluster "$cluster_name" \
  --services "$service_name"

running=$(aws ecs describe-services \
  --region "$aws_region" \
  --cluster "$cluster_name" \
  --services "$service_name" \
  --query 'services[0].runningCount' \
  --output text)
if [[ "$running" != "2" ]]; then
  echo "Expected two running ECS tasks; found $running." >&2
  exit 1
fi

export ARTIFACT_SERVER_AWS_QUALIFICATION_EVIDENCE=\
"evidence/aws-deployment-horizontal.json"
scripts/run-aws-deployment-product-qualification.sh
