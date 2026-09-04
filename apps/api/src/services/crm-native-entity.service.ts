import { eq } from "drizzle-orm";
import type { Db } from "@skout/db";
import { schema, scopedById } from "@skout/db";
import { asFieldSourcesMap, markManualSources, type CrmSyncEntityType } from "@skout/shared";
import { recordEvidence } from "./evidence.service.js";
import { queueCrmOutboundWriteIfOwned } from "./crm-outbound-sync.service.js";

const { contacts, deals } = schema;

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
