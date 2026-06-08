#!/usr/bin/env bash
# Build and push API + AI images to dev ECR. Run from repo root after Registry stack exists.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
REGION="${AWS_REGION:-us-east-1}"
ACCOUNT_ID="$(aws sts get-caller-identity --query Account --output text)"
REGISTRY="${ACCOUNT_ID}.dkr.ecr.${REGION}.amazonaws.com"
TAG="${IMAGE_TAG:-latest}"
# ECS Fargate default is x86_64 — required when building on Apple Silicon Macs.
PLATFORM="${DOCKER_PLATFORM:-linux/amd64}"

echo "Logging in to ECR (${REGISTRY})..."
echo "Building for platform: ${PLATFORM}"
aws ecr get-login-password --region "$REGION" | docker login --username AWS --password-stdin "$REGISTRY"

echo "Building API image..."
docker build --platform "$PLATFORM" -f "$ROOT/apps/api/Dockerfile" -t "${REGISTRY}/skout-dev-api:${TAG}" "$ROOT"
docker push "${REGISTRY}/skout-dev-api:${TAG}"

echo "Building AI image..."
docker build --platform "$PLATFORM" -f "$ROOT/apps/ai/Dockerfile" -t "${REGISTRY}/skout-dev-ai:${TAG}" "$ROOT/apps/ai"
docker push "${REGISTRY}/skout-dev-ai:${TAG}"

FRONTEND_DIR="${FRONTEND_DIR:-$ROOT/../Skout Ai Frontend}"
if [[ -f "$FRONTEND_DIR/package.json" ]]; then
  echo "Building Web image from ${FRONTEND_DIR}..."
  docker build --platform "$PLATFORM" -f "$FRONTEND_DIR/Dockerfile" -t "${REGISTRY}/skout-dev-web:${TAG}" "$FRONTEND_DIR"
  docker push "${REGISTRY}/skout-dev-web:${TAG}"
else
  echo "Frontend not found at ${FRONTEND_DIR} — skip web image (deploy with -c skipWeb=true)."
fi

echo "Done. Images pushed with tag: ${TAG}"
