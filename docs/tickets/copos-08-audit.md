# COPS-08 audit: approvals, e-sign, subscriptions and renewals, finance

Ticket: COPS-08 (XXL, P1), first ticket of Phase 2. Bible p.32, 34, 36-37, 67; Epic E04/E05.
Branch: `feature/copos-08-commercial-advanced`, from `develop` after COPS-06/07 merged (PR #186).
Owner: SahilPreet. Reviewer: Aditya. Decisions below are Aditya's, 2026-10-13.

This is the audit-and-extend pass: what exists, what is reused, what is new, what is blocked.
The ticket heading says Phase 2 does not start until the Phase 1 gates pass. Two gates are still
open (alerting live: PR #194; Sales/CS pilot sign-off: Aditya). Aditya asked for this audit and the
contract now; section 7 lists what was checked against the Bible and the ticket.
Nothing in this ticket is implemented yet. The contract is `docs/api/copos-08-commercial-advanced.openapi.yaml`.

## 1. Decisions taken (2026-10-13)

- **Payments**: Razorpay. Pricing is per seat plus credit packs.
- **Currency**: customers are billed in their own currency, with no implicit conversion. One price
  book per currency (USD, EUR, GBP, INR). Currency is set per account, carried on opportunity,
  proposal, payment request, subscription and ledger entry, and locked once a proposal is sent.
- **E-sign**: DocuSeal (replaced Dropbox Sign, 2026-10-14), behind a connector interface so that a swap is an adapter change.
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
| Approval engine | Only `approve-trial` on the gate | **New**: `approvals`, `approval_decisions`, rule evaluator, and the proposal fields the rules read. |
| E-sign | Nothing. Razorpay is the only provider adapter (`services/psp`) | **New**: `signature_envelopes`, `signature_events`, an e-sign adapter interface, a DocuSeal adapter and a mock. |
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
4. E-sign: adapter interface, mock adapter, envelopes, out-of-order tolerant events. DocuSeal
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

**DocuSeal**: sandbox/trial API token (`X-Auth-Token`), the account region (base URL) and the webhook secret.

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
9. **DocuSeal credentials** must go in the secrets manager, never in the repository or in chat.
10. Prices other than USD are suggestions; Finance confirms before launch.
11. **Free credits.** The ticket and Bible p.34 list free credits as an approval rule. The kickoff
    thresholds have none. What is the threshold (for example: any complimentary credits over N need
    Finance), or is the rule left off for now? It is `null` in the defaults file.
12. **Stage rule.** The ticket says approvals hook into stage rules as well as the gate. Proposed:
    an opportunity cannot move into Contracting, and a contract cannot be sent for signature, while
    required approvals are missing (409 BUSINESS_STATE_CONFLICT). Is Contracting the right stage?
13. **Modules.** Bible p.37 allows amendments for seats, credits, modules or term. There is no
    module catalogue today (line kinds are product, seats, credits, fee). Proposed: seats, credits
    and term in COPS-08; modules when a catalogue exists.

## 7. Checked against the Bible and the ticket (2026-10-13)

Read: ticket COPS-08 (epics p.10-11) and Definition of Done (p.15); Bible p.8, 22, 28, 31-37, 62,
67, 73, 77. The first version of this audit was written from the kickoff message and the code. These
are the gaps that reading found, and what changed in this commit.

| Source | Requirement | Gap in the first version | Now |
|---|---|---|---|
| Ticket BE, Bible p.34 | Rules on discount, contract value, term, **free credits**, payment terms, custom clauses, non-standard SLA | Free credits missing | Rule added to the contract and defaults (`null`); question 11 |
| Ticket BE | Approvals hook into **stage rules** and the gate | Only the gate | Stage rule added; question 12 |
| Code | The rules need data to read | `proposal_versions` has currency, cadence, term, discount and totals only. **No payment terms, custom clauses, SLA or free-credit fields** | New fields on the proposal version (additive migration). Four of the seven rules cannot be evaluated without them |
| Bible p.37 | Amendments for seats, **credits, modules**, term; **versioned entitlements** | Seats and term only; entitlements unversioned | Credits added; modules deferred (question 13); `entitlements` is key/value with no history, so each amendment stores the entitlement set it produced |
| Bible p.67 | Finance screen: invoices/payment links, **subscription state and upcoming renewal**, failed payments, reconciliation, credit activity | No list of payment requests, no list of subscriptions | `GET /finance/payment-requests`, `GET /finance/subscriptions` added |
| Bible p.32 | Template selection, **merge fields**, redline status | Merge fields not in the contract | Added to the envelope request |
| Bible p.77 | Tables `signature_envelopes`, `approvals`, `payments`, `subscriptions`, `subscription_items`, `entitlements` | I named the approval tables `approval_requests` / `approval_decisions` | Renamed to `approvals` and `approval_decisions`. No `payments` table exists: payments live on `payment_requests` and `payment_provider_events`, which is kept (no parallel table) |
| Bible p.73 | `RenewalOpened` is a core event | Not in `copos-events.ts` | New event with a schema test |
| Bible p.8, p.35 | Account states are Trial, Paid, Suspended, Closed; lifecycle rules decide grace and suspension | Proposed two new account states as one option | Supports the recommendation in question 4: dunning stage on the subscription, account states unchanged |
| Bible p.36 | Wallet credited after confirmed payment "unless a controlled invoiced-credit policy exists" | Not covered | Out of scope unless Aditya wants it: invoiced accounts are handled manually by Finance |
| Bible p.62 | Documents: proposal, MSA, order form, DPA | Contract kinds in use are `msa` and `dpa` | Order form kind added with the amendment flow |

Confirmed as already right: approvals record decision, actor, time and comment; material change or
expiry voids them; sent versions and originals are immutable; e-sign events are verified, deduplicated
and applied out of order; one renewal opportunity per term; provider IDs are references only.

## 8. Acceptance criteria and how each will be proven

| Ticket acceptance | Test |
|---|---|
| Editing approved terms voids the approval | Integration: approve, create a new version with a material change, the approval is `voided` and the gate closes |
| Sub-threshold deals skip approval with no added step | Unit on the evaluator at each band edge; integration: a 10% deal sends with no approval row |
| Out-of-order e-sign webhooks converge | Every ordering of sent / viewed / signed, plus duplicates, ends in the same state |
| ContractSigned fires once | Concurrent and replayed `signed` events write one outbox row |
| One renewal opportunity per term | The renewal job run twice, and concurrently, creates one opportunity and one `RenewalOpened` |
| Amendments never mutate original contracts | Hash of the original contract version is unchanged after amendments; no UPDATE path on amendment rows |
| Mismatched provider and Skout state shows in reconciliation | Subscription active here and halted at the provider appears in `GET /finance/reconciliation` |

Definition of Done items that apply (epics p.15): permission checks and audit events on every write;
event schema tests; analytics instrumentation; a runbook and alerts for the dunning job, the renewal
job and the e-sign webhook; tenant-isolation tests on every new table; Playwright for the FE flows.
Phase 2 golden paths (COPS-13) include e-sign delay and renewal, so both are built to be testable
end to end.

## 9. Decisions from Aditya on the open questions (2026-10-13, second round)

| Question | Decision | Effect |
|---|---|---|
| Policy file (6.1) | Aditya is updating it | Until it lands, the file in this branch stands. EUR, GBP and INR contract-value thresholds stay `null` |
| Free credits (6.11) | Set a threshold for now; take Finance questions to the meeting with Sailish | Provisional: over 500 credits Sales Manager, over 2,000 plus Finance. 500 is the standard trial grant, so a normal trial needs no approval. Marked provisional in the file |
| Executive approver (6.2) | An Admin decides | `APPROVER_DECIDED_BY.executive = "admin"`; no new role |
| `RAZORPAY_WEBHOOK_SECRET` in environments | Aditya is checking | PR #193 waits on it |
| Account states (6.4) | Agreed | The dunning stage lives on the subscription; the account moves only to `suspended` and `closed` |
| Razorpay (section 5) | Look for a solution, or discuss with Sailish | See below |
| Alert destination | "notifications" | To confirm: which Datadog handle this is. Not needed until PR #194 is deployed |
| Start of Phase 2 code | Start now | Done: config kinds, approval evaluator, dunning stages, price book |

Still for the Finance meeting: contract-value thresholds outside USD; the free-credit thresholds;
prices outside USD; how the 20% month-to-month surcharge is shown; the band edges (6.3).

### Razorpay: what public documentation says, and the fallback

Read on 2026-10-13, not confirmed for this merchant account:

- Razorpay says international payments cover Subscriptions as well as Payment Links, in 100+
  currencies including USD, EUR and GBP.
- An Indian business has to apply for international payments (Account & Settings > International
  payments). It is not on by default.
- Card subscriptions have been paused and re-enabled in the past, and the international
  subscription pages are written for businesses outside India. Whether USD recurring charges on
  foreign cards are enabled for this entity is something only Razorpay support, or a test on the
  account, can answer. Retry and halted timing and proration were not found in what was read.

Design consequence, so the build does not wait: every subscription has `billing: provider | invoiced`.
`invoiced` uses the COPS-03 payment-link flow, one payment request per billing period, which already
works in any currency Razorpay accepts for links. Renewals, dunning, amendments and the finance
screens are the same in both modes; only the charge differs. If USD recurring turns out to be
unsupported, those accounts are `invoiced` and nothing is rebuilt.

Sources: https://razorpay.com/docs/payments/international-payments ,
https://razorpay.com/accept-international-payments/ , https://razorpay.com/subscriptions/

## 10. Decisions from Aditya (2026-10-13, third round) and what was built

| Topic | Decision | State |
|---|---|---|
| Policy file | Keep this structure (the code reads it); carry over the content of the file on develop; validate on load | Done. Sources, benchmarks and country defaults carried over. The file is parsed by the config schemas when the app loads and a test covers bad edits |
| Free credits | Count rule stays for now (over 500 Sales Manager, over 2,000 plus Finance), in config. Keep "complimentary value over 10% of TCV" in the file, dormant | Done. The dormant rule is under `_dormant_complimentary_value_rule`; no code reads it. Switch when Finance gives the value of one credit |
| Contract value | TCV, not the raw proposal amount | Done, see below |
| Deals already in flight | Do not block them. Sent, signed or paid deals are grandfathered; drafts follow the new rules. Report for Finance | Done: migration 0126 and `GET /approvals/grandfathered` |
| Secrets | SOPS + age encrypted env files (`deploy/hetzner/env-enc/*.env`), not AWS Secrets Manager | Applies to the DocuSeal keys and the Datadog webhook secret |
| Notifications | In-app notification center (COPS-01), routed by role from config. No Slack | Next |
| Datadog alerts | Datadog webhook to a signed internal endpoint that creates in-app notifications for Admin and Engineering, plus a team email as fallback | Next. The team email address is still to be given |
| Razorpay | Aditya is checking the merchant account. Build payment-link-per-period billing now; count failed-payment days from the invoice due date, because the halted event never fires without auto-debit | With subscriptions |
| PR #193 | Do not merge until `RAZORPAY_WEBHOOK_SECRET` is in the encrypted env file for every environment | Aditya |

### Definition of total contract value (TCV)

TCV = recurring line items x term in months + whole-term line items + one-time fees, after line and
header discounts, before tax.

- Each proposal line says what its amount covers: `per_month`, `per_term` or `one_time`
  (`price_basis`, migration 0125). Every line is brought to the full term before summing, so ten
  seats at 79 a month for 12 months and ten seats at 948 for the term both give 9,480.
- A line with no basis (written before COPS-08) is a whole-term amount, or a single charge when its
  kind is `fee`. Existing proposals therefore keep the contract value they had.
- The discount the rules read is the effective discount on the same basis: (gross TCV - TCV) / gross
  TCV. A discount placed on line items counts exactly like a header discount.
- Code: `proposalTcv` in `packages/shared/src/cops-commercial.ts`. Tests cover both line styles.

### Grandfathered deals

When migration 0126 runs, an opportunity is marked if it has a sent proposal version, a signed
contract or a paid payment request. The mark is on `commercial_gates`. The engine still shows which
rules such a deal matches, but requires nothing, and the gate ignores approvals for it. The backfill
runs once: a second run marks nothing, so deals sent later are never grandfathered.

## 10a. Decisions from Aditya (2026-10-14) and what was built

| Topic | Decision | State |
|---|---|---|
| Renewal opportunities | Created directly in the CRM `deals` table, as ADR 0003 says; no parallel renewals table | Already built that way (`cops-renewals.service.ts`) |
| Suspended customer | Can sign in and see a read-only billing page with the amount due and pay; product use (search, enrichment, sequences, exports) blocked; paying lifts it through the normal path | Done: 402 `subscription_suspended` on those routes, `GET /billing/subscription`, `POST /billing/subscription/invoices/:id/pay`, banner and Settings > Workspace card |
| Sole-owner approval | The rule stays: an owner cannot approve the Sales Manager or Finance slot without that role. A second person gets the Sales Manager role | No code change. The role is assigned in team settings |
| E-sign provider | DocuSeal, not Dropbox Sign. Mock stays for tests | Done: `docuseal-adapter.ts`, webhook `/api/v1/esign/webhooks/docuseal`, env `DOCUSEAL_API_KEY`, `DOCUSEAL_BASE_URL`, `DOCUSEAL_WEBHOOK_SECRET`, `DOCUSEAL_WEBHOOK_HEADER` |
| Auto-debit | Not now: payment link per period | Unchanged |
| Amendments with credits | Not until Finance decides what credits mean in an amendment | Not built |

## 11. State of the backend (2026-10-13)

Built and tested on this branch. Migrations 0123 to 0131, all additive.

| Ticket line | Built | Not built |
|---|---|---|
| Approval engine | Rules from config on discount, seats, TCV, term, free credits, payment terms, custom clauses, SLA. Request, decide per role (Admin or owner for the executive slot), reject with comment, void on material change, expiry after 14 days, in-app notifications. Hooks: proposal send, contract send, envelope send, the provisioning gate, and the stage rule (an opportunity cannot be marked won while a proposal waits for approval). Deals already in flight are skipped and listed for Finance | The complimentary-value rule is dormant until Finance prices a credit. The stage rule blocks the move to won (both stage routes are in apps/api); it does not block entry to an earlier stage |
| E-sign | Adapter interface, mock provider, envelopes, signed webhooks that are verified, deduplicated and applied in any order, template selection from config, merge fields, negotiated versions with a redline status (migration 0131). Replaces the manual status, which stays as the fallback | Live DocuSeal use: the adapter is built and tested, and is switched on by `DOCUSEAL_API_KEY` and `DOCUSEAL_WEBHOOK_SECRET` in the encrypted env file. Region, segment and legal entity are passed on the request: the account record does not hold them |
| Subscriptions | `subscriptions`, `subscription_items`, a bill per period, payment link per bill, failed-payment timeline from the due date, automatic restore, invoiced accounts, renewal opportunity once per term (`RenewalOpened`), append-only amendments for seats and term. The account lifecycle state follows the subscription, and the customer's workspace carries a `subscription` entitlement. From day 8 a restricted workspace cannot spend credits (402) or send outreach (sequence steps are deferred, not dropped; `canContact` refuses outreach) | Provider auto-debit (waits on Razorpay). Sending a suspended workspace's login to the billing page only (that is in the product's own auth flow). Entitlements beyond the subscription itself (plan limits, purchased credits). Amendments for credits and modules |
| Finance ops | Failed-payment queue, reconciliation queue, subscriptions and payment-link lists, grandfathered-deals report | Nothing known. `GET /finance/credit-activity` lists purchases, grants, adjustments and refunds across accounts with actor and reason |

Acceptance criteria:

| Criterion | Proven by |
|---|---|
| Editing approved terms voids the approval | `cops-approvals.routes.test.ts`: a deeper discount voids, a notes-only change does not |
| Sub-threshold deals skip approval with no added step | Same file: no approval row, the request is refused, the proposal sends at once |
| Out-of-order e-sign webhooks converge | `cops-esign.test.ts` (every ordering) and `cops-esign.routes.test.ts` (signed first, then viewed and sent) |
| ContractSigned fires once | `cops-esign.routes.test.ts`: one outbox row after out-of-order events and a retry |
| One renewal opportunity per term | `cops-subscriptions.routes.test.ts`: two passes at once and a third later open one |
| Amendments never mutate original contracts | Same file: contract version rows unchanged; a DB trigger rejects UPDATE of an amendment |
| Mismatched provider and Skout state shows in reconciliation | Same file: a bill paid at the provider and open here; an envelope signed with the contract still out |

Things a reviewer should know:

- `cops-renewals.service.ts` inserts into `deals`, an apps/crm-owned table, so that the renewal is
  opened exactly once. ADR 0003 has the new entry and the reason.
- The contract in `docs/api/copos-08-commercial-advanced.openapi.yaml` now describes the endpoints as
  built (version 1.0.0). Not built: `/billing/webhooks/razorpay/subscriptions` (provider auto-debit).
- The worker file `cops-onboarding-evaluator.worker.ts` is also changed by PR #194, a few lines
  away; whichever merges second may need a small conflict resolved.
- Restrictions read one entitlement on the customer's workspace (`subscription`). If that read
  fails the customer keeps working: the guard fails open on purpose. Enrichment is restricted
  through the credit spend, so an enrichment that costs no credits is not blocked.
- `cops-onboarding.routes.test.ts` has one test that times out on my machine with or without this
  branch's changes; CI is the reference for it.
- Runbook: `docs/runbooks/cops-commercial-advanced.md`.
- The currency of an opportunity is locked once a proposal has been sent. The currency is still
  read from the opportunity; there is no currency field on the account record itself.
