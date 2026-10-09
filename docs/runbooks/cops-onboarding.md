# Runbook: CustomerOps onboarding (COPS-05)

Covers the onboarding email, the follow-up after it, activation and the onboarding evaluator.
Contract: `docs/api/copos-05-onboarding.openapi.yaml`. Audit and decisions: `docs/tickets/copos-05-audit.md`.

## Re-send onboarding safely (Bible Appendix I)

Use this when a customer says they never got the welcome email, or the first send failed.

1. Open the account's Customer 360, Onboarding tab, and look at **Onboarding email**:
   - `failed` (provider error): use **Send** again. The dialog keeps its Idempotency-Key, and the
     API retries the same send row, so the email can never go out twice.
   - `bounced`, or the preview says it is blocked: do **not** re-send to the same address. The
     contact hard-bounced or is suppressed. Fix the contact first (step 3).
   - `sent` / `delivered` / `opened`: the email reached the provider. Ask the customer to check
     spam, then re-send if needed (step 2).
2. Re-send: **Re-send** in the dialog, with a reason (for example "Customer could not find it").
   The API answers 409 `ALREADY_SENT` to a second plain send; a re-send needs `resend: true` and a
   reason, and is audited as `onboarding_email.resent` (override). It emits a new
   `WelcomeEmailSent`; the follow-up for it is idempotent, so no second sequence is enrolled while
   the first is active.
3. Wrong or dead address: add the right contact on the account, then send with `contact_id` of
   that contact. Never remove a suppression to get an email through; suppressions are customer
   opt-outs.

API equivalent:

```
POST /api/v1/accounts/{accountId}/onboarding/send
Idempotency-Key: <new key per attempt you mean as distinct; same key to retry>
{ "resend": true, "reason": "Customer could not find it", "contact_id": "<optional>" }
```

## A WelcomeEmailSent has no follow-up

Every sent onboarding email must end with an enrollment or a task (acceptance 1). The event worker
creates it; if Redis or the worker was down, the onboarding evaluator sweeps `WelcomeEmailSent`
events older than 10 minutes without a `cops_follow_ups` row and completes them.

- Check: `select o.id from cops_outbox o where o.event_type = 'WelcomeEmailSent' and not exists (select 1 from cops_follow_ups f where f.source_event_id = o.id);`
- Fix: make sure the `cops-onboarding-evaluator` worker runs (every 10 minutes, needs Redis); the
  next pass completes them. Running it twice is safe (unique per event).

## Stop or pause a follow-up

From the Onboarding tab, follow-up card: **Pause** or **Stop** (reason required, audited). Stop
cancels every pending step; a step that already started finishes. Automatic stops (reply, meeting
booked, activated, opportunity lost, opt-out, hard bounce, critical escalation if enabled) record
their reason on the enrollment and on the account timeline.

Critical escalation stop is off by default. Turn it on per workspace:
`PUT /api/v1/onboarding/settings { "stop_on_critical_escalation": true, "reason": "..." }` (admin).

## A step is stuck in `executing`

A worker that died after claiming a step leaves it `executing`. The sequence worker picks it up
again after 15 minutes (`STALE_CLAIM_MS`). Do not set it back to `scheduled` by hand while the
enrollment is active, or it may run twice.

## Activation looks wrong

- Activation never comes from login alone; it needs every required milestone of the template the
  account started with (`cops_onboarding_instances.template_key/template_version`).
- A milestone is completed by product data in the customer workspace (CRM connected, first search,
  first export, invite accepted, teammate invited) on the next evaluator pass, or by hand for
  manual milestones (reason required, audited).
- Changing weights: insert a new version of the template; existing accounts keep theirs. Rows in
  `cops_activation_templates` cannot be updated (trigger).

## Email delivery tracking is empty

Delivered / opened / clicked / bounced come from the Resend webhook
`POST /api/v1/billing/webhooks/resend/email-events`. Check `RESEND_WEBHOOK_SECRET` is set and the
webhook is configured in Resend with the same signing secret. A bad signature is answered 401 and
logged; nothing is stored.

## Alerts to watch

- `onboarding evaluation failed` and `sweep could not complete a follow-up` errors in the API logs.
- `Failed to release step claim` from the sequence worker.
- Count of `WelcomeEmailSent` without a follow-up (query above) above zero for more than 30 minutes.
