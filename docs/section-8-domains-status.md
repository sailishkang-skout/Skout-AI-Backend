# §8 product domains — engineering completeness

**Source:** Skout Enterprise Completion Plan §8 + Engineering Vision v2.1  
**Updated:** 2026-08-31

| § | Domain | Backend | Frontend | Residual (external) |
|---|---|---|---|---|
| 8.1 | Onboarding / setup | ✅ | ✅ `/onboarding` | Persona polish only |
| 8.2 | Discover / TAM / search | ✅ | ✅ `/tam`, `/prospects/search` | — |
| 8.3 | Enrichment workbooks | ✅ | ✅ `/enrichment/workbooks` | — |
| 8.4 | Account / Person 360 | ✅ | ✅ `/crm/360` | — |
| 8.5 | Signals | ✅ | ✅ `/signals` | — |
| 8.6 | Sequence Studio | ✅ | ✅ `/sequences` | — |
| 8.7 | Dexter AI SDR | ✅ command center + event spine | ✅ `/dexter` + Dexter chat FAB | Deploy uncommitted spine |
| 8.8 | LinkedIn workspace | ✅ | ✅ inbox + `/linkedin/voice` | Legal sign-off doc only |
| 8.9 | Chrome companion | ✅ extension | N/A | Optional Web Store publish |
| 8.10 | Email intel / deliverability | ✅ | ✅ `/intelligence/email`, `/warmup` | Warm-Up Microsoft OAuth (Sailesh) |
| 8.11 | Numbers / voice | ✅ marketplace + click-to-call | ✅ `/settings/numbers`, calling copilot | Live transcription copilot = later phase |
| 8.12 | CRM Intelligence | ✅ | ✅ `/crm/intelligence` | — |
| 8.13 | AI command bar / copilots | ✅ preview + execute-tool evidence | ✅ Dexter chat confirm panel | — |
| 8.14 | Automation / integrations | ✅ Workflow Studio | ✅ `/workflows` | — |
| 8.15 | Reporting / GTM learning | ✅ | ✅ `/admin/reporting`, `/admin/revenue`, `/admin/cro` | — |
| §16 | Compliance / DSAR / SSO | ✅ `/consents`, `/suppressions`, `/dsar`, `/sso/*` | ✅ `/settings/compliance`, `/settings/sso` | — |
| §17.1–17.18 | Concept UI pillars (4 per screen) | ✅ Shared `VisionConceptFrame` + route auto-wrap | ✅ Dexter FAB + Chrome extension | — |
| §2 | Competitive win/loss | ✅ API | ✅ `/admin/competitive` | GTM enters ≥4 real deals |

**Verdict:** All code-shippable §8 + §16 + §17 surfaces are **complete** on `develop` pending commit/deploy. Remaining items are **external/process only** (Warm-Up OAuth creds, Chrome store click, GTM deal entry, live call transcription).
