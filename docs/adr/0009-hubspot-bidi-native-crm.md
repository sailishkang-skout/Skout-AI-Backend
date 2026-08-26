# ADR 0009: HubSpot bi-directional sync — native CRM inbound (§8.12)

## Status
Accepted — Wave 2 (2026-08-26): webhook + deal sync shipped.

## Context
Outbound HubSpot export (`crm-export.runner.ts`) and prospect-corpus import
(`CrmService.importFromHubSpot`) existed. §8.12 CRM Intelligence requires bi-directional sync
with conflict rules into native CRM (`contacts` / `companies` / `deals`).

## Decision
1. **Outbound (existing):** list export → HubSpot upsert via `POST /lists/:id/export/hubspot`.
2. **Inbound contacts (manual):** `POST /api/v1/crm/hubspot/sync-native` pulls HubSpot contacts
   into native CRM with manual-wins conflict rules + evidence dual-write.
3. **Inbound deals:** same route also syncs HubSpot deals (name match; amount autofill with
   manual locks). Requires `crm.objects.deals.read` OAuth scope on reconnect.
4. **Webhooks:** `POST /api/v1/crm/hubspot/webhook?workspaceId=` — verifies
   `X-HubSpot-Signature` (sha256 of clientSecret + body), then runs a bounded native sync.
5. **Still deferred:** full HubSpot Companies API object sync (domain-match during contact sync
   remains); real-time per-object property patch without full pull.

## Consequences
- Operators can run manual inbound sync and subscribe HubSpot webhooks to the public endpoint.
- Re-authorize HubSpot OAuth to pick up deals.read scope.
