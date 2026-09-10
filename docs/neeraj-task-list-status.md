# Neeraj task list — completion status

**Source:** `Skout_AI_Neeraj_Task_List.pdf`  
**Last reviewed:** 2026-08-29 (§2 competitive positioning policy closed; GTM deal entry pending)

| Status | Notes |
|---|---|
| ✅ Complete | All PDF engineering + ops controls on the only cluster (`SkoutDev`) |
| ℹ️ External | GTM win/loss deal entry + sign-off template; Warm-Up **Microsoft** OAuth; optional Chrome Web Store; per-customer Clerk IdP |

## Production environment

**SkoutDev = production** for account `119408973331` — see `docs/ops/skoutdev-is-production.md`.  
No separate `SkoutProd` cluster will be created in this account.

## §11.1 Security / tenancy

- ✅ Fail-closed RBAC live (`RBAC_ENFORCEMENT_ENABLED=true` API + CRM)
- ✅ Consent enforcement live (`CONSENT_ENFORCEMENT_ENABLED=true`)
- ✅ Encryption rotation executed on this env (2026-08-26); next Tier‑1 window 2026-11-23
- ✅ SSO/SCIM Stage‑6 platform + per-workspace bind APIs live — customer IdP metadata = Clerk Dashboard **process** at deal time (`docs/ops/sso-stage6-checklist.md`)

## §8 residuals closed

| § | Item | Close artifact |
|---|------|----------------|
| 8.8 | LinkedIn legal | `docs/ops/linkedin-compliance-signoff.md` (Unipile product path) |
| 8.9 | Chrome store listing | `docs/ops/chrome-extension-store-listing.md` (package ready) |
| 8.11 | Telnyx marketplace/KYC | `docs/ops/telnyx-numbers-kyc.md` (dialer shipped; KYC = Telnyx portal) |

## §2 Competitive win/loss (closed — GTM data pending)

- ✅ API + Postgres + Regional TAM gate (`proposed_not_proven` until ≥4 deals)
- ✅ ADR 0012 + ops runbook + updated template (gap + pilot feedback)
- ⏳ GTM: review deal history, enter deals or document gap — **due 2026-09-09**
- Runbook: [`docs/ops/competitive-win-loss-process.md`](./ops/competitive-win-loss-process.md)

## Still external (not Neeraj eng)

1. GTM win/loss: enter ≥4 real deals **or** complete gap + pilot sections in template — due **2026-09-09**  
2. Warm-Up **Microsoft** OAuth app credentials (Google uses `SkoutDev/google` + ECS wiring)  
3. Optional: Google Chrome Web Store publisher submit  
4. Per enterprise deal: Clerk Org SSO IdP metadata exchange  

## Test guide

Step-by-step QA: [`docs/neeraj-feature-test-guide.md`](./neeraj-feature-test-guide.md)
