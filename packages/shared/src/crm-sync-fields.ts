/**
 * §8.12 Task ADI-10 — which native Skout fields, per entity type, are eligible for CRM push-back.
 * Distinct from FieldSource (field-sources.ts): FieldSource governs the *inbound* direction (can
 * an auto-fill overwrite this field, or has a human locked it as "manual"). This governs the
 * *outbound* direction (should a change to this field be queued as an outbound write to the
 * connected CRM at all). A field can be manual-locked and CRM-sync-owned at the same time — those
 * are orthogonal questions.
 */
export const CRM_SYNC_OWNED_FIELDS = {
  contact: ["firstName", "lastName", "email", "phone", "title"],
  deal: ["name", "amount"],
} as const;

export type CrmSyncEntityType = keyof typeof CRM_SYNC_OWNED_FIELDS;

/** Narrows `patch` down to only the keys eligible for CRM push-back for this entity type. */
export function crmSyncOwnedPatch(
  entityType: CrmSyncEntityType,
  patch: Record<string, unknown>
): Record<string, unknown> {
  const owned: readonly string[] = CRM_SYNC_OWNED_FIELDS[entityType];
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(patch)) {
    if (owned.includes(key)) out[key] = patch[key];
  }
  return out;
}
