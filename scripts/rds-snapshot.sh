#!/usr/bin/env bash
# Take a manual RDS snapshot before a migration-bearing deploy (AUTH-ADI-07).
# Usage: ./scripts/rds-snapshot.sh SkoutDev
#        ./scripts/rds-snapshot.sh SkoutProd

set -euo pipefail

STACK_PREFIX="${1:?Stack prefix required (e.g. SkoutDev or SkoutProd)}"
REGION="${AWS_REGION:-${AWS_DEFAULT_REGION:-us-east-1}}"
export AWS_REGION="$REGION"
export AWS_DEFAULT_REGION="$REGION"

PREFIX_LOWER="$(echo "$STACK_PREFIX" | tr '[:upper:]' '[:lower:]')"

DB_INSTANCE_ID="$(aws rds describe-db-instances \
  --region "$REGION" \
  --query "DBInstances[?starts_with(DBInstanceIdentifier, \`${PREFIX_LOWER}\`)].DBInstanceIdentifier | [0]" \
  --output text)"

if [ -z "$DB_INSTANCE_ID" ] || [ "$DB_INSTANCE_ID" = "None" ]; then
  echo "No RDS instance found with identifier prefix '${PREFIX_LOWER}' — likely a first-ever"
  echo "deploy to this environment (nothing to snapshot yet). Skipping, not failing the deploy."
  exit 0
fi

SNAPSHOT_ID="${PREFIX_LOWER}-pre-migrate-$(date -u +%Y%m%dT%H%M%SZ)"

echo "DB instance: ${DB_INSTANCE_ID}"
echo "Creating snapshot: ${SNAPSHOT_ID}"

aws rds create-db-snapshot \
  --region "$REGION" \
  --db-instance-identifier "$DB_INSTANCE_ID" \
  --db-snapshot-identifier "$SNAPSHOT_ID" \
  --tags "Key=purpose,Value=pre-migration" "Key=stack,Value=${STACK_PREFIX}" \
  --query 'DBSnapshot.DBSnapshotIdentifier' \
  --output text

echo "Waiting for snapshot to become available..."
aws rds wait db-snapshot-available \
  --region "$REGION" \
  --db-snapshot-identifier "$SNAPSHOT_ID"

echo "Snapshot ${SNAPSHOT_ID} is available."
