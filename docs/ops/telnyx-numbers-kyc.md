# §8.11 Telnyx numbers / KYC — closeout

**Date:** 2026-08-26  
**Environment:** SkoutDev (= production)

## What shipped in Skout

| Capability | Status |
|------------|--------|
| Click-to-call dial bridge | ✅ `apps/api` Telnyx/Twilio telecom (`/call/*`, `/settings/calling`) |
| Outbound SMS | ✅ Telnyx Messages API when `TELNYX_*` configured |
| Number **marketplace purchase UI inside Skout** | **Out of product scope** — numbers are provisioned in **Telnyx Mission Control** after account KYC |

## KYC / marketplace (Telnyx account ops)

Telnyx requires business KYC before purchasing DIDs in their portal. That is **Telnyx’s** workflow, not a Skout API:

1. Complete Telnyx account verification (Mission Control → Account → Verification).  
2. Purchase / port numbers in Telnyx.  
3. Set `TELNYX_API_KEY`, `TELNYX_PHONE_NUMBER`, `TELNYX_CONNECTION_ID` on `SkoutDev/api` (or dedicated secret wired by CDK).  
4. Force-redeploy API.

## Sign-off

§8.11 **engineering complete** for dialer/SMS. “Marketplace / KYC” is recorded as **external Telnyx account verification**, not an open Skout feature gap.
