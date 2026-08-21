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

WEB_ONLY="${WEB_ONLY:-0}"
DOCKER_NO_CACHE="${DOCKER_NO_CACHE:-0}"

echo "Logging in to ECR (${REGISTRY})..."
echo "Building for platform: ${PLATFORM}"
aws ecr get-login-password --region "$REGION" | docker login --username AWS --password-stdin "$REGISTRY"

if [[ "$WEB_ONLY" != "1" ]]; then
  echo "Building API image..."
  docker build --platform "$PLATFORM" -f "$ROOT/apps/api/Dockerfile" -t "${REGISTRY}/skout-dev-api:${TAG}" "$ROOT"
  docker push "${REGISTRY}/skout-dev-api:${TAG}"

  echo "Building AI image..."
  docker build --platform "$PLATFORM" -f "$ROOT/apps/ai/Dockerfile" -t "${REGISTRY}/skout-dev-ai:${TAG}" "$ROOT/apps/ai"
  docker push "${REGISTRY}/skout-dev-ai:${TAG}"
else
  echo "WEB_ONLY=1 — skipping API and AI images"
fi

FRONTEND_DIR="${FRONTEND_DIR:-$ROOT/../Skout Ai Frontend}"
if [[ -f "$FRONTEND_DIR/package.json" ]]; then
  echo "Building Web image from ${FRONTEND_DIR}..."
  WEB_BUILD_ARGS=(--platform "$PLATFORM")

  # Default API URL to dev HTTPS WebUrl (CloudFront) when not set.
  if [[ -z "${NEXT_PUBLIC_API_URL:-}" ]]; then
    WEB_URL="$(aws cloudformation describe-stacks --region "$REGION" \
      --stack-name SkoutDev-Compute \
      --query "Stacks[0].Outputs[?OutputKey=='WebUrl'].OutputValue" \
      --output text 2>/dev/null || true)"
    if [[ -n "$WEB_URL" && "$WEB_URL" != "None" ]]; then
      NEXT_PUBLIC_API_URL="$WEB_URL"
    else
      ALB_DNS="$(aws cloudformation describe-stacks --region "$REGION" \
        --stack-name SkoutDev-Compute \
        --query "Stacks[0].Outputs[?OutputKey=='LoadBalancerDns'].OutputValue" \
        --output text 2>/dev/null || true)"
      if [[ -n "$ALB_DNS" && "$ALB_DNS" != "None" ]]; then
        NEXT_PUBLIC_API_URL="http://${ALB_DNS}"
      fi
    fi
  fi
  if [[ -n "${NEXT_PUBLIC_API_URL:-}" ]]; then
    WEB_BUILD_ARGS+=(--build-arg "NEXT_PUBLIC_API_URL=${NEXT_PUBLIC_API_URL}")
    WEB_BUILD_ARGS+=(--build-arg "NEXT_PUBLIC_APP_URL=${NEXT_PUBLIC_APP_URL:-${NEXT_PUBLIC_API_URL}}")
    WEB_BUILD_ARGS+=(--build-arg "NEXT_PUBLIC_CRM_API_URL=${NEXT_PUBLIC_CRM_API_URL:-${NEXT_PUBLIC_API_URL}}")
  fi

  # Clerk keys: env → frontend .env.local → Secrets Manager.
  if [[ -z "${NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY:-}" && -z "${CLERK_PUBLISHABLE_KEY:-}" ]]; then
    for candidate in "$FRONTEND_DIR/.env.local" "$FRONTEND_DIR/.env.dev"; do
      if [[ -f "$candidate" ]]; then
        # shellcheck disable=SC1090
        set -a && source "$candidate" && set +a
        break
      fi
    done
  fi
  CLERK_PUBLISHABLE_KEY="${CLERK_PUBLISHABLE_KEY:-${NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY:-}}"
  if [[ -z "${CLERK_SECRET_KEY:-}" || -z "${CLERK_PUBLISHABLE_KEY:-}" ]]; then
    CLERK_JSON="$(aws secretsmanager get-secret-value --region "$REGION" \
      --secret-id SkoutDev/clerk --query SecretString --output text 2>/dev/null || echo '{}')"
    if [[ -z "${CLERK_SECRET_KEY:-}" ]]; then
      CLERK_SECRET_KEY="$(python3 -c "import json,sys; print(json.loads(sys.argv[1]).get('CLERK_SECRET_KEY',''))" "$CLERK_JSON")"
    fi
    if [[ -z "${CLERK_PUBLISHABLE_KEY:-}" ]]; then
      CLERK_PUBLISHABLE_KEY="$(python3 -c "import json,sys; print(json.loads(sys.argv[1]).get('CLERK_PUBLISHABLE_KEY',''))" "$CLERK_JSON")"
    fi
  fi
  if [[ -n "${CLERK_PUBLISHABLE_KEY:-}" && "$CLERK_PUBLISHABLE_KEY" != "replace-me" ]]; then
    WEB_BUILD_ARGS+=(--build-arg "NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=${CLERK_PUBLISHABLE_KEY}")
  fi
  if [[ -n "${CLERK_SECRET_KEY:-}" && "$CLERK_SECRET_KEY" != "replace-me" ]]; then
    WEB_BUILD_ARGS+=(--build-arg "CLERK_SECRET_KEY=${CLERK_SECRET_KEY}")
  fi

  # Pre-login access gate (src/middleware.ts). Empty/unset disables the gate.
  if [[ -z "${GATE_TOKEN:-}" ]]; then
    for candidate in "$FRONTEND_DIR/.env.local" "$FRONTEND_DIR/.env.dev"; do
      if [[ -f "$candidate" ]] && grep -q '^GATE_TOKEN=' "$candidate"; then
        GATE_TOKEN="$(grep '^GATE_TOKEN=' "$candidate" | tail -n1 | cut -d= -f2-)"
        break
      fi
    done
  fi
  if [[ -n "${GATE_TOKEN:-}" ]]; then
    WEB_BUILD_ARGS+=(--build-arg "GATE_TOKEN=${GATE_TOKEN}")
    echo "Access gate: GATE_TOKEN is set (value not printed)"
  else
    echo "ERROR: GATE_TOKEN is empty. The pre-login /app gate will be disabled." >&2
    echo "Set GATE_TOKEN in the environment or in the frontend .env.local." >&2
    exit 1
  fi

  if [[ "$DOCKER_NO_CACHE" == "1" ]]; then
    WEB_BUILD_ARGS+=(--no-cache)
    echo "Docker: --no-cache (force rebuild so GATE_TOKEN is inlined)"
  fi

  docker build "${WEB_BUILD_ARGS[@]}" -f "$FRONTEND_DIR/Dockerfile" \
    -t "${REGISTRY}/skout-dev-web:${TAG}" "$FRONTEND_DIR"

  # ECS pins a sha tag (e.g. dev-abc1234), not `latest`. Also push that tag or
  # force-new-deployment will keep running the previous image.
  ECS_WEB_IMAGE="$(aws ecs describe-services --region "$REGION" --cluster SkoutDev-cluster --services web \
    --query 'services[0].taskDefinition' --output text 2>/dev/null || true)"
  if [[ -n "$ECS_WEB_IMAGE" && "$ECS_WEB_IMAGE" != "None" ]]; then
    ECS_WEB_TAG="$(aws ecs describe-task-definition --region "$REGION" --task-definition "$ECS_WEB_IMAGE" \
      --query 'taskDefinition.containerDefinitions[0].image' --output text 2>/dev/null | awk -F: '{print $NF}' || true)"
    if [[ -n "$ECS_WEB_TAG" && "$ECS_WEB_TAG" != "$TAG" && "$ECS_WEB_TAG" != *\/* ]]; then
      echo "Also tagging web image as ${ECS_WEB_TAG} (current ECS task definition)"
      docker tag "${REGISTRY}/skout-dev-web:${TAG}" "${REGISTRY}/skout-dev-web:${ECS_WEB_TAG}"
      docker push "${REGISTRY}/skout-dev-web:${ECS_WEB_TAG}"
    fi
  fi

  docker push "${REGISTRY}/skout-dev-web:${TAG}"
else
  echo "Frontend not found at ${FRONTEND_DIR} — skip web image (deploy with -c skipWeb=true)."
fi

echo "Done. Images pushed with tag: ${TAG}"
