#!/usr/bin/env bash
# Run the three migration sets against the managed Postgres as one-off containers.
# Requires DOCKER_HOST=ssh://root@<manager> and the decrypted env files in deploy/hetzner/env/.
# Usage: GHCR_OWNER=... IMAGE_TAG=... ./run-migrations.sh
set -euo pipefail
: "${GHCR_OWNER:?}" "${IMAGE_TAG:?}"
ENV_DIR="$(cd "$(dirname "$0")/../env" && pwd)"

# No --network: migrations only need the managed Postgres, which is reachable over the node's public
# address (the DB firewall allows the node IPs). The skout_skout overlay network does not exist yet on a
# first deploy, because `docker stack deploy` creates it.
# The warm-up image's own entrypoint builds DATABASE_URL from the DATABASE_* fields, which its migrate command
# requires, so it runs with the image's default entrypoint ("default"). The others call node directly.
run() { # image env-file entrypoint|default args...
  local image="$1" envfile="$2" ep="$3"
  shift 3
  local ep_args=()
  [ "$ep" = "default" ] || ep_args=(--entrypoint "$ep")
  docker run --rm --env-file "$ENV_DIR/$envfile" -e MIGRATIONS_FOLDER=/app/db/drizzle \
    "${ep_args[@]}" "ghcr.io/$GHCR_OWNER/$image:$IMAGE_TAG" "$@"
}

echo "== core (drizzle) =="
run skout-api api.env node /app/node_modules/@skout/db/dist/migrate.js

# Roles, permissions and member grants live in data, not migrations. Every environment runs this
# idempotent backfill after migrating (CI does too); without it the API refuses to start once a member exists.
echo "== core (rbac seed) =="
run skout-api api.env node /app/node_modules/@skout/db/dist/backfill-rbac.js

echo "== email-intel =="
run skout-email-intel email-intel-api.env node dist/db/ensureDatabase.js
run skout-email-intel email-intel-api.env node dist/db/migrate.js

echo "== warm-up tool =="
run skout-warmup-tool warmup-tool-api.env default node dist/cli/ensure-database.js
run skout-warmup-tool warmup-tool-api.env default node dist/cli/migrate.js up
