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
