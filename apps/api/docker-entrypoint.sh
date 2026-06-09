#!/bin/sh
set -e

MIGRATE_JS="/app/node_modules/@skout/db/dist/migrate.js"
if [ -f "$MIGRATE_JS" ]; then
  echo "Running database migrations..."
  export MIGRATIONS_FOLDER="${MIGRATIONS_FOLDER:-/app/node_modules/@skout/db/drizzle}"
  node "$MIGRATE_JS"
else
  echo "Migration runner not found — skipping (local dev image without @skout/db)"
fi

exec "$@"
