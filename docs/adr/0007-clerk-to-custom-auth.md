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

AUTH-ADI-02 ran against SkoutDev (2026-09-22): it refused to run the decrypt check because
**`INTEGRATION_ENCRYPTION_KEY` is missing or still the CDK placeholder (`replace-me`) in this
environment.** This is exactly the risk the ticket doc flagged for this ticket — until a real key
is set, we don't know whether any currently-encrypted row (automation secrets, inbox SMTP/OAuth
tokens, integration API keys, calendar tokens) depends on the dev-fallback default or the Clerk key
fallback. **AUTH-BE-07 (removing the Clerk-key crypto fallback) cannot merge until this is fixed**
— provisioning a real `INTEGRATION_ENCRYPTION_KEY` is a Secrets Manager write + redeploy, tracked
under AUTH-ADI-09.

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

## Decisions

| ID | Decision | Chosen | Rationale | Confirming input (not yet run) |
|---|---|---|---|---|
| D1 | SSO/SCIM strategy | **Build in-house** | Full removal of Clerk Enterprise dependency; matches AUTH-BE-23/24 scope already in the ticket doc. Kept despite AUTH-ADI-03 showing zero active Organizations and no real enterprise SSO connection today — Aditya confirmed there is a business reason for building this ahead of visible usage (2026-09-22). | Confirmed via AUTH-ADI-03: zero Clerk Organizations, no enterprise SSO connections. Decision explicitly held anyway — see Risks. |
| D2 | Token & cookie architecture | **Same-origin route-handler layer (BFF)** — JWT access + rotating opaque refresh; TTLs per ticket doc §3 (access 10 min · refresh idle 14 d · absolute 60 d) | Matches the ticket doc's recommended default; avoids the cross-origin cookie risk AUTH-ADI-11 flags for API-host cookies through the marketing proxy. | None — independently decidable, no change pending |
| D3 | MFA scope | **None at launch** | Ship core own-auth first. | **Still open**: AUTH-ADI-03 shows SMS-based MFA is *enabled and optional* in Clerk (not required). Need an actual adoption count (Users tab or Backend API `two_factor_enabled`) before this can be finalized — if adoption is non-trivial, those users need a migration path (e.g. forced TOTP re-enrollment) even if MFA itself isn't built into launch scope. |
| D4 | Where own-auth lives | **Module in `apps/api`** | Reuses existing DB, email, and OTP infrastructure; no new deploy target. | None |
| D5 | User migration approach | **Import hashes (if exportable)**, **cohort rollout** | Least user disruption if Clerk exports usable password hashes. | AUTH-ADI-03 (Clerk's written answer on hash export format) — **if hashes are not exportable, this falls back to force-reset or passwordless-OTP; AUTH-BE-21/22 and FE-16 must not assume hash import until AUTH-ADI-03 confirms it** |
| D6 | Signing-key custody | **Secrets Manager injected as env** | Matches the existing secrets pattern (AUTH-ADI-09), fastest to ship; revisit KMS custody later if a compliance requirement demands it. | None |
| D7 | Social-login scope | **Google + Microsoft** | Adds Microsoft OAuth alongside Google in AUTH-BE-16/FE-10 scope. | None — no blocking audit, but adds scope to BE-16/FE-10 vs. the ticket doc's Google-only baseline |

Cohort success criteria (error rate, login success rate, support-ticket threshold gating G5): **not
yet defined** — needs concrete numbers, follow up separately now that D5 (cohort rollout) is set.

## Risks — decisions made ahead of confirming audits
- **D1** — kept "build in-house" even though AUTH-ADI-03 shows zero active Clerk Organizations and
  no real enterprise SSO connection today. Aditya confirmed (2026-09-22) there's a business reason
  for this outside what's visible in Clerk's current config.
- **D3** — SMS-based MFA is enabled and optional in Clerk today; adoption count is still unknown.
  If any users have enrolled, "none at launch" needs a migration path for them specifically (they
  lose their second factor silently otherwise) even though MFA isn't being built into own-auth at
  launch. Get the adoption count before cutover, not after.
- **D5** assumes Clerk's password hashes are exportable. AUTH-ADI-03 includes asking Clerk support
  this explicitly, in writing — until that answer lands, AUTH-BE-21 (import tool) should be built
  to support hash-import as the primary path but must not hard-fail if hashes turn out unavailable.

## Inputs still needed (confirm or revise D1/D3/D5 above)
- [x] AUTH-ADI-01 — ran against SkoutDev 2026-09-22, results in Context above. No cleanup items
      for BE-02 (zero stub/fake/duplicate rows); strengthens the D1 risk (zero SSO config rows).
- [x] AUTH-ADI-02 (blocked, new action item) — ran against SkoutDev 2026-09-22: refused to proceed
      because `INTEGRATION_ENCRYPTION_KEY` is still the CDK placeholder. **New task: provision a
      real key for SkoutDev (AUTH-ADI-09), then re-run
      `pnpm --filter @skout/db audit-encryption-key-dependency` (or
      `./scripts/ecs-run-auth-audit.sh SkoutDev encryption-key-dependency`) before AUTH-BE-07 can
      merge.**
- [x] AUTH-ADI-03 (partial) — Clerk dashboard walkthrough done 2026-09-22 (single instance, no
      separate prod — see Context): MFA config, Organizations, SSO Connections, session-token
      claims all recorded above.
  - [ ] Still open: SMS-MFA adoption count (Users tab or Backend API `two_factor_enabled`) — feeds
        D3.
  - [ ] Still open: Clerk support's written answer on password-hash export format — feeds D5.
  - [ ] Still open (lower priority, not decision-blocking): issuer URL, allowed
        origins/redirects, DNS records, webhooks, plan tier/MAU.

## Consequences
AUTH-BE-10 (own-auth schema) and AUTH-FE-05 (route-handler layer) can start now — they only needed
D2/D4. AUTH-BE-17/FE-13 (MFA) are closed as not-in-scope per D3. AUTH-BE-16/FE-10 (Google sign-in)
gain Microsoft as in-scope per D7. AUTH-BE-21/22 and FE-16 (migration tooling) should build for
hash-import as primary per D5, with force-reset/OTP as the documented fallback until AUTH-ADI-03
confirms hash export is real.
