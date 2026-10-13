# COPS-08 audit: approvals, e-sign, subscriptions and renewals, finance

Ticket: COPS-08 (XXL, P1), first ticket of Phase 2. Bible p.32, 34, 36-37, 67; Epic E04/E05.
Branch: `feature/copos-08-commercial-advanced`, from `develop` after COPS-06/07 merged (PR #186).
Owner: SahilPreet. Reviewer: Aditya. Decisions below are Aditya's, 2026-10-13.

This is the audit-and-extend pass: what exists, what is reused, what is new, what is blocked.
Nothing in this ticket is implemented yet. The contract is `docs/api/copos-08-commercial-advanced.openapi.yaml`.

## 1. Decisions taken (2026-10-13)

- **Payments**: Razorpay. Pricing is per seat plus credit packs.
- **Currency**: customers are billed in their own currency, with no implicit conversion. One price
  book per currency (USD, EUR, GBP, INR). Currency is set per account, carried on opportunity,
  proposal, payment request, subscription and ledger entry, and locked once a proposal is sent.
- **E-sign**: Dropbox Sign, behind a connector interface so that a swap is an adapter change.
  Sandbox keys expected by Wednesday 2026-10-14; a mock adapter until then.
- **Approvals**: rules on discount, seats, contract value, term, payment terms, custom clauses and
  non-standard SLA. Every matching rule applies and the deal needs every approver. Approvals expire
  after 14 days; any material change voids them.
- **Failed payment**: past due (day 0-7), restricted (8-14), suspended (15, or earlier if Razorpay
  halts), closed (45). Data is never deleted on payment failure. A successful payment restores
  access. Invoiced enterprise accounts are not auto-suspended.
- **Config, not code**: all of the above lives in the versioned admin config (COPS-07), seeded from
  `docs/ops/cops-commercial-policy.default.json`, editable by an Admin without a deploy.

## 2. What exists and what is missing

| Need | What exists today | Plan |
|---|---|---|
| Proposals, contracts, versions | `proposals`, `proposal_versions` (currency, cadence, term, discount, totals, content hash), `proposal_line_items`, `contracts`, `contract_versions` (file hash) from COPS-03 | Reuse. Approvals attach to a proposal version. |
| Manual contract status | `POST /contracts/:id/status` with actor and reason (COPS-03) | Keep as the fallback; e-sign events take over when an envelope exists. |
| Commercial gate | `commercial_gates`, `commercial_gate_policies`, fires once (COPS-03) | Reuse. Add one condition: required approvals are granted. |
| Approval engine | Only `approve-trial` on the gate | **New**: `approval_requests`, `approval_decisions`, rule evaluator. |
| E-sign | Nothing. Razorpay is the only provider adapter (`services/psp`) | **New**: `signature_envelopes`, `signature_events`, an e-sign adapter interface, a Dropbox Sign adapter and a mock. |
| Connector interface | `psp-adapter.ts` (payments) and the HubSpot client; no shared connector abstraction | Model the e-sign adapter on `psp-adapter.ts` (verify, parse, dedupe). The shared framework is COPS-09. |
| Subscriptions | None. `entitlements` is a key/value table per workspace | **New**: `subscriptions`, `subscription_items`, append-only amendments. Entitlements stay in the existing table. |
| Razorpay subscriptions | Adapter creates payment links only. Billing webhook handles `payment.captured` only | **New**: plan and subscription calls, and `subscription.*` webhook events. |
| Credit packs | `RAZORPAY_CREDIT_PACKS_JSON` env var; `payment_orders.amount_paise` (INR only, no currency column) | Move packs to the `credit_package` admin config with a price per currency; add `currency` to `payment_orders`. Wallet is still credited only after confirmed payment. |
| Account currency | `deals.currency` and `proposal_versions.currency`. **No currency on the account** (`companies`) | **New**: account currency, defaulted onto new opportunities, locked when a proposal is sent. |
| Account lifecycle | `account`: trial, paid, suspended, closed (COPS-01) | **Change**: add `past_due` and `restricted`. See risk 4. |
| Renewal opportunity | `deals.contract_end_date`; no renewal generation; no `RenewalOpened` event | **New**: idempotent renewal job, one per term, and the event. |
| Finance queue | `payment_provider_events` with outcomes (COPS-03), webhook latency (COPS-07), `GET /credits/reconciliation` (COPS-04) | Reuse as the sources. **New**: one finance read API over them. |
| Admin config | `cops_config_versions` with kinds credit_package, trial_template, email_template, retention_policy, feature_flags (COPS-07) | Add kinds: `approval_policy`, `dunning_policy`, `price_book`, `esign_templates`. Change `credit_package` to a price per currency. |

## 3. Order of work

1. Audit, contract, policy defaults (this commit).
2. Config kinds and the seed loader; account currency and the currency lock.
3. Approval engine: rules, requests, decisions, voiding, expiry, the gate condition.
4. E-sign: adapter interface, mock adapter, envelopes, out-of-order tolerant events. Dropbox Sign
   adapter when sandbox keys arrive.
5. Subscriptions: tables, Razorpay plan and subscription, webhook to state, dunning job, restore.
6. Renewals and amendments.
7. Finance read API.
8. Frontend: approval queue, e-sign timeline, subscription and renewal views, Finance screen.

Steps 2 to 4 and 7 need nothing from outside. Step 5 is blocked on the Razorpay answers in section 5.

## 4. Fixed alongside

`POST /billing/webhooks/razorpay` skipped signature verification when `RAZORPAY_WEBHOOK_SECRET` was
unset, in every environment. It now fails closed outside local development. Separate PR: #193.

## 5. Blocked on answers from outside

**Razorpay support** (to be asked by someone with the merchant account; not something code can settle):

1. Are international recurring subscriptions in USD supported for an Indian merchant, and which
   currencies are supported?
2. Retry schedule and the timing of `subscription.halted`.
3. Proration behaviour on a quantity change.
4. Confirmation that only overseas-issued cards are supported (no wire transfers).

If USD recurring is not supported, those accounts use invoiced / payment-link billing, which the
COPS-03 payment-link flow already supports.

**Dropbox Sign**: sandbox API key and the webhook signing key.

## 6. Risks and open questions for Aditya

1. **The policy file was not found.** `docs/ops/cops-commercial-policy.default.json` on branch
   `docs/cops-commercial-policy` is not on the remote of either repository. The file in this commit
   was written from the numbers in the kickoff message. **Contract-value thresholds for EUR, GBP and
   INR are missing** (the message says "other currencies in the file"); they are `null` in the file,
   and a deal in those currencies cannot be evaluated on contract value until they are filled in.
2. **There is no Executive role.** The roles are Sales, Sales Manager, CS, Finance, Legal/RevOps,
   Engineering, Product, Admin, plus workspace owner. Who approves as "Executive": the workspace
   owner, Admin, or a new role?
3. **Band edges.** Read as: up to and including 10% needs no approval; over 10% up to 20% Sales
   Manager; over 20% up to 30% plus Finance; over 30% plus Executive. Seats and contract value use
   "over" strictly. Correct?
4. **Account lifecycle gains two states.** `past_due` and `restricted` do not exist in the COPS-01
   state model. Adding them touches the transition table, the Customer 360 header and any consumer
   that switches on account state. Alternative: keep four account states and hold the dunning stage
   on the subscription only. Recommendation: hold it on the subscription, and move the account to
   `suspended` and `closed` only, so COPS-01 consumers do not change.
5. **"Closed per retention policy" on day 45.** The COPS-07 retention job deletes only audit logs,
   onboarding email sends, idempotency keys and published outbox events, and never core records. So
   "closed" here means a state change and loss of access, with data kept. Confirm that is the intent.
6. **What counts as a material change** that voids approvals: proposed as any change to line items,
   seats, discount, term, cadence, payment terms, currency, custom clauses or SLA. A change to notes
   or title does not.
7. **Month-to-month surcharge of 20%** is applied to the per-seat price in the price book. Is it
   shown as a separate line on the proposal or folded into the unit price?
8. **Restricted access** (no new credit use, enrichment runs or outreach sends) has to be enforced in
   the product, outside CustomerOps: the credit consume path, the enrichment job start and the
   sequence send path. That is three guards in code owned by other tickets (enrichment is ENR).
9. **Dropbox Sign credentials** must go in the secrets manager, never in the repository or in chat.
10. Prices other than USD are suggestions; Finance confirms before launch.
