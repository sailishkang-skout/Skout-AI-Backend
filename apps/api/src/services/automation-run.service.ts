import { and, asc, eq } from "drizzle-orm";
import type { Db } from "@skout/db";
import { schema } from "@skout/db";
import { createLogger } from "@skout/observability";
import { HttpError } from "../utils/http.js";
import { findStartNodes, type AutomationGraph } from "./automation-graph.js";

const { automationRuns, automationRunSteps } = schema;
const log = createLogger("automation-run.service");

const MAX_ATTEMPTS = 5;
const BACKOFF_BASE_MS = 5_000;

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

/** Marks a step failed; if attempts remain, schedules a retry with exponential backoff + jitter. */
export async function failStep(
  db: Db,
  stepId: string,
  error: string,
  opts: { attempt: number; maxAttempts?: number }
) {
  const maxAttempts = opts.maxAttempts ?? MAX_ATTEMPTS;
  const willRetry = opts.attempt < maxAttempts;
  const delayMs = BACKOFF_BASE_MS * 2 ** (opts.attempt - 1) * (0.5 + Math.random());

  const [row] = await db
    .update(automationRunSteps)
    .set(
      willRetry
        ? { status: "pending", attempt: opts.attempt + 1, error, nextRetryAt: new Date(Date.now() + delayMs), updatedAt: new Date() }
        : { status: "failed", error, updatedAt: new Date() }
    )
    .where(eq(automationRunSteps.id, stepId))
    .returning();
  return row!;
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
