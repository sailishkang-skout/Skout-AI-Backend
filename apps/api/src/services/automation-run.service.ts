import { and, asc, desc, eq, inArray, isNull, lt, lte, or, sql } from "drizzle-orm";
import type { Db } from "@skout/db";
import { schema, scopedTo, scopedById } from "@skout/db";
import { createLogger } from "@skout/observability";
import { claimNext, recordResult, buildIdempotencyKey } from "@skout/shared";
import type { Env } from "../config/env.js";
import { HttpError } from "../utils/http.js";
import { findStartNodes, type AutomationGraph } from "./automation-graph.js";
import { listAutomationSecretValues, maskAutomationSecrets } from "./automation-secrets.service.js";

const { automationRuns, automationRunSteps, automationVersions, auditLogs } = schema;
const FINISHED_RUN = ["succeeded", "failed", "cancelled"];
const log = createLogger("automation-run.service");

const CLAIM_LEASE_MS = 60_000;

export interface CreateRunInput {
  automationId: string;
  automationVersionId: string;
  workspaceId: string;
  triggerType: "event" | "webhook" | "schedule" | "manual";
  triggerRef?: string;
  correlationId?: string;
  graph: AutomationGraph;
  idempotencyKey?: string;
  isSimulation?: boolean;
  /** COPS-10: what started the run, and what it is about (e.g. an account). */
  triggerPayload?: Record<string, unknown>;
  subject?: { type: RunSubjectType; id: string };
}

export const RUN_SUBJECT_TYPES = ["account", "contact", "deal"] as const;
export type RunSubjectType = (typeof RUN_SUBJECT_TYPES)[number];

/**
 * Creates a run plus one pending step per start node (a node with no incoming edge). Idempotent
 * on (automationId, idempotencyKey) — a duplicated trigger delivery returns the existing run
 * instead of spawning a second one.
 */
export async function createAutomationRun(db: Db, input: CreateRunInput) {
  const [existing] = input.idempotencyKey
    ? await db
        .select()
        .from(automationRuns)
        .where(and(eq(automationRuns.automationId, input.automationId), eq(automationRuns.idempotencyKey, input.idempotencyKey)))
        .limit(1)
    : [];
  if (existing) return existing;

  const [run] = await db
    .insert(automationRuns)
    .values({
      automationId: input.automationId,
      automationVersionId: input.automationVersionId,
      workspaceId: input.workspaceId,
      triggerType: input.triggerType,
      triggerRef: input.triggerRef ?? null,
      correlationId: input.correlationId,
      idempotencyKey: input.idempotencyKey ?? null,
      isSimulation: input.isSimulation ?? false,
      triggerPayload: input.triggerPayload ?? null,
      subjectType: input.subject?.type ?? null,
      subjectId: input.subject?.id ?? null,
    })
    .returning();

  const startNodes = findStartNodes(input.graph);
  for (const node of startNodes) {
    await db.insert(automationRunSteps).values({
      automationRunId: run!.id,
      nodeId: node.id,
      status: "pending",
      idempotencyKey: buildIdempotencyKey(run!.id, node.id),
    });
  }

  log.info("automation run created", { runId: run!.id, automationId: input.automationId, triggerType: input.triggerType });
  return run!;
}

/**
 * Claims the oldest pending step for a run via the shared execution-intent library. A waiting
 * delay step (run_after in the future) is skipped, so it neither runs early nor blocks a parallel
 * branch.
 */
export async function claimNextStep(db: Db, automationRunId: string, workerId: string) {
  const due = or(isNull(automationRunSteps.runAfter), lte(automationRunSteps.runAfter, sql`now()`));
  const claimed = await claimNext(db, automationRunSteps, workerId, CLAIM_LEASE_MS, and(eq(automationRunSteps.automationRunId, automationRunId), due));
  return claimed ?? null;
}

/**
 * COPS-10 durable delay: puts a claimed delay step back to pending until `runAfter`, releasing
 * this worker's lease. The claim's attempt is given back, so waiting never uses up retries.
 * Returns false when the lease was already lost (another worker owns the step).
 */
export async function deferStep(db: Db, stepId: string, workerId: string, runAfter: Date) {
  const rows = await db
    .update(automationRunSteps)
    .set({
      status: "pending",
      runAfter,
      leaseOwner: null,
      leaseExpiresAt: null,
      attemptCount: sql`greatest(${automationRunSteps.attemptCount} - 1, 0)`,
    })
    .where(and(eq(automationRunSteps.id, stepId), eq(automationRunSteps.leaseOwner, workerId)))
    .returning({ id: automationRunSteps.id });
  return rows.length > 0;
}

/**
 * Runs with a waiting delay step that is now due. The worker's sweep re-enqueues them, which is
 * what makes a delay survive a restart or a lost queue job.
 */
export async function listRunsWithDueSteps(db: Db, now: Date, limit = 200) {
  return db
    .selectDistinct({ automationRunId: automationRunSteps.automationRunId, workspaceId: automationRuns.workspaceId })
    .from(automationRunSteps)
    .innerJoin(automationRuns, eq(automationRunSteps.automationRunId, automationRuns.id))
    .where(
      and(
        eq(automationRunSteps.status, "pending"),
        lte(automationRunSteps.runAfter, now),
        inArray(automationRuns.status, ["pending", "running"])
      )
    )
    .limit(limit);
}

export async function markStepRunning(db: Db, stepId: string, input: unknown) {
  const [row] = await db
    .update(automationRunSteps)
    .set({ status: "running", input, updatedAt: new Date() })
    .where(eq(automationRunSteps.id, stepId))
    .returning();
  return row!;
}

export async function completeStep(db: Db, stepId: string, workerId: string, output: unknown) {
  return recordResult(db, automationRunSteps, stepId, workerId, { status: "succeeded", output });
}

/**
 * Marks a step failed (or outcome_unknown for an ambiguous provider result — see
 * automation-nodes/action-http.node.ts). Failures are terminal, not auto-retried — recovery is
 * retryFailedSteps() below, an explicit user-triggered action.
 */
export async function failStep(db: Db, stepId: string, workerId: string, error: string, status: "failed" | "outcome_unknown" = "failed") {
  return recordResult(db, automationRunSteps, stepId, workerId, { status, error });
}

/**
 * Resets every failed step in a run back to pending and reopens the run — the manual recovery
 * path for a failed run. Caller is responsible for re-enqueuing the advance job afterward.
 */
export async function retryFailedSteps(db: Db, workspaceId: string, runId: string) {
  const [run] = await db
    .select()
    .from(automationRuns)
    .where(scopedById(automationRuns, workspaceId, runId))
    .limit(1);
  if (!run) throw new HttpError("automation_run_not_found", 404);
  if (run.status !== "failed") throw new HttpError("automation_run_not_failed", 422);

  // Deliberately scoped to status = "failed" only. "outcome_unknown" steps are excluded from
  // this automatic reset on purpose: they represent an ambiguous provider result (e.g. a request
  // that timed out with no confirmation of whether it actually went through), not a confirmed
  // failure — blindly resubmitting one risks a duplicate side effect. They need a human to review
  // the ambiguous result first; a dedicated reconciliation flow for them is out of scope here.
  await db
    .update(automationRunSteps)
    .set({ status: "pending", error: null, updatedAt: new Date() })
    .where(and(eq(automationRunSteps.automationRunId, runId), eq(automationRunSteps.status, "failed")));

  const [updatedRun] = await db
    .update(automationRuns)
    .set({ status: "running", finishedAt: null })
    .where(scopedById(automationRuns, workspaceId, runId))
    .returning();
  return updatedRun!;
}

/**
 * §8.14 — steps' input/output are masked here, at the service layer, before returning: this is
 * the one place both the run-detail route and any other future caller (e.g. an export) get their
 * data from, so masking here protects the API response regardless of what a node handler puts in
 * a step's input/output. A UI-only mask would still leak via a direct API call.
 */
export async function getRun(db: Db, config: Env, workspaceId: string, runId: string) {
  const [run] = await db
    .select()
    .from(automationRuns)
    .where(scopedById(automationRuns, workspaceId, runId))
    .limit(1);
  if (!run) throw new HttpError("automation_run_not_found", 404);
  const rawSteps = await db.select().from(automationRunSteps).where(eq(automationRunSteps.automationRunId, runId)).orderBy(asc(automationRunSteps.createdAt));

  const secretValues = await listAutomationSecretValues(db, config, workspaceId);
  const steps = rawSteps.map((step) => ({
    ...step,
    input: maskAutomationSecrets(step.input, secretValues),
    output: maskAutomationSecrets(step.output, secretValues),
  }));

  return { run, steps };
}

export interface RunHistoryQuery {
  automationId?: string;
  version?: number;
  subject?: { type: RunSubjectType; id: string };
  status?: string;
  /** Runs created before this time (paging, newest first). */
  before?: Date;
  limit?: number;
}

/**
 * COPS-10 run history: newest first, filtered by workflow, version, subject (e.g. one account
 * across every workflow) and status. Each row carries its version number.
 */
export async function listRuns(db: Db, workspaceId: string, query: RunHistoryQuery) {
  const limit = Math.min(Math.max(query.limit ?? 50, 1), 200);
  const conditions = [eq(automationRuns.workspaceId, workspaceId)];
  if (query.automationId) conditions.push(eq(automationRuns.automationId, query.automationId));
  if (query.version !== undefined) conditions.push(eq(automationVersions.version, query.version));
  if (query.subject) conditions.push(eq(automationRuns.subjectType, query.subject.type), eq(automationRuns.subjectId, query.subject.id));
  if (query.status) conditions.push(eq(automationRuns.status, query.status));
  if (query.before) conditions.push(lt(automationRuns.createdAt, query.before));
  const rows = await db
    .select({ run: automationRuns, version: automationVersions.version })
    .from(automationRuns)
    .innerJoin(automationVersions, eq(automationRuns.automationVersionId, automationVersions.id))
    .where(and(...conditions))
    .orderBy(desc(automationRuns.createdAt), desc(automationRuns.id))
    .limit(limit + 1);
  const page = rows.slice(0, limit).map((r) => ({ ...r.run, version: r.version }));
  const last = page[page.length - 1];
  return { data: page, nextBefore: rows.length > limit && last ? last.createdAt.toISOString() : null };
}

/**
 * COPS-10: an approval step the Policy Gateway did not allow waits as `awaiting_approval`. Neither
 * a claim (pending only) nor the lease reclaim (claimed/running only) picks it up, so it is not
 * re-asked on every lease expiry; it moves on only through decideApproval().
 */
export async function pauseStepForApproval(db: Db, stepId: string, workerId: string, detail: unknown) {
  const rows = await db
    .update(automationRunSteps)
    .set({ status: "awaiting_approval", output: { policy: detail ?? null }, leaseOwner: null, leaseExpiresAt: null })
    .where(and(eq(automationRunSteps.id, stepId), eq(automationRunSteps.leaseOwner, workerId)))
    .returning({ id: automationRunSteps.id });
  return rows.length > 0;
}

async function lockRun(tx: Parameters<Parameters<Db["transaction"]>[0]>[0], workspaceId: string, runId: string) {
  const [run] = await tx.select().from(automationRuns).where(scopedById(automationRuns, workspaceId, runId)).for("update").limit(1);
  if (!run) throw new HttpError("automation_run_not_found", 404);
  return run;
}

/**
 * Approve: the waiting step runs again with the approval (the Policy Gateway then allows it).
 * Reject: the step fails, what was left of the run is skipped and the run is cancelled. Audited.
 * The caller enqueues the run after an approval.
 */
export async function decideApproval(
  db: Db,
  workspaceId: string,
  runId: string,
  decision: "approve" | "reject",
  actorId: string | undefined,
  reason: string | null
) {
  return db.transaction(async (tx) => {
    const run = await lockRun(tx, workspaceId, runId);
    if (run.status !== "awaiting_approval") throw new HttpError("automation_run_not_awaiting_approval", 409);
    const [step] = await tx
      .select()
      .from(automationRunSteps)
      .where(and(eq(automationRunSteps.automationRunId, runId), eq(automationRunSteps.status, "awaiting_approval")))
      .limit(1);
    if (!step) throw new HttpError("automation_run_not_awaiting_approval", 409);
    const at = new Date();
    if (decision === "approve") {
      await tx
        .update(automationRunSteps)
        .set({ status: "pending", input: { approval: { approvedBy: actorId ?? null, reason, at: at.toISOString() } } })
        .where(eq(automationRunSteps.id, step.id));
      await tx.update(automationRuns).set({ status: "running" }).where(eq(automationRuns.id, runId));
    } else {
      await tx.update(automationRunSteps).set({ status: "failed", error: `approval rejected${reason ? `: ${reason}` : ""}` }).where(eq(automationRunSteps.id, step.id));
      await tx
        .update(automationRunSteps)
        .set({ status: "skipped" })
        .where(and(eq(automationRunSteps.automationRunId, runId), eq(automationRunSteps.status, "pending")));
      await tx.update(automationRuns).set({ status: "cancelled", finishedAt: at }).where(eq(automationRuns.id, runId));
    }
    await tx.insert(auditLogs).values({
      workspaceId,
      actorType: actorId ? "user" : "system",
      actorId: actorId ?? null,
      action: decision === "approve" ? "automation.step_approved" : "automation.step_rejected",
      entityType: "automation_run",
      entityId: runId,
      beforeState: { status: run.status, nodeId: step.nodeId },
      afterState: { status: decision === "approve" ? "running" : "cancelled" },
      reason: reason ?? `Workflow step ${step.nodeId} ${decision === "approve" ? "approved" : "rejected"}`,
    });
    return { runId, decision, nodeId: step.nodeId };
  });
}

/**
 * Cancels a run that has not finished: its waiting steps are skipped, and a step a worker is
 * running now is skipped when that worker next looks at the run. Audited.
 */
export async function cancelRun(db: Db, workspaceId: string, runId: string, actorId: string | undefined, reason: string | null) {
  return db.transaction(async (tx) => {
    const run = await lockRun(tx, workspaceId, runId);
    if (FINISHED_RUN.includes(run.status)) throw new HttpError("automation_run_already_finished", 409);
    await tx
      .update(automationRunSteps)
      .set({ status: "skipped" })
      .where(and(eq(automationRunSteps.automationRunId, runId), inArray(automationRunSteps.status, ["pending", "awaiting_approval"])));
    const [updated] = await tx.update(automationRuns).set({ status: "cancelled", finishedAt: new Date() }).where(eq(automationRuns.id, runId)).returning();
    await tx.insert(auditLogs).values({
      workspaceId,
      actorType: actorId ? "user" : "system",
      actorId: actorId ?? null,
      action: "automation.run_cancelled",
      entityType: "automation_run",
      entityId: runId,
      beforeState: { status: run.status },
      afterState: { status: "cancelled" },
      reason: reason ?? "Workflow run cancelled",
    });
    return updated!;
  });
}

/**
 * COPS-10 replay: a new run with the original trigger payload and subject, on the original
 * version or the latest published one. The original run is not changed. Audited.
 */
export async function replayRun(db: Db, workspaceId: string, runId: string, actorId: string | undefined, target: "same" | "latest") {
  const [original] = await db.select().from(automationRuns).where(scopedById(automationRuns, workspaceId, runId)).limit(1);
  if (!original) throw new HttpError("automation_run_not_found", 404);
  const [version] =
    target === "same"
      ? await db.select().from(automationVersions).where(eq(automationVersions.id, original.automationVersionId)).limit(1)
      : await db
          .select()
          .from(automationVersions)
          .where(and(eq(automationVersions.automationId, original.automationId), eq(automationVersions.status, "published")))
          .orderBy(desc(automationVersions.version))
          .limit(1);
  if (!version) throw new HttpError("automation_version_not_found", 422);
  const run = await createAutomationRun(db, {
    automationId: original.automationId,
    automationVersionId: version.id,
    workspaceId,
    triggerType: original.triggerType as CreateRunInput["triggerType"],
    triggerRef: `replay:${original.id}`,
    graph: version.graph as AutomationGraph,
    idempotencyKey: `replay:${original.id}:${crypto.randomUUID()}`,
    isSimulation: original.isSimulation,
    triggerPayload: (original.triggerPayload ?? undefined) as Record<string, unknown> | undefined,
    subject: original.subjectType && original.subjectId ? { type: original.subjectType as RunSubjectType, id: original.subjectId } : undefined,
  });
  await db.insert(auditLogs).values({
    workspaceId,
    actorType: actorId ? "user" : "system",
    actorId: actorId ?? null,
    action: "automation.run_replayed",
    entityType: "automation_run",
    entityId: original.id,
    afterState: { replayRunId: run.id, version: version.version },
    reason: `Workflow run replayed on v${version.version}`,
  });
  return run;
}
