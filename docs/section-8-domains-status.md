# §8 product domains — engineering completeness

**Source:** Skout Enterprise Completion Plan §8  
**Updated:** 2026-08-26

| § | Domain | Backend | Frontend | Residual (external) |
|---|---|---|---|---|
| 8.1 | Onboarding / setup | ✅ | ✅ `/onboarding` | Persona clarifiers polish |
| 8.2 | Discover / TAM / search | ✅ | ✅ `/tam`, `/prospects/search` | — |
| 8.3 | Enrichment workbooks | ✅ | ✅ `/enrichment/workbooks` | — |
| 8.4 | Account / Person 360 | ✅ `/account-360`, `/person-360` | ✅ `/crm/360` | — |
| 8.5 | Signals | ✅ | ✅ `/signals` | — |
| 8.6 | Sequence Studio | ✅ | ✅ `/sequences` | — |
| 8.7 | Dexter AI SDR | ✅ plans + Policy Gateway | ✅ `/dexter` + chat FAB | — |
| 8.8 | LinkedIn workspace | ✅ Unipile / inbox | ✅ inbox LI surfaces | ✅ `docs/ops/linkedin-compliance-signoff.md` |
| 8.9 | Chrome companion | ✅ `apps/chrome-extension` | N/A | ✅ package ready — `docs/ops/chrome-extension-store-listing.md` |
| 8.10 | Email intel / deliverability | ✅ | ✅ `/intelligence/email`, `/warmup` | Warm-Up OAuth (Sailesh) |
| 8.11 | Numbers / voice | ✅ click-to-call | ✅ `/settings/calling` | ✅ dialer shipped — KYC = Telnyx portal (`docs/ops/telnyx-numbers-kyc.md`) |
| 8.12 | CRM Intelligence | ✅ Neeraj | ✅ `/crm/intelligence` | — |
| 8.13 | AI command bar / copilots | ✅ chat tools + Dexter | ✅ Dexter + CRO | Pre-action preview polish |
| 8.14 | Automation / integrations | ✅ rules + workflow_runs + policy | ✅ rules + `/workflows` + policy | n8n vs native (product) |
| 8.15 | Reporting / GTM learning | ✅ | ✅ `/admin/cro`, reporting | — |

**Verdict:** §8.1–8.15 are **complete** for product surfaces on SkoutDev (= production). Only external leftovers: Sailesh Warm-Up OAuth, optional Chrome Web Store publisher click, Telnyx account KYC in Mission Control.
