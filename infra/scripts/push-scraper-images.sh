#!/usr/bin/env bash
# Build and push scraper worker images to dev ECR.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
REGION="${AWS_REGION:-us-east-1}"
ACCOUNT_ID="$(aws sts get-caller-identity --query Account --output text)"
REGISTRY="${ACCOUNT_ID}.dkr.ecr.${REGION}.amazonaws.com"
TAG="${IMAGE_TAG:-latest}"
PLATFORM="${DOCKER_PLATFORM:-linux/amd64}"

aws ecr get-login-password --region "$REGION" | docker login --username AWS --password-stdin "$REGISTRY"

build_scraper() {
  local subpath="$1"
  local package="$2"
  local repo_name="$3"
  local repo
  repo=$(aws ecr describe-repositories --repository-names "$repo_name" --query 'repositories[0].repositoryUri' --output text)
  echo "Building ${repo_name} (${PLATFORM})..."
  docker build --platform "$PLATFORM" -f "$ROOT/workers/scrapers/Dockerfile" \
    --build-arg WORKER_SUBPATH="$subpath" \
    --build-arg WORKER_PACKAGE="$package" \
    -t "${repo}:${TAG}" -t "${repo}:latest" "$ROOT"
  docker push "${repo}:${TAG}"
  docker push "${repo}:latest"
}

build_scraper orchestrator @skout/scraper-orchestrator skout-dev-scraper-orchestrator
build_scraper cleaner @skout/scraper-cleaner skout-dev-scraper-cleaner
build_scraper ingestor @skout/scraper-ingestor skout-dev-scraper-ingestor

echo "Scraper images pushed with tag: ${TAG}"
