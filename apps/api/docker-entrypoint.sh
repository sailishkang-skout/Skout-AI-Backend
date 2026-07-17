#!/bin/sh
set -e

MIGRATE_JS="/app/node_modules/@skout/db/dist/migrate.js"
APPLY_PENDING_JS="/app/node_modules/@skout/db/dist/apply-pending.js"
if [ -f "$MIGRATE_JS" ]; then
  echo "Running database migrations..."
  export MIGRATIONS_FOLDER="${MIGRATIONS_FOLDER:-/app/db/drizzle}"
  node "$MIGRATE_JS"
else
  echo "Migration runner not found — skipping (local dev image without @skout/db)"
fi

# Idempotent ALTER IF NOT EXISTS for columns drizzle migrate may skip when the
# image's drizzle journal/hash is stale relative to schema (e.g. delay_unit).
if [ -f "$APPLY_PENDING_JS" ]; then
  echo "Applying pending schema repairs..."
  node "$APPLY_PENDING_JS"
fi

exec "$@"
