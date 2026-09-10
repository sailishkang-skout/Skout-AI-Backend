# §16 Missing areas — triage & owners

**Decision:** Leadership triage **2026-08-26** — Wave 2 eng updates same day.

| Area | Status | Owner | Notes / next ticket |
|---|---|---|---|
| Entitlements / credits / usage ledger | **Eng-complete** | Neeraj | `EntitlementsService` + PlatformContext + inbox/LinkedIn/search overrides; credit ledger remains separate by design |
| Consent / suppression center | **Partial** | Shailpreet | Backend `consents` + enforcement; unified UI center = frontend |
| Provider / data licensing rules | **Deferred** | Product + Legal | Ticket: license inventory → ADR |
| Search reindex / schema evolution | **Deferred** | Aditya | Ticket: OpenSearch backfill playbook |
| Model eval / prompt registry / red-team | **Eng-complete** | Neeraj | `model_versions` / `prompt_versions` + pin surfaces; red-team ops playbook later |
| Manual review queues | **Partial** | Shailpreet | Identity merge + AI drafts exist; unify UI |
| Notifications center | **Shipped** | Shailpreet | R17.1 |
| i18n / locale | **Partial** | Shailpreet | See `docs/adr/0009-i18n-sales-comp-deferred.md` |
| Import / export / bulk-undo / DSAR | **Partial** | Neeraj | DSAR intake shipped; bulk-undo ticket open |
| Sales comp / territory routing | **Deferred** | Product | `docs/adr/0009-i18n-sales-comp-deferred.md` |

## Engineering closure
§16 is **triaged + Neeraj backend items closed or ADR-deferred**. Remaining rows are Product/Legal/Aditya/Shailpreet.
