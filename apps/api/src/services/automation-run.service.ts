import { and, asc, eq } from "drizzle-orm";
import type { Db } from "@skout/db";
import { schema } from "@skout/db";
import { createLogger } from "@skout/observability";
import { claimNext, recordResult, buildIdempotencyKey } from "@skout/shared";
import type { Env } from "../config/env.js";
import { HttpError } from "../utils/http.js";
import { findStartNodes, type AutomationGraph } from "./automation-graph.js";
import { listAutomationSecretValues, maskAutomationSecrets } from "./automation-secrets.service.js";

const { automationRuns, automationRunSteps } = schema;
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

/** Claims the oldest pending step for a run via the shared execution-intent library. */
export async function claimNextStep(db: Db, automationRunId: string, workerId: string) {
  const claimed = await claimNext(db, automationRunSteps, workerId, CLAIM_LEASE_MS, eq(automationRunSteps.automationRunId, automationRunId));
  return claimed ?? null;
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
    .where(and(eq(automationRuns.id, runId), eq(automationRuns.workspaceId, workspaceId)))
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
    .where(eq(automationRuns.id, runId))
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
    .where(and(eq(automationRuns.id, runId), eq(automationRuns.workspaceId, workspaceId)))
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

export async function listRuns(db: Db, workspaceId: string, automationId: string) {
  return db
    .select()
    .from(automationRuns)
    .where(and(eq(automationRuns.automationId, automationId), eq(automationRuns.workspaceId, workspaceId)))
    .orderBy(asc(automationRuns.createdAt));
}
