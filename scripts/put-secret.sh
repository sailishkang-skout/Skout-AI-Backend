#!/usr/bin/env bash
# Update a Skout secret in AWS Secrets Manager.
#
# Usage:
#   ./scripts/put-secret.sh SkoutDev openai '{"OPENAI_API_KEY":"sk-..."}'
#   ./scripts/put-secret.sh SkoutDev clerk '{"CLERK_SECRET_KEY":"...","CLERK_PUBLISHABLE_KEY":"..."}'

set -euo pipefail

if [ "$#" -lt 3 ]; then
  echo "Usage: $0 <prefix> <secret-path> <json-body>" >&2
  echo "Example: $0 SkoutDev openai '{\"OPENAI_API_KEY\":\"sk-...\"}'" >&2
  exit 1
fi

PREFIX="$1"
PATH_PART="$2"
JSON="$3"
SECRET_ID="${PREFIX}/${PATH_PART}"

aws secretsmanager put-secret-value \
  --secret-id "${SECRET_ID}" \
  --secret-string "${JSON}"

echo "Updated secret: ${SECRET_ID}"
