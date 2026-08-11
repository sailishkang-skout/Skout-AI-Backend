#!/usr/bin/env bash
# Bootstrap + migrate the Email Intelligence service's database as one-off ECS
# Fargate tasks (same image/network as email-intel-api). The shared RDS
# instance only auto-creates a "skout" database, so this first ensures
# "email_intelligence" exists (idempotent) before running its migrations.
# Usage: ./scripts/ecs-run-email-intel-migrations.sh SkoutDev
#        ./scripts/ecs-run-email-intel-migrations.sh SkoutProd

set -euo pipefail

STACK_PREFIX="${1:?Stack prefix required (e.g. SkoutDev or SkoutProd)}"
SERVICE_NAME="${2:-email-intel-api}"
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
  echo "email-intel-api service is not ACTIVE (${SERVICE_STATUS:-missing})."
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
    aws logs tail "/skout/${env_slug}/email-intel-api" --since 10m 2>/dev/null || true
    exit 1
  fi
}

# The task definition's baseline DATABASE_NAME is "email_intelligence" (the
# service's target db, which may not exist yet). Override it to "skout" — the
# RDS instance's always-present default database — just for this step.
run_one_off "ensure-database" \
  '["node","dist/db/ensureDatabase.js"]' \
  '[{"name":"DATABASE_NAME","value":"skout"}]'

run_one_off "migrate" '["node","dist/db/migrate.js"]'

echo "Email Intelligence database migrations completed successfully"
