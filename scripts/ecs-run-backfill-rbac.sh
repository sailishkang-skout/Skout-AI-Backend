#!/usr/bin/env bash
# Backfill tenants / roles / workspace_member_roles as a one-off ECS Fargate task.
# Usage: ./scripts/ecs-run-backfill-rbac.sh SkoutDev
#        ./scripts/ecs-run-backfill-rbac.sh SkoutProd

set -euo pipefail

STACK_PREFIX="${1:?Stack prefix required (e.g. SkoutDev or SkoutProd)}"
SERVICE_NAME="${2:-api}"
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
  DISCOVERED="$(aws ecs list-services --cluster "$CLUSTER" \
    --query "serviceArns[?contains(@, 'ApiService')]" --output text | awk '{print $1}' | awk -F/ '{print $NF}')"
  if [ -n "$DISCOVERED" ] && [ "$DISCOVERED" != "None" ]; then
    echo "Service '${SERVICE_NAME}' not ACTIVE — using ${DISCOVERED}"
    SERVICE_NAME="$DISCOVERED"
  fi
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
echo "Starting RBAC backfill task..."

TASK_ARN="$(aws ecs run-task \
  --cluster "$CLUSTER" \
  --task-definition "$TASK_DEF" \
  --launch-type FARGATE \
  --network-configuration "$NETWORK_CONFIG" \
  --overrides "{\"containerOverrides\":[{\"name\":\"${CONTAINER_NAME}\",\"command\":[\"node\",\"/app/db/dist/backfill-rbac.js\"]}]}" \
  --query 'tasks[0].taskArn' \
  --output text)"

if [ -z "$TASK_ARN" ] || [ "$TASK_ARN" = "None" ]; then
  echo "Failed to start RBAC backfill task"
  exit 1
fi

echo "RBAC backfill task: ${TASK_ARN}"
aws ecs wait tasks-stopped --cluster "$CLUSTER" --tasks "$TASK_ARN"

EXIT_CODE="$(aws ecs describe-tasks \
  --cluster "$CLUSTER" \
  --tasks "$TASK_ARN" \
  --query 'tasks[0].containers[0].exitCode' \
  --output text)"

STOP_REASON="$(aws ecs describe-tasks \
  --cluster "$CLUSTER" \
  --tasks "$TASK_ARN" \
  --query 'tasks[0].stoppedReason' \
  --output text)"

if [ "$EXIT_CODE" != "0" ]; then
  echo "RBAC backfill failed (exit ${EXIT_CODE}): ${STOP_REASON}"
  ENV_SLUG="$(echo "$STACK_PREFIX" | sed 's/^Skout//' | tr '[:upper:]' '[:lower:]')"
  aws logs tail "/skout/${ENV_SLUG}/api" --since 10m 2>/dev/null || true
  exit 1
fi

echo "RBAC backfill completed successfully"
