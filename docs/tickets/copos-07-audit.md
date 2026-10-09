# COPS-07 audit: admin configuration, privacy/retention, Phase 1 quality gates

Ticket: COPS-07 (XL, P0), closes Phase 1. Bible p.16, 85-86, 90-91, 98-100, Appendix F/G/I.
Branch: `feature/copos-07-admin-privacy-qa`, stacked on `feature/copos-06-eng-tickets` until COPS-06
merges. Owner: SahilPreet. Reviewer: Aditya.

This is the audit-and-extend pass: what exists, what is reused, what is missing, and the order of work.

## 1. Admin configuration

| Config (ticket) | What exists today | Plan |
|---|---|---|
| Pipelines / stage rules | `apps/crm` `pipelines.routes.ts` (CRUD); stage rules from COPS-02 | Reuse. Admin screen calls the existing routes. No new store. |
| Commercial-gate policy | `commercial_gate_policies` + `GET /commercial/gate-policies` (COPS-03) | Reuse. Add the admin write path with audit if it is missing. |
| Activation definitions | `cops_activation_templates`: versioned, rows immutable by trigger (COPS-05) | Reuse. Add admin list / new-version endpoints. |
| Onboarding email templates | Constants in `services/cops-onboarding-templates.ts` (key + version in code) | Gap. Move to the versioned config store; code constants stay as the system default. |
| Follow-up templates | `sequences` + `sequence_versions` (frozen snapshot per enrollment); default cadence in `cops-cadence.service.ts` | Reuse the sequence engine: an edit publishes a new version, running enrollments keep theirs (already true). Admin screen over the existing sequence. |
| Credit packages | None | Gap. Versioned config store. |
| Trial templates | None; plan, days and credits are typed into the provision dialog | Gap. Versioned config store; the dialog reads defaults from it. |
| Notification routing | `cops_notification_routes` + `GET|PUT /notifications/cops-routes` (COPS-01, admin-only, audited) + FE panel | Reuse. (An earlier draft of this audit called it code-only; that was wrong.) |
| Onboarding settings | `cops_onboarding_settings` + `GET|PUT /onboarding/settings` | Reuse. |

**Decision: one versioned config store for the gaps, not one table per config.**
`cops_config_versions (workspace_id, kind, key, version, value jsonb, reason, created_by, created_at)`,
unique on `(workspace_id, kind, key, version)`, rows immutable. An edit inserts the next version; a
rollback inserts a new version with the old value. Each `kind` has a zod schema. Configs that already
have their own versioned table (activation templates, sequences, gate policies) keep it.

## 2. Privacy and retention

| Need | What exists today | Plan |
|---|---|---|
| Export / delete | `schema/dsar.ts`, `routes/dsar.routes.ts`, `docs/ops/dsar-fulfillment.md` | Reuse. Retention delete goes through the same deletion path. |
| Data inventory / classification | None | Gap. A classification map in code (table -> category), tested against the schema so a new table must be classified. |
| Retention by category (Appendix F) | None. (`retention-signals-sweep.worker.ts` is customer-retention signals, not data retention.) | Gap. `retention_policy` config kind (days per category) + a retention job. |
| Dry-run first | None | The job has a dry-run mode that only counts; a real run needs a prior dry-run and an admin confirmation. |
| One `canContact()` gate, enforced by CI | Gate exists (COPS-05). 7 files still call the pieces directly. | **Done in this PR**: `scripts/check-can-contact-gate.mjs` in CI, as a ratchet (see section 4). |

## 3. Quality

| Need | What exists today | Plan |
|---|---|---|
| Tenant-isolation suite that fails for an unscoped new table | `cops-tenant-isolation.test.ts` checks a hand-written list | **Done in this PR**: `tenant-scoping-guard.test.ts` reads the live schema. |
| Feature flags per module | None | Gap. `feature_flags` config kind + a route gate per COPS module. |
| Dashboards + alerts | Thresholds written in `docs/runbooks/cops-platform.md`; `docs/ops/datadog-slo-dashboard.json` | Gap. An ops metrics endpoint (outbox lag, dead letters, provisioning latency, webhook latency, stuck steps) + dashboard and monitor definitions. |
| Runbooks (Appendix I) | Replay events and re-send onboarding exist | Gap: reconcile payment, correct the credit ledger by compensating entry. |
| Golden-path e2e (5 paths) | Per-ticket Playwright specs with a mocked API | Gap. Five golden paths. See risk 1. |

## 4. Done in the first commit

- **`scripts/check-can-contact-gate.mjs`** (CI, architecture-gates job). Fails on a new direct call to
  `isSuppressed`, `isSendBlockedByEligibility` or `gateEnrollConsent`. It is a ratchet: the 7 files
  that predate the gate are listed with their current call counts and may not grow. They are not
  migrated in this ticket: `ai.routes.ts`, `compliance.routes.ts`, `sequence.routes.ts`,
  `ai-draft-send.service.ts`, `inbox.service.ts`, `reply-tag-actions.service.ts`,
  `sequence-enrollment.worker.ts`.
- **`packages/db/src/schema/tenant-scoping-guard.test.ts`**. 176 tables in the migrated schema; 39 have
  neither `workspace_id` nor `tenant_id`. Each is listed with a reason. A new table without the
  column fails the suite. **The reasons for the non-COPS tables are inferred from the table names and
  need a review by Aditya** (in particular `signals`, `scrape_jobs`, `buying_committee_members`,
  `company_snapshots`, `enrichment_attempts`).

## 5. Order of work

1. Audit, contract, the two CI gates (this commit).
2. Versioned config store + admin config API (credit packages, trial templates, email templates,
   retention policy, feature flags), audited, admin-only. **Done.**
3. Consumers: provision dialog defaults, notification routing override, onboarding email template.
4. Retention: classification map, policy, dry-run job.
5. Feature flags per module; ops metrics endpoint; runbooks.
6. FE: admin screens, retention/privacy page, empty/loading/error audit, golden-path specs.

## 6. Risks and open questions for Aditya

1. **Golden paths "green in CI" is not reachable today.** The frontend Playwright suite has failed on
   every branch since 2026-10-06, `develop` included (53 failing tests on old pages, none in the COPS
   specs). The five golden paths can be written and pass on their own; the suite stays red until
   the older specs are fixed. Who owns that?
2. **Sales/CS pilot sign-off and "dashboards live"** are release gates outside the code. This ticket can
   deliver the dashboard definitions and the metrics; someone must import them and run the pilot.
3. Retention periods per category: defaults needed from Product/Legal. Proposed until told otherwise:
   nothing is deleted by default (every category "keep"), so turning retention on is an explicit choice.
4. Feature-flag granularity: one flag per COPS module (crm, commercial, provisioning, onboarding,
   tickets, admin) per workspace. Enough?
5. Are credit packages only a catalog for the grant dialog, or do they tie to PSP prices (COPS-08)?
6. Local dev: the SES credentials in `.env` are rejected (`535`), so no email can be sent locally.

## 7. Status (2026-10-09)

Backend done and tested: versioned config store and API; onboarding email wording from the
`email_template` config; trial-template and credit-package catalogs; activation definitions as new
versions; feature flags gating each module's routes; data inventory; retention policy with
dry-run-first runs; ops metrics endpoint; the two CI gates.

Frontend done and tested (component tests): CustomerOps admin page with trial templates, credit
packages, email templates (version history and restore), activation definitions, gate policy,
notification routing, module switches, retention policy with dry-run-first runs, data inventory and
operations metrics; the provision dialog offers the trial templates. Runbooks and alert thresholds
are written (`docs/runbooks/cops-commercial-credits.md`, `docs/ops/cops-alerts.md`).

Not done: the admin screens were not opened in a browser; no Playwright spec for them; the
empty/loading/error audit across all Phase 1 screens; live end-to-end specs for the five golden
paths; Datadog monitors; the navigation does not yet hide a module that is turned off (the API
refuses it). The release gates that need people (pilot sign-off, dashboards live) are open.

## 8. Phase 1 gap list against the epic document (COPS-01 to COPS-07)

Basis: the per-ticket audit docs and what was run in the COPS-05/06/07 work. It is not a fresh
line-by-line re-read of the COPS-01 to COPS-04 code, so treat those rows as "known open items",
not as proof that nothing else is open.

| Ticket | Open against the epic text |
|---|---|
| COPS-01 | A real 429 has never been triggered end to end (retry/backoff code exists). Slack/Teams webhook adapters and per-user notification preferences: not re-checked here. `cops_processed_events` has no `workspace_id` (keyed by event id; listed in the scoping guard with its reason). |
| COPS-02 | Customer 360 "Usage" and "Success" tabs are still placeholders (Success belongs to COPS-11). Not re-checked: kanban 409 inline messages, account merge. |
| COPS-03 | Not re-checked in this pass. The live run skipped it: the deal and fired gate were inserted in the database. Paid-deal and failed-payment paths have no live browser run. |
| COPS-04 | Fixed here: the dialog said "Invitation sent" when the invite email had failed. The frontend message for that fix was type-checked, not opened in a browser. |
| COPS-05 | Fixed here: a failed first onboarding email could not be sent again from the UI. Still open: calendar integration shows "not tracked" (no calendar connection model); delivery/open/click tracking was not exercised live (no provider webhook locally); questions Q1 to Q5 in the COPS-05 audit. The signal-trigger playbooks (no login 24h, no activity 72h, trial ending) were not exercised live. |
| COPS-06 | PRs open, not merged. Create ticket from an onboarding blocker was run live without a blocker present, so the blocker prefill was only covered by tests. SLA, incident linking and release tracking are COPS-12 by design. |
| COPS-07 | See section 7. All frontend work is open. "Five golden paths green in CI", "dashboards live" and "pilot sign-off" cannot be closed by code alone (section 6). |

Cross-cutting, from the Definition of Done:

- **Analytics instrumentation**: added on the frontend for COPS-03 to COPS-06 actions; none yet for COPS-07.
- **Runbooks**: platform, onboarding, and payments/credits/provisioning now exist. No runbook yet for tickets.
- **e2e**: per-ticket Playwright specs use a mocked API. The frontend suite as a whole is red on `develop` (older specs).
- **Local email**: SES credentials in the local `.env` are rejected (`535`), so every email path was tested against a local catcher, not a real provider.

## 9. Empty / loading / error states across Phase 1 screens (Appendix G)

Method: a code scan of each screen for a loading state (skeleton or spinner), an error state (error
alert) and an empty state (dashed empty box or "No ... yet" text). It is not a visual review of every
screen in a browser.

| Screen | Loading | Error | Empty |
|---|---|---|---|
| Commercial Desk (`/commercial`) | yes | yes | yes |
| Customer 360 shell, timeline, deals table | yes | yes | yes |
| Commercial tab, Billing tab | yes | yes | yes |
| Onboarding tab and Onboarding Control | yes | yes | yes ("No onboarding yet", "No open blockers") |
| Sales Follow-up (`/follow-up`) | yes | yes | yes (Appendix G: next recommended action) |
| Engineering queue, ticket drawer, account Engineering tab | yes | yes | yes (Appendix G: healthy state + create button) |
| Audit log (`/cops/audit`) | yes | yes | yes (in `AuditViewer`) |
| Notification routing panel | yes | yes | not needed: it always lists every event type |
| CustomerOps admin: every tab | yes | yes | yes |

Fixed while doing this: Engineering and Follow-up showed "this queue is for other roles" when the
module was turned off; they now say the module is off. No other gap was found by the scan.
