# Neeraj task list — completion status

**Source:** `Skout_AI_Neeraj_Task_List.pdf`  
**Last reviewed:** 2026-08-26 (SkoutDev declared production; residuals closed)

| Status | Notes |
|---|---|
| ✅ Complete | All PDF engineering + ops controls on the only cluster (`SkoutDev`) |
| ℹ️ External | GTM ≥4 win/loss deals; Sailesh Warm-Up OAuth; optional Chrome Web Store publisher click; per-customer Clerk IdP at deal time |

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

## Still external (not Neeraj eng)

1. GTM ≥4 production win/loss deals (due ~2026-09-09)  
2. Sailesh Warm-Up Google/Microsoft OAuth app credentials  
3. Optional: Google Chrome Web Store publisher submit  
4. Per enterprise deal: Clerk Org SSO IdP metadata exchange  

## Test guide

Step-by-step QA: [`docs/neeraj-feature-test-guide.md`](./neeraj-feature-test-guide.md)
