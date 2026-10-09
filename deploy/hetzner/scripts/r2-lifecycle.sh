#!/usr/bin/env bash
# Mirror CDK SkoutStorage lifecycle rules on R2 (dev values: exports/email-intel expire after 30 days,
# scrape quarantine/ after 30 days). R2 has no Glacier tier, so the 90-day raw/ transition is dropped.
# Usage: R2_ENDPOINT=... AWS_ACCESS_KEY_ID=... AWS_SECRET_ACCESS_KEY=... ./r2-lifecycle.sh skout-staging
set -euo pipefail
PREFIX="${1:?bucket prefix, e.g. skout-staging}"
: "${R2_ENDPOINT:?}"
export AWS_DEFAULT_REGION=auto

put() { # bucket json
  aws s3api put-bucket-lifecycle-configuration --endpoint-url "$R2_ENDPOINT" --bucket "$1" --lifecycle-configuration "$2"
}

EXPIRE_30='{"Rules":[{"ID":"expire-30d","Status":"Enabled","Filter":{"Prefix":""},"Expiration":{"Days":30}}]}'
put "$PREFIX-exports" "$EXPIRE_30"
put "$PREFIX-email-intel" "$EXPIRE_30"
put "$PREFIX-scrape" '{"Rules":[{"ID":"quarantine-30d","Status":"Enabled","Filter":{"Prefix":"quarantine/"},"Expiration":{"Days":30}}]}'
echo "lifecycle rules applied"
