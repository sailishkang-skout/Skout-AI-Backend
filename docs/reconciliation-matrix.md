# §13.2 Reconciliation matrix (in-repo)

**Source workbook:** `Skout_AI_Reconciliation_and_WBS.xlsx` (external — merge manually when updated)  
**Last synced from Enterprise Completion Plan:** 2026-08-26  
**Program owner:** Neeraj (Lead)

| Capability | Evidence (repo) | Status | Risk | Target gap | Stage |
|---|---|---|---|---|---|
| Evidence Ledger (D4) | `evidence_ledger`, ADR 0002/0007 | Wave 2 in progress | Med | Full cutover; retire parallel ledgers | 1 |
| Tenancy / RBAC | `tenants`, `roles`, `assertPermission`, SkoutDev fail-closed | Wave 1 live | Med | Migrate all `requireRole()` sites; SkoutProd backfill | 1 |
| Anti-hallucination (§6.1) | `evidence-contract`, pin on NBA/chat/sequence/drafts | Partial | Med | Every AI response boundary | 1–2 |
| Identity merge (§5.2) | discovery worker + apply/restore | Shipped | Low | Prospect↔CRM uuid reconciliation (R14.1) | 2 |
| CRM Intelligence (§8.12) | buying committee, retention, HubSpot sync-native | Partial | Med | Full bi-di webhooks, pipeline intel | 2–3 |
| Regional Intel (§6.2/6.3) | `regional-intel.service`, unverified flag | Advisory only | **High** | Blocked on §2 win/loss ≥4 deals | 2 |
| Signals (D5) | `signals` table + ingest | Shipped (Neeraj platform); UI Shailpreet | Low | Signal Center surface | 2 |
| Automation (D15) | activation-rules; n8n live | Decision-gated | Med | Native Workflow Studio vs n8n UI | 3 |
| Observability (§11.3) | Datadog APM, OTLP, sweep spans | Baseline live | Low | Business-journey metrics, anomaly detection | 1–2 |
| SLO targets (§11.2) | `docs/slo-targets.md`, `GET /slo` | **Locked baseline** | Low | Contractual customer-specific overrides | 1 |
| SSO / SCIM (Stage-6) | ADR 0006, `docs/ops/sso-stage6-checklist.md` | Platform ready | Low | Per-customer IdP bind in Clerk | 6 |
| Competitive win/loss (§2) | `competitive_win_loss_*` tables + API | **Engineering ready** | **High** until GTM fills ≥4 deals | Product data entry | 0 |
| Cross-domain journeys (§10) | `apps/api/src/e2e/journeys.e2e.test.ts` | Contract tests live | Med | Full HTTP E2E per journey | 2–5 |
| SkoutProd deploy | CDK flags wired | Not deployed | Med | Run forwarder + RBAC scripts | 1 |

## Sign-off
Eng lead reconciliation sync: **2026-08-26** — replaces interim-only gap list for backend-owned rows.
