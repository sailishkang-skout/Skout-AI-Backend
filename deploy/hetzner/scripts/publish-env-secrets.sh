#!/usr/bin/env bash
# Store each built env file (deploy/hetzner/env/<service>.env) as a GitHub environment secret ENV_<SERVICE>.
# The repository is public, so the env files are never committed; the deploy workflow writes them from these
# secrets for the duration of one run. Rebuild the files with config-from-synth.mjs, then run this again.
# Usage: ./publish-env-secrets.sh [owner/repo] [environment]
set -euo pipefail
REPO="${1:-sailishkang-skout/Skout-AI-Backend}"
ENVIRONMENT="${2:-hetzner-staging}"
DIR="$(cd "$(dirname "$0")/../env" && pwd)"

shopt -s nullglob
files=("$DIR"/*.env)
[ "${#files[@]}" -gt 0 ] || { echo "no env files in $DIR (run config-from-synth.mjs first)" >&2; exit 1; }

for f in "${files[@]}"; do
  service="$(basename "$f" .env)"
  name="ENV_$(printf '%s' "$service" | tr 'a-z-' 'A-Z_')"
  size="$(wc -c < "$f")"
  # GitHub secrets are limited to 48 KB each.
  [ "$size" -lt 49152 ] || { echo "$f is $size bytes, over the 48 KB secret limit" >&2; exit 1; }
  gh secret set "$name" -R "$REPO" --env "$ENVIRONMENT" < "$f"
  echo "set $name ($size bytes)"
done
