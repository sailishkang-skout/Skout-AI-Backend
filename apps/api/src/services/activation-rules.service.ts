import { and, count, eq, isNull } from "drizzle-orm";
import type { Db } from "@skout/db";
import { schema } from "@skout/db";
import { getProspectById, type OpenSearchConfig } from "@skout/opensearch";
import { createLogger } from "@skout/observability";
import { HttpError } from "../utils/http.js";
import type { Env } from "../config/env.js";
import { openSearchConfigFromEnv } from "../lib/opensearch-config.js";
import { snapshotFromCorpusDoc } from "../utils/verified-email.js";
import { buildEnrichmentService, type ProspectSnapshot } from "./enrichment/index.js";
import { buildListService } from "./list.service.js";
import { buildSequenceService } from "./sequence.service.js";

const { activationRules, activationRuleRuns, prospectActivations } = schema;
const log = createLogger("activation-rules.service");

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

/**
 * Reverse a logged run — R13.4 AC3 names "unenroll" / "remove from list" explicitly, so those two
 * target actions actually undo the effect (sequence.unenroll / list removeMember) before the run
 * is marked reversed. "activate" has no defined undo in the AC (there's no "deactivate" concept
 * in this codebase) — those runs are marked reversed for bookkeeping but `undone` comes back
 * false so callers can be honest about it rather than implying something was rolled back.
 *
 * If the undo action itself fails, the run is NOT marked reversed — better to leave it
 * re-triable than to record a reversal that didn't actually happen.
 */
export async function reverseRuleRun(
  db: Db,
  config: Env,
  workspaceId: string,
  runId: string
): Promise<{ reversed: boolean; undone: boolean } | null> {
  const [run] = await db
    .select()
    .from(activationRuleRuns)
    .where(and(eq(activationRuleRuns.id, runId), eq(activationRuleRuns.workspaceId, workspaceId)))
    .limit(1);
  if (!run) return null;
  if (run.reversedAt) return { reversed: true, undone: false };

  const [rule] = await db.select().from(activationRules).where(eq(activationRules.id, run.ruleId)).limit(1);

  let undone = false;
  if (rule?.targetId) {
    if (rule.targetAction === "enroll_sequence") {
      const seqSvc = buildSequenceService(db);
      const result = seqSvc ? await seqSvc.unenroll(workspaceId, rule.targetId, run.prospectId) : null;
      undone = Boolean(result);
    } else if (rule.targetAction === "add_to_list") {
      const listSvc = buildListService(db, openSearchConfigFromEnv(config));
      undone = listSvc ? await listSvc.removeMember(workspaceId, rule.targetId, run.prospectId) : false;
    }
  }

  const [row] = await db
    .update(activationRuleRuns)
    .set({ reversedAt: new Date() })
    .where(and(eq(activationRuleRuns.id, runId), eq(activationRuleRuns.workspaceId, workspaceId)))
    .returning();
  return row ? { reversed: true, undone } : null;
}

export async function listRuleRuns(db: Db, workspaceId: string, ruleId?: string) {
  const conditions = [eq(activationRuleRuns.workspaceId, workspaceId)];
  if (ruleId) conditions.push(eq(activationRuleRuns.ruleId, ruleId));
  return db
    .select()
    .from(activationRuleRuns)
    .where(and(...conditions));
}

/**
 * Best-effort snapshot for the "activate" target action, which needs a full ProspectSnapshot
 * (companyDomain in particular). Prefers the workspace's already-activated snapshot (the common
 * case — a rule fires from the list-score pipeline, and list members are activated already), then
 * falls back to the OpenSearch corpus doc, then a minimal placeholder so activation never throws
 * for lack of enrichment data alone.
 */
async function buildSnapshotForActivate(
  db: Db,
  osCfg: OpenSearchConfig | null,
  workspaceId: string,
  prospectId: string
): Promise<ProspectSnapshot> {
  const [existing] = await db
    .select()
    .from(prospectActivations)
    .where(and(eq(prospectActivations.workspaceId, workspaceId), eq(prospectActivations.prospectId, prospectId)))
    .limit(1);
  if (existing?.snapshot && typeof existing.snapshot === "object") {
    const snap = existing.snapshot as Record<string, unknown>;
    return {
      prospectId,
      companyId: existing.companyId,
      companyDomain: typeof snap.companyDomain === "string" ? snap.companyDomain : existing.companyId,
      fullName: typeof snap.fullName === "string" ? snap.fullName : undefined,
      email: typeof snap.email === "string" ? snap.email : undefined,
      title: typeof snap.title === "string" ? snap.title : undefined,
      companyName: typeof snap.companyName === "string" ? snap.companyName : undefined,
      linkedinUrl: typeof snap.linkedinUrl === "string" ? snap.linkedinUrl : undefined,
    };
  }
  if (osCfg) {
    const doc = await getProspectById(osCfg, prospectId).catch(() => null);
    if (doc) {
      const snap = snapshotFromCorpusDoc(doc) as unknown as Record<string, unknown>;
      return {
        prospectId,
        companyDomain: typeof snap.companyDomain === "string" ? snap.companyDomain : prospectId,
        fullName: typeof snap.fullName === "string" ? snap.fullName : undefined,
        email: typeof snap.email === "string" ? snap.email : undefined,
        title: typeof snap.title === "string" ? snap.title : undefined,
        companyName: typeof snap.companyName === "string" ? snap.companyName : undefined,
      };
    }
  }
  return { prospectId, companyDomain: prospectId };
}

/** Runs the actual target action for one matched rule. Throws on failure — caller decides how to log it. */
async function executeRuleAction(
  db: Db,
  config: Env,
  workspaceId: string,
  rule: ActivationRuleDto,
  prospectId: string
): Promise<void> {
  switch (rule.targetAction) {
    case "activate": {
      const osCfg = openSearchConfigFromEnv(config);
      const snapshot = await buildSnapshotForActivate(db, osCfg, workspaceId, prospectId);
      const enrichmentSvc = buildEnrichmentService(db, config);
      await enrichmentSvc.activate(workspaceId, [snapshot]);
      return;
    }
    case "add_to_list": {
      if (!rule.targetId) throw new HttpError("add_to_list rule missing targetId", 422);
      const listSvc = buildListService(db, openSearchConfigFromEnv(config));
      if (!listSvc) throw new HttpError("list_service_unavailable", 503);
      const result = await listSvc.addMembers(workspaceId, rule.targetId, [{ prospectId }]);
      if (!result) throw new HttpError(`target list ${rule.targetId} not found`, 404);
      return;
    }
    case "enroll_sequence": {
      if (!rule.targetId) throw new HttpError("enroll_sequence rule missing targetId", 422);
      const seqSvc = buildSequenceService(db);
      if (!seqSvc) throw new HttpError("sequence_service_unavailable", 503);
      await seqSvc.enroll(rule.targetId, workspaceId, { prospectIds: [prospectId] });
      return;
    }
  }
}

/**
 * R13.4 — the missing half of `matchActivationRules`: actually run the target action for every
 * matched rule and log each firing (auditable + reversible per the AC). Called from the scoring
 * pipeline (`list-score.runner.ts`) right after a prospect's score is computed.
 *
 * `activeSignalTypes` comes from the R11.2 unified signal store (see `list-score.runner.ts`,
 * which calls `listSignalsForEntity` before this) — rules with a `signalType` match against
 * whatever's currently active for the prospect; score-only rules are unaffected either way.
 *
 * One rule's failure never blocks another's — each is caught and counted independently so a
 * single misconfigured target (e.g. a deleted list) can't silently swallow the rest.
 */
export async function executeActivationRules(
  db: Db,
  config: Env,
  workspaceId: string,
  prospectId: string,
  prospectScore: number,
  activeSignalTypes: string[] = []
): Promise<{ matched: number; executed: number; failed: number }> {
  const matches = await matchActivationRules(db, workspaceId, prospectScore, activeSignalTypes);
  let executed = 0;
  let failed = 0;
  for (const rule of matches) {
    try {
      await executeRuleAction(db, config, workspaceId, rule, prospectId);
      await recordRuleRun(db, workspaceId, rule.id, prospectId, rule.targetAction);
      executed++;
    } catch (err) {
      failed++;
      log.error("activation rule execution failed", err, {
        workspaceId,
        ruleId: rule.id,
        prospectId,
        targetAction: rule.targetAction,
      });
    }
  }
  return { matched: matches.length, executed, failed };
}
