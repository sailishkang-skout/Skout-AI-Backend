#!/bin/sh
set -e

# CRM shares RDS with the API. Migrations run from the API entrypoint and/or
# the ECS one-off migrate task — skip here to avoid concurrent migrate races.
exec "$@"
