#!/usr/bin/env bash
# Bootstrap + migrate the Warm-Up Tool database as one-off ECS Fargate tasks.
# Shared RDS only auto-creates "skout"; this ensures "email_warmup" exists then migrates.
# Usage: ./scripts/ecs-run-warmup-tool-migrations.sh SkoutDev
#        ./scripts/ecs-run-warmup-tool-migrations.sh SkoutProd

set -euo pipefail

STACK_PREFIX="${1:?Stack prefix required (e.g. SkoutDev or SkoutProd)}"
SERVICE_NAME="${2:-warmup-tool-api}"
CONTAINER_NAME="${3:-Container}"
REGION="${AWS_REGION:-${AWS_DEFAULT_REGION:-us-east-1}}"
export AWS_REGION="$REGION"
export AWS_DEFAULT_REGION="$REGION"

CLUSTER="$(aws ecs list-clusters \
  --region "$REGION" \
  --query "clusterArns[?contains(@, '${STACK_PREFIX}')]" \
  --output text | head -n1)"

if [ -z "$CLUSTER" ] || [ "$CLUSTER" = "None" ]; then
  echo "No ECS cluster found for prefix ${STACK_PREFIX}"
  exit 1
fi

echo "Cluster: ${CLUSTER}"

SERVICE_STATUS="$(aws ecs describe-services \
  --cluster "$CLUSTER" \
  --services "$SERVICE_NAME" \
  --query 'services[0].status' \
  --output text 2>/dev/null || true)"

if [ "$SERVICE_STATUS" != "ACTIVE" ]; then
  echo "warmup-tool-api service is not ACTIVE (${SERVICE_STATUS:-missing})."
  echo "Skipping one-off migration tasks."
  exit 0
fi

TASK_DEF="$(aws ecs describe-services \
  --cluster "$CLUSTER" \
  --services "$SERVICE_NAME" \
  --query 'services[0].taskDefinition' \
  --output text)"

NETWORK_CONFIG="$(aws ecs describe-services \
  --cluster "$CLUSTER" \
  --services "$SERVICE_NAME" \
  --query 'services[0].networkConfiguration' \
  --output json)"

echo "Task definition: ${TASK_DEF}"

run_one_off() {
  local label="$1"
  local command_json="$2"
  local environment_json="${3:-[]}"
  echo "Starting ${label}..."
  local task_arn
  task_arn="$(aws ecs run-task \
    --cluster "$CLUSTER" \
    --task-definition "$TASK_DEF" \
    --launch-type FARGATE \
    --network-configuration "$NETWORK_CONFIG" \
    --overrides "{\"containerOverrides\":[{\"name\":\"${CONTAINER_NAME}\",\"command\":${command_json},\"environment\":${environment_json}}]}" \
    --query 'tasks[0].taskArn' \
    --output text)"

  if [ -z "$task_arn" ] || [ "$task_arn" = "None" ]; then
    echo "Failed to start ${label}"
    exit 1
  fi

  echo "${label}: ${task_arn}"
  aws ecs wait tasks-stopped --cluster "$CLUSTER" --tasks "$task_arn"

  local exit_code stop_reason
  exit_code="$(aws ecs describe-tasks \
    --cluster "$CLUSTER" \
    --tasks "$task_arn" \
    --query 'tasks[0].containers[0].exitCode' \
    --output text)"
  stop_reason="$(aws ecs describe-tasks \
    --cluster "$CLUSTER" \
    --tasks "$task_arn" \
    --query 'tasks[0].stoppedReason' \
    --output text)"

  if [ "$exit_code" != "0" ]; then
    echo "${label} failed (exit ${exit_code}): ${stop_reason}"
    local env_slug
    env_slug="$(echo "$STACK_PREFIX" | sed 's/^Skout//' | tr '[:upper:]' '[:lower:]')"
    aws logs tail "/skout/${env_slug}/warmup-tool-api" --since 10m 2>/dev/null || true
    exit 1
  fi
}

# Connect to always-present "skout" DB to CREATE DATABASE email_warmup.
run_one_off "ensure-database" \
  '["node","dist/cli/ensure-database.js"]' \
  '[{"name":"DATABASE_NAME","value":"skout"},{"name":"ADMIN_DATABASE_NAME","value":"skout"},{"name":"TARGET_DATABASE_NAME","value":"email_warmup"}]'

run_one_off "migrate" \
  '["node","dist/cli/migrate.js","up"]'

echo "Warm-Up Tool database migrations completed successfully"
