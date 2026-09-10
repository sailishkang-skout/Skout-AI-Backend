#!/usr/bin/env bash
# Run Drizzle migrations as a one-off ECS Fargate task (same image/network as API).
# Usage: ./scripts/ecs-run-migrations.sh SkoutDev
#        ./scripts/ecs-run-migrations.sh SkoutProd

set -euo pipefail

STACK_PREFIX="${1:?Stack prefix required (e.g. SkoutDev or SkoutProd)}"
SERVICE_NAME="${2:-api}"
CONTAINER_NAME="${3:-Container}"
# Skout stacks live in us-east-1; local ~/.aws/config may default elsewhere (e.g. ap-south-1).
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
  DISCOVERED="$(aws ecs list-services --cluster "$CLUSTER" \
    --query "serviceArns[?contains(@, 'ApiService')]" --output text | awk '{print $1}' | awk -F/ '{print $NF}')"
  if [ -n "$DISCOVERED" ] && [ "$DISCOVERED" != "None" ]; then
    echo "Service '${SERVICE_NAME}' not ACTIVE — using ${DISCOVERED}"
    SERVICE_NAME="$DISCOVERED"
    SERVICE_STATUS="$(aws ecs describe-services \
      --cluster "$CLUSTER" \
      --services "$SERVICE_NAME" \
      --query 'services[0].status' \
      --output text 2>/dev/null || true)"
  fi
fi

if [ "$SERVICE_STATUS" != "ACTIVE" ]; then
  echo "ECS API service is not ACTIVE (${SERVICE_STATUS:-missing})."
  echo "Skipping one-off migration task — entrypoint will migrate on first API start."
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
  echo "Starting ${label}..."
  local task_arn
  task_arn="$(aws ecs run-task \
    --cluster "$CLUSTER" \
    --task-definition "$TASK_DEF" \
    --launch-type FARGATE \
    --network-configuration "$NETWORK_CONFIG" \
    --overrides "{\"containerOverrides\":[{\"name\":\"${CONTAINER_NAME}\",\"command\":${command_json},\"environment\":[{\"name\":\"MIGRATIONS_FOLDER\",\"value\":\"/app/db/drizzle\"}]}]}" \
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
    aws logs tail "/skout/${env_slug}/api" --since 10m 2>/dev/null || true
    exit 1
  fi
}

# Drizzle migrator (journal-based), then idempotent schema repairs for columns
# that may be missing when the image's drizzle folder lags the schema.
run_one_off "drizzle migrate" '["node","/app/node_modules/@skout/db/dist/migrate.js"]'
run_one_off "apply-pending" '["node","/app/node_modules/@skout/db/dist/apply-pending.js"]'

echo "Migrations completed successfully"
