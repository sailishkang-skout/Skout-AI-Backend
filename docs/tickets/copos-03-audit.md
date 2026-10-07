# COPS-03 audit-and-extend findings

Ticket: COPS-03 Commercial workspace + payment links + provisioning gate (XL, P1). Bible p.30-35,
62, 77; Epic E04/E05. Depends on COPS-02 (branch `feature/copos-02-internal-crm-360`, PR #175), so
this branch starts from it and is rebased onto develop once #175 merges.

Contract: `docs/api/copos-03-commercial.openapi.yaml` (published before any implementation).

## Existing capabilities reused

| Ticket need | Existing implementation | Decision |
|---|---|---|
| PSP ("reuse existing billing provider") | Razorpay in `apps/api/src/services/billing.service.ts` (`RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET`, `RAZORPAY_WEBHOOK_SECRET`, HMAC verify) | Reuse the same account, keys and signature check. Add a PSP adapter that creates Razorpay **Payment Links** (provider-hosted checkout). The credit-pack order flow stays as it is. |
| Webhook routing | `POST /billing/webhooks/razorpay`; the `/api/v1/billing/webhooks/` prefix is already public in `plugins/auth.ts` | New endpoint under the same prefix: `POST /billing/webhooks/razorpay/payment-links`. No auth change needed. |
| Opportunity | `deals` (crm.ts), COPS-02 mapping Opportunity = deals | Proposals, contracts and payment requests reference `deals.id`. |
| Deal type for the gate | none (deals has no type column) | Add nullable `deals.deal_type` (text). The gate policy is looked up by it. |
| Commercial lifecycle | COPS-01 `commercial` dimension: proposal_sent → msa_pending → payment_pending → complete | Reuse. Entity is the opportunity id. Advanced by the commercial service through `runLifecycleTransition`; a move the table does not allow is skipped, never fails the write. |
| Events | COPS-01 registry already has ProposalSent, ContractSent, ContractSigned, PaymentRequested, PaymentSucceeded | Reuse. Add `ProvisioningRequested` (registry 20 → 21 events). |
| Timeline | COPS-02 projector already maps proposal / contract / payment events | Reuse, no change. |
| Audit, idempotency, error envelope | `writeCopsAudit`, `withCopsIdempotentReply`, `copsErrorBody` (COPS-01) | Reuse on every write route. |
| Permissions | `commercial:*`, `legal:*`, `billing:*` keys already in the catalog and role grants (`cops-role-grants.ts`) | Reuse. No new keys. |
| Customer 360 | `GET /accounts/:id/360` returns `commercial_state: null` | Fill it from the commercial lifecycle of the account's open opportunity. |
| Document storage | `packages/storage` | Not used in this ticket: contract versions store a document reference + SHA-256 (status-tracking scope). Upload and e-sign are COPS-08. |

## Gaps (genuinely missing, built here)

- `proposals`, `proposal_versions`, `proposal_line_items`
- `contracts`, `contract_versions`
- `payment_requests`, `payment_provider_events` (dedupe + raw webhook references)
- `commercial_gate_policies` (per workspace, per deal type), `commercial_gates` (per opportunity, fire-once state)
- Totals calculator (pure function in `@skout/shared`, unit tested)

## Design decisions

1. **Money** is stored in integer minor units (`*_minor`, bigint) with an ISO currency. Totals:
   line gross = quantity × unit price; line discount = gross × line discount %; subtotal = sum of
   gross; header discount % applies to subtotal after line discounts; tax % applies to the
   discounted amount; every step rounds half-up to a minor unit. Discount and tax are stored per version.
2. **Versions.** Every edit creates a new version (`POST /proposals/:id/versions`); there is no
   update path for a version. Send marks the latest version sent, stores `content_hash` (SHA-256 of
   canonical JSON of terms, line items and totals) and `sent_at`. A Postgres trigger rejects UPDATE or
   DELETE of a sent version and of its line items, so immutability holds even outside the API.
   Reads recompute the hash and return `hash_valid`.
3. **Contracts** (MSA, order form, DPA) track status only: draft → sent → signed | declined | expired.
   A version carries `document_url` + `file_sha256`; sent versions are immutable (same trigger).
   Signed / declined / expired are set manually with actor + reason (e-sign arrives in COPS-08).
   A signed MSA or order form satisfies the gate's signature condition; a DPA alone does not.
4. **Payment requests** create a Razorpay Payment Link and store only the provider link id, the
   hosted URL, status and amounts. No card data reaches Skout; the webhook stores only ids, event
   type, status and amount. Status: requested → paid | failed | expired | cancelled; paid → refunded.
5. **Webhook**: missing secret, missing signature or bad signature → 401. Dedupe on
   `x-razorpay-event-id` (unique `(provider, provider_event_id)`); a replay returns 200 and changes
   nothing. Status derivation only moves forward (a late `failed` after `paid` is recorded but does
   not change the status).
6. **Gate**: policy is one of `trial_approval_only | signature | payment | signature+payment |
   manual_override`. The evaluator runs after every relevant change, inside the same transaction,
   with the gate row locked (`SELECT … FOR UPDATE`). It sets `fired_at` with
   `WHERE fired_at IS NULL` and only then appends `ProvisioningRequested`, so duplicate or concurrent
   events produce exactly one event. Once fired it never un-fires: a later failed payment or refund
   records state, it does not remove provisioning (account grace/suspension is COPS-04/08).
7. **Default gate when no policy is configured**: `signature+payment` (the strictest, so nothing
   provisions by accident). Open question Q3 below.

## Permissions

| Action | Required (any of) |
|---|---|
| Read proposals, contracts, payments, gate | `commercial:read` |
| Create proposal / version, send proposal or contract | `commercial:send`, `commercial:write` |
| Create / version a contract | `commercial:write`, `legal:write`, `commercial:send` |
| Manual status (signed, declined, expired, accepted) | `commercial:write`, `legal:write` |
| Create payment request | `commercial:send`, `billing:write` |
| Approve trial (trial_approval_only) | `commercial:approve` |
| Manual gate override | `commercial:approve` (reason required, audited as override) |
| Set gate policy per deal type | `commercial:admin` |

The legacy `member` role has none of these (only `crm:manage`), so members see the Commercial tab
read-only empty state until given a CustomerOps role. Owner and admin hold all keys.

## Proposed PRs (contract first)

1. This audit + OpenAPI contract.
2. Migration + schema + totals calculator + proposals/contracts routes.
3. PSP adapter + payment requests + webhook.
4. Gate policy + evaluator + override + 360 commercial_state.
5. FE: Commercial Desk, proposal builder, payment link, Customer 360 Commercial tab (polling).

## Open questions for the reviewer

- Q1: Razorpay Payment Links is assumed as the PSP for payment requests (same provider as credit
  packs). Confirm, or name another PSP.
- Q3: Default commercial gate per deal type. Until answered, `signature+payment` everywhere and the
  admin can set per-type policies through the API.
- Tax: a single tax % per version (no tax engine). Enough for Phase 1?

## Implementation status (branch feature/copos-03-commercial, backend)

Not merged; for review. Frontend (PR 5) follows as a separate PR against this contract.

### Acceptance

| Criterion | Status | Evidence |
|---|---|---|
| Sent versions cannot be mutated (test + hash check) | Done | Migration 0111 triggers reject UPDATE of a sent proposal or contract version and any write to its line items; reads return `hash_valid`. `cops-commercial.routes.test.ts`: direct SQL UPDATE/INSERT rejected, a removed line flips `hash_valid` to false, edits create v2 and leave v1 byte-identical. |
| Totals unit-tested | Done | `packages/shared/src/cops-commercial.test.ts`: line and header discount, tax, half-up rounding, 100% discount, large quantities, invalid input. |
| No card data stored or logged | Done | Only ids, status and amounts are kept (`payment_provider_events.refs` has a fixed key set). `cops-payments.routes.test.ts` sends a webhook with card number, name, email and phone and asserts none of it is stored. |
| Replayed webhook leaves state unchanged | Done | Dedupe on `X-Razorpay-Event-Id` inside the transaction; replay and three concurrent deliveries apply once. |
| Bad signature -> 401 | Done | Missing secret, missing signature, wrong signature and a body changed after signing all return 401. |
| Gate fires exactly once under duplicate/concurrent events | Done | `cops-gate.routes.test.ts`: four concurrent paid events on two links emit one `ProvisioningRequested`. |
| Later payment failure does not delete the workspace | Done | Refund after firing keeps `fired_at` and the single event; nothing in this ticket deletes or suspends a workspace. |
| Manual override needs permission + reason + audit | Done | 422 without reason, 403 for Sales, audit row with `is_override = true` and the reason, second override 409. |
| FE: status visible from the account record without refresh | Pending (FE PR) | `GET /accounts/:id/commercial` and `/opportunities/:id/commercial` return everything in one call for polling. |

### Decisions for the reviewer

1. Event registry grew from 20 to 21 events: `ProvisioningRequested` (payload: opportunity_id, account_id, policy, trigger).
2. Commercial events reach the account timeline through `opportunity_id` (the COPS-02 resolver now also maps
   `opportunity_id` and the commercial lifecycle dimension to the deal's company). Before this, they were not projected.
3. `runLifecycleTransition` takes an optional actor type so webhook-driven moves are recorded as the integration, not a user.
4. Razorpay auth header and HMAC check moved to `services/psp/razorpay.ts` and are shared with credit-pack billing.
   The credit-pack webhook keeps its existing behaviour (no secret = accepted, bad signature = 400); only the new
   payment-link webhook enforces 401.
5. Webhook events are matched by one identifier, most specific first (link id, then our id in the notes, then the
   provider payment id), never an OR of several.
6. Customer 360 `commercial_state` is the commercial lifecycle of the account's most recently updated open or won
   opportunity, and is null for roles without `commercial:read` (Engineering).

### Rollout

1. Run migration 0111 (idempotent; verified on a freshly created empty database: all 113 migrations apply).
2. Configure a second Razorpay webhook to `/api/v1/billing/webhooks/razorpay/payment-links` with events
   `payment_link.paid`, `payment_link.expired`, `payment_link.cancelled`, `payment.failed`, `refund.processed`,
   using `RAZORPAY_WEBHOOK_SECRET`. Without the secret every delivery is rejected with 401.
3. Optional: set gate policies per deal type with `PUT /commercial/gate-policies` (default `signature+payment`).
