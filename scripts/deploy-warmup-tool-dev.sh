#!/usr/bin/env bash
# Deploy Warm-Up Tool to SkoutDev after code + Dockerfile exist.
# Usage (from Backend repo root):
#   bash scripts/deploy-warmup-tool-dev.sh [imageTag]
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
REGION="${AWS_REGION:-us-east-1}"
export AWS_REGION="$REGION" AWS_DEFAULT_REGION="$REGION"
TAG="${1:-latest}"
WARMUP_DIR="${WARMUP_DIR:-$ROOT/../Skout-Warm-Up-Tool}"

echo "==> 1) Ensure secrets are not placeholders"
aws secretsmanager get-secret-value --secret-id SkoutDev/warmup-tool --query SecretString --output text \
  | grep -q 'replace-me' && {
  echo "SkoutDev/warmup-tool still has replace-me placeholders. Update ENCRYPTION_KEY, API_KEY_PEPPER, PLATFORM_PROVISIONING_KEY first."
  exit 1
} || true

echo "==> 2) Build/push image tag=${TAG}"
IMAGE_TAG="$TAG" SKIP_WARMUP_TOOL=0 WEB_ONLY=1 FRONTEND_DIR=/nonexistent \
  bash "$ROOT/infra/scripts/push-dev-images.sh" || {
  # push-dev-images requires GATE_TOKEN for web; force warmup-only path:
  ACCOUNT_ID="$(aws sts get-caller-identity --query Account --output text)"
  REGISTRY="${ACCOUNT_ID}.dkr.ecr.${REGION}.amazonaws.com"
  aws ecr get-login-password --region "$REGION" | docker login --username AWS --password-stdin "$REGISTRY"
  docker build --platform linux/amd64 -f "$WARMUP_DIR/Dockerfile" \
    -t "${REGISTRY}/skout-dev-warmup-tool:${TAG}" \
    -t "${REGISTRY}/skout-dev-warmup-tool:latest" \
    "$WARMUP_DIR"
  docker push "${REGISTRY}/skout-dev-warmup-tool:${TAG}"
  docker push "${REGISTRY}/skout-dev-warmup-tool:latest"
}

echo "==> 3) CDK WarmupTool bootstrap (desiredCount 0)"
cd "$ROOT/infra"
pnpm cdk deploy SkoutDev-WarmupTool -c env=dev -c imageTag="$TAG" -c warmupToolBootstrap=true -c httpsMode=apigateway --require-approval never

echo "==> 4) Create DB + migrate"
bash "$ROOT/scripts/ecs-run-warmup-tool-migrations.sh" SkoutDev

echo "==> 5) CDK WarmupTool live + Compute (API env)"
pnpm cdk deploy SkoutDev-WarmupTool SkoutDev-Compute -c env=dev -c imageTag="$TAG" -c httpsMode=apigateway --require-approval never

echo "==> 6) Force ECS redeploy"
CLUSTER="$(aws ecs list-clusters --query "clusterArns[?contains(@, 'SkoutDev')]" --output text | head -n1)"
for svc in api warmup-tool-api warmup-tool-worker warmup-tool-inbound warmup-tool-classification warmup-tool-policy web; do
  aws ecs update-service --cluster "$CLUSTER" --service "$svc" --force-new-deployment >/dev/null && echo "redeployed $svc" || echo "skip $svc"
done

echo "Done. See docs/WARMUP_TOOL_TESTING.md for smoke tests."
