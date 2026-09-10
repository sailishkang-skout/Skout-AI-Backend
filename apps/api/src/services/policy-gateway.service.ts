import { and, desc, eq, inArray } from "drizzle-orm";
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

/** §8.1 onboarding "autonomy" step's three choices, matching the frontend wizard's copy. */
export const ONBOARDING_AUTONOMY_MODES = ["manual", "assisted", "autonomous"] as const;
export type OnboardingAutonomyMode = (typeof ONBOARDING_AUTONOMY_MODES)[number];

/**
 * SS-09 — the onboarding "autonomy" question was captured and stored on `workspace_icp.config`
 * but never actually reached the Policy Gateway that gates real automated actions
 * (`automation_policies` / `assertAllowed`), so the choice had no server-side effect. This turns
 * it into real `automation_policies` rows across every known action key:
 *
 *  - "manual" ("you approve every send and action") — only overrides the one action key whose
 *    system default is already "auto" (`sequence.enroll`), forcing it to "ask" too. Every other
 *    key's default is already ask/draft/approve (review required), so it's left alone rather
 *    than flattened — no reason to make an approve-gated action merely ask-gated.
 *  - "assisted" ("drafts and acts on routine steps, flags anything new") — this is exactly what
 *    DEFAULT_ACTION_MODES already encodes (routine sequence.enroll auto, riskier actions
 *    ask/approve/draft), so it clears any prior override back to those system defaults rather
 *    than writing anything.
 *  - "autonomous" ("sends and acts... without a per-item review") — forces every action key to
 *    "auto", including the ones that otherwise require approval.
 *
 * Called once, when onboarding actually completes (`onboarding.completedAt` set) — not on every
 * incremental wizard-step save.
 */
export async function applyOnboardingAutonomyMode(
  db: Db,
  workspaceId: string,
  autonomyMode: OnboardingAutonomyMode,
  userId?: string
): Promise<void> {
  const actionKeys = Object.keys(DEFAULT_ACTION_MODES);

  // Reset first, every time — switching autonomy levels must be able to revert a previous
  // level's override (e.g. autonomous's "auto" on dexter.plan_invoke), not just layer a new
  // one on top of whatever rows already exist.
  await db
    .delete(automationPolicies)
    .where(and(eq(automationPolicies.workspaceId, workspaceId), inArray(automationPolicies.actionKey, actionKeys)));

  if (autonomyMode === "assisted") return; // system defaults, no override rows needed

  const targetMode: AutomationMode = autonomyMode === "autonomous" ? "auto" : "ask";
  for (const actionKey of actionKeys) {
    if (autonomyMode === "manual" && DEFAULT_ACTION_MODES[actionKey] !== "auto") continue;
    await upsertActionMode(db, workspaceId, actionKey, targetMode, userId);
  }
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
