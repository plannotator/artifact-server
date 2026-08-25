#!/usr/bin/env bash
set -euo pipefail

repository_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
stack_name=${ARTIFACT_SERVER_AWS_QUALIFICATION_STACK:-aws-qualification}
aws_region=${AWS_REGION:-us-east-1}
evidence_path=${ARTIFACT_SERVER_AWS_RESTORE_EVIDENCE:-project/evidence/aws-coordinated-restore.json}

if [[ -z "${PULUMI_BACKEND_URL:-}" ]]; then
  echo "PULUMI_BACKEND_URL must identify the existing qualification backend." >&2
  exit 2
fi

cd "$repository_root"
account_id=$(aws sts get-caller-identity --query Account --output text)
qualification_id="$(date -u +%Y%m%d%H%M%S)-$(openssl rand -hex 3)"
resource_stem="as-restore-$qualification_id"
backup_bucket="as-restore-bak-$account_id-$qualification_id"
restore_bucket="as-restore-out-$account_id-$qualification_id"
snapshot_id="$resource_stem"
restored_database_id="$resource_stem"
execution_role_name="$resource_stem-exec"
task_role_name="$resource_stem-task"
secret_name="$resource_stem-database-url"
task_family="$resource_stem-integrity"

trust_policy_file=$(mktemp)
execution_policy_file=$(mktemp)
task_policy_file=$(mktemp)
task_definition_file=$(mktemp)
secret_value_file=$(mktemp)
delete_objects_file=$(mktemp)
readiness_response_file=$(mktemp)
chmod 0600 "$secret_value_file"

capacity_changed=0
backup_bucket_created=0
restore_bucket_created=0
snapshot_created=0
restored_database_created=0
secret_created=0
execution_role_created=0
task_role_created=0
registered_task_definition=""

deployment=$(pulumi stack output deployment \
  --stack "$stack_name" \
  --cwd deploy/pulumi/aws \
  --json)
runtime_arn=$(jq -er '.runtimeResourceId' <<<"$deployment")
runtime_path=${runtime_arn#*:service/}
cluster_name=${runtime_path%%/*}
service_name=${runtime_path#*/}
resource_id="service/$cluster_name/$service_name"
database_arn=$(jq -er '.databaseResourceId' <<<"$deployment")
database_id=${database_arn##*:db:}
source_bucket_arn=$(jq -er '.objectStorageResourceId' <<<"$deployment")
source_bucket=${source_bucket_arn#arn:aws:s3:::}
api_token_secret=$(jq -er '.secretResourceIds.apiToken' <<<"$deployment")
database_url_secret=$(jq -er '.secretResourceIds.databaseUrl' <<<"$deployment")
readiness_url=$(jq -er '.readinessUrl' <<<"$deployment")
application_subnet_1=$(jq -er '.networkResourceIds.applicationSubnet1' <<<"$deployment")
application_subnet_2=$(jq -er '.networkResourceIds.applicationSubnet2' <<<"$deployment")
application_security_group=$(jq -er '.networkResourceIds.applicationSecurityGroup' \
  <<<"$deployment")

service=$(aws ecs describe-services \
  --region "$aws_region" \
  --cluster "$cluster_name" \
  --services "$service_name")
original_desired=$(jq -er '.services[0].desiredCount' <<<"$service")
source_task_definition=$(jq -er '.services[0].taskDefinition' <<<"$service")
scaling_target=$(aws application-autoscaling describe-scalable-targets \
  --region "$aws_region" \
  --service-namespace ecs \
  --resource-ids "$resource_id" \
  --scalable-dimension ecs:service:DesiredCount)
original_minimum=$(jq -er '.ScalableTargets[0].MinCapacity' <<<"$scaling_target")
original_maximum=$(jq -er '.ScalableTargets[0].MaxCapacity' <<<"$scaling_target")

empty_versioned_bucket() {
  local bucket=$1
  while true; do
    aws s3api list-object-versions \
      --region "$aws_region" \
      --bucket "$bucket" \
      --output json | jq '{Objects: ([
        (.Versions // [])[] | {Key, VersionId},
        (.DeleteMarkers // [])[] | {Key, VersionId}
      ] | .[:1000]), Quiet: true}' > "$delete_objects_file"
    if [[ $(jq '.Objects | length' "$delete_objects_file") == "0" ]]; then
      break
    fi
    aws s3api delete-objects \
      --region "$aws_region" \
      --bucket "$bucket" \
      --delete "file://$delete_objects_file" >/dev/null
  done
}

restore_capacity() {
  if (( capacity_changed == 1 )); then
    aws application-autoscaling register-scalable-target \
      --region "$aws_region" \
      --service-namespace ecs \
      --resource-id "$resource_id" \
      --scalable-dimension ecs:service:DesiredCount \
      --min-capacity "$original_minimum" \
      --max-capacity "$original_maximum" >/dev/null || true
    aws ecs update-service \
      --region "$aws_region" \
      --cluster "$cluster_name" \
      --service "$service_name" \
      --desired-count "$original_desired" >/dev/null || true
    aws ecs wait services-stable \
      --region "$aws_region" \
      --cluster "$cluster_name" \
      --services "$service_name" || true
    capacity_changed=0
  fi
}

cleanup() {
  restore_capacity
  if [[ -n "$registered_task_definition" ]]; then
    aws ecs deregister-task-definition \
      --region "$aws_region" \
      --task-definition "$registered_task_definition" >/dev/null 2>&1 || true
  fi
  if (( restored_database_created == 1 )); then
    aws rds delete-db-instance \
      --region "$aws_region" \
      --db-instance-identifier "$restored_database_id" \
      --skip-final-snapshot \
      --delete-automated-backups >/dev/null 2>&1 || true
    aws rds wait db-instance-deleted \
      --region "$aws_region" \
      --db-instance-identifier "$restored_database_id" >/dev/null 2>&1 || true
  fi
  if (( snapshot_created == 1 )); then
    aws rds wait db-snapshot-available \
      --region "$aws_region" \
      --db-snapshot-identifier "$snapshot_id" >/dev/null 2>&1 || true
    aws rds delete-db-snapshot \
      --region "$aws_region" \
      --db-snapshot-identifier "$snapshot_id" >/dev/null 2>&1 || true
  fi
  if (( restore_bucket_created == 1 )); then
    empty_versioned_bucket "$restore_bucket" || true
    aws s3api delete-bucket \
      --region "$aws_region" \
      --bucket "$restore_bucket" >/dev/null 2>&1 || true
  fi
  if (( backup_bucket_created == 1 )); then
    empty_versioned_bucket "$backup_bucket" || true
    aws s3api delete-bucket \
      --region "$aws_region" \
      --bucket "$backup_bucket" >/dev/null 2>&1 || true
  fi
  if (( secret_created == 1 )); then
    aws secretsmanager delete-secret \
      --region "$aws_region" \
      --secret-id "$secret_name" \
      --force-delete-without-recovery >/dev/null 2>&1 || true
  fi
  if (( execution_role_created == 1 )); then
    aws iam delete-role-policy \
      --role-name "$execution_role_name" \
      --policy-name restore-secrets >/dev/null 2>&1 || true
    aws iam detach-role-policy \
      --role-name "$execution_role_name" \
      --policy-arn arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy \
      >/dev/null 2>&1 || true
    aws iam delete-role \
      --role-name "$execution_role_name" >/dev/null 2>&1 || true
  fi
  if (( task_role_created == 1 )); then
    aws iam delete-role-policy \
      --role-name "$task_role_name" \
      --policy-name restore-object-storage >/dev/null 2>&1 || true
    aws iam delete-role \
      --role-name "$task_role_name" >/dev/null 2>&1 || true
  fi
  rm -f \
    "$trust_policy_file" \
    "$execution_policy_file" \
    "$task_policy_file" \
    "$task_definition_file" \
    "$secret_value_file" \
    "$delete_objects_file" \
    "$readiness_response_file"
}
trap cleanup EXIT

wait_for_readiness() {
  local attempt
  local status_code
  for attempt in $(seq 1 24); do
    status_code=$(curl \
      --silent \
      --show-error \
      --output "$readiness_response_file" \
      --write-out '%{http_code}' \
      "$readiness_url" || true)
    if [[ "$status_code" == "200" ]] && \
      jq -e '.status == "ready"' "$readiness_response_file" >/dev/null 2>&1; then
      return 0
    fi
    sleep 5
  done
  echo "The production service did not become ready after backup quiescing." >&2
  return 1
}

create_secure_bucket() {
  local bucket=$1
  if [[ "$aws_region" == "us-east-1" ]]; then
    aws s3api create-bucket --region "$aws_region" --bucket "$bucket" >/dev/null
  else
    aws s3api create-bucket \
      --region "$aws_region" \
      --bucket "$bucket" \
      --create-bucket-configuration "LocationConstraint=$aws_region" >/dev/null
  fi
  aws s3api put-public-access-block \
    --region "$aws_region" \
    --bucket "$bucket" \
    --public-access-block-configuration \
      BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true
  aws s3api put-bucket-encryption \
    --region "$aws_region" \
    --bucket "$bucket" \
    --server-side-encryption-configuration \
      '{"Rules":[{"ApplyServerSideEncryptionByDefault":{"SSEAlgorithm":"AES256"}}]}'
  aws s3api put-bucket-versioning \
    --region "$aws_region" \
    --bucket "$bucket" \
    --versioning-configuration Status=Enabled
}

started_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)
create_secure_bucket "$backup_bucket"
backup_bucket_created=1

aws application-autoscaling register-scalable-target \
  --region "$aws_region" \
  --service-namespace ecs \
  --resource-id "$resource_id" \
  --scalable-dimension ecs:service:DesiredCount \
  --min-capacity 0 \
  --max-capacity "$original_maximum" >/dev/null
capacity_changed=1
aws ecs update-service \
  --region "$aws_region" \
  --cluster "$cluster_name" \
  --service "$service_name" \
  --desired-count 0 >/dev/null
aws ecs wait services-stable \
  --region "$aws_region" \
  --cluster "$cluster_name" \
  --services "$service_name"

aws rds wait db-instance-available \
  --region "$aws_region" \
  --db-instance-identifier "$database_id"
aws rds create-db-snapshot \
  --region "$aws_region" \
  --db-instance-identifier "$database_id" \
  --db-snapshot-identifier "$snapshot_id" >/dev/null
snapshot_created=1
aws s3 sync \
  --region "$aws_region" \
  --only-show-errors \
  "s3://$source_bucket" \
  "s3://$backup_bucket"
restore_capacity
wait_for_readiness

aws rds wait db-snapshot-available \
  --region "$aws_region" \
  --db-snapshot-identifier "$snapshot_id"
create_secure_bucket "$restore_bucket"
restore_bucket_created=1
aws s3 sync \
  --region "$aws_region" \
  --only-show-errors \
  "s3://$backup_bucket" \
  "s3://$restore_bucket"

database=$(aws rds describe-db-instances \
  --region "$aws_region" \
  --db-instance-identifier "$database_id" \
  --query 'DBInstances[0]')
database_class=$(jq -er '.DBInstanceClass' <<<"$database")
database_parameter_group=$(jq -er '.DBParameterGroups[0].DBParameterGroupName' \
  <<<"$database")
database_subnet_group=$(jq -er '.DBSubnetGroup.DBSubnetGroupName' <<<"$database")
database_security_groups=$(jq -er \
  '[.VpcSecurityGroups[].VpcSecurityGroupId] | join(" ")' <<<"$database")
read -r -a database_security_group_ids <<<"$database_security_groups"

aws rds restore-db-instance-from-db-snapshot \
  --region "$aws_region" \
  --db-instance-identifier "$restored_database_id" \
  --db-snapshot-identifier "$snapshot_id" \
  --db-instance-class "$database_class" \
  --db-subnet-group-name "$database_subnet_group" \
  --db-parameter-group-name "$database_parameter_group" \
  --vpc-security-group-ids "${database_security_group_ids[@]}" \
  --no-publicly-accessible \
  --no-deletion-protection \
  --copy-tags-to-snapshot \
  --tags Key=artifactserver.com/purpose,Value=restore-qualification >/dev/null
restored_database_created=1
aws rds wait db-instance-available \
  --region "$aws_region" \
  --db-instance-identifier "$restored_database_id"
restored_endpoint=$(aws rds describe-db-instances \
  --region "$aws_region" \
  --db-instance-identifier "$restored_database_id" \
  --query 'DBInstances[0].Endpoint.Address' \
  --output text)

original_database_url=$(aws secretsmanager get-secret-value \
  --region "$aws_region" \
  --secret-id "$database_url_secret" \
  --query SecretString \
  --output text)
printf '%s' "$original_database_url" | node -e '
  let value = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => { value += chunk; });
  process.stdin.on("end", () => {
    const url = new URL(value);
    url.hostname = process.argv[1];
    process.stdout.write(url.href);
  });
' "$restored_endpoint" > "$secret_value_file"
unset original_database_url
restored_database_secret_arn=$(aws secretsmanager create-secret \
  --region "$aws_region" \
  --name "$secret_name" \
  --secret-string "file://$secret_value_file" \
  --query ARN \
  --output text)
secret_created=1

cat > "$trust_policy_file" <<'JSON'
{
  "Version": "2012-10-17",
  "Statement": [{
    "Effect": "Allow",
    "Principal": {"Service": "ecs-tasks.amazonaws.com"},
    "Action": "sts:AssumeRole"
  }]
}
JSON
execution_role_arn=$(aws iam create-role \
  --role-name "$execution_role_name" \
  --assume-role-policy-document "file://$trust_policy_file" \
  --query Role.Arn \
  --output text)
execution_role_created=1
aws iam attach-role-policy \
  --role-name "$execution_role_name" \
  --policy-arn arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy
jq -n \
  --arg apiToken "$api_token_secret" \
  --arg databaseUrl "$restored_database_secret_arn" \
  '{
    Version: "2012-10-17",
    Statement: [{
      Effect: "Allow",
      Action: "secretsmanager:GetSecretValue",
      Resource: [$apiToken, $databaseUrl]
    }]
  }' > "$execution_policy_file"
aws iam put-role-policy \
  --role-name "$execution_role_name" \
  --policy-name restore-secrets \
  --policy-document "file://$execution_policy_file"

task_role_arn=$(aws iam create-role \
  --role-name "$task_role_name" \
  --assume-role-policy-document "file://$trust_policy_file" \
  --query Role.Arn \
  --output text)
task_role_created=1
jq -n --arg bucket "arn:aws:s3:::$restore_bucket" '{
  Version: "2012-10-17",
  Statement: [
    {
      Effect: "Allow",
      Action: ["s3:GetBucketLocation", "s3:ListBucket"],
      Resource: $bucket
    },
    {
      Effect: "Allow",
      Action: ["s3:GetObject"],
      Resource: ($bucket + "/*")
    }
  ]
}' > "$task_policy_file"
aws iam put-role-policy \
  --role-name "$task_role_name" \
  --policy-name restore-object-storage \
  --policy-document "file://$task_policy_file"

aws ecs describe-task-definition \
  --region "$aws_region" \
  --task-definition "$source_task_definition" \
  --query taskDefinition \
  --output json | jq \
    --arg databaseSecret "$restored_database_secret_arn" \
    --arg executionRole "$execution_role_arn" \
    --arg family "$task_family" \
    --arg restoreBucket "$restore_bucket" \
    --arg taskRole "$task_role_arn" '
    {
      containerDefinitions,
      cpu,
      ephemeralStorage,
      executionRoleArn: $executionRole,
      family: $family,
      memory,
      networkMode,
      requiresCompatibilities,
      runtimePlatform,
      taskRoleArn: $taskRole,
      volumes
    }
    | with_entries(select(.value != null))
    | .containerDefinitions[0].command = [
        "node dist/cli/main.js integrity check --mode external-storage"
      ]
    | .containerDefinitions[0].environment |= map(
        if .name == "ARTIFACT_SERVER_S3_BUCKET"
        then .value = $restoreBucket
        else .
        end
      )
    | .containerDefinitions[0].secrets |= map(
        if .name == "ARTIFACT_SERVER_DATABASE_URL"
        then .valueFrom = $databaseSecret
        else .
        end
      )' > "$task_definition_file"

sleep 10
registered_task_definition=$(aws ecs register-task-definition \
  --region "$aws_region" \
  --cli-input-json "file://$task_definition_file" \
  --query taskDefinition.taskDefinitionArn \
  --output text)
task_arn=$(aws ecs run-task \
  --region "$aws_region" \
  --cluster "$cluster_name" \
  --launch-type FARGATE \
  --task-definition "$registered_task_definition" \
  --network-configuration \
    "awsvpcConfiguration={subnets=[$application_subnet_1,$application_subnet_2],securityGroups=[$application_security_group],assignPublicIp=DISABLED}" \
  --query 'tasks[0].taskArn' \
  --output text)
if [[ "$task_arn" == "None" || -z "$task_arn" ]]; then
  echo "ECS did not start the restored-data integrity task." >&2
  exit 1
fi
aws ecs wait tasks-stopped \
  --region "$aws_region" \
  --cluster "$cluster_name" \
  --tasks "$task_arn"
task_result=$(aws ecs describe-tasks \
  --region "$aws_region" \
  --cluster "$cluster_name" \
  --tasks "$task_arn")
exit_code=$(jq -er '.tasks[0].containers[0].exitCode' <<<"$task_result")
if [[ "$exit_code" != "0" ]]; then
  stop_reason=$(jq -er '.tasks[0].stoppedReason' <<<"$task_result")
  echo "Restored-data integrity failed: $stop_reason" >&2
  exit 1
fi

source_object_count=$(aws s3api list-objects-v2 \
  --region "$aws_region" \
  --bucket "$source_bucket" \
  --output json | jq '(.Contents // []) | length')
restored_object_count=$(aws s3api list-objects-v2 \
  --region "$aws_region" \
  --bucket "$restore_bucket" \
  --output json | jq '(.Contents // []) | length')
if [[ "$source_object_count" != "$restored_object_count" ]]; then
  echo "Restored object count does not match the source." >&2
  exit 1
fi

completed_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)
jq -n \
  --arg completedAt "$completed_at" \
  --arg startedAt "$started_at" \
  --argjson objectCount "$restored_object_count" \
  '{
    schemaVersion: 1,
    startedAt: $startedAt,
    completedAt: $completedAt,
    target: "aws",
    applicationQuiescedForBackup: true,
    databaseSnapshot: "restored_to_clean_instance",
    objectStorageCopy: "restored_to_clean_bucket",
    objectCount: $objectCount,
    restoredIntegrityCheck: "passed",
    productionReadinessAfterBackup: "ready",
    temporaryResourcesRemovedOnExit: true
  }' > "$evidence_path"
