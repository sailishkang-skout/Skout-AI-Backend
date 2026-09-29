# ADR 0007: Clerk → Custom Authentication

## Status
**Decided (2026-09-22) by Aditya — implementation still gated on AUTH-ADI-01/02/03 confirming
inputs.** D1–D7 below are the calls; D1, D3, and D5 were made ahead of their confirming audits
(SSO/MFA counts, hash-export answer) and may need revisiting if those audits contradict the
assumption behind them — see the Risks section. Supersedes the Clerk-enterprise assumption in
[0006-sso-scim-stage-6.md](0006-sso-scim-stage-6.md): SSO/SCIM will be built in-house (D1), not kept
on Clerk.

## Context
See `docs/superpowers/specs/2026-09-21-Clerk-Migration-Task-Tickets.docx` §0–§3 for the full
program (phases, gates, ownership, shared BE/FE contract). This ADR exists because AUTH-ADI-04
"Blocks: all of Phase 2" — every SahilPreet and Sahil Sawal ticket in Phase 2 onward is waiting on
one or more decisions below. With D1–D7 now decided, AUTH-BE-10 (schema) and AUTH-FE-05 (route
handlers) are unblocked immediately (they only depended on D2/D4).

Infra note from AUTH-ADI-01 exploration: as of 2026-09-22, only **one** environment is actually
deployed — `SkoutDev-cluster` / one RDS instance. No `SkoutUat` or `SkoutProd` ECS cluster or RDS
instance exists yet in this AWS account/region (consistent with ADR-0006's "Production host =
SkoutDev (only cluster)"). The dev/UAT/prod audit scope in AUTH-ADI-01 currently has one real
target, not three — confirm before writing UAT/prod rows into the audit results as "N/A" vs
"not yet provisioned."

AUTH-ADI-01 ran against SkoutDev (2026-09-22, script executed as a one-off ECS task): 14 total
users, all with a `clerk_user_id`, zero stub/fake-email/duplicate/inactive rows, zero active
invite sessions, and **`workspace_sso_configs` has zero rows** — the app's own database has never
had a single SSO binding configured, which is a second, independent confirmation of the D1 risk
below (Clerk's dashboard already showed no real SSO connections).

AUTH-ADI-02 ran against SkoutDev (2026-09-22): it initially refused to run the decrypt check
because **`INTEGRATION_ENCRYPTION_KEY` was still the CDK placeholder (`replace-me`)**. **Resolved
same day**: a real key was provisioned in `SkoutDev/app-config` and the API service redeployed.
The rotation script (`packages/db/src/rotate-integration-encryption-key.ts`) found that of 10
encrypted values (3 `workspace_integrations`, up to 3 fields × 3 `inboxes`, 2 fields × 2
`calendar_connections`), only 1 actually decrypted under the old `replace-me` value — the other 9
decrypted under **neither** `replace-me` nor the real `CLERK_SECRET_KEY` (both tested directly,
read-only, no key material ever printed). Not seed data either (`packages/db/src/seed.ts` has no
path that writes these columns) — these were real accounts a user connected through the app.
Working theory: this dev stack's Secrets Manager construct was recreated at some point (its
placeholder is only set once, at first creation) while the database persisted, orphaning whatever
real key existed before from any currently-configured value — Secrets Manager only retains two
version stages, so that original key is not recoverable. Aditya confirmed resetting these accounts
is acceptable (users just reconnect). **Deleted the 7 unrecoverable rows** (2
`workspace_integrations`, 3 `inboxes`, 2 `calendar_connections` — exact IDs in the PR that made
this change) rather than leaving them permanently undecryptable. Re-ran the audit after deletion:
clean, zero undecryptable rows, zero Clerk-key dependency. **AUTH-BE-07 is now unblocked.**

Matching finding from AUTH-ADI-03 (2026-09-22, Aditya, dashboard walkthrough — not the full formal
audit, but enough to confirm two of the three open decisions below): **Clerk also has no separate
Production instance provisioned** — there is only a Development instance, consistent with the
single-AWS-environment finding above. On that instance: **SMS verification code is enabled** (available for users to opt into);
authenticator app and backup codes are off; "Require MFA" is off, so MFA is optional, not
mandatory. This means some users may have voluntarily enrolled in SMS-based MFA today — actual
adoption count is still unknown and needs checking (Users tab, or Clerk's Backend API
`two_factor_enabled` field) before D3 can be called confirmed. Organizations is
not enabled (no active orgs) and SSO Connections lists only Google as a social sign-in provider —
no real enterprise SAML/OIDC connection exists. Session token custom claims are currently empty
(`{}`) — worth a follow-up for AUTH-BE-03/BE-12 but not decision-blocking.

Issuer URL (2026-09-22, decoded from the publishable key — no secret material needed): **the
Clerk instance's `iss` is `https://honest-mammoth-99.clerk.accounts.dev`.** This is the value
AUTH-BE-03's issuer allowlist needs.

### Incident: Clerk instance mismatch on dev (2026-09-25)

The live Clerk instance for dev is **`honest-mammoth-99`** (dashboard: Skout AI / Development). A
second, unexplained dev instance, `large-warthog-47`, was baked into the deployed frontend
(`NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` GitHub Actions secret, repo-level, last set June 2026), so
browser tokens carried `iss=https://large-warthog-47.clerk.accounts.dev` while the API trusts only
`CLERK_JWT_ISSUER` (`SkoutDev/clerk-issuer`). Result: every API call 401 `AUTH_TOKEN_INVALID`,
and onboarding ("Could not save your answers") failed. Users, sessions and SSO do not carry
between instances.

- Fix: set the repo secrets `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` and `CLERK_SECRET_KEY` to the
  `honest-mammoth-99` keys and redeploy (the key is compiled into the web image at build time).
- `SkoutDev/clerk-issuer` was briefly changed to `large-warthog-47` during triage and had to be
  restored to `https://honest-mammoth-99.clerk.accounts.dev` (no trailing slash), followed by a
  forced api/crm redeploy (ECS tasks read secrets only at start).
- Phone number was required at sign-up on `honest-mammoth-99` and Clerk blocks SMS to India;
  disabled in Configure -> User & authentication -> Phone number.
- Symptom to recognise: `auth.verify` failures for the correct issuer with **no**
  `clerk.verify_failed` log line mean the issuer allowlist rejected the token before Clerk was
  consulted (`providerForIssuer` returned null). A `clerk.verify_failed` line carries Clerk's
  fixed `reason` enum (PR #154).
- Known frontend bug, not fixed: the sign-up form's hardcoded `signInUrl="/app/signin"`
  (`sign-up-form.tsx`) plus Next's `/app` basePath yields `/app/app/signin` (blank page).
- Also on 2026-09-25: `INTEGRATION_ENCRYPTION_KEY`(_PREVIOUS) had been reset to `replace-me` by
  CloudFormation re-pushing the CDK placeholder, tripping the ECS circuit breaker (PR #148 RETAIN;
  PR #153 imports `appConfig`/`auth` by ARN on dev). One undecryptable Warm-Up Tool credential
  row remained in the personal dev workspace pending delete/reconnect.

## Decisions

| ID | Decision | Chosen | Rationale | Confirming input (not yet run) |
|---|---|---|---|---|
| D1 | SSO/SCIM strategy | **Build in-house** | Full removal of Clerk Enterprise dependency; matches AUTH-BE-23/24 scope already in the ticket doc. Kept despite AUTH-ADI-03 showing zero active Organizations and no real enterprise SSO connection today — Aditya confirmed there is a business reason for building this ahead of visible usage (2026-09-22). | Confirmed via AUTH-ADI-03: zero Clerk Organizations, no enterprise SSO connections. Decision explicitly held anyway — see Risks. |
| D2 | Token & cookie architecture | **Same-origin route-handler layer (BFF)** — JWT access + rotating opaque refresh; TTLs per ticket doc §3 (access 10 min · refresh idle 14 d · absolute 60 d) | Matches the ticket doc's recommended default; avoids the cross-origin cookie risk AUTH-ADI-11 flags for API-host cookies through the marketing proxy. | None — independently decidable, no change pending |
| D3 | MFA scope | **None at launch** | Ship core own-auth first. | **Still open**: AUTH-ADI-03 shows SMS-based MFA is *enabled and optional* in Clerk (not required). Need an actual adoption count (Users tab or Backend API `two_factor_enabled`) before this can be finalized — if adoption is non-trivial, those users need a migration path (e.g. forced TOTP re-enrollment) even if MFA itself isn't built into launch scope. |
| D4 | Where own-auth lives | **Module in `apps/api`** | Reuses existing DB, email, and OTP infrastructure; no new deploy target. | None |
| D5 | User migration approach | **Import hashes (confirmed exportable)**, **cohort rollout** | Least user disruption; Clerk support confirmed (2026-09-22, written 2026-09-28) the Dashboard self-serve export includes standard bcrypt digests, importable as-is. | **Confirmed** — see Context below. |
| D6 | Signing-key custody | **Secrets Manager injected as env** | Matches the existing secrets pattern (AUTH-ADI-09), fastest to ship; revisit KMS custody later if a compliance requirement demands it. | None |
| D7 | Social-login scope | **Google + Microsoft** | Adds Microsoft OAuth alongside Google in AUTH-BE-16/FE-10 scope. | None — no blocking audit, but adds scope to BE-16/FE-10 vs. the ticket doc's Google-only baseline |

### Cohort success criteria (gates G5, and ADI-14's rehearsal / ADI-17's cutover)

**Proposed 2026-09-28, needs Aditya's sign-off before it gates anything.** Measured on the pilot
cohort only, over the window it's in dual-verify, own-auth (own-issued) attempts only unless noted:

| Metric | Threshold | Action if breached |
|---|---|---|
| Login success rate (own-auth) | ≥ 99% of attempts (excluding wrong-password/locked-account, which are correct rejections, not errors) | Investigate before expanding the cohort; do not proceed to the next tranche |
| Auth error rate (5xx from `/auth/*`, or unexpected `AUTH_TOKEN_INVALID` on a token this service issued) | < 0.5% of login/refresh/me calls, sustained over any 15-minute window | Same as above; if sustained > 2% for 15 min, treat as a rollback trigger per ADI-17 |
| Refresh-reuse (theft signal) rate | No more than baseline-expected benign double-fires; any *confirmed* reuse (beyond the 5s grace window, `session.service.ts`) outside a known test gets investigated same-day | Do not expand the cohort until explained |
| Support tickets tagged auth-related | ≤ 5 per 100 pilot users over the cohort's first 7 days | Pause expansion, review ticket contents for a pattern before continuing |
| Rollback decision window | Any single breach above → hold at current cohort size for 48h minimum before the next tranche, not an automatic rollback (ADI-17's runbook, not this table, owns the actual rollback trigger) | — |

These are proposed numbers, not measured baselines — Clerk's own current error/success rates were
not pulled before writing this table. If real Clerk-era numbers exist (e.g. from Sentry/Datadog),
compare against them before treating a own-auth number as a regression.

## Risks — decisions made ahead of confirming audits
- **D1** — kept "build in-house" even though AUTH-ADI-03 shows zero active Clerk Organizations and
  no real enterprise SSO connection today. Aditya confirmed (2026-09-22) there's a business reason
  for this outside what's visible in Clerk's current config.
- **D3** — SMS-based MFA is enabled and optional in Clerk today; adoption count is still unknown.
  If any users have enrolled, "none at launch" needs a migration path for them specifically (they
  lose their second factor silently otherwise) even though MFA isn't being built into own-auth at
  launch. Get the adoption count before cutover, not after.
- **D5 — resolved 2026-09-28.** Clerk support confirmed in writing (2026-09-22 email, reviewed
  2026-09-28): the Dashboard's per-instance User export (Instance Settings -> User exports ->
  Export users; self-serve, workspace-admin only, no Clerk-side request needed) includes standard
  bcrypt digests (`$2a$10$...`, cost factor and 22-char salt embedded — importable directly, no
  separate salt field needed). Google-only sign-ups have no digest (expected — they never set a
  password) and fall back to force-reset/OTP on first own-auth login, same as any hash-import
  migration. The CSV export may not carry full OAuth provider user IDs; for Google `sub` values,
  call the Backend API `GET /users` (`external_accounts[]`) and match by Clerk user id instead —
  AUTH-BE-21 needs this as a second data source alongside the CSV.
  **Handle the export file as sensitive**: it can contain password hashes. Encrypt at rest, delete
  after the retention window, never commit it or paste it into chat/tickets (AUTH-ADI-13 already
  says this; repeating it here since this is where the file's contents are first confirmed).

## Inputs still needed (confirm or revise D1/D3/D5 above)
- [x] AUTH-ADI-01 — ran against SkoutDev 2026-09-22, results in Context above. No cleanup items
      for BE-02 (zero stub/fake/duplicate rows); strengthens the D1 risk (zero SSO config rows).
- [x] AUTH-ADI-02 — **resolved 2026-09-22**. Real key provisioned, 7 unrecoverable rows deleted
      (see Context above), re-verified clean. AUTH-BE-07 unblocked. Remaining tidy-up (not
      blocking): remove `INTEGRATION_ENCRYPTION_KEY_PREVIOUS` from `SkoutDev/app-config` and do one
      more `--force-new-deployment` now that rotation is done.
- [x] AUTH-ADI-03 (partial) — Clerk dashboard walkthrough done 2026-09-22 (single instance, no
      separate prod — see Context): MFA config, Organizations, SSO Connections, session-token
      claims all recorded above.
  - [ ] Still open: SMS-MFA adoption count (Users tab or Backend API `two_factor_enabled`) — feeds
        D3.
  - [x] Clerk support's written answer on password-hash export format — feeds D5. **Confirmed
        exportable, bcrypt, self-serve.** See Risks above for the full answer and the caveat on
        Google-only users and OAuth provider ids.
  - [x] Issuer URL — `https://honest-mammoth-99.clerk.accounts.dev` (see Context above). Feeds
        AUTH-BE-03's issuer allowlist.
  - [ ] Still open (lower priority, not decision-blocking): allowed origins/redirects, DNS
        records, webhooks, plan tier/MAU.

## Consequences
AUTH-BE-10 (own-auth schema) and AUTH-FE-05 (route-handler layer) can start now — they only needed
D2/D4. AUTH-BE-17/FE-13 (MFA) are closed as not-in-scope per D3. AUTH-BE-16/FE-10 (Google sign-in)
gain Microsoft as in-scope per D7. AUTH-BE-21/22 and FE-16 (migration tooling) build for hash-import as the
primary, now-confirmed path per D5, with force-reset/OTP only for the expected Google-only-signup
case (no password hash exists for them) — not as a fallback for hash-import failing.
