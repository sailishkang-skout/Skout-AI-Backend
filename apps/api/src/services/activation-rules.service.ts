import { and, count, eq, isNull } from "drizzle-orm";
import type { Db } from "@skout/db";
import { schema } from "@skout/db";
import { HttpError } from "../utils/http.js";

const { activationRules, activationRuleRuns } = schema;

/** R13.4 — hard cap on active rules per workspace; a deliberate guardrail, not a UX limit. */
export const MAX_ACTIVE_RULES_PER_WORKSPACE = 5;

export type TargetAction = "activate" | "add_to_list" | "enroll_sequence";

export interface ActivationRuleDto {
  id: string;
  workspaceId: string;
  name: string;
  scoreThreshold: number;
  signalType: string | null;
  targetAction: TargetAction;
  targetId: string | null;
  enabled: boolean;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ActivationRuleCreateInput {
  name: string;
  scoreThreshold: number;
  signalType?: string;
  targetAction: TargetAction;
  targetId?: string;
}

function toDto(row: typeof activationRules.$inferSelect): ActivationRuleDto {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    name: row.name,
    scoreThreshold: row.scoreThreshold,
    signalType: row.signalType,
    targetAction: row.targetAction as TargetAction,
    targetId: row.targetId,
    enabled: row.enabled,
    createdBy: row.createdBy,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export async function listActivationRules(db: Db, workspaceId: string): Promise<ActivationRuleDto[]> {
  const rows = await db
    .select()
    .from(activationRules)
    .where(and(eq(activationRules.workspaceId, workspaceId), isNull(activationRules.deletedAt)));
  return rows.map(toDto);
}

export async function createActivationRule(
  db: Db,
  workspaceId: string,
  createdBy: string | undefined,
  input: ActivationRuleCreateInput
): Promise<ActivationRuleDto> {
  if ((input.targetAction === "add_to_list" || input.targetAction === "enroll_sequence") && !input.targetId) {
    throw new HttpError(`targetId is required for targetAction=${input.targetAction}`, 400);
  }

  const [{ activeCount }] = await db
    .select({ activeCount: count() })
    .from(activationRules)
    .where(
      and(eq(activationRules.workspaceId, workspaceId), eq(activationRules.enabled, true), isNull(activationRules.deletedAt))
    );
  if (Number(activeCount) >= MAX_ACTIVE_RULES_PER_WORKSPACE) {
    throw new HttpError(
      `Workspace already has ${MAX_ACTIVE_RULES_PER_WORKSPACE} active rules — the limit exists to keep automation reviewable. Disable one before adding another.`,
      422
    );
  }

  const [row] = await db
    .insert(activationRules)
    .values({
      workspaceId,
      name: input.name,
      scoreThreshold: input.scoreThreshold,
      signalType: input.signalType,
      targetAction: input.targetAction,
      targetId: input.targetId,
      createdBy,
    })
    .returning();
  return toDto(row);
}

export async function setActivationRuleEnabled(
  db: Db,
  workspaceId: string,
  id: string,
  enabled: boolean
): Promise<ActivationRuleDto | null> {
  if (enabled) {
    const [{ activeCount }] = await db
      .select({ activeCount: count() })
      .from(activationRules)
      .where(
        and(
          eq(activationRules.workspaceId, workspaceId),
          eq(activationRules.enabled, true),
          isNull(activationRules.deletedAt)
        )
      );
    if (Number(activeCount) >= MAX_ACTIVE_RULES_PER_WORKSPACE) {
      throw new HttpError(`Workspace already has ${MAX_ACTIVE_RULES_PER_WORKSPACE} active rules.`, 422);
    }
  }
  const [row] = await db
    .update(activationRules)
    .set({ enabled, updatedAt: new Date() })
    .where(and(eq(activationRules.id, id), eq(activationRules.workspaceId, workspaceId)))
    .returning();
  return row ? toDto(row) : null;
}

export async function softDeleteActivationRule(db: Db, workspaceId: string, id: string): Promise<boolean> {
  const [row] = await db
    .update(activationRules)
    .set({ deletedAt: new Date(), enabled: false, updatedAt: new Date() })
    .where(and(eq(activationRules.id, id), eq(activationRules.workspaceId, workspaceId)))
    .returning();
  return Boolean(row);
}

/**
 * R13.4 — decide which enabled rules match a prospect's score/signal, WITHOUT executing the
 * target action. Callers (e.g. the scoring pipeline, once wired) are responsible for actually
 * calling ListService.addMember / SequenceService.enroll / EnrichmentService.activate for each
 * matched rule and then calling `recordRuleRun` below to log it — kept as two steps so a rule
 * match is never silently un-auditable, and so this module doesn't reach into three unrelated
 * services' constructors just to decide a match.
 */
export async function matchActivationRules(
  db: Db,
  workspaceId: string,
  prospectScore: number,
  activeSignalTypes: string[]
): Promise<ActivationRuleDto[]> {
  const rules = await listActivationRules(db, workspaceId);
  return rules.filter((rule) => {
    if (!rule.enabled) return false;
    if (prospectScore < rule.scoreThreshold) return false;
    if (rule.signalType && !activeSignalTypes.includes(rule.signalType)) return false;
    return true;
  });
}

/** Log a rule firing (R13.4 AC: "every auto-action a rule takes is logged and reversible"). */
export async function recordRuleRun(
  db: Db,
  workspaceId: string,
  ruleId: string,
  prospectId: string,
  actionTaken: string
): Promise<void> {
  await db.insert(activationRuleRuns).values({ workspaceId, ruleId, prospectId, actionTaken });
}

/** Mark a logged run as manually reversed (unenroll / remove from list), per the AC above. */
export async function reverseRuleRun(db: Db, workspaceId: string, runId: string): Promise<boolean> {
  const [row] = await db
    .update(activationRuleRuns)
    .set({ reversedAt: new Date() })
    .where(and(eq(activationRuleRuns.id, runId), eq(activationRuleRuns.workspaceId, workspaceId)))
    .returning();
  return Boolean(row);
}

export async function listRuleRuns(db: Db, workspaceId: string, ruleId?: string) {
  const conditions = [eq(activationRuleRuns.workspaceId, workspaceId)];
  if (ruleId) conditions.push(eq(activationRuleRuns.ruleId, ruleId));
  return db
    .select()
    .from(activationRuleRuns)
    .where(and(...conditions));
}
