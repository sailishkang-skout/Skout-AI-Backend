import { and, asc, eq } from "drizzle-orm";
import type { Db } from "@skout/db";
import { schema } from "@skout/db";
import { createLogger } from "@skout/observability";
import { HttpError } from "../utils/http.js";
import { findStartNodes, type AutomationGraph } from "./automation-graph.js";

const { automationRuns, automationRunSteps } = schema;
const log = createLogger("automation-run.service");

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
}

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
    })
    .returning();

  const startNodes = findStartNodes(input.graph);
  for (const node of startNodes) {
    await db.insert(automationRunSteps).values({ automationRunId: run!.id, nodeId: node.id, status: "pending" });
  }

  log.info("automation run created", { runId: run!.id, automationId: input.automationId, triggerType: input.triggerType });
  return run!;
}

/** Claims the oldest pending step for a run, marking it claimed by this worker. */
export async function claimNextStep(db: Db, automationRunId: string, workerId: string) {
  const [candidate] = await db
    .select()
    .from(automationRunSteps)
    .where(and(eq(automationRunSteps.automationRunId, automationRunId), eq(automationRunSteps.status, "pending")))
    .orderBy(asc(automationRunSteps.createdAt))
    .limit(1);
  if (!candidate) return null;

  const [claimed] = await db
    .update(automationRunSteps)
    .set({ status: "claimed", claimedAt: new Date(), claimedByWorker: workerId, updatedAt: new Date() })
    .where(and(eq(automationRunSteps.id, candidate.id), eq(automationRunSteps.status, "pending")))
    .returning();
  return claimed ?? null; // null if another worker claimed it first
}

export async function heartbeatStep(db: Db, stepId: string) {
  await db.update(automationRunSteps).set({ heartbeatAt: new Date() }).where(eq(automationRunSteps.id, stepId));
}

export async function markStepRunning(db: Db, stepId: string, input: unknown) {
  const [row] = await db
    .update(automationRunSteps)
    .set({ status: "running", input, updatedAt: new Date() })
    .where(eq(automationRunSteps.id, stepId))
    .returning();
  return row!;
}

export async function completeStep(db: Db, stepId: string, output: unknown) {
  const [row] = await db
    .update(automationRunSteps)
    .set({ status: "succeeded", output, updatedAt: new Date() })
    .where(eq(automationRunSteps.id, stepId))
    .returning();
  return row!;
}

/**
 * Marks a step failed. Failures are terminal, not auto-retried — nothing in this worker consumes
 * a scheduled retry time, so pretending otherwise (an earlier version of this function reset the
 * step to "pending" with a future nextRetryAt) just left runs permanently stuck: the run itself
 * was still marked "failed" immediately regardless, and nothing ever re-enqueued the step.
 * Recovery is retryFailedSteps() below — an explicit, user-triggered action.
 */
export async function failStep(db: Db, stepId: string, error: string) {
  const [row] = await db
    .update(automationRunSteps)
    .set({ status: "failed", error, updatedAt: new Date() })
    .where(eq(automationRunSteps.id, stepId))
    .returning();
  return row!;
}

/**
 * Resets every failed step in a run back to pending and reopens the run — the manual recovery
 * path for a failed run. Caller is responsible for re-enqueuing the advance job afterward.
 */
export async function retryFailedSteps(db: Db, workspaceId: string, runId: string) {
  const [run] = await db
    .select()
    .from(automationRuns)
    .where(and(eq(automationRuns.id, runId), eq(automationRuns.workspaceId, workspaceId)))
    .limit(1);
  if (!run) throw new HttpError("automation_run_not_found", 404);
  if (run.status !== "failed") throw new HttpError("automation_run_not_failed", 422);

  await db
    .update(automationRunSteps)
    .set({ status: "pending", error: null, nextRetryAt: null, updatedAt: new Date() })
    .where(and(eq(automationRunSteps.automationRunId, runId), eq(automationRunSteps.status, "failed")));

  const [updatedRun] = await db
    .update(automationRuns)
    .set({ status: "running", finishedAt: null })
    .where(eq(automationRuns.id, runId))
    .returning();
  return updatedRun!;
}

export async function getRun(db: Db, workspaceId: string, runId: string) {
  const [run] = await db
    .select()
    .from(automationRuns)
    .where(and(eq(automationRuns.id, runId), eq(automationRuns.workspaceId, workspaceId)))
    .limit(1);
  if (!run) throw new HttpError("automation_run_not_found", 404);
  const steps = await db.select().from(automationRunSteps).where(eq(automationRunSteps.automationRunId, runId)).orderBy(asc(automationRunSteps.createdAt));
  return { run, steps };
}

export async function listRuns(db: Db, workspaceId: string, automationId: string) {
  return db
    .select()
    .from(automationRuns)
    .where(and(eq(automationRuns.automationId, automationId), eq(automationRuns.workspaceId, workspaceId)))
    .orderBy(asc(automationRuns.createdAt));
}
