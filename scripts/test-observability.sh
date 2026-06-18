#!/usr/bin/env bash
# Smoke-test local observability: API health, headers, rate limit, AI service, optional keys.
#
# Usage:
#   ./scripts/test-observability.sh
#   API_URL=http://127.0.0.1:3001 AI_URL=http://127.0.0.1:8000 ./scripts/test-observability.sh
#
# Note: /api/v1/health is allowlisted — it never returns 429. Rate-limit checks use /api/v1/me.
#
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
API_URL="${API_URL:-http://localhost:3001}"
AI_URL="${AI_URL:-http://localhost:8000}"
RATE_LIMIT_PATH="${RATE_LIMIT_PATH:-/api/v1/me}"
RATE_LIMIT_REQUESTS="${RATE_LIMIT_REQUESTS:-210}"
ENV_FILE="${ENV_FILE:-$ROOT/.env}"

PASS=0
FAIL=0
SKIP=0

green() { printf '\033[32m%s\033[0m\n' "$*"; }
red() { printf '\033[31m%s\033[0m\n' "$*"; }
yellow() { printf '\033[33m%s\033[0m\n' "$*"; }

pass() {
  PASS=$((PASS + 1))
  green "PASS  $*"
}

fail() {
  FAIL=$((FAIL + 1))
  red "FAIL  $*"
}

skip() {
  SKIP=$((SKIP + 1))
  yellow "SKIP  $*"
}

http_code() {
  curl -s -o /dev/null -w "%{http_code}" --connect-timeout 3 --max-time 10 "$@"
}

http_headers() {
  curl -s -D - -o /dev/null --connect-timeout 3 --max-time 10 "$@"
}

is_configured_secret() {
  local v="${1:-}"
  [[ -n "$v" ]] || return 1
  local lower
  lower="$(printf '%s' "$v" | tr '[:upper:]' '[:lower:]')"
  case "$lower" in
    replace-me*|undefined|null|none|"") return 1 ;;
  esac
  [[ "$v" != *"..."* ]] || return 1
  [[ "$v" != your_* ]] || return 1
  return 0
}

echo "Skout observability smoke test"
echo "  API_URL=$API_URL"
echo "  AI_URL=$AI_URL"
echo ""

# --- API health ---
code="$(http_code "$API_URL/api/v1/health" || true)"
if [[ "$code" == "200" ]]; then
  pass "API health → HTTP $code"
else
  fail "API health → HTTP ${code:-unreachable} (is \`pnpm dev\` running?)"
fi

# --- Request ID ---
req_id="$(http_headers "$API_URL/api/v1/health" | tr -d '\r' | awk 'tolower($1)=="x-request-id:" {print $2; exit}')"
if [[ -n "$req_id" ]]; then
  pass "x-request-id header present ($req_id)"
else
  fail "x-request-id header missing"
fi

# --- Security headers ---
headers="$(http_headers "$API_URL/api/v1/health" | tr -d '\r')"
sec_ok=0
echo "$headers" | grep -qi '^x-frame-options:' && sec_ok=$((sec_ok + 1))
echo "$headers" | grep -qi '^x-content-type-options:' && sec_ok=$((sec_ok + 1))
echo "$headers" | grep -qi '^strict-transport-security:' && sec_ok=$((sec_ok + 1))
if [[ "$sec_ok" -ge 2 ]]; then
  pass "Security headers present (helmet: $sec_ok/3 checked)"
else
  fail "Security headers weak or missing ($sec_ok/3 — expected x-frame-options, x-content-type-options)"
fi

# --- Rate limit (health is allowlisted — use another route) ---
echo ""
yellow "INFO  /api/v1/health is rate-limit allowlisted — testing $RATE_LIMIT_PATH instead"
count_200=0
count_429=0
count_other=0
for _ in $(seq 1 "$RATE_LIMIT_REQUESTS"); do
  code="$(http_code "$API_URL$RATE_LIMIT_PATH" || true)"
  case "$code" in
    200|401|403) count_200=$((count_200 + 1)) ;;
    429) count_429=$((count_429 + 1)) ;;
    *) count_other=$((count_other + 1)) ;;
  esac
done
if [[ "$count_429" -gt 0 ]]; then
  pass "Rate limit → $count_429 x 429 after $RATE_LIMIT_REQUESTS requests to $RATE_LIMIT_PATH"
elif [[ "$count_200" -eq "$RATE_LIMIT_REQUESTS" ]]; then
  fail "Rate limit → no 429 after $RATE_LIMIT_REQUESTS requests (got $count_200 OK-ish, $count_other other)"
  yellow "      Check RATE_LIMIT_MAX / RATE_LIMIT_WINDOW_MS in .env (default 200/min)"
else
  fail "Rate limit → unexpected mix: ${count_200} ok-ish, ${count_429} throttled, ${count_other} other"
fi

# --- AI health ---
echo ""
code="$(http_code "$AI_URL/health" || true)"
if [[ "$code" == "200" ]]; then
  pass "AI health → HTTP $code"
else
  fail "AI health → HTTP ${code:-unreachable}"
  yellow "      Start AI: docker compose -f docker-compose.yml -f docker-compose.local.yml up ai -d"
fi

# --- AI classify (PostHog event: prospect_classified) ---
if [[ "$code" == "200" ]]; then
  classify_body='{"thread_id":"obs-test-1","content":"hello"}'
  classify_resp="$(curl -s -w "\n%{http_code}" -X POST "$AI_URL/v1/classify" \
    -H "Content-Type: application/json" \
    -d "$classify_body" \
    --connect-timeout 3 --max-time 15 2>/dev/null || true)"
  classify_code="$(printf '%s' "$classify_resp" | tail -n1)"
  classify_json="$(printf '%s' "$classify_resp" | sed '$d')"
  if [[ "$classify_code" == "200" ]] && echo "$classify_json" | grep -q '"intent"'; then
    pass "AI classify → HTTP 200 with intent field"
  else
    fail "AI classify → HTTP ${classify_code:-?} body=${classify_json:-empty}"
  fi
else
  skip "AI classify (AI service not up)"
fi

# --- Optional env keys (presence only — values not printed) ---
echo ""
if [[ -f "$ENV_FILE" ]]; then
  # shellcheck disable=SC1090
  set -a
  # shellcheck source=/dev/null
  source "$ENV_FILE"
  set +a

  for key in SENTRY_DSN POSTHOG_API_KEY DD_API_KEY; do
    val="${!key:-}"
    if is_configured_secret "$val"; then
      pass "Env $key is set (observability enabled when service starts)"
    else
      skip "Env $key not set — observability layer disabled (app still runs)"
    fi
  done

  ai_env="$ROOT/apps/ai/.env"
  if [[ -f "$ai_env" ]]; then
    # shellcheck disable=SC1090
    source "$ai_env"
    if is_configured_secret "${POSTHOG_PROJECT_TOKEN:-${POSTHOG_API_KEY:-}}"; then
      pass "AI PostHog token is set"
    else
      skip "AI PostHog token not set"
    fi
  fi
else
  skip "No $ENV_FILE — skipping env key checks"
fi

# --- Summary ---
echo ""
echo "────────────────────────────────────"
echo "Results: $PASS passed, $FAIL failed, $SKIP skipped"
if [[ "$FAIL" -eq 0 ]]; then
  green "All required checks passed."
  echo ""
  echo "Verify dashboards manually:"
  echo "  • API logs     → terminal running pnpm dev (JSON lines)"
  echo "  • Sentry       → https://sentry.io (nodejs / python / frontend projects)"
  echo "  • PostHog      → https://us.posthog.com → Live events (prospect_classified)"
  echo "  • Datadog APM  → https://us5.datadoghq.com (needs local DD agent on :8126)"
  exit 0
else
  red "$FAIL check(s) failed — see messages above."
  exit 1
fi
