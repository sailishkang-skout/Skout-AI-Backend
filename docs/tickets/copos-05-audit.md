# COPS-05 audit: onboarding email, follow-up sequence, activation, rep queue

Ticket: COPS-05 (XXL, P0), depends on COPS-04. Bible p.41-48, 63-64, Appendix C/H; Epic E08/E09.
Branch: `feature/copos-05-onboarding` (stacked on COPS-04). Owner: SahilPreet. Reviewer: Aditya.

This is the audit-and-extend pass the epic asks for before any code: what already exists, what is
reused, and what is genuinely missing.

## What already exists

| Ticket need | Existing code | Use |
|---|---|---|
| Onboarding email send | `services/mail.service.ts` `sendMail` (Resend when `RESEND_API_KEY` is set, decided 2026-10-06; otherwise SMTP). COPS-04 sends the admin invite through it. | Reuse. Add an onboarding template builder next to `buildInviteEmail`. |
| Suppression / consent | `services/suppression.service.ts` `isSuppressed`, `services/send-eligibility-guard.service.ts` `isSendBlockedByEligibility`, `services/consent-enroll.service.ts` `gateEnrollConsent`, `routes/unsubscribe.routes.ts` | Reuse inside one new `canContact()` gate. Every COPS-05 send and enrollment calls it; nothing calls the pieces directly. |
| Delivery, bounce, reply | `services/tracking.service.ts` (open/click), `services/inbound-reply.service.ts` (replies, `HARD_BOUNCE`, bounced) | Reuse as stop signals and email status. |
| Follow-up sequence | `schema/sequences.ts`: `sequences`, `sequence_steps`, `sequence_enrollments` (`sequence_version_id`, `stop_reason`), `sequence_enrollment_steps` (`scheduled_at`, `attempt_count`), `sequence_versions` (frozen snapshot); `workers/sequence-enrollment.worker.ts` | Reuse the engine. Enrollment already stores the template version, steps are scheduled in Postgres (survive deploys), and stop reasons are standard codes. |
| Tasks | `tasks` (COPS-02 added call/email/meeting/review/approval/onboarding check/renewal/ticket follow-up types; completing one emits `TaskCompleted`) | Reuse for enrollment tasks, playbook tasks, CS handoff. |
| Events | `packages/shared/src/copos-events.ts` already defines `WelcomeEmailSent`, `SequenceEnrolled`, `TaskCreated`, `FirstLogin`, `ActivationMilestoneCompleted`, `CustomerActivated` (COPS-01) | Reuse; emit through the COPS-01 outbox. |
| First login | `auth_events` row `login_success` (`routes/auth-core.routes.ts`) | Source for `FirstLogin` on the provisioned workspace (COPS-04 `cops_provisionings.provisioned_workspace_id`). |
| Provisioned customer | COPS-04 `cops_provisionings` (workspace, admin invite, trial dates), credit wallet | Input to the email (workspace link) and the "high usage / low credits" trigger. |
| Timeline, next actions | COPS-02 `cops_timeline_events` projector, 360 `next_actions` | Every step and action lands here through events. |

## Gaps (genuinely missing)

1. **Activation model.** `activation_rules` / `activation-rule.routes.ts` (R13.4) is *prospect* auto-activation: "score >= threshold (+ signal) -> activate / add to list / enroll sequence". It has no milestones, weights, rule versions or customer accounts. The ticket's "reuse activation-rule.routes.ts" does not fit, so COPS-05 adds `onboarding_templates` (versioned, weighted milestones per product/segment), `onboarding_instances` (one per provisioned account, pinned to a template version, `activation_pct`), `onboarding_milestones` and `milestone_events`. Open question Q1.
2. **Customers are contacts, sequences run on prospects.** `sequence_enrollments.prospect_id` is a corpus prospect id; a CRM contact has an optional `source_prospect_id`. The invited admin of a new trial usually has none. Rule: enroll when the contact maps to a prospect, otherwise create an enrollment task for the rep. Never silently nothing (ticket acceptance).
3. **One `canContact()` gate.** Suppression, consent, bounce and eligibility checks exist in four places. COPS-05 adds the single gate and uses it for the email, every sequence step it starts, and one-click email. COPS-07 adds the lint/CI rule that forbids the direct calls.
4. **Onboarding email send record.** No table records a customer-facing operational email with its template version, recipient, provider id and delivery status. Adds `onboarding_email_sends` (idempotency key, explicit audited re-send, double click sends once).
5. **Signal triggers and playbooks.** No job evaluates "no login 24h / no activity 72h / trial ending / delivered but no login / logged in but no value / integration error / high usage low credits". Adds one scheduled evaluator that creates a task or escalation suggestion once per instance and trigger.
6. **Rep queue.** No API combines due tasks, stalled milestones, replies, high-intent usage, trial expiry and commercial blockers. Adds `GET /follow-up/queue` and one-click actions that always write an activity.
7. **CS handoff.** Criteria-based handoff task, created exactly once, Sales keeps visibility.

## Decisions (proposed)

- Default cadence as config (Day 0/1/3/5-7/10/14) seeded as a system sequence template, versioned through `sequence_versions`; signal triggers from Bible p.43.
- Stop conditions (Appendix C) map to `stop_reason` codes: reply, meeting booked, activated, opportunity closed/lost, opt-out, hard bounce, rep stop, critical escalation (configurable). A stop cancels pending `sequence_enrollment_steps` in the same transaction that records the stop, so an activation mid-step cancels the pending step (race-safe with a row lock on the enrollment).
- Login alone never activates: the first-login milestone has weight 0 in the default template, and `CustomerActivated` needs every required milestone.
- A template edit creates a new version; instances keep the version they started with, so past activations are never rewritten.
- Permissions: send/re-send `onboarding:send`; queue and actions `onboarding:write` or `crm:manage`; reads `onboarding:read`. No new keys.

## Open questions for the reviewer

- Q1: Activation is a new model, not an extension of R13.4 `activation_rules` (different domain). Agree?
- Q2: First activation template. Bible example: CRM connected + first search + first export. Which product events count, and their weights?
- Q3: Handoff criteria: activation, first payment, account tier, or a custom rule?
- Q4: Which onboarding contacts are enrolled: the invited admin only, or every contact with the onboarding role?
- Q5: Is "critical support escalation" a stop condition by default (Appendix C says "if configured")? Proposed: off by default, on per workspace.

## PR plan

1. This audit and the OpenAPI contract (`docs/api/copos-05-onboarding.openapi.yaml`).
2. BE: schema + migration (activation tables, email sends), `canContact()` gate, onboarding email send and re-send.
3. BE: follow-up enrollment on `WelcomeEmailSent` (sequence or task), stop conditions, cadence template.
4. BE: activation (milestones, analytics events satisfy them, `activation_pct`, `CustomerActivated`), stalled-onboarding evaluator, CS handoff.
5. BE: rep queue and one-click actions.
6. FE: Onboarding Control screen, Sales Follow-up screen, onboarding-email dialog with preview, sequence pause/stop.
