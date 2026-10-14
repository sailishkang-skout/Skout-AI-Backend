import { and, eq, inArray } from "drizzle-orm";
import { schema, type Db } from "@skout/db";
import { writeCopsAudit } from "./cops-platform.service.js";
import { CommercialError, type CommercialContext } from "./cops-commercial.service.js";

/**
 * Section 7.1 / Section 5 DOCUMENTED READ-MODEL EXCEPTION (Enterprise Completion Plan) - see
 * docs/adr/0003-read-model-exceptions.md (COPS-08 additions).
 *   - Tables touched directly: companies - read only, to check the account belongs to the
 *     workspace before its custom field values are written (owned by apps/crm)
 *   - Owning service: apps/crm (apps/api has direct Postgres access via the shared instance)
 */

/**
 * COPS-08 account details that pick the contract template (Bible p.32: region, segment, legal
 * entity). Aditya, 2026-10-14: reuse the existing custom fields (migration 0104,
 * `custom_field_definitions` / `custom_field_values`) instead of adding columns. The three
 * definitions are created per workspace on first use, as object type "account".
 */
const { customFieldDefinitions, customFieldValues, companies } = schema;

export const ACCOUNT_CONTRACT_FIELDS = [
  { key: "region", label: "Region" },
  { key: "segment", label: "Segment" },
  { key: "legal_entity", label: "Legal entity" },
] as const;
export type AccountContractFieldKey = (typeof ACCOUNT_CONTRACT_FIELDS)[number]["key"];
export type AccountContractFields = Partial<Record<AccountContractFieldKey, string>>;
const KEYS = ACCOUNT_CONTRACT_FIELDS.map((f) => f.key);
const OBJECT_TYPE = "account";

type Reader = Pick<Db, "select">;

async function definitions(db: Reader, workspaceId: string) {
  return db
    .select({ id: customFieldDefinitions.id, key: customFieldDefinitions.key })
    .from(customFieldDefinitions)
    .where(and(eq(customFieldDefinitions.workspaceId, workspaceId), eq(customFieldDefinitions.objectType, OBJECT_TYPE), inArray(customFieldDefinitions.key, KEYS)));
}

/** The account's region, segment and legal entity; a field with no value is left out. */
export async function getAccountContractFields(db: Reader, workspaceId: string, accountId: string): Promise<AccountContractFields> {
  const rows = await db
    .select({ key: customFieldDefinitions.key, value: customFieldValues.value })
    .from(customFieldValues)
    .innerJoin(customFieldDefinitions, eq(customFieldDefinitions.id, customFieldValues.definitionId))
    .where(
      and(
        eq(customFieldValues.workspaceId, workspaceId),
        eq(customFieldValues.objectId, accountId),
        eq(customFieldDefinitions.objectType, OBJECT_TYPE),
        inArray(customFieldDefinitions.key, KEYS)
      )
    );
  const out: AccountContractFields = {};
  for (const r of rows) if (typeof r.value === "string" && r.value.trim()) out[r.key as AccountContractFieldKey] = r.value;
  return out;
}

/** Sets or clears the fields given (an empty string clears one); the others are unchanged. Audited. */
export async function setAccountContractFields(db: Db, ctx: CommercialContext, accountId: string, input: AccountContractFields): Promise<AccountContractFields> {
  const [account] = await db.select({ id: companies.id }).from(companies).where(and(eq(companies.id, accountId), eq(companies.workspaceId, ctx.workspaceId))).limit(1);
  if (!account) throw new CommercialError("NOT_FOUND", "Account not found");
  const before = await getAccountContractFields(db, ctx.workspaceId, accountId);
  await db.transaction(async (tx) => {
    await tx
      .insert(customFieldDefinitions)
      .values(ACCOUNT_CONTRACT_FIELDS.map((f) => ({ workspaceId: ctx.workspaceId, objectType: OBJECT_TYPE, key: f.key, label: f.label, fieldType: "text" })))
      .onConflictDoNothing();
    const defs = await definitions(tx as unknown as Reader, ctx.workspaceId);
    for (const def of defs) {
      if (!(def.key in input)) continue;
      const value = (input[def.key as AccountContractFieldKey] ?? "").trim();
      if (value) {
        await tx
          .insert(customFieldValues)
          .values({ workspaceId: ctx.workspaceId, definitionId: def.id, objectId: accountId, value, updatedAt: new Date() })
          .onConflictDoUpdate({ target: [customFieldValues.workspaceId, customFieldValues.definitionId, customFieldValues.objectId], set: { value, updatedAt: new Date() } });
      } else {
        await tx.delete(customFieldValues).where(and(eq(customFieldValues.workspaceId, ctx.workspaceId), eq(customFieldValues.definitionId, def.id), eq(customFieldValues.objectId, accountId)));
      }
    }
  });
  const after = await getAccountContractFields(db, ctx.workspaceId, accountId);
  await writeCopsAudit(db, {
    tenantId: ctx.workspaceId,
    actor: { type: "user", id: ctx.userId },
    entityType: "account",
    entityId: accountId,
    action: "account.contract_fields_updated",
    before,
    after,
    correlationId: ctx.requestId,
    sourceChannel: "api",
  });
  return after;
}
