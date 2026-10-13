# Runbook: CustomerOps payments, credits and provisioning (COPS-03, COPS-04, COPS-07)

Written for: on-call engineers and Finance. Bible Appendix I: "Reconcile payment" and "Correct credit
ledger via compensating entry". The numbers to watch are in `GET /api/v1/admin/ops/metrics`.

## Reconcile a payment

Symptom: a customer paid but the opportunity still shows payment pending, or
`payment_webhooks_rejected_24h` is above zero.

1. Find the provider events for the payment. Each webhook is one row in `payment_provider_events`,
   deduplicated on `(provider, provider_event_id)`. `outcome` is one of:
   - `applied`: the payment request was updated.
   - `ignored`: a known event that changes nothing (for example a duplicate status).
   - `unmatched`: no payment request has this provider reference.
   - `received`: stored but never processed. The handler stopped part-way.
2. Compare with the payment request: `GET /api/v1/payment-requests/:id` (status and provider refs).
3. `unmatched`: the provider reference on the request is wrong or the link was created outside
   Skout. Do not edit rows by hand. Create the payment request again from the opportunity so the
   references match, then ask the provider to resend the webhook.
4. `received`: ask the provider to resend the webhook, or replay it from the provider dashboard. A
   replay is safe: the event id is deduplicated, and a second delivery leaves the state unchanged.
5. A bad signature returns 401 and stores nothing. Check the webhook secret before anything else.
6. Never mark a payment paid in the database. The commercial gate fires once from the
   `PaymentSucceeded` event; a manual edit skips it.

## Correct the credit ledger

The ledger is append-only: `credit_transactions` has a trigger that rejects UPDATE and DELETE.
A correction is always a new, compensating entry.

1. See the mismatch: `GET /api/v1/credits/reconciliation` (needs `credits:adjust`). It compares each
   wallet this workspace provisioned with the sum of its ledger rows. The platform-wide daily run is
   recorded in `credit_reconciliation_runs`.
2. Post the correction: `POST /api/v1/accounts/:id/credits/adjustments` with the signed amount and a
   reason. Send an `Idempotency-Key`; repeating the same key does not post twice.
3. Run the reconciliation again. The wallet must now equal the ledger.
4. If a grant was duplicated, post the negative of the duplicate. Do not try to remove the row.

## Provisioning is slow or failed

Symptom: `provisioning_p95_ms` above 120000, `provisioning_within_target_pct` below 95, or
`provisioning_failed` above zero.

1. `GET /api/v1/accounts/:id/provisioning` shows each step with its status, duration and last error.
2. Retry a failed run: `POST /api/v1/provisionings/:id/retry`. Steps that finished are not run again.
3. The admin invitation email failing does not fail provisioning. `admin_invite.email_sent` is
   `false` in that case; share `accept_url` with the customer.
4. A later payment failure never deletes a provisioned workspace.

## Related

- Outbox lag and replaying events: `docs/runbooks/cops-platform.md`.
- Re-sending the onboarding email and stuck follow-up steps: `docs/runbooks/cops-onboarding.md`.
