/**
 * Section 7.1 / Section 5 DOCUMENTED READ-MODEL EXCEPTION (Enterprise Completion Plan) - see
 * docs/adr/0003-read-model-exceptions.md (COPS-09 additions).
 *   - Tables touched directly: contacts, deals - read and update on manual/policy conflict resolution (owned by apps/crm)
 *   - Owning service: apps/crm (apps/api has direct Postgres access via the shared instance)
 *   - Reason: applies CRM conflict resolution decisions directly to canonical records within the same transaction.
 *   - Review date: 2026-10-16
 */
import { and, desc, eq, sql } from "drizzle-orm";
import type { Db } from "@skout/db";
import { schema, scopedTo } from "@skout/db";
import { createLogger } from "@skout/observability";
import { HttpError } from "@skout/auth";
import { CRM_SYNC_OWNED_FIELDS } from "@skout/shared";
import { queueCrmOutboundWriteIfOwned } from "./crm-outbound-sync.service.js";

const { crmConflicts, contacts, deals, auditLogs } = schema;
const log = createLogger("crm-conflict");

export type CrmConflictPolicy = "skout_wins" | "external_wins" | "most_recent" | "manual_review";

export const PROTECTED_SYSTEM_FIELDS = [
  "lifecycleStage",
  "commercialState",
  "healthScore",
  "accountStatus",
  "autoApproved",
  "riskScore",
  "evidenceCount",
  "deletedAt",
  "id",
  "workspaceId",
  "createdAt",
  "updatedAt",
] as const;

export function isProtectedField(fieldName: string): boolean {
  return (PROTECTED_SYSTEM_FIELDS as readonly string[]).includes(fieldName);
}

export interface EvaluateConflictParams {
  fieldName: string;
  skoutValue: unknown;
  externalValue: unknown;
  skoutUpdatedAt?: Date | null;
  externalUpdatedAt?: Date | null;
  policy: CrmConflictPolicy;
  isFieldProtected?: boolean;
}

export interface ConflictDecision {
  action: "apply_external" | "keep_skout" | "manual_review";
  reason: string;
}

/**
 * Evaluates field-level conflict policies:
 * - protected fields never overwritten
 * - skout_wins keeps internal Skout value
 * - external_wins applies incoming CRM value
 * - most_recent applies external only if external timestamp is strictly newer
 * - manual_review blocks overwrite and queues for side-by-side admin review
 */
export function evaluateFieldConflict(params: EvaluateConflictParams): ConflictDecision {
  if (params.isFieldProtected || isProtectedField(params.fieldName)) {
    return {
      action: "keep_skout",
      reason: `Field '${params.fieldName}' is a protected system-derived field`,
    };
  }

  const skoutStr = params.skoutValue == null ? "" : String(params.skoutValue).trim();
  const extStr = params.externalValue == null ? "" : String(params.externalValue).trim();

  // Values identical: no conflict
  if (skoutStr === extStr) {
    return {
      action: "keep_skout",
      reason: "Values are identical",
    };
  }

  // Skout has no value: external fills it safely
  if (skoutStr === "") {
    return {
      action: "apply_external",
      reason: "Skout value is empty; applying incoming value",
    };
  }

  // External has no value: keep existing Skout value
  if (extStr === "") {
    return {
      action: "keep_skout",
      reason: "External value is empty; keeping existing Skout value",
    };
  }

  switch (params.policy) {
    case "skout_wins":
      return {
        action: "keep_skout",
        reason: "Policy is skout_wins",
      };

    case "external_wins":
      return {
        action: "apply_external",
        reason: "Policy is external_wins",
      };

    case "most_recent": {
      const skoutTime = params.skoutUpdatedAt ? new Date(params.skoutUpdatedAt).getTime() : 0;
      const extTime = params.externalUpdatedAt ? new Date(params.externalUpdatedAt).getTime() : 0;

      if (extTime > skoutTime) {
        return {
          action: "apply_external",
          reason: `External edit is newer (${new Date(extTime).toISOString()} > ${new Date(skoutTime).toISOString()})`,
        };
      } else {
        return {
          action: "keep_skout",
          reason: `Skout edit is newer or equal (${new Date(skoutTime).toISOString()} >= ${new Date(extTime).toISOString()})`,
        };
      }
    }

    case "manual_review":
    default:
      return {
        action: "manual_review",
        reason: "Policy is manual_review and values differ",
      };
  }
}

export interface RecordConflictInput {
  workspaceId: string;
  connectionId: string;
  entityType: "contact" | "deal";
  entityId: string;
  externalId: string;
  fieldName: string;
  skoutValue?: string | null;
  externalValue?: string | null;
  skoutUpdatedAt?: Date | null;
  externalUpdatedAt?: Date | null;
  policy?: CrmConflictPolicy;
}

/**
 * Queues a conflict for review. A field has at most one pending conflict (partial unique index
 * crm_conflicts_one_pending_uq), so a repeated poll, webhook or replay refreshes the values on the
 * open conflict instead of queueing a duplicate.
 */
export async function recordCrmConflict(db: Db, input: RecordConflictInput): Promise<string> {
  const values = {
    skoutValue: input.skoutValue ?? null,
    externalValue: input.externalValue ?? null,
    skoutUpdatedAt: input.skoutUpdatedAt ?? null,
    externalUpdatedAt: input.externalUpdatedAt ?? null,
    policy: input.policy ?? "manual_review",
  };
  const [row] = await db
    .insert(crmConflicts)
    .values({
      workspaceId: input.workspaceId,
      connectionId: input.connectionId,
      entityType: input.entityType,
      entityId: input.entityId,
      externalId: input.externalId,
      fieldName: input.fieldName,
      ...values,
      status: "pending",
    })
    .onConflictDoUpdate({
      target: [crmConflicts.connectionId, crmConflicts.entityType, crmConflicts.entityId, crmConflicts.fieldName],
      targetWhere: sql`status = 'pending'`,
      set: { ...values, updatedAt: new Date() },
    })
    .returning({ id: crmConflicts.id });

  log.info("CRM conflict recorded for manual review", {
    conflictId: row?.id,
    workspaceId: input.workspaceId,
    entityType: input.entityType,
    fieldName: input.fieldName,
  });

  return row?.id ?? "";
}

/**
 * Fields of one record with a pending conflict. Neither direction may overwrite them until an
 * admin resolves the conflict.
 */
export async function getPendingConflictFields(
  db: Db,
  workspaceId: string,
  connectionId: string,
  entityType: "contact" | "deal",
  entityId: string
): Promise<Set<string>> {
  const rows = await db
    .select({ fieldName: crmConflicts.fieldName })
    .from(crmConflicts)
    .where(
      scopedTo(
        crmConflicts,
        workspaceId,
        eq(crmConflicts.connectionId, connectionId),
        eq(crmConflicts.entityType, entityType),
        eq(crmConflicts.entityId, entityId),
        eq(crmConflicts.status, "pending")
      )
    );
  return new Set(rows.map((r) => r.fieldName));
}

export interface ListConflictsOptions {
  status?: string;
  entityType?: string;
  /** One record's conflicts (its sync history in the conflict queue). */
  entityId?: string;
  limit?: number;
  offset?: number;
}

export async function listCrmConflicts(db: Db, workspaceId: string, opts: ListConflictsOptions = {}) {
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
  const offset = Math.max(opts.offset ?? 0, 0);

  const conditions = [eq(crmConflicts.workspaceId, workspaceId)];
  if (opts.status) {
    conditions.push(eq(crmConflicts.status, opts.status));
  }
  if (opts.entityType) {
    conditions.push(eq(crmConflicts.entityType, opts.entityType));
  }
  if (opts.entityId) {
    conditions.push(eq(crmConflicts.entityId, opts.entityId));
  }

  const rows = await db
    .select()
    .from(crmConflicts)
    .where(and(...conditions))
    .orderBy(desc(crmConflicts.createdAt))
    .limit(limit)
    .offset(offset);

  return rows;
}

export interface ResolveConflictInput {
  choice: "skout" | "external" | "custom";
  customValue?: string;
  resolvedBy?: string;
}

/** Turns the stored text value into what the column holds; throws 422 when it cannot. */
function columnValue(
  entityType: "contact" | "deal",
  table: typeof contacts | typeof deals,
  fieldName: string,
  value: string
): unknown {
  const column = (table as unknown as Record<string, { dataType?: string; columnType?: string } | undefined>)[fieldName];
  const owned: readonly string[] = CRM_SYNC_OWNED_FIELDS[entityType];
  if (!owned.includes(fieldName) || !column || typeof column !== "object" || !column.dataType || isProtectedField(fieldName)) {
    throw new HttpError(`Field '${fieldName}' cannot be set from a conflict resolution`, 422);
  }
  switch (column.dataType) {
    case "string":
      // Drizzle reads numeric and uuid columns as strings; Postgres still checks them.
      if (column.columnType === "PgNumeric" && (value.trim() === "" || !Number.isFinite(Number(value)))) {
        throw new HttpError(`'${value}' is not a number for ${fieldName}`, 422);
      }
      if (column.columnType === "PgUUID" && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) {
        throw new HttpError(`'${value}' is not an id for ${fieldName}`, 422);
      }
      return value;
    case "number": {
      const n = Number(value);
      if (value.trim() === "" || !Number.isFinite(n)) throw new HttpError(`'${value}' is not a number for ${fieldName}`, 422);
      return n;
    }
    case "boolean":
      if (value !== "true" && value !== "false") throw new HttpError(`'${value}' is not true or false for ${fieldName}`, 422);
      return value === "true";
    case "date": {
      const d = new Date(value);
      if (Number.isNaN(d.getTime())) throw new HttpError(`'${value}' is not a date for ${fieldName}`, 422);
      return d;
    }
    default:
      throw new HttpError(`Field '${fieldName}' cannot be set from a conflict resolution`, 422);
  }
}

/**
 * Resolves a pending conflict in one transaction: the chosen value is written to the Skout record,
 * the conflict is closed only if it is still pending (a second resolve gets 409), and the decision
 * is audited. When the decided value is not the provider's, it is queued for push-back after the
 * commit so both sides end up equal.
 */
export async function resolveCrmConflict(
  db: Db,
  workspaceId: string,
  conflictId: string,
  input: ResolveConflictInput
) {
  if (input.choice === "custom" && (input.customValue == null || input.customValue.trim() === "")) {
    throw new HttpError("customValue is required for a custom resolution", 422);
  }
  const now = new Date();

  const result = await db.transaction(async (tx) => {
    const [conflict] = await tx
      .select()
      .from(crmConflicts)
      .where(scopedTo(crmConflicts, workspaceId, eq(crmConflicts.id, conflictId)))
      .limit(1);
    if (!conflict) throw new HttpError(`Conflict ${conflictId} not found`, 404);
    if (conflict.status !== "pending") throw new HttpError(`Conflict ${conflictId} is already resolved (${conflict.status})`, 409);

    const status =
      input.choice === "skout" ? "resolved_skout" : input.choice === "external" ? "resolved_external" : "resolved_custom";
    const resolvedValue =
      input.choice === "skout" ? conflict.skoutValue : input.choice === "external" ? conflict.externalValue : input.customValue!;

    const table = conflict.entityType === "contact" ? contacts : conflict.entityType === "deal" ? deals : null;
    if (!table) throw new HttpError(`Unsupported entity type ${conflict.entityType}`, 422);
    if (input.choice !== "skout" && resolvedValue != null) {
      const value = columnValue(conflict.entityType as "contact" | "deal", table, conflict.fieldName, resolvedValue);
      await tx
        .update(table)
        .set({ [conflict.fieldName]: value, updatedAt: now })
        .where(scopedTo(table, workspaceId, eq(table.id, conflict.entityId)));
    }

    // Conditional on still pending: a concurrent resolve loses here and its transaction rolls back.
    const closed = await tx
      .update(crmConflicts)
      .set({ status, resolvedValue, resolvedAt: now, resolvedBy: input.resolvedBy ?? null, updatedAt: now })
      .where(and(eq(crmConflicts.id, conflict.id), eq(crmConflicts.status, "pending")))
      .returning({ id: crmConflicts.id });
    if (closed.length === 0) throw new HttpError(`Conflict ${conflictId} is already resolved`, 409);

    await tx.insert(auditLogs).values({
      workspaceId,
      actorType: input.resolvedBy ? "user" : "system",
      actorId: input.resolvedBy ?? null,
      action: `crm_conflict.${input.choice}_applied`,
      entityType: conflict.entityType,
      entityId: conflict.entityId,
      beforeState: { skoutValue: conflict.skoutValue, externalValue: conflict.externalValue },
      afterState: { conflictId: conflict.id, fieldName: conflict.fieldName, choice: input.choice, resolvedValue },
      reason: `CRM conflict resolved via ${input.choice}`,
    });

    return { conflict, status, resolvedValue };
  });

  // Skout's or a custom value differs from the provider's: push it back to the provider.
  if (
    input.choice !== "external" &&
    result.resolvedValue != null &&
    result.resolvedValue !== result.conflict.externalValue
  ) {
    await queueCrmOutboundWriteIfOwned(
      db,
      workspaceId,
      result.conflict.entityType as "contact" | "deal",
      result.conflict.entityId,
      { [result.conflict.fieldName]: result.resolvedValue },
      now
    );
  }

  log.info("CRM conflict resolved", { conflictId, workspaceId, choice: input.choice, status: result.status });

  return {
    id: result.conflict.id,
    status: result.status,
    resolvedValue: result.resolvedValue,
    resolvedAt: now.toISOString(),
  };
}
