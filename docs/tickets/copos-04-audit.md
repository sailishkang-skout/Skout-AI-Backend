# COPS-04 audit-and-extend: trial provisioning + credit ledger

Ticket: COPS-04 (XL, P0), depends on COPS-01 and COPS-03. Bible p.36, 39-40, Appendix H; Epic E06/E07.
Contract: `docs/api/copos-04-provisioning.openapi.yaml`.

## What already exists

| Area | Existing code | Finding |
|---|---|---|
| Credit ledger | `packages/db/src/schema/credits.ts` (`credit_balances`, `credit_transactions`) | Append-only in intent, not enforced: no trigger, no kind, no actor, no reason, no idempotency key. |
| Credit writers | `workspace.service.addCredits` (admin top-up), `enrichment/db-store` (search/enrich consume), `billing.service.captureOrder` (Razorpay credit packs), `auth.service` signup (500 grant), `demo-workspace.ts` | Five independent writers. Each reads the balance and writes `balance + amount` without a lock, so two concurrent writes lose one. `demo-workspace` overwrites the balance with no ledger row. |
| Credit purchase | `billing.service.captureOrder` credits only after the captured-payment webhook/verify | Matches the Bible rule (wallet only after confirmed payment). Kept; it now goes through the ledger with the payment id as idempotency key. |
| Workspace creation | `packages/auth/src/auth.service.ts` (signup creates workspace + owner + 500 credits) | Only at signup, tied to a user. Nothing creates a workspace for a customer account. |
| Admin invitation | `workspace_invites` + `autoAcceptPendingInvites` (member row + `grantSystemMemberRole` on sign-in) | Reused as-is: provisioning creates an `owner` invite; the existing accept path grants the role. |
| Plan / entitlements | `entitlements` table + `EntitlementsService` | Reused for plan, trial dates and integration placeholders. No new plan table. |
| Roles | System roles are global (`roles.workspace_id is null`, `backfill-rbac.ts`) | Nothing per workspace to create; the step verifies the system roles exist and records the admin role. |
| Events | `WorkspaceProvisioned`, `CreditsGranted` already in the COPS-01 registry and mapped to the `provisioning` timeline type | Reused, payloads unchanged. |

## Decisions

1. **One ledger path.** `postCreditTransaction(tx, …)` in `packages/db/src/credit-ledger.ts` is the only way to change a balance. It locks the wallet row, enforces an idempotency key per workspace, writes `balance_after`, and refuses to go below zero. All five writers above call it; their `action` strings stay the same.
2. **Append-only in the database.** `credit_transactions` gets a trigger that rejects UPDATE always and DELETE unless the workspace itself is gone (so workspace deletion still cascades). Corrections are compensating rows that point at the row they correct (`compensates_id`).
3. **Kinds.** `grant | purchase | consume | refund | expire | adjustment`. Existing rows are backfilled from `action` and the amount sign. Credit categories are left out until Product decides (Q2); a nullable `category` column is there so adding them is not a migration on a hot table.
4. **Opening balance.** Wallets whose balance does not equal the sum of their rows today get one `adjustment` row (`reason = COPS-04 opening balance`) in the migration, so reconciliation starts clean and every later mismatch is real.
5. **Reconciliation.** A daily job compares `credit_balances.balance` with `sum(amount)` and with the last `balance_after`; mismatches are stored in `credit_reconciliation_runs` and logged as errors. It never "fixes" a wallet; a fix is a compensating adjustment by a person.
6. **Provisioning is a saga** in the operator's workspace (`cops_provisionings` + `cops_provisioning_steps`). Steps run in order, each idempotent and recorded: `create_workspace → default_roles → entitlements → credit_wallet → integration_placeholders → admin_invite → link_crm`. A failed step leaves earlier steps done; retry continues from the failed step.
7. **Idempotency key** is `sha256(account_id + Idempotency-Key)`, unique on `cops_provisionings`. The same key returns the same provisioning (and resumes it if it failed). An account that already has a provisioned workspace gets 409 for a new key, so a double click or a second rep cannot create a second workspace.
8. **Gate.** Provisioning needs an opportunity whose COPS-03 gate has fired (`ProvisioningRequested`). Trials use the `trial_approval_only` policy. To confirm with Product (Q1).
9. **Latency.** `duration_ms` is stored per provisioning and per step; anything over the 2-minute target is logged as a warning and visible in the API.
10. **Who authorised complimentary credits.** Every grant and adjustment row stores actor type, actor id and reason; the API refuses one without a reason. The trial grant at provisioning is attributed to the user who provisioned.

## Permissions (no new keys)

| Action | Keys |
|---|---|
| Provision, retry, extend trial | `onboarding:write` or `commercial:send` |
| Read provisioning and wallet | `onboarding:read`, `commercial:read` or `credits:read` |
| Grant / adjust credits | `credits:adjust` |

## PR plan

1. This doc + OpenAPI.
2. Ledger: migration, `postCreditTransaction`, refactor of the five writers, append-only trigger, tests.
3. Provisioning saga + routes + failure injection tests + latency.
4. Wallet routes (balance, ledger, grant, adjust, extend trial, usage) + reconciliation job.
5. FE: provision flow with step progress and retry; wallet UI.

## Open questions

- Q1: Provisioning requires a fired gate. Is a trial without an opportunity ever allowed?
- Q2: Credit categories (e.g. enrichment vs AI credits)?
- Q3: Default trial length and trial credits (default 14 days / 500 credits, the signup amount).

## Implementation status (2026-10-07)

| Acceptance | Where it is proved |
|---|---|
| Same idempotency key returns the same result; no duplicate workspace/invite/wallet | `cops-provisioning.service.test.ts` (replay, concurrent replay, second key 409), `cops-provisioning.routes.test.ts` (201 then 200) |
| Failure injected at each saga step resumes cleanly | `cops-provisioning.service.test.ts`: one test per step (7); the failed step rolls back, retry resumes from it, nothing runs twice, one WorkspaceProvisioned and one CreditsGranted |
| No UPDATE/DELETE on ledger rows; duplicate adjustment idempotent; reconciliation detects corruption | `packages/db/src/credit-ledger.test.ts` (trigger, concurrent duplicate, drifted wallet), `credit-reconciliation.worker.test.ts` |
| Latency measured against the 2-minute target | `duration_ms` + `within_target` on every provisioning (API and audit row); log warning above 120 s |

Also built:

- Wallet API: balance, ledger (cursor), 30-day usage, complimentary grant, manual adjustment (override audit, compensating `compensates_id`), trial extension. Finance-only for grant/adjust (`credits:adjust`).
- Purchases: credits lines of a paid COPS-03 payment request become one `purchase` (key = payment request id), from the existing COPS-03 webhook hook and from the provisioning wallet step (payment before provisioning). Reuses the COPS-03 payment service; no new payment code.
- 360 header: `plan` and `provisioning {workspace_id, trial_starts_at, trial_ends_at}`; account lifecycle starts at `trial`.
- Daily reconciliation worker (03:15 UTC), records runs, logs mismatches as errors, never edits a wallet.
- Tenant isolation test covers `cops_provisionings`, `cops_provisioning_steps`.

Decisions taken while building:

- Provision does not use the COPS-01 idempotency store: a stored 502 would block resume. The saga row's own key (sha256(account + Idempotency-Key)) does replay and resume. Other writes use the store, and grant/adjust also use the key as the ledger key.
- Invite email is sent after the invite commits; a send failure is recorded on the step (`email_sent: false`), never fails provisioning. The accept link is on the provisioning for the rep.
- `CreditsGranted` payload gained an optional `account_id` (additive) so grants reach the account timeline.
- `duration_ms` is the wall time of the run that finished (a retry a day later is not counted as one slow provisioning).

## Runbook: correct the credit ledger

1. `GET /credits/reconciliation` (or the latest row in `credit_reconciliation_runs`) shows the wallet and the problem.
2. Never edit `credit_transactions` or `credit_balances` by hand (the trigger refuses ledger edits).
3. Post `POST /accounts/:id/credits/adjustments` with the signed amount, a reason, and `compensates_id` of the wrong entry. It is audited as an override.
4. If only `credit_balances` drifted (ledger is right), the fix is an engineering ticket: the balance row is restored to the ledger sum in a reviewed migration, since the adjustment API moves both together.

## Frontend (Skout-AI-Frontend PR #114)

- Onboarding tab: provision-trial flow with step-by-step progress, retry from the failed step (same Idempotency-Key), trial info, admin invite status, extend trial.
- Billing tab: balance, ledger table, 30-day usage chart, grant/adjust dialogs (reason required), extend trial, add credits.
- Browser-verified against the local API with a real user: 7/7 steps, 6.9 s; grant of 100 moved the balance 500 -> 600.

## COPS-01..04 completeness pass (2026-10-08)

A pass over every COPS-01..04 acceptance item and the Definition of Done found these gaps; all are closed in the COPS-04 PRs unless marked.

| Gap | Fix |
|---|---|
| CI architecture gates fail against develop (stacked PRs never ran CI) | ADR 0003 exception blocks on `cops-commercial.routes.ts` and `cops-gate.service.ts` (commit on the COPS-03 branch); §1 gate line answered on PRs #176 and #178. Both gates pass locally against develop. |
| Commercial navigation (deferred from COPS-01 to COPS-03, never built) | `GET /api/v1/commercial/opportunities` (cross-account desk, state filter, cursor) and the FE `/commercial` page with a `commercial:read` nav entry. **Route test written; not yet run, the local test database was down.** |
| `/cops` and `/commercial` reachable signed-out at the FE middleware | Added to the protected routes; a test now fails when a dashboard folder is missing from the list. |
| FE e2e only covered COPS-01 | `e2e/cops-customer-ops.spec.ts`: 360 timeline, provision failure + retry (same key), grant with reason, Commercial Desk, permission-hidden nav. 7/7 with `cops-platform.spec.ts`. |
| Every protected e2e page bounced to sign-in (AUTH-FE-18 dropped the middleware's E2E bypass; the e2e job on #110/#111 fails this way) | Bypass restored for non-production servers only. Needs review by the auth owner. |
| Analytics instrumentation (DoD) missing in all four tickets | `lib/cops-analytics.ts`: canonical, versioned PostHog events for the COPS-01..04 writes; ids and counts only. |

Still open:

- Q1-Q4 above (Q4: refunds of a credit purchase are not reversed automatically yet; Finance posts an adjustment).
- COPS-01: authenticated 422/429 check against a real API response (only mocked so far) - needs the local database.
- The full `apps/api` suite has not completed locally (30-minute limit); CI runs it once the stack is retargeted to develop.
