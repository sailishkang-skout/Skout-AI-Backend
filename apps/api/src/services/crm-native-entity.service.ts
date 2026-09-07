import { eq } from "drizzle-orm";
import type { Db } from "@skout/db";
import { schema, scopedById } from "@skout/db";
import { asFieldSourcesMap, markManualSources, type CrmSyncEntityType } from "@skout/shared";
import { recordEvidence } from "./evidence.service.js";
import { queueCrmOutboundWriteIfOwned } from "./crm-outbound-sync.service.js";

const { contacts, deals } = schema;

/**
 * Section 7.1 / Section 5 DOCUMENTED READ-MODEL EXCEPTION (Enterprise Completion Plan) - see
 * docs/adr/0003-read-model-exceptions.md for the full audit and rationale.
 *   - Tables touched directly: contacts, deals (owned by apps/crm) - read AND write
 *   - Owning service: apps/crm (apps/api has direct Postgres access via the shared instance)
 *   - Reason: this is the manual field-edit path other apps/api CRM code (crm-hubspot-native-
 *     sync.service.ts, identity-merge-apply.service.ts, enrichment-autofill.service.ts — all
 *     already direct read+write exceptions on these same tables) already establishes as the
 *     accepted pattern; a real internal-API round trip isn't warranted for a single-row PATCH
 *     that also needs to run in the same transaction as the fieldSources/evidence-ledger writes
 *   - Review date: revisit once apps/crm exposes a native contacts/deals write endpoint
 */

export interface ContactPatch {
  firstName?: string;
  lastName?: string;
  email?: string;
  phone?: string;
  title?: string;
}

export interface DealPatch {
  name?: string;
  amount?: string;
}

/**
 * §8.12 Task ADI-10 — the one real "a human edited a Skout-native field" mutation path in this
 * codebase today (see PATCH /crm/contacts/:id, /crm/deals/:id). Marks the edited fields "manual"
 * in both the fieldSources cache column and the evidence ledger (evidence_ledger is authoritative
 * for the inbound lock rule — see field-sources.ts), then queues an outbound push-back write for
 * whichever edited fields are CRM-sync-owned and this entity is linked to a CRM record.
 */
export async function applyManualEntityPatch(
  db: Db,
  workspaceId: string,
  entityType: CrmSyncEntityType,
  id: string,
  patch: ContactPatch | DealPatch
): Promise<Record<string, unknown> | null> {
  const table = entityType === "contact" ? contacts : deals;
  const [existing] = await db
    .select()
    .from(table)
    .where(scopedById(table, workspaceId, id))
    .limit(1);
  if (!existing) return null;

  const editedFields = Object.keys(patch);
  if (editedFields.length === 0) return existing;

  const existingSources = asFieldSourcesMap(existing.fieldSources);
  const nextFieldSources = markManualSources(existingSources, editedFields);

  const [updated] = await db
    .update(table)
    .set({ ...patch, fieldSources: nextFieldSources, updatedAt: new Date() })
    .where(eq(table.id, id))
    .returning();

  const changedAt = new Date();
  for (const field of editedFields) {
    try {
      await recordEvidence(db, {
        workspaceId,
        entityType,
        entityId: id,
        attribute: field,
        value: (patch as Record<string, unknown>)[field],
        source: "manual",
        observedAt: changedAt,
        confidence: 1,
        method: "manual_edit",
      });
    } catch {
      // Evidence is a provenance record, not the source of truth for the field value itself —
      // the update above already succeeded; don't fail the request over a logging write.
    }
  }

  await queueCrmOutboundWriteIfOwned(db, workspaceId, entityType, id, patch as Record<string, unknown>, changedAt);

  return updated ?? null;
}
