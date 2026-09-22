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

## Decisions

| ID | Decision | Chosen | Rationale | Confirming input (not yet run) |
|---|---|---|---|---|
| D1 | SSO/SCIM strategy | **Build in-house** | Full removal of Clerk Enterprise dependency; matches AUTH-BE-23/24 scope already in the ticket doc. | AUTH-ADI-01 (active SSO workspace count) / AUTH-ADI-03 (SSO/SCIM connections) — confirm the customer count this must support before committing engineering time |
| D2 | Token & cookie architecture | **Same-origin route-handler layer (BFF)** — JWT access + rotating opaque refresh; TTLs per ticket doc §3 (access 10 min · refresh idle 14 d · absolute 60 d) | Matches the ticket doc's recommended default; avoids the cross-origin cookie risk AUTH-ADI-11 flags for API-host cookies through the marketing proxy. | None — independently decidable, no change pending |
| D3 | MFA scope | **None at launch** | Ship core own-auth first; revisit if AUTH-ADI-03 shows meaningful existing Clerk MFA usage. | AUTH-ADI-03 (does Clerk report MFA usage today?) — if usage is non-trivial, reopen this decision before cutover |
| D4 | Where own-auth lives | **Module in `apps/api`** | Reuses existing DB, email, and OTP infrastructure; no new deploy target. | None |
| D5 | User migration approach | **Import hashes (if exportable)**, **cohort rollout** | Least user disruption if Clerk exports usable password hashes. | AUTH-ADI-03 (Clerk's written answer on hash export format) — **if hashes are not exportable, this falls back to force-reset or passwordless-OTP; AUTH-BE-21/22 and FE-16 must not assume hash import until AUTH-ADI-03 confirms it** |
| D6 | Signing-key custody | **Secrets Manager injected as env** | Matches the existing secrets pattern (AUTH-ADI-09), fastest to ship; revisit KMS custody later if a compliance requirement demands it. | None |
| D7 | Social-login scope | **Google + Microsoft** | Adds Microsoft OAuth alongside Google in AUTH-BE-16/FE-10 scope. | None — no blocking audit, but adds scope to BE-16/FE-10 vs. the ticket doc's Google-only baseline |

Cohort success criteria (error rate, login success rate, support-ticket threshold gating G5): **not
yet defined** — needs concrete numbers, follow up separately now that D5 (cohort rollout) is set.

## Risks — decisions made ahead of confirming audits
- **D1** assumes in-house SSO/SCIM is worth building without yet knowing how many customers use
  Clerk's SSO today (AUTH-ADI-01/03 not run). If that count is near zero, this may be over-scoped.
- **D3** assumes dropping MFA at launch is acceptable without yet knowing current Clerk MFA usage.
- **D5** assumes Clerk's password hashes are exportable. AUTH-ADI-03 includes asking Clerk support
  this explicitly, in writing — until that answer lands, AUTH-BE-21 (import tool) should be built
  to support hash-import as the primary path but must not hard-fail if hashes turn out unavailable.

## Inputs still needed (confirm or revise D1/D3/D5 above)
- [ ] AUTH-ADI-01 — identity data audit (counts only: total users, `clerk_user_id` nulls,
      `stub:%` ids, `@clerk.local` emails, case-duplicate emails, inactive users, SSO config counts
      by status/scim_enabled, active invite sessions). Script ready:
      `pnpm --filter @skout/db audit-identity-data`. Scope note: only SkoutDev exists today (see
      Context) — run there; UAT/prod rows are N/A until those environments exist.
- [ ] AUTH-ADI-02 — prove `INTEGRATION_ENCRYPTION_KEY` / `HUBSPOT_CLIENT_SECRET` don't depend on
      `CLERK_SECRET_KEY`. Script ready: `pnpm --filter @skout/db audit-encryption-key-dependency`
      (read-only, counts only, no plaintext).
- [ ] AUTH-ADI-03 — Clerk dashboard audit (dev + prod): customized session-token claims, issuer
      URL, auth methods + user counts (incl. MFA usage — feeds D3), allowed origins/redirects, DNS
      records, webhooks, Organizations/SSO connections (feeds D1), plan tier/MAU, and Clerk's
      written answer on password-hash export format (feeds D5). Manual — needs Clerk dashboard
      admin login.

## Consequences
AUTH-BE-10 (own-auth schema) and AUTH-FE-05 (route-handler layer) can start now — they only needed
D2/D4. AUTH-BE-17/FE-13 (MFA) are closed as not-in-scope per D3. AUTH-BE-16/FE-10 (Google sign-in)
gain Microsoft as in-scope per D7. AUTH-BE-21/22 and FE-16 (migration tooling) should build for
hash-import as primary per D5, with force-reset/OTP as the documented fallback until AUTH-ADI-03
confirms hash export is real.
