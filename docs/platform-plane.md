# Platform plane — tenancy, entitlements, feature flags (§7)

**Status: Wave 2 shipped 2026-08-26**

The **platform plane** is the shared layer every domain service reads for:

| Concern | Implementation | Status |
|---|---|---|
| Tenant boundary | `tenants` + `tenant_workspaces` | Shipped |
| RBAC | `roles` / `permissions` / `workspace_member_roles` + `enforcePermission` | SkoutDev fail-closed |
| Entitlements | `entitlements` + `EntitlementsService` | LinkedIn/WhatsApp limits, search/enrichment credit costs, `inbox.daily_send_limit` |
| Consent | `consents` + `ConsentService` | SkoutDev enforced |
| PlatformContext | `loadPlatformContext()` in `@skout/auth` | **Wired** on authenticated API requests (`request.platformContext`) |
| Billing / credits | `credits` + `payment_orders` | Real; still separate ledger from entitlements overrides |

## Request shape

```ts
request.platformContext = {
  tenantId,
  workspaceId,
  userId,
  permissions: string[],
  entitlements: Record<string, unknown>,
  consent: PlatformConsentSnapshot[],
}
```

## References
- ADR 0002 (canonical operating model)
- `packages/auth/src/platform-context.ts`
- `apps/api/src/plugins/auth.ts` (attach hook)
- `apps/api/src/services/entitlements.service.ts`
