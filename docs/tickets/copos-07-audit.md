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
| Notification routing | `services/cops-notification-routing.ts` (config in code) + FE read-only panel | Gap. Versioned config store overrides the code default. |
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
   notification routing), audited, admin-only.
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
