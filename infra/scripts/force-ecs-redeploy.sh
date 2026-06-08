#!/usr/bin/env bash
# Redeploy running ECS tasks only — no CDK/CloudFormation (typically 2-5 min).
set -euo pipefail

REGION="${AWS_REGION:-us-east-1}"
CLUSTER=$(aws ecs list-clusters --region "$REGION" \
  --query "clusterArns[?contains(@, 'SkoutDev')]" --output text)

if [ -z "$CLUSTER" ]; then
  echo "No SkoutDev ECS cluster found."
  exit 1
fi

echo "Cluster: $CLUSTER"
for svc in api ai web; do
  echo "Force redeploy: $svc"
  aws ecs update-service --cluster "$CLUSTER" --service "$svc" \
    --force-new-deployment --region "$REGION" --output text --query 'service.serviceName' || true
done

echo "Done. Watch: aws ecs describe-services --cluster $CLUSTER --services api ai web --region $REGION"
