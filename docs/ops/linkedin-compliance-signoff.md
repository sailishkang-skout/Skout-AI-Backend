# §8.8 LinkedIn — compliance posture (signed)

**Date:** 2026-08-26  
**Environment:** SkoutDev (= production for this account)  
**Owner:** Neeraj (Eng / Ops)

## Product LinkedIn path (customer-facing)

Skout’s **supported** LinkedIn outreach and account connect path is **Unipile** (official partner API), not browser session cookie scraping for send.

| Surface | Mechanism | Compliance note |
|---------|-----------|-----------------|
| Sequence LinkedIn steps | Unipile connect / message | Customer connects their own LinkedIn via Unipile hosted auth |
| Inbox / LI workspace | Unipile-backed | Same |
| Chrome extension | Capture into Skout lists + optional Unipile-backed sequence send | User-initiated capture on pages they already browse |

## Corpus scrapers (internal)

Bulk LinkedIn corpus bots under `workers/scrapers` are **Tier‑4 scraping infrastructure** (see `docs/secrets-rotation-policy.md`). They are **not** the enterprise product SSO/outreach path. Operate only with owned accounts and within documented rate limits.

## Sign-off

Engineering accepts this posture as the §8.8 **legal/compliance close** for the Neeraj task list:

- [x] Product send path = Unipile  
- [x] No custom SAML/LinkedIn ACS required for LI  
- [x] Customer ToS: document “LinkedIn send is Unipile-backed” in MVP checklist  

**Residual (external):** Customer Legal may still review Unipile DPA for enterprise contracts — not a Skout code gate.
