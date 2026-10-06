# COPS-01 audit-and-extend findings

This is the required existing-code audit for COPS-01. The backend already owns CRM, billing,
notifications, tenancy/RBAC, audit history, and the Skout event spine. COPS-01 extends those
systems and adds only the missing transactional-outbox and idempotency capabilities.

## Existing capabilities reused

| Bible area | Existing implementation | COPS-01 integration |
|---|---|---|
| CRM and Customer 360 | `packages/db/src/schema/crm.ts`, `apps/api/src/routes/crm-native.routes.ts`, `account-360.routes.ts`, `apps/crm` | Keep existing resources and routes; link from the existing dashboard navigation. COPS-02 owns CRM changes. |
| Credits and billing | `packages/db/src/schema/credits.ts`, `billing.ts`, `apps/api/src/routes/billing.routes.ts`, `entitlements.routes.ts` | Keep existing ledger and billing APIs; no second billing model in COPS-01. |
| Sequences and automation | `packages/db/src/schema/sequences.ts`, `automation.ts`, `automations.ts`, existing sequence/automation routes | Reuse existing sequences and workflows; COPS-05/10 own customer-lifecycle automation. |
| Event log and event transport | `packages/db/src/schema/events.ts` (`skout_events`), `packages/shared/src/event-envelope.ts`, `apps/api/src/services/skout-event.service.ts`, existing BullMQ/webhook dispatch | Keep the existing event spine. It is durable best-effort logging, not an atomic outbox, so COPS-01 adds a transactional outbox for new lifecycle writes rather than replacing the current event API. |
| Audit | `packages/db/src/schema/audit.ts` (`audit_logs`), `apps/crm/src/services/audit.service.ts`, `packages/auth` step-up audit writes | Extend `audit_logs` with Appendix D context and write through one shared COPS audit helper. Do not create a parallel `cops_audit_events` table. |
| Incidents | `packages/db/src/schema/incidents.ts`, existing incident routes | Reuse for incident state; COPS-06 owns ticket/incident lifecycle integration. |
| RBAC | `workspace_member_roles`, `roles`, `role_permissions`, `permissions`, `packages/auth/src/require-permission.ts`, `packages/db/src/backfill-rbac.ts` | Seed COPS permission keys and system-role grants into the existing catalog; use `getMemberPermissions` server-side. Never trust client-only visibility checks. |
| Notifications and preferences | `packages/db/src/schema/notifications.ts`, `apps/api/src/services/notifications.service.ts`, `notification.routes.ts`, dashboard `NotificationBell`, `/settings/notifications` | Reuse the existing center, settings, delivery service, and endpoints. Do not add a second notification page or provider service. |
| Integrations and SSO | `packages/db/src/schema/integrations.ts`, HubSpot and SSO/SCIM routes | Retain existing integrations and configuration. |
| AI / recommendations | `apps/ai`, `next-best-action.ts`, activation-rule routes | Keep AI recommendation and approval boundaries in their existing modules. |

## COPS-01 additions that were actually missing

- A Postgres transactional outbox, typed COPS event schemas, relay retry/dead-letter handling,
  idempotent-consumer primitives, and audited replay by event ids or time range. The existing `skout_events`
  table is an event log and cannot atomically commit with a business write.
- The existing CRM deal service now writes the `OpportunityQualified` outbox event in the same
  transaction as the deal-stage update and existing audit row; the relay uses the existing
  `skout-dexter-event` queue and worker.
- The six independent lifecycle dimensions and their allowed-transition rules. Opportunity
  `won` does not imply onboarding `activated`.
- The COPS verb/resource permission catalog and role grants, layered onto the existing RBAC
  tables. `Engineering` is deliberately not granted commercial or legal reads.
- Persisted idempotency outcomes for mutating endpoints.
- A workspace-scoped, permission-checked audit query and an audit helper that writes to the
  existing `audit_logs` table.
- The OpenAPI contract and the audit-log view. The existing dashboard navigation is extended to
  link the view only when the server-reported permission allows it.

## Contract and rollout notes

- The global API error body now includes the Bible contract fields
  `{code, message, details, request_id, retryable}` and keeps the legacy `ok`, `error`, and
  `statusCode` aliases for current clients.
- `GET /api/v1/me` returns the authenticated user's permission keys from the existing RBAC
  service. The audit navigation item is hidden until `admin:read` is granted; the API still
  enforces that permission independently.
- Run the existing `@skout/db backfill-rbac` command after deploying the permission-catalog
  update. It is idempotent and creates the COPS system roles/grants for future assignment.
- Notification delivery remains on the current notification service. The existing bell is the
  notification center; `/settings/notifications` remains the preferences and channel setup page.

## Acceptance verification (2026-10-06)

| Acceptance item | Status | Evidence / remaining work |
|---|---|---|
| Outbox crash safety and duplicate-event no-op | ✅ | In-memory crash/consumer tests pass; the real-Postgres process-kill test passed 2/2 with `COPS_TEST_DATABASE_URL` and is committed as `81f9c61`. |
| Illegal lifecycle transitions return 409; won does not imply activated | ✅ | Independent dimensions and transition tables; lifecycle/error unit tests pass. |
| Permission matrix; Engineering denied commercial/legal reads | ⚠️ Partial | Permission matrix tests and the exact CustomerOps role grant seed pass, including Engineering's denial. Verify the live database grants after the idempotent RBAC backfill; do not enable enforcement before rollout. |
| Overrides require a reason and create audit records | ✅ | Shared audit validation rejects overrides without a reason; lifecycle/replay writes persist audit records transactionally. Each later ticket must assert its own override audit write. |
| Notification provider outage retries, alerts, and does not fail the originating write | ⚠️ Partial | Existing delivery tests verify retry/fallback and Sentry exception capture; notification creation still succeeds with the in-app record. Production alert delivery still requires configured SENTRY_DSN and Sentry alert rules. |
| Permission-aware frontend; no raw 403 screen | ✅ | Audit nav is permission-gated; the audit page renders a user-facing forbidden message. |
| 422 field errors and retryable/429 handling | ✅ | API returns `details.fields[]`; frontend audit-page integration test verifies submitting a date filter displays the returned `from` error. Envelope/retry tests pass. Browser smoke for audit page passes; authenticated browser-level 422 still needs a valid E2E auth fixture before release. |
| OpenAPI contract and existing-code audit | ✅ | Contract: `docs/api/copos-01-platform-foundation.openapi.yaml`; findings recorded above. |
| Six Bible p.10 ADRs | ✅ | All six decisions are documented and linked below. ADRs are proposed pending reviewer sign-off; provider selections are correctly deferred to the tickets that integrate them. |
| Commercial / Engineering navigation | ⏭ | Deliberately deferred to COPS-03 / COPS-06. |

Focused verification run: backend COPS shared tests **67/67 passed**; seeded COPS role grant
tests **3/3 passed**; frontend COPS error, fetch, navigation-helper, audit-viewer, and audit-page
integration tests **20/20 passed**. The existing audit-page Playwright smoke test passes.
Notification provider retry, Sentry-capture, and fallback tests **7/7 passed**.

### Product Bible v2 p.10 decision ADRs

- [ADR 0013 — Skout Internal CRM is canonical](../adr/0013-internal-crm-canonical.md)
- [ADR 0014 — External CRM sync is opt-in](../adr/0014-external-crm-sync-opt-in.md)
- [ADR 0015 — Skout generates commercial documents; signatures are delegated](../adr/0015-commercial-docs-esign-delegated.md)
- [ADR 0016 — PSP processes payments; Skout stores references and status only](../adr/0016-payments-via-psp-references-only.md)
- [ADR 0017 — Event-driven workflows with idempotency and replay](../adr/0017-event-driven-idempotent-replayable-workflows.md)
- [ADR 0018 — AI recommends; permissioned humans approve](../adr/0018-ai-recommends-humans-approve.md)
