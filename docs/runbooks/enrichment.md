# LinkedIn enrichment runbook (ENR-06)

Written for: on-call engineers and whoever runs a release. Covers capture, provider jobs,
campaigns and the Chrome extension. Design and rationale are in ADR 0019; release approval is in
[docs/ops/enrichment-release-gates.md](../ops/enrichment-release-gates.md).

## What runs where

| Piece | Where | Stops working when |
| --- | --- | --- |
| Capture ingest, research, campaigns API | `apps/api` | API or Postgres is down |
| Provider job worker (`enrichment-provider-job.worker.ts`) | starts with the API | Postgres is down. Without Redis it still runs, on a 30 s timer |
| Ops worker (`enrichment-ops.worker.ts`) | starts with the API | Postgres is down |
| Evidence retention worker | starts with the API, daily 03:17 UTC | Redis is down (no fallback) |
| Campaign sending | the existing sequence worker | Redis is down |
| Chrome extension | users' browsers | The API host in its manifest is unreachable |

## Health checks

| Check | How | Healthy |
| --- | --- | --- |
| API up | `GET /api/v1/health` | `200`, `status: ok` |
| Enrichment metrics readable | `GET /api/v1/metrics` | `skout_enrichment_metrics_up 1` |
| Queue moving | `skout_enrichment_queue_lag_seconds` | under 300 |
| No orphaned jobs | `skout_enrichment_jobs_lost_lease` | 0 |
| One workspace | `GET /api/v1/enrichment/ops` (`enrichment:admin`) | `alerts: []` |
| Release state | start-up log line `LinkedIn enrichment release stage: …` | the stage you intended |

### When the database is down or restarting

- Every request that needs the database answers **503 `SERVICE_UNAVAILABLE`**, `retryable: true`,
  with `Retry-After: 5`; no SQL reaches the client and nothing is changed. `GET /api/v1/health`
  stays 200 (the API process is up), so watch `skout_enrichment_metrics_up`, which drops to 0
  within 30 seconds.
- The API reconnects on its own when the database is back; no restart is needed.
- The Chrome extension retries its reads (status, freshness) up to 5 times over about 7.5 seconds;
  captures are never retried, so a capture made during the outage shows its error and is run again
  by the user.
- A graceful shutdown during or after an outage waits at most 5 seconds for open queries, then
  closes the remaining database connections.

## Metrics and alerts

All gauges are on `GET /api/v1/metrics`, cover the last 24 hours, and are labelled only by
status or error code — never by workspace, URL or person.

| Metric | Meaning |
| --- | --- |
| `skout_enrichment_capture_runs{status}` | Capture runs by status |
| `skout_enrichment_capture_runs_abandoned` | Runs still `running` after two hours |
| `skout_enrichment_capture_leads_received` / `_rejected` | Leads accepted into runs / refused as unreadable |
| `skout_enrichment_jobs{status}` | Provider jobs by status |
| `skout_enrichment_job_errors{code}` | Jobs that stopped, by error code |
| `skout_enrichment_jobs_lost_lease` | Jobs marked running whose worker lease expired |
| `skout_enrichment_queue_waiting` / `skout_enrichment_queue_lag_seconds` | Jobs due and waiting / age of the oldest |
| `skout_enrichment_campaigns_pending_review` / `_changes_required` | Campaigns waiting on a person |

The ops worker evaluates these every five minutes and logs each firing alert as
`enrichment alert firing` at error level with fields `alert`, `severity`, `value`, `threshold`,
`detail`, `action`. A standing alert is logged again every 30 minutes; a cleared one logs
`enrichment alert resolved`. Build one log monitor per row:

| `alert` | Severity | Fires when | Monitor |
| --- | --- | --- | --- |
| `enrichment_queue_lag_high` | page | oldest due job waiting > 300 s | log `@alert:enrichment_queue_lag_high`, or metric `skout_enrichment_queue_lag_seconds > 300` for 5 min |
| `enrichment_jobs_lost_lease` | page | any running job with an expired lease | metric `skout_enrichment_jobs_lost_lease > 0` for 5 min |
| `enrichment_jobs_worker_lost` | ticket | any job failed `WORKER_LOST` in 24 h | log `@alert:enrichment_jobs_worker_lost` |
| `enrichment_job_failure_rate_high` | ticket | > 25% of ≥ 10 finished jobs failed | log `@alert:enrichment_job_failure_rate_high` |
| `enrichment_provider_credential_errors` | ticket | any job stopped on a missing/rejected credential | log `@alert:enrichment_provider_credential_errors` |
| `enrichment_provider_rate_limited` | ticket | any job gave up on rate limits | log `@alert:enrichment_provider_rate_limited` |
| `enrichment_capture_runs_abandoned` | ticket | any run running > 2 h | metric `skout_enrichment_capture_runs_abandoned > 0` for 15 min |
| `enrichment_capture_failure_rate_high` | ticket | > 30% of ≥ 10 finished runs failed or were rejected | log `@alert:enrichment_capture_failure_rate_high` |
| (scrape) | page | metrics unreadable | metric `skout_enrichment_metrics_up < 1` for 10 min |

**These monitors and the dashboard are not created by the code.** Creating them in Datadog is
a release gate (see the release-gates document).

## 1. Jobs are queued and not moving (`enrichment_queue_lag_high`)

1. Is the API process up? The job worker lives in it.
2. Look for the log line `Enrichment provider job worker started`, or `Redis unavailable —
   enrichment provider jobs run in-process on a timer`. Neither means the worker did not start;
   check `DATABASE_URL`.
3. Look for `enrichment provider job recovery failed` or `enrichment provider job pass failed`.
4. Restart the API. On start-up the worker re-queues every due job immediately.
5. Nothing is lost by a restart: a job is a database row. It is either re-queued or failed with
   `WORKER_LOST` and a message the user sees.

## 2. Jobs fail or stop with a provider error

| `errorCode` | Meaning | Action |
| --- | --- | --- |
| `PROVIDER_NOT_PERMITTED` | The provider is not approved or not enabled here | Expected until Legal approves it. See the provider policy |
| `PROVIDER_CONNECTION_REQUIRED` | No active provider account for the workspace | Workspace admin connects one under Enrichment → Providers |
| `PROVIDER_CREDENTIAL_REQUIRED` / `_REJECTED` | Key missing or refused | Workspace admin updates the key under Settings → Integrations; rotate the platform key if it is that one |
| `PROVIDER_ACCOUNT_UNAVAILABLE` | The account cannot read the profile | Reconnect the account |
| `PROVIDER_RATE_LIMITED` | Rate limited on all three attempts | Lower `enrichment.provider_daily_job_limit`. Do not add retries, proxies or parallelism |
| `PROVIDER_REQUEST_FAILED` | Timeouts / 5xx on all three attempts | Provider outage; users re-run later |
| `PROFILE_NOT_FOUND` | The provider has no such profile | None |
| `WORKER_LOST` / `ATTEMPTS_EXHAUSTED` | The process died repeatedly mid-job | Look for crashes or OOM around the job's `updated_at` |

## 3. Captures fail (`enrichment_capture_failure_rate_high`)

1. `GET /api/v1/enrichment/capture/runs` for an affected workspace shows each run's `errorCode`.
2. `profile_not_readable` or a jump in rejected leads usually means LinkedIn changed its page
   markup. Update the extension's parser fixtures (`apps/chrome-extension/test`) and release.
3. If LinkedIn is warning or restricting accounts, **turn capture off first**:
   `PUT /api/v1/enrichment/capture/settings` `{ "enabled": false, "reason": "…" }` per
   workspace (entitlement `enrichment.capture_kill_switch`). The next capture request is refused.
   Then review the workflow with Legal. Do not add proxy rotation, CAPTCHA handling or retries.

## 4. A campaign will not send

`GET /api/v1/enrichment/campaigns/:id` shows the status and each recipient's exclusion reason.
In the sequence worker log, a held or skipped campaign email names its reason:

| Reason | Meaning |
| --- | --- |
| `campaign_approval_required` / `campaign_re_review_required` | No standing approval. The email is deferred an hour at a time until someone re-approves |
| `sandbox_recipient_blocked` | Not production and the address is not in `ENRICHMENT_CAMPAIGN_SANDBOX_RECIPIENTS` |
| `email_not_verified` / `campaign_recipient_email_changed` | The address changed or lost its verification after approval |
| `suppressed` | On the suppression list |

**Approve is refused with `self_approval_not_allowed` (403).** A second person approves: the user
who created the campaign, or submitted it for review, cannot approve it (they can still reject it).
Ask another member with the send permission (`sequences:send`) to approve. A workspace with a
single member cannot approve campaigns until a second member is added.

## Deployment

Environments and branches are in `docs/deployment-environments.md`. For a release that includes
enrichment changes:

1. **CI is green** on the commit: tests, typecheck, migration validation, secret scan,
   dependency audit (critical), Chrome package validation.
2. **Snapshot the database**: `scripts/rds-snapshot.sh`. Note the snapshot id in the release
   ticket. RPO/RTO are in `docs/slo-targets.md`.
3. **Migrate**: `scripts/ecs-run-migrations.sh`. Migrations are additive and are applied by
   journal order; CI refuses a journal that would skip one. Run migrations before the new API
   takes traffic — new code reads the new columns.
4. **Seed permissions**: `scripts/ecs-run-backfill-rbac.sh` (idempotent).
5. **Deploy the API**, then the dashboard.
6. **Check**: the health table above, the start-up release-stage log line, and that
   `skout_enrichment_queue_lag_seconds` returns to 0.
7. **Chrome extension**, only when its code changed — see below.

### Environment separation

| Setting | Development / test | UAT | Production |
| --- | --- | --- | --- |
| `ENRICHMENT_RELEASE_STAGE` | not enforced | `internal` | `internal` until the gates are met |
| `ENRICHMENT_LEGAL_APPROVAL_REF` | unset | unset | set only with the recorded approval |
| `ENRICHMENT_PERMITTED_PROVIDERS` | unset | unset | unset until a provider is approved |
| `ENRICHMENT_CAMPAIGN_SANDBOX_RECIPIENTS` | a sandbox domain | a sandbox domain | ignored |
| `LINKEDIN_ENRICHMENT_TEST_MODE` | `true` when exercising the job lifecycle | optional | ignored |
| Database | local Docker | its own | its own |

**Data never moves downward or sideways into production.** Do not restore, import or copy a
local or UAT database, a dump, or a file of captured profiles into production. Production
enrichment data is only ever written by the API, on behalf of a signed-in user, with a workspace
on every row. If production data is needed for debugging, read it in place. CI's secret scan
refuses committed dumps, `.env` files and captured-data files for the same reason.

### Rollback

- **Fastest: turn the feature off.** Set `ENRICHMENT_RELEASE_STAGE=internal` (and clear
  `ENRICHMENT_LEGAL_APPROVAL_REF`) and restart; only workspaces with `enrichment.internal_access`
  keep access. For one workspace, turn on the capture kill switch. Neither needs a deploy of code.
- **Roll back the API** to the previous image. Enrichment migrations are additive, so the
  previous image runs against the new schema; do not roll the schema back.
- **Stop sending**: pause the campaign's sequence in the Sequences screen. Withdrawn approvals
  already hold campaign emails.
- **Restore from snapshot** only for data corruption, and only into the same environment. It
  discards everything written since the snapshot, including suppressions and unsubscribes —
  re-apply those from the audit log before sending resumes.

## Chrome extension release

1. Bump `version` in `apps/chrome-extension/manifest.json` and `package.json` (they must match).
2. `pnpm --filter @skout/chrome-extension test`
3. `pnpm --filter @skout/chrome-extension package:store`
4. `GITHUB_BASE_REF=main node scripts/check-extension-package.mjs --release` — fails if the
   version did not move, a permission or host is outside the reviewed list, a development origin
   is in the store manifest, or a script the manifest names is missing.
5. Load `store-build/` unpacked in Chrome and run acceptance cases 1–5 from the release-gates
   document against UAT.
6. Upload `skout-extension-v<version>.zip` (see `docs/ops/chrome-extension-store-listing.md`).
   Record the version in the release ticket.

CI runs steps 3–4 (without `--release`) on every change, so a version that was not bumped shows
as a warning on the pull request.

## Retention and deletion

| Data | Kept for | Removed by |
| --- | --- | --- |
| Capture evidence (`evidence_ledger`, capture sources) | 365 days from last capture (entitlement `enrichment.evidence_retention_days`) | Retention worker, daily |
| Raw provider responses | 90 days | Retention worker, daily; the attempt row stays |
| Snapshots, change events, identity keys, jobs, campaign recipients | Life of the person or company | Deleting the record |
| Capture runs, audit log | Kept | — (they hold counts and actions, not profile content) |
| Suppressions | Kept | Never removed by a delete: a deleted person must stay suppressed |

- **Delete one person or company:** `DELETE /api/v1/enrichment/people/:id` /
  `…/companies/:id` (`enrichment:delete`, audited). Removes identity keys, evidence, snapshots,
  change events, discovery links, jobs and raw responses in one transaction.
- **Data-subject request:** follow `docs/ops/dsar-fulfillment.md`; the enrichment delete above is
  the enrichment step of it.
- **Workspace offboarding:** every enrichment table has `workspace_id` with `ON DELETE CASCADE`.
- **If the retention worker has not run** (Redis was down): nothing is lost; it removes
  everything past its date on the next run.
