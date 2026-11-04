/**
 * Section 7.1 / Section 5 DOCUMENTED READ-MODEL EXCEPTION (Enterprise Completion Plan) - see
 * docs/adr/0003-read-model-exceptions.md (COPS-10 additions).
 *   - Tables touched directly: contacts, deals (update of CRM-sync-owned fields of one record)
 *   - Owning service: apps/crm (apps/api has direct Postgres access via the shared instance)
 *   - Reason: the workflow "update allowed fields" action, with the same field allowlist and type
 *     checks as a COPS-09 conflict resolution.
 *   - Review date: 2026-10-19
 */
import { and, eq } from "drizzle-orm";
import { schema, type Db } from "@skout/db";
import { HttpError } from "../../utils/http.js";
import { columnValue } from "../crm-conflict.service.js";
import { queueCrmOutboundWriteIfOwned } from "../crm-outbound-sync.service.js";
import type { NodeHandler } from "./types.js";
import { withStepEffect } from "./step-effect.js";

const { contacts, deals } = schema;

/**
 * COPS-10 "update allowed fields" (Bible p.68). Config: { entityType: "contact" | "deal";
 * entityId?; fields: { [field]: value } }. Only the fields the CRM sync owns can be set, each
 * cast to its column type (422 otherwise); protected system fields never. entityId defaults to
 * the run's subject when it is that kind of record. The change is pushed to a connected CRM
 * like any Skout edit. Runs once per step.
 */
export const updateFieldsActionNodeHandler: NodeHandler = async (ctx) => {
  const config = ctx.node.config as { entityType?: string; entityId?: string; fields?: Record<string, unknown> };
  const entityType = config.entityType;
  if (entityType !== "contact" && entityType !== "deal") throw new HttpError('Update fields needs entityType "contact" or "deal"', 422);
  const entityId = config.entityId || (ctx.subject?.type === entityType ? ctx.subject.id : undefined);
  if (!entityId && !ctx.isSimulation) throw new HttpError("Update fields needs a record id", 422);
  const table = entityType === "contact" ? contacts : deals;
  const entries = Object.entries(config.fields ?? {});
  if (!entries.length) throw new HttpError("Update fields needs at least one field", 422);
  const patch = Object.fromEntries(entries.map(([field, value]) => [field, columnValue(entityType, table, field, String(value ?? ""))]));

  if (ctx.isSimulation) return { output: { simulated: true, entityType, entityId: entityId ?? null, patch } };
  if (!entityId) throw new HttpError("Update fields needs a record id", 422);

  const output = await withStepEffect(ctx, "update_fields", async (tx) => {
    const updated = await tx
      .update(table)
      .set({ ...patch, updatedAt: new Date() } as never)
      .where(and(eq(table.id, entityId), eq(table.workspaceId, ctx.workspaceId)))
      .returning({ id: table.id });
    if (!updated.length) throw new HttpError(`The ${entityType} is not in this workspace`, 422);
    await queueCrmOutboundWriteIfOwned(tx as unknown as Db, ctx.workspaceId, entityType, entityId, patch);
    return { entityType, entityId, fields: Object.keys(patch) };
  });
  return { output };
};
