#!/usr/bin/env bash
# Run the AUTH-ADI-01 / AUTH-ADI-02 read-only Clerk-migration audits as a
# one-off ECS Fargate task (same image/network as API). Read-only: neither
# script writes to the DB. Output is counts only, never PII or key material.
#
# Usage: ./scripts/ecs-run-auth-audit.sh SkoutDev identity-data
#        ./scripts/ecs-run-auth-audit.sh SkoutUat encryption-key-dependency
#        ./scripts/ecs-run-auth-audit.sh SkoutProd identity-data

set -euo pipefail

STACK_PREFIX="${1:?Stack prefix required (e.g. SkoutDev, SkoutUat, or SkoutProd)}"
AUDIT="${2:?Audit required: identity-data (AUTH-ADI-01) or encryption-key-dependency (AUTH-ADI-02)}"
SERVICE_NAME="${3:-api}"
CONTAINER_NAME="${4:-Container}"
REGION="${AWS_REGION:-${AWS_DEFAULT_REGION:-us-east-1}}"
export AWS_REGION="$REGION"
export AWS_DEFAULT_REGION="$REGION"
# Avoid Git Bash mangling leading-slash args (e.g. log group names) into
# Windows paths, and avoid the AWS CLI crashing on non-ASCII log output
# (pino's ✓/✗) under Windows' default console codepage.
export MSYS_NO_PATHCONV=1
export PYTHONIOENCODING=utf-8

case "$AUDIT" in
  identity-data) SCRIPT_FILE="audit-identity-data.js" ;;
  encryption-key-dependency) SCRIPT_FILE="audit-encryption-key-dependency.js" ;;
  *)
    echo "Unknown audit '${AUDIT}'. Use identity-data or encryption-key-dependency."
    exit 1
    ;;
esac

CLUSTER="$(aws ecs list-clusters \
  --region "$REGION" \
  --query "clusterArns[?contains(@, '${STACK_PREFIX}')]" \
  --output text | head -n1)"

if [ -z "$CLUSTER" ] || [ "$CLUSTER" = "None" ]; then
  echo "No ECS cluster found for prefix ${STACK_PREFIX}"
  exit 1
fi

echo "Cluster: ${CLUSTER}"

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
echo "Starting ${AUDIT} audit (read-only)..."

# encryption-key-dependency also needs CLERK_SECRET_KEY, which is already
# wired into the API task definition's secrets — no override needed here.
TASK_ARN="$(aws ecs run-task \
  --cluster "$CLUSTER" \
  --task-definition "$TASK_DEF" \
  --launch-type FARGATE \
  --network-configuration "$NETWORK_CONFIG" \
  --overrides "{\"containerOverrides\":[{\"name\":\"${CONTAINER_NAME}\",\"command\":[\"node\",\"/app/node_modules/@skout/db/dist/${SCRIPT_FILE}\"]}]}" \
  --query 'tasks[0].taskArn' \
  --output text)"

if [ -z "$TASK_ARN" ] || [ "$TASK_ARN" = "None" ]; then
  echo "Failed to start ${AUDIT} audit task"
  exit 1
fi

echo "Task: ${TASK_ARN}"
aws ecs wait tasks-stopped --cluster "$CLUSTER" --tasks "$TASK_ARN"

EXIT_CODE="$(aws ecs describe-tasks \
  --cluster "$CLUSTER" \
  --tasks "$TASK_ARN" \
  --query 'tasks[0].containers[0].exitCode' \
  --output text)"

ENV_SLUG="$(echo "$STACK_PREFIX" | sed 's/^Skout//' | tr '[:upper:]' '[:lower:]')"
TASK_ID="${TASK_ARN##*/}"
LOG_STREAM="${SERVICE_NAME}/${CONTAINER_NAME}/${TASK_ID}"
echo "Task finished (exit ${EXIT_CODE}). Fetching output from log stream ${LOG_STREAM}..."
aws logs get-log-events \
  --log-group-name "/skout/${ENV_SLUG}/api" \
  --log-stream-name "$LOG_STREAM" \
  --query "events[].message" \
  --output text 2>&1 || true

if [ "$EXIT_CODE" != "0" ] && [ "$EXIT_CODE" != "2" ]; then
  echo "${AUDIT} audit crashed (exit ${EXIT_CODE}) — see logs above."
  exit 1
fi

if [ "$EXIT_CODE" = "2" ]; then
  echo "${AUDIT} audit completed with a FINDING that needs follow-up — see logs above."
fi
