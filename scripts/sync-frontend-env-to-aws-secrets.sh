#!/usr/bin/env bash
# Push frontend .env values into AWS Secrets Manager (SkoutDev by default).
#
# Updates:
#   {Prefix}/clerk     — CLERK_SECRET_KEY + CLERK_PUBLISHABLE_KEY (from NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY)
#   {Prefix}/frontend  — all NEXT_PUBLIC_* and CLERK_* vars from the frontend env file
#
# Usage:
#   ./scripts/sync-frontend-env-to-aws-secrets.sh
#   ./scripts/sync-frontend-env-to-aws-secrets.sh SkoutDev
#   FRONTEND_ENV_FILE=../Skout\ Ai\ Frontend/.env.dev ./scripts/sync-frontend-env-to-aws-secrets.sh
#
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PREFIX="${1:-SkoutDev}"
REGION="${AWS_REGION:-us-east-1}"
FRONTEND_DIR="${FRONTEND_DIR:-$ROOT/../Skout Ai Frontend}"

# Prefer .env.local (local dev keys), then .env.dev (deploy template with real values).
if [[ -n "${FRONTEND_ENV_FILE:-}" ]]; then
  ENV_FILE="$FRONTEND_ENV_FILE"
elif [[ -f "$FRONTEND_DIR/.env.local" ]]; then
  ENV_FILE="$FRONTEND_DIR/.env.local"
elif [[ -f "$FRONTEND_DIR/.env.dev" ]]; then
  ENV_FILE="$FRONTEND_DIR/.env.dev"
else
  echo "No frontend env file found under $FRONTEND_DIR (.env.local or .env.dev)" >&2
  exit 1
fi

# shellcheck disable=SC1090
set -a
source "$ENV_FILE"
set +a

ALB_DNS="${ALB_DNS:-$(aws cloudformation describe-stacks --region "$REGION" \
  --stack-name "${PREFIX}-Compute" \
  --query "Stacks[0].Outputs[?OutputKey=='LoadBalancerDns'].OutputValue" \
  --output text 2>/dev/null || true)}"

if [[ -z "${NEXT_PUBLIC_API_URL:-}" || "$NEXT_PUBLIC_API_URL" == *REPLACE* ]]; then
  if [[ -n "$ALB_DNS" && "$ALB_DNS" != "None" ]]; then
    NEXT_PUBLIC_API_URL="http://${ALB_DNS}"
  fi
fi

# Map frontend naming → backend secret field names.
CLERK_PUBLISHABLE_KEY="${CLERK_PUBLISHABLE_KEY:-${NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY:-}}"

put_or_create() {
  local secret_id="$1"
  local json="$2"
  if aws secretsmanager describe-secret --region "$REGION" --secret-id "$secret_id" >/dev/null 2>&1; then
    aws secretsmanager put-secret-value --region "$REGION" --secret-id "$secret_id" --secret-string "$json"
  else
    aws secretsmanager create-secret --region "$REGION" --name "$secret_id" --secret-string "$json"
  fi
  echo "✓ ${secret_id}"
}

# Merge clerk secret (preserve existing values when a field is unset locally).
CLERK_JSON="$(python3 - <<PY
import json, os, subprocess
prefix = "${PREFIX}"
region = "${REGION}"
existing = {}
try:
    raw = subprocess.check_output([
        "aws", "secretsmanager", "get-secret-value",
        "--region", region,
        "--secret-id", f"{prefix}/clerk",
        "--query", "SecretString",
        "--output", "text",
    ], text=True)
    existing = json.loads(raw)
except subprocess.CalledProcessError:
    pass
merged = {
    "CLERK_SECRET_KEY": existing.get("CLERK_SECRET_KEY", "replace-me"),
    "CLERK_PUBLISHABLE_KEY": existing.get("CLERK_PUBLISHABLE_KEY", "replace-me"),
}
if os.environ.get("CLERK_SECRET_KEY"):
    merged["CLERK_SECRET_KEY"] = os.environ["CLERK_SECRET_KEY"]
if os.environ.get("CLERK_PUBLISHABLE_KEY"):
    merged["CLERK_PUBLISHABLE_KEY"] = os.environ["CLERK_PUBLISHABLE_KEY"]
print(json.dumps(merged))
PY
)"
put_or_create "${PREFIX}/clerk" "$CLERK_JSON"

# Full frontend env snapshot for build-time reference / ops.
FRONTEND_JSON="$(python3 - <<PY
import json, os
keys = sorted(k for k in os.environ if k.startswith("NEXT_PUBLIC_") or k.startswith("CLERK_"))
payload = {k: os.environ[k] for k in keys if os.environ.get(k)}
if os.environ.get("NEXT_PUBLIC_API_URL"):
    payload["NEXT_PUBLIC_API_URL"] = os.environ["NEXT_PUBLIC_API_URL"]
print(json.dumps(payload))
PY
)"
if [[ "$FRONTEND_JSON" != "{}" ]]; then
  put_or_create "${PREFIX}/frontend" "$FRONTEND_JSON"
fi

echo "Done. Frontend env synced from $ENV_FILE → ${PREFIX}/clerk and ${PREFIX}/frontend"
