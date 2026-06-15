#!/usr/bin/env bash
# Push provider keys from backend .env into AWS Secrets Manager (SkoutDev by default).
#
# Usage:
#   ./scripts/sync-env-to-aws-secrets.sh              # reads .env, prefix SkoutDev
#   ./scripts/sync-env-to-aws-secrets.sh SkoutProd     # production prefix
#   ./scripts/sync-env-to-aws-secrets.sh SkoutDev --redeploy   # also force ECS rollout
#
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PREFIX="${1:-SkoutDev}"
REDEPLOY="${2:-}"
ENV_FILE="${ENV_FILE:-$ROOT/.env}"
REGION="${AWS_REGION:-us-east-1}"

if [[ ! -f "$ENV_FILE" ]]; then
  echo "Missing $ENV_FILE — copy .env.example and fill provider keys." >&2
  exit 1
fi

# shellcheck disable=SC1090
set -a
source "$ENV_FILE"
set +a

require() {
  local name="$1"
  if [[ -z "${!name:-}" ]]; then
    echo "Skip $name (not set in $ENV_FILE)" >&2
    return 1
  fi
  return 0
}

put_json() {
  local path="$1"
  local json="$2"
  aws secretsmanager put-secret-value \
    --region "$REGION" \
    --secret-id "${PREFIX}/${path}" \
    --secret-string "$json"
  echo "✓ ${PREFIX}/${path}"
}

# Hunter (dedicated secret)
if require HUNTER_API_KEY; then
  put_json hunter "$(python3 -c "import json,os; print(json.dumps({'HUNTER_API_KEY': os.environ['HUNTER_API_KEY']}))")"
fi

# OpenAI (AI service)
if require OPENAI_API_KEY; then
  put_json openai "$(python3 -c "import json,os; print(json.dumps({'OPENAI_API_KEY': os.environ['OPENAI_API_KEY']}))")"
fi

# OpenSearch / Bonsai — skip localhost (local dev only)
if require OPENSEARCH_URL && [[ "${OPENSEARCH_URL}" != *localhost* && "${OPENSEARCH_URL}" != *127.0.0.1* ]]; then
  put_json opensearch "$(python3 - <<'PY'
import json, os
d = {"OPENSEARCH_URL": os.environ["OPENSEARCH_URL"]}
for k in ("OPENSEARCH_USERNAME", "OPENSEARCH_PASSWORD"):
    if os.environ.get(k):
        d[k] = os.environ[k]
print(json.dumps(d))
PY
)"
fi

# Clerk (optional — auth)
if [[ -n "${CLERK_SECRET_KEY:-}" && -n "${CLERK_PUBLISHABLE_KEY:-}" ]]; then
  put_json clerk "$(python3 - <<'PY'
import json, os
print(json.dumps({
  "CLERK_SECRET_KEY": os.environ["CLERK_SECRET_KEY"],
  "CLERK_PUBLISHABLE_KEY": os.environ["CLERK_PUBLISHABLE_KEY"],
}))
PY
)"
fi

# All PAL providers in one secret
ENRICH_KEYS=(
  MILLIONVERIFIER_API_KEY
  ZEROBOUNCE_API_KEY
  NEVERBOUNCE_API_KEY
  PDL_API_KEY
  REVENUEBASE_API_KEY
  EXPLORIUM_API_KEY
  CORESIGNAL_API_KEY
  DATAGMA_API_KEY
  CONTACTOUT_API_KEY
  COGNISM_API_KEY
  OPENCORPORATES_API_KEY
)

# ECS task definition expects every key below — always write the full set (placeholder when unset in .env).
ENRICH_JSON="$(python3 - <<PY
import json, os, subprocess
prefix = "${PREFIX}"
region = "${REGION}"
keys = [
  "MILLIONVERIFIER_API_KEY", "ZEROBOUNCE_API_KEY", "NEVERBOUNCE_API_KEY",
  "PDL_API_KEY", "REVENUEBASE_API_KEY", "EXPLORIUM_API_KEY", "CORESIGNAL_API_KEY",
  "DATAGMA_API_KEY", "CONTACTOUT_API_KEY", "COGNISM_API_KEY", "OPENCORPORATES_API_KEY",
]
existing = {}
try:
    raw = subprocess.check_output([
        "aws", "secretsmanager", "get-secret-value",
        "--region", region,
        "--secret-id", f"{prefix}/enrichment-providers",
        "--query", "SecretString",
        "--output", "text",
    ], text=True)
    existing = json.loads(raw)
except subprocess.CalledProcessError:
    pass
merged = {k: existing.get(k, "replace-me") for k in keys}
for k in keys:
    if os.environ.get(k):
        merged[k] = os.environ[k]
print(json.dumps(merged))
PY
)"

if [[ -n "$ENRICH_JSON" && "$ENRICH_JSON" != "{}" ]]; then
  put_json enrichment-providers "$ENRICH_JSON"
else
  echo "Skip enrichment-providers (failed to build secret JSON)" >&2
fi

if [[ "$REDEPLOY" == "--redeploy" || "${REDEPLOY:-}" == "--redeploy" ]]; then
  CLUSTER="${PREFIX}-cluster"
  echo "Forcing ECS redeploy on ${CLUSTER}..."
  for svc in api ai web; do
    if aws ecs describe-services --region "$REGION" --cluster "$CLUSTER" --services "$svc" \
      --query 'services[0].status' --output text 2>/dev/null | grep -q ACTIVE; then
      aws ecs update-service --region "$REGION" --cluster "$CLUSTER" --service "$svc" \
        --force-new-deployment --no-cli-pager >/dev/null
      echo "✓ redeploy $svc"
    fi
  done
fi

echo "Done. Secrets synced from $ENV_FILE → ${PREFIX}/*"
