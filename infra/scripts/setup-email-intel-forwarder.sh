#!/usr/bin/env bash
# Create/update Skout*/email-intel-forwarder secret.
# Usage:
#   ./infra/scripts/setup-email-intel-forwarder.sh SkoutDev https://ckoy6iywm0.execute-api.us-east-1.amazonaws.com
#   ./infra/scripts/setup-email-intel-forwarder.sh SkoutProd https://api.skoutai.io
set -euo pipefail

PREFIX="${1:?stack prefix e.g. SkoutDev}"
API_URL="${2:?public API base URL (no path)}"
REGION="${AWS_REGION:-us-east-1}"
WORKSPACE_ID="${EVIDENCE_INGEST_DEFAULT_WORKSPACE_ID:-00000000-0000-4000-8000-000000000001}"
SECRET_NAME="${PREFIX}/email-intel-forwarder"
TOKEN="$(openssl rand -hex 32)"

PAYLOAD="$(
  TOKEN="$TOKEN" WORKSPACE_ID="$WORKSPACE_ID" API_URL="$API_URL" python3 - <<'PY'
import json, os
url = os.environ["API_URL"].rstrip("/")
print(json.dumps({
  "EMAIL_INTEL_EXTERNAL_API_KEY": os.environ["TOKEN"],
  "SKOUT_CANONICAL_EVIDENCE_TOKEN": os.environ["TOKEN"],
  "EVIDENCE_INGEST_DEFAULT_WORKSPACE_ID": os.environ["WORKSPACE_ID"],
  "SKOUT_CANONICAL_EVIDENCE_URL": url,
}))
PY
)"

if aws secretsmanager describe-secret --region "$REGION" --secret-id "$SECRET_NAME" >/dev/null 2>&1; then
  aws secretsmanager put-secret-value --region "$REGION" --secret-id "$SECRET_NAME" --secret-string "$PAYLOAD" >/dev/null
  echo "Updated secret $SECRET_NAME"
else
  aws secretsmanager create-secret --region "$REGION" --name "$SECRET_NAME" \
    --description "Skout Email-Intel → canonical evidence forwarder (§5.3)" \
    --secret-string "$PAYLOAD" >/dev/null
  echo "Created secret $SECRET_NAME"
fi

echo "Keys set (values not printed): EMAIL_INTEL_EXTERNAL_API_KEY,"
echo "  SKOUT_CANONICAL_EVIDENCE_TOKEN (same), EVIDENCE_INGEST_DEFAULT_WORKSPACE_ID,"
echo "  SKOUT_CANONICAL_EVIDENCE_URL=$API_URL"
echo "Next: python3 infra/scripts/patch-ecs-email-intel-forwarder.py $PREFIX"
