#!/usr/bin/env bash
# Give the app user ownership of the three databases. Migrations in this repo create no extensions
# (verified: `grep -rhi "create extension" packages/db/drizzle` is empty), so nothing else is needed.
# Usage: PG_HOST=... PG_PORT=... PG_ADMIN_USER=doadmin PG_ADMIN_PASSWORD=... ./pg-bootstrap.sh
set -euo pipefail
: "${PG_HOST:?}" "${PG_PORT:?}" "${PG_ADMIN_USER:?}" "${PG_ADMIN_PASSWORD:?}"

for db in skout email_intelligence email_warmup; do
  PGPASSWORD="$PG_ADMIN_PASSWORD" psql "host=$PG_HOST port=$PG_PORT user=$PG_ADMIN_USER dbname=$db sslmode=require" -v ON_ERROR_STOP=1 <<SQL
ALTER DATABASE $db OWNER TO skout;
GRANT ALL ON SCHEMA public TO skout;
SQL
done
echo "bootstrapped skout, email_intelligence, email_warmup"
