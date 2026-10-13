# Runbook: CustomerOps approvals, e-sign, subscriptions and renewals (COPS-08)

Written for: on-call engineers, Finance and Sales Ops. Covers the jobs and webhooks COPS-08 adds.
For payment links and the credit ledger see `cops-commercial-credits.md`; for the outbox and the
event worker see `cops-platform.md`.

Three rules hold in every case below:

- Never edit a status in the database. Approvals, envelopes, subscriptions and bills each change
  through one code path that also writes the audit row and the event. A manual edit skips both.
- Nothing here deletes data. A subscription that is suspended or closed keeps everything.
- Every action below is safe to repeat.

## A proposal or contract will not send (409)

Symptom: Send answers "Needs approval from ..." or "Waiting for approval from ...".

1. `GET /api/v1/proposals/:id/approvals/evaluate` shows the terms the rules read, the rules that
   matched, who has to approve and the current approval.
2. `approval: null` and `required: true`: nobody has asked. Request approval from the Commercial tab.
3. `approval.status: pending`: the listed roles have not all decided. They see it on `/approvals`.
4. The approval was `voided`: a material term changed after it was given (the reason lists the
   fields). Request it again. A change to the title or notes does not void.
5. The approval `expired`: 14 days passed (config: `approval_policy.expires_after_days`) before the
   proposal was sent. Request it again. An approval used in time never lapses afterwards.
6. `grandfathered: true`: the deal was already sent, signed or paid when approvals were introduced.
   It needs none, by design. The list is `GET /api/v1/approvals/grandfathered`.
7. `unevaluated: ["contract_value"]`: the currency has no contract-value thresholds in the
   approval policy. The rule is skipped, not failed. Add thresholds in CustomerOps admin >
   Commercial policy.

The wrong person cannot approve: each approver role decides its own slot, and an Admin or the
owner decides the executive slot. A 403 on a decision means the user does not hold that role.

## An opportunity cannot be marked won (409)

A proposal on it is over a threshold and unapproved. Approve or reject it, or mark the proposal
declined or expired; then move the deal. Marking the deal lost is always allowed.

## The signature did not arrive

Symptom: the customer says they signed; the contract still shows sent.

1. `GET /api/v1/contracts/:id/envelopes` lists each envelope with every provider event received.
2. No event for the signature: the provider has not delivered it. Ask the provider to resend it. A
   replay is safe: events are deduplicated on the provider event id, and a late or repeated event
   never moves a contract backwards.
3. A 401 on the webhook: the signing secret is wrong or missing in the encrypted env file.
4. The envelope shows `signed` and the contract does not: look at
   `GET /api/v1/finance/reconciliation`, kind `envelope_contract_mismatch`. This happens when the
   contract had already left `sent` (someone recorded an outcome by hand, or a decline arrived
   first). Legal decides which is right; record it with the manual contract status and a reason.
5. An envelope for an older contract version does not change the contract. Send the current
   version for signature.
6. An envelope stuck in `pending_send` for over 15 minutes appears in reconciliation as
   `envelope_never_confirmed`. The provider may or may not have sent it. Check the provider's
   dashboard before sending again, so the customer does not get the document twice. If the
   provider did send it, its next event repairs the envelope on its own (it carries our id).
7. `signature_events` rows with `outcome = 'unmatched'` are events for an envelope Skout does not
   know. They have no workspace and are not shown on any screen yet; query the table.

Only the mock provider exists today. It sends nothing to anyone and is never configured in
production. Until the Dropbox Sign adapter is added, record signatures with the manual contract
status.

## A subscription is past due, restricted or suspended

The status comes from one thing: the oldest bill that is unpaid past its due date. Day 0 is that
due date. Defaults: restricted from day 8, suspended from day 15, closed on day 45
(`dunning_policy`, editable in CustomerOps admin).

1. `GET /api/v1/accounts/:id/subscription` shows the bills and the `dunning` block: the overdue
   bill, the day number and the next automatic step with its date.
2. The customer wants to pay: "Copy payment link" on the bill (Finance screen or the account's
   Billing tab). When they pay, the COPS-03 webhook marks the payment request paid and the next
   billing pass marks the bill paid and returns the subscription to active. Nothing else is needed.
3. The money arrived another way (bank transfer): "Mark paid" on the bill, with a reason. Access is
   restored at once.
4. The customer paid and is still restricted after 10 minutes: see reconciliation, kind
   `bill_paid_at_provider_open_here`. The billing pass is not running or is failing. Check the
   `cops-onboarding-evaluator` worker and its log line "subscription billing pass failed".
5. Invoiced accounts never move past `past_due` automatically. Finance decides.
6. A closed subscription does not reopen when a late payment arrives. Create a new subscription.

What "restricted" does to the customer's workspace: spending credits answers 402
`subscription_restricted`, sequence emails are deferred six hours at a time (not dropped), and
`canContact` refuses outreach. Login, payment, transactional email and all existing data are
untouched. The restriction is read from the `subscription` entitlement on the customer's own
workspace; if that row is missing the workspace is not restricted.

To lift a restriction that should not be there: fix the bill (pay it or mark it paid). Do not
delete the entitlement row; the next pass writes it again.

## The billing or renewal pass is not running

Both run inside the `cops-onboarding-evaluator` worker tick, every 10 minutes, after the onboarding
evaluator. Each subscription is its own transaction, so one failure does not stop the rest.

1. Look for "subscription billing pass finished" in the worker log. Absent: the worker, Redis or
   the database is down; see `cops-platform.md`.
2. "subscription billing pass failed" or "renewal pass failed": the error is in the log line. The
   pass is safe to run again; a period is billed once and a renewal is opened once.
3. A missed pass loses nothing. The next one bills every period that has started since.

## A renewal opportunity is missing or duplicated

- Missing: the term ends more than `renewal_policy.lead_days` (default 90) from now, or the
  subscription is closed, or the renewal pass has not run. `renewal_opportunity_id` on the
  subscription shows whether one was opened.
- Duplicated: this should not be possible. One is opened per subscription term under a row lock.
  If two exist, one was created by hand in the CRM; close that one as lost with a reason.

## A seat change did not take effect

A seat amendment starts with the next billing period, never inside the current one. The
subscription shows it under "Amendments" with its start date; the bill already raised keeps its
price. If the term has no later period (annual billing with one period), a seat change is refused:
extend the term or change seats at renewal. Amendments are never edited; add another one.

## A proposal's currency cannot be changed (409)

The currency of an opportunity is locked once any of its proposals has been sent. Nothing is ever
converted. To quote in another currency, close this opportunity and open a new one.
