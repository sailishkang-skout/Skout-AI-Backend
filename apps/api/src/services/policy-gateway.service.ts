import { desc, eq } from "drizzle-orm";
import type { Db } from "@skout/db";
import { schema, scopedTo } from "@skout/db";
import { HttpError } from "../utils/http.js";
import { incrJourneyMetric } from "./journey-metrics.js";

const { automationPolicies, policyDecisions } = schema;

/** D7 four modes — distinct from sequence Mode A/B/C. */
export const AUTOMATION_MODES = ["ask", "auto", "draft", "approve"] as const;
export type AutomationMode = (typeof AUTOMATION_MODES)[number];

export const DEFAULT_ACTION_MODES: Record<string, AutomationMode> = {
  "dexter.chat_write": "ask",
  "dexter.enroll_list": "approve",
  "dexter.plan_invoke": "approve",
  "sequence.activate": "ask",
  "sequence.enroll": "auto",
  "activation_rule.fire": "draft",
  "ai.draft_auto_approve": "draft",
  "linkedin.voice_confirm": "approve",
};

export function isAutomationMode(v: string): v is AutomationMode {
  return (AUTOMATION_MODES as readonly string[]).includes(v);
}

export async function getActionMode(
  db: Db,
  workspaceId: string,
  actionKey: string
): Promise<AutomationMode> {
  const [row] = await db
    .select()
    .from(automationPolicies)
    .where(scopedTo(automationPolicies, workspaceId, eq(automationPolicies.actionKey, actionKey)))
    .limit(1);
  if (row && isAutomationMode(row.mode)) return row.mode;
  return DEFAULT_ACTION_MODES[actionKey] ?? "ask";
}

export async function upsertActionMode(
  db: Db,
  workspaceId: string,
  actionKey: string,
  mode: AutomationMode,
  userId?: string
) {
  const [row] = await db
    .insert(automationPolicies)
    .values({
      workspaceId,
      actionKey,
      mode,
      updatedBy: userId,
      updatedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: [automationPolicies.workspaceId, automationPolicies.actionKey],
      set: { mode, updatedBy: userId, updatedAt: new Date() },
    })
    .returning();
  return row!;
}

export async function listPolicies(db: Db, workspaceId: string) {
  const rows = await db
    .select()
    .from(automationPolicies)
    .where(scopedTo(automationPolicies, workspaceId));
  const keys = new Set(rows.map((r) => r.actionKey));
  const defaults = Object.entries(DEFAULT_ACTION_MODES)
    .filter(([k]) => !keys.has(k))
    .map(([actionKey, mode]) => ({
      actionKey,
      mode,
      source: "default" as const,
    }));
  return {
    policies: rows.map((r) => ({
      id: r.id,
      actionKey: r.actionKey,
      mode: r.mode,
      source: "workspace" as const,
      updatedAt: r.updatedAt.toISOString(),
    })),
    defaults,
  };
}

export type ClassifyResult = {
  actionKey: string;
  mode: AutomationMode;
  outcome: "allowed" | "denied" | "staged" | "proposed";
  decisionId: string;
};

/**
 * Classify an action and persist an audit row. Call before side effects.
 * - auto → allowed (caller may execute)
 * - ask → proposed (caller must not execute)
 * - draft → staged (caller should create a draft / pending artifact)
 * - approve → denied until a prior approved decision exists (caller passes priorApproval=true)
 */
export async function classifyAndRecord(
  db: Db,
  opts: {
    workspaceId: string;
    actionKey: string;
    actorUserId?: string;
    entityType?: string;
    entityId?: string;
    detail?: Record<string, unknown>;
    /** When mode is approve, set true after human approval to allow invoke. */
    priorApproval?: boolean;
  }
): Promise<ClassifyResult> {
  const mode = await getActionMode(db, opts.workspaceId, opts.actionKey);
  let outcome: ClassifyResult["outcome"] = "proposed";
  if (mode === "auto") outcome = "allowed";
  else if (mode === "draft") outcome = "staged";
  else if (mode === "approve") outcome = opts.priorApproval ? "allowed" : "denied";
  else outcome = "proposed";

  const [decision] = await db
    .insert(policyDecisions)
    .values({
      workspaceId: opts.workspaceId,
      actionKey: opts.actionKey,
      mode,
      outcome,
      actorUserId: opts.actorUserId,
      entityType: opts.entityType,
      entityId: opts.entityId,
      detail: opts.detail ?? {},
    })
    .returning();

  incrJourneyMetric("policyClassify");

  return {
    actionKey: opts.actionKey,
    mode,
    outcome,
    decisionId: decision!.id,
  };
}

export async function assertAllowed(
  db: Db,
  opts: Parameters<typeof classifyAndRecord>[1]
): Promise<ClassifyResult> {
  const result = await classifyAndRecord(db, opts);
  if (result.outcome === "denied") {
    throw new HttpError(
      `Policy Gateway denied action ${opts.actionKey} (mode=${result.mode}; needs approval)`,
      403,
      { policy: result }
    );
  }
  if (result.outcome === "proposed") {
    throw new HttpError(
      `Policy Gateway requires Ask confirmation for ${opts.actionKey}`,
      409,
      { policy: result }
    );
  }
  return result;
}

export async function listDecisions(db: Db, workspaceId: string, limit = 50) {
  return db
    .select()
    .from(policyDecisions)
    .where(scopedTo(policyDecisions, workspaceId))
    .orderBy(desc(policyDecisions.createdAt))
    .limit(limit);
}
