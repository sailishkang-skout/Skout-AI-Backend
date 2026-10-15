import { and, desc, eq } from "drizzle-orm";
import type { Db } from "@skout/db";
import { schema, scopedTo } from "@skout/db";
import { createLogger } from "@skout/observability";

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
 * Inserts or updates a conflict row in crm_conflicts.
 */
export async function recordCrmConflict(db: Db, input: RecordConflictInput): Promise<string> {
  const [row] = await db
    .insert(crmConflicts)
    .values({
      workspaceId: input.workspaceId,
      connectionId: input.connectionId,
      entityType: input.entityType,
      entityId: input.entityId,
      externalId: input.externalId,
      fieldName: input.fieldName,
      skoutValue: input.skoutValue ?? null,
      externalValue: input.externalValue ?? null,
      skoutUpdatedAt: input.skoutUpdatedAt ?? null,
      externalUpdatedAt: input.externalUpdatedAt ?? null,
      policy: input.policy ?? "manual_review",
      status: "pending",
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

export interface ListConflictsOptions {
  status?: string;
  entityType?: string;
  limit?: number;
  offset?: number;
}

export async function listCrmConflicts(db: Db, workspaceId: string, opts: ListConflictsOptions = {}) {
  const limit = opts.limit ?? 50;
  const offset = opts.offset ?? 0;

  const conditions = [eq(crmConflicts.workspaceId, workspaceId)];
  if (opts.status) {
    conditions.push(eq(crmConflicts.status, opts.status));
  }
  if (opts.entityType) {
    conditions.push(eq(crmConflicts.entityType, opts.entityType));
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

/**
 * Resolves a pending conflict and optionally applies the chosen value to the entity.
 */
export async function resolveCrmConflict(
  db: Db,
  workspaceId: string,
  conflictId: string,
  input: ResolveConflictInput
) {
  const [conflict] = await db
    .select()
    .from(crmConflicts)
    .where(scopedTo(crmConflicts, workspaceId, eq(crmConflicts.id, conflictId)))
    .limit(1);

  if (!conflict) {
    throw new Error(`Conflict ${conflictId} not found`);
  }

  let resolvedValue: string | null = null;
  let newStatus: string;

  if (input.choice === "skout") {
    newStatus = "resolved_skout";
    resolvedValue = conflict.skoutValue;
  } else if (input.choice === "external") {
    newStatus = "resolved_external";
    resolvedValue = conflict.externalValue;
  } else {
    newStatus = "resolved_custom";
    resolvedValue = input.customValue ?? null;
  }

  // Update conflict record
  await db
    .update(crmConflicts)
    .set({
      status: newStatus,
      resolvedValue,
      resolvedAt: new Date(),
      resolvedBy: input.resolvedBy ?? null,
      updatedAt: new Date(),
    })
    .where(eq(crmConflicts.id, conflict.id));

  // If external or custom value was chosen, apply it to the entity
  if (input.choice !== "skout" && resolvedValue != null) {
    if (conflict.entityType === "contact") {
      await db
        .update(contacts)
        .set({
          [conflict.fieldName]: resolvedValue,
          updatedAt: new Date(),
        })
        .where(eq(contacts.id, conflict.entityId));
    } else if (conflict.entityType === "deal") {
      await db
        .update(deals)
        .set({
          [conflict.fieldName]: resolvedValue,
          updatedAt: new Date(),
        })
        .where(eq(deals.id, conflict.entityId));
    }
  }

  try {
    await db.insert(auditLogs).values({
      workspaceId,
      actorType: input.resolvedBy ? "user" : "system",
      actorId: input.resolvedBy ?? null,
      action: `crm_conflict.${input.choice}_applied`,
      entityType: conflict.entityType,
      entityId: conflict.entityId,
      details: {
        conflictId: conflict.id,
        fieldName: conflict.fieldName,
        choice: input.choice,
        resolvedValue,
        skoutValue: conflict.skoutValue,
        externalValue: conflict.externalValue,
      },
    });
  } catch (auditErr) {
    log.warn("Failed recording audit log for conflict resolution", { auditErr, conflictId: conflict.id });
  }

  log.info("CRM conflict resolved", {
    conflictId: conflict.id,
    workspaceId,
    choice: input.choice,
    status: newStatus,
  });

  return {
    id: conflict.id,
    status: newStatus,
    resolvedValue,
    resolvedAt: new Date().toISOString(),
  };
}
