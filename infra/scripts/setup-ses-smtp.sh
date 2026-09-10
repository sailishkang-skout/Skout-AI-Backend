#!/usr/bin/env bash
# Provision SES SMTP credentials into Secrets Manager for Skout transactional mail.
# Usage:
#   ./infra/scripts/setup-ses-smtp.sh              # defaults: SkoutDev, us-east-1
#   STACK_PREFIX=SkoutProd FROM_EMAIL=noreply@skoutai.io ./infra/scripts/setup-ses-smtp.sh
#
# Prerequisites: AWS CLI, SES out of sandbox (or invitee emails verified in SES),
# and FROM_EMAIL verified as a SES identity in the target region.
set -euo pipefail

REGION="${AWS_REGION:-us-east-1}"
STACK_PREFIX="${STACK_PREFIX:-SkoutDev}"
SECRET_NAME="${STACK_PREFIX}/smtp"
# IAM user names are lowercase; e.g. skout-dev-ses-smtp
IAM_USER="${IAM_USER:-skout-$(echo "${STACK_PREFIX#Skout}" | tr '[:upper:]' '[:lower:]')-ses-smtp}"
FROM_EMAIL="${FROM_EMAIL:-skoutaiofficial@gmail.com}"
SMTP_HOST="${SMTP_HOST:-email-smtp.${REGION}.amazonaws.com}"
SMTP_PORT="${SMTP_PORT:-587}"

echo "==> Ensuring IAM user ${IAM_USER}"
if ! aws iam get-user --user-name "$IAM_USER" >/dev/null 2>&1; then
  aws iam create-user --user-name "$IAM_USER" --tags Key=App,Value=Skout Key=Purpose,Value=ses-smtp >/dev/null
fi

POLICY_ARN="arn:aws:iam::aws:policy/AmazonSESFullAccess"
aws iam attach-user-policy --user-name "$IAM_USER" --policy-arn "$POLICY_ARN" 2>/dev/null || true

echo "==> Creating access key for ${IAM_USER}"
KEY_JSON=$(aws iam create-access-key --user-name "$IAM_USER" --output json)
ACCESS_KEY_ID=$(echo "$KEY_JSON" | python3 -c 'import json,sys; print(json.load(sys.stdin)["AccessKey"]["AccessKeyId"])')
SECRET_ACCESS_KEY=$(echo "$KEY_JSON" | python3 -c 'import json,sys; print(json.load(sys.stdin)["AccessKey"]["SecretAccessKey"])')

echo "==> Deriving SES SMTP password"
SMTP_PASSWORD=$(
  SECRET_ACCESS_KEY="$SECRET_ACCESS_KEY" REGION="$REGION" python3 - <<'PY'
import base64, hashlib, hmac, os
secret = os.environ["SECRET_ACCESS_KEY"]
region = os.environ["REGION"]
DATE = "11111111"
SERVICE = "ses"
MESSAGE = "SendRawEmail"
TERMINAL = "aws4_request"
VERSION = 0x04

def sign(key: bytes, msg: str) -> bytes:
    return hmac.new(key, msg.encode("utf-8"), hashlib.sha256).digest()

k_date = sign(("AWS4" + secret).encode("utf-8"), DATE)
k_region = sign(k_date, region)
k_service = sign(k_region, SERVICE)
k_signing = sign(k_service, TERMINAL)
signature = hmac.new(k_signing, MESSAGE.encode("utf-8"), hashlib.sha256).digest()
print(base64.b64encode(bytes([VERSION]) + signature).decode("utf-8"))
PY
)

SECRET_PAYLOAD=$(
  ACCESS_KEY_ID="$ACCESS_KEY_ID" SMTP_PASSWORD="$SMTP_PASSWORD" \
  SMTP_HOST="$SMTP_HOST" SMTP_PORT="$SMTP_PORT" FROM_EMAIL="$FROM_EMAIL" \
  python3 - <<'PY'
import json, os
print(json.dumps({
  "SMTP_HOST": os.environ["SMTP_HOST"],
  "SMTP_PORT": os.environ["SMTP_PORT"],
  "SMTP_USERNAME": os.environ["ACCESS_KEY_ID"],
  "SMTP_PASSWORD": os.environ["SMTP_PASSWORD"],
  "SES_FROM_EMAIL": os.environ["FROM_EMAIL"],
}))
PY
)

echo "==> Upserting secret ${SECRET_NAME}"
if aws secretsmanager describe-secret --secret-id "$SECRET_NAME" --region "$REGION" >/dev/null 2>&1; then
  aws secretsmanager put-secret-value \
    --secret-id "$SECRET_NAME" \
    --region "$REGION" \
    --secret-string "$SECRET_PAYLOAD" >/dev/null
else
  aws secretsmanager create-secret \
    --name "$SECRET_NAME" \
    --region "$REGION" \
    --description "Skout SES SMTP for transactional mail" \
    --secret-string "$SECRET_PAYLOAD" >/dev/null
fi

echo "==> Done. From=${FROM_EMAIL} Host=${SMTP_HOST}"
echo "    Redeploy or force-new ECS API deployment so tasks pick up secret values."
echo "    SES sandbox: recipients must also be verified identities until production access is granted."
