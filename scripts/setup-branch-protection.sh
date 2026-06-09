#!/usr/bin/env bash
# Apply GitHub branch protection: PR required + 1 approving review before merge.
#
# Prerequisites:
#   gh auth login
#   Admin access on the repository
#
# Usage:
#   ./scripts/setup-branch-protection.sh
#   ./scripts/setup-branch-protection.sh --dry-run

set -euo pipefail

DRY_RUN=false
if [[ "${1:-}" == "--dry-run" ]]; then
  DRY_RUN=true
fi

if ! command -v gh >/dev/null 2>&1; then
  echo "Error: GitHub CLI (gh) is required. Install: https://cli.github.com/" >&2
  exit 1
fi

if ! gh auth status >/dev/null 2>&1; then
  echo "Error: Not logged in. Run: gh auth login" >&2
  exit 1
fi

REPO="$(gh repo view --json nameWithOwner --jq .nameWithOwner)"
BRANCHES=(develop uat main)
REQUIRED_REVIEWS=1

echo "Repository: ${REPO}"
echo "Branches:   ${BRANCHES[*]}"
echo "Required approving reviews: ${REQUIRED_REVIEWS}"
echo

apply_branch_protection() {
  local branch="$1"
  local payload
  payload="$(cat <<EOF
{
  "required_status_checks": null,
  "enforce_admins": true,
  "required_pull_request_reviews": {
    "dismiss_stale_reviews": true,
    "require_code_owner_reviews": false,
    "required_approving_review_count": ${REQUIRED_REVIEWS},
    "require_last_push_approval": false
  },
  "restrictions": null,
  "required_linear_history": false,
  "allow_force_pushes": false,
  "allow_deletions": false,
  "block_creations": false,
  "required_conversation_resolution": true
}
EOF
)"

  if [[ "$DRY_RUN" == true ]]; then
    echo "[dry-run] Would protect branch: ${branch}"
    return 0
  fi

  echo "Protecting branch: ${branch}"
  gh api \
    --method PUT \
    -H "Accept: application/vnd.github+json" \
    "/repos/${REPO}/branches/${branch}/protection" \
    --input - <<<"${payload}"
}

for branch in "${BRANCHES[@]}"; do
  apply_branch_protection "${branch}"
done

cat <<EOF

Done.

Merges to develop, uat, and main are now blocked until:
  - the change is opened as a pull request, and
  - at least ${REQUIRED_REVIEWS} teammate approves the PR.

Optional next step — require CI to pass before merge:
  GitHub → Settings → Branches → edit each rule → enable required status checks
  after CI has run at least once (job names from .github/workflows/ci.yml).

EOF
