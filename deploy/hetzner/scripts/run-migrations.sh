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

  # The staging Postgres is small (db-g1-small: 50 connections, 3 kept for superusers) and the running
  # services hold pools of their own, so a step can start while it is briefly full. That is transient:
  # wait for the services to release connections and try again, instead of failing the whole deploy
  # (this is what failed the run for PR #286). Any other failure still fails immediately.
  local attempt=1 max_attempts="${MIGRATION_MAX_ATTEMPTS:-6}" delay="${MIGRATION_RETRY_DELAY_SECS:-30}" log
  log="$(mktemp)"
  until docker run --rm --env-file "$ENV_DIR/$envfile" -e MIGRATIONS_FOLDER=/app/db/drizzle \
    "${ep_args[@]}" "ghcr.io/$GHCR_OWNER/$image:$IMAGE_TAG" "$@" 2>&1 | tee "$log"; do
    if [ "$attempt" -lt "$max_attempts" ] && grep -qE "remaining connection slots are reserved|too many clients already" "$log"; then
      echo "Postgres has no free connection slots (attempt $attempt of $max_attempts); retrying in ${delay}s." >&2
      attempt=$((attempt + 1))
      sleep "$delay"
      continue
    fi
    rm -f "$log"
    return 1
  done
  rm -f "$log"
}

echo "== core (drizzle) =="
run skout-api api.env node /app/node_modules/@skout/db/dist/migrate.js

# Roles, permissions and member grants live in data, not migrations. Every environment runs this
# idempotent backfill after migrating (CI does too); without it the API refuses to start once a member exists.
echo "== core (rbac seed) =="
run skout-api api.env node /app/node_modules/@skout/db/dist/backfill-rbac.js

# Regions, the 250 countries, their aliases and the country x industry TAM rows. The brief seed below only
# attaches facts to countries that already exist, and the country picker lists this table, so this must run
# first; without it only countries auto-provisioned on demand (e.g. US) appear. Upserts, safe on every deploy.
echo "== core (regional brief reference data) =="
run skout-api api.env node /app/node_modules/@skout/db/dist/seed-regional-brief-reference-data.js

# The Regional Selling Brief content (facts for 250 markets) is also data, not a migration; the page is empty
# without it. The seed upserts, so running it on every deploy is safe.
echo "== core (regional brief seed) =="
run skout-api api.env node /app/node_modules/@skout/db/dist/seed-regional-brief.js

echo "== email-intel =="
run skout-email-intel email-intel-api.env node dist/db/ensureDatabase.js
run skout-email-intel email-intel-api.env node dist/db/migrate.js

echo "== warm-up tool =="
run skout-warmup-tool warmup-tool-api.env default node dist/cli/ensure-database.js
run skout-warmup-tool warmup-tool-api.env default node dist/cli/migrate.js up
