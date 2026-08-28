import { Worker } from "bullmq";
import type { Db } from "@skout/db";
import { schema } from "@skout/db";
import { eq, inArray } from "drizzle-orm";
import { createLogger } from "@skout/observability";
import type { Env } from "../config/env.js";
import { loadEnv } from "../config/env.js";
import { isRedisAvailable, redisBullMqConnection } from "../lib/redis.js";
import { createDb } from "@skout/db";
import {
  claimNextStep,
  markStepRunning,
  completeStep,
  failStep,
} from "../services/automation-run.service.js";
import { reclaimExpiredLeases, withLeaseHeartbeat, buildIdempotencyKey, LeaseLostError } from "@skout/shared";
import { AmbiguousOutcomeError } from "../services/automation-nodes/types.js";
import { getNodeHandler } from "../services/automation-nodes/registry.js";
import { interpolateConfig } from "../services/automation-nodes/interpolate.js";
import { nextNodeIds, type AutomationGraph } from "../services/automation-graph.js";
import { AUTOMATION_RUN_QUEUE, enqueueAutomationRunAdvance, type AutomationRunAdvancePayload } from "./automation-run.queue.js";

const { automationRuns, automationVersions, automationRunSteps } = schema;
const log = createLogger("automation-run.worker");
const WORKER_ID = `worker-${process.pid}`;

/**
 * Calls failStep, but treats a LeaseLostError raised by *that call itself* as "another worker
 * already owns this step now" rather than an error to propagate — recordResult (which failStep
 * delegates to) is lease-gated, so the same LeaseLostError that can escape completeStep/failStep
 * higher up can also come out of this recovery-path call to failStep. If it does, it's not this
 * worker's job to touch run/step status any further: the worker that currently holds the lease
 * is responsible for whatever happens next. Returns false when the caller should stand down
 * (skip any further run-status update) and true when it's safe to proceed.
 */
async function failStepSafely(
  db: Db,
  stepId: string,
  workerId: string,
  message: string,
  status: "failed" | "outcome_unknown",
  runId: string,
  nodeId: string
): Promise<boolean> {
  try {
    await failStep(db, stepId, workerId, message, status);
    return true;
  } catch (failErr) {
    if (failErr instanceof LeaseLostError) {
      log.info("step lease lost while recording failure — another worker already claimed it, standing down", {
        runId,
        nodeId,
      });
      return false;
    }
    throw failErr;
  }
}

/** Advances a run by exactly one claimed step, then enqueues its successors (or none). */
export async function advanceAutomationRun(
  db: Db,
  config: Env,
  payload: AutomationRunAdvancePayload,
  graphOverride?: AutomationGraph
) {
  const step = await claimNextStep(db, payload.automationRunId, WORKER_ID);
  if (!step) return; // nothing pending — another worker got there first, or the run is done

  const [run] = await db.select().from(automationRuns).where(eq(automationRuns.id, payload.automationRunId)).limit(1);
  if (!run) {
    log.error("automation run vanished mid-advance", undefined, { automationRunId: payload.automationRunId });
    return;
  }

  let graph = graphOverride;
  if (!graph) {
    const [version] = await db.select().from(automationVersions).where(eq(automationVersions.id, run.automationVersionId)).limit(1);
    graph = version!.graph as AutomationGraph;
  }

  const node = graph.nodes.find((n) => n.id === step.nodeId);
  if (!node) {
    await failStepSafely(db, step.id, WORKER_ID, `node ${step.nodeId} not found in graph`, "failed", run.id, step.nodeId);
    return;
  }

  await markStepRunning(db, step.id, {});

  const priorSteps = await db.select().from(automationRunSteps).where(eq(automationRunSteps.automationRunId, run.id));
  const priorOutputs = Object.fromEntries(
    (priorSteps as { status: string; nodeId: string; output: unknown }[])
      .filter((s) => s.status === "succeeded")
      .map((s) => [s.nodeId, s.output])
  );

  try {
    const handler = getNodeHandler(node.type);
    const interpolatedNode = { ...node, config: interpolateConfig(node.config, priorOutputs) };
    const result = await withLeaseHeartbeat(db, automationRunSteps, step.id, WORKER_ID, 60_000, () =>
      handler({
        db,
        config,
        workspaceId: run.workspaceId,
        runId: run.id,
        isSimulation: run.isSimulation,
        node: interpolatedNode,
        priorOutputs,
      })
    );
    if (result.outcome === "ambiguous") {
      const recorded = await failStepSafely(
        db,
        step.id,
        WORKER_ID,
        "ambiguous provider outcome — needs manual reconciliation",
        "outcome_unknown",
        run.id,
        node.id
      );
      if (!recorded) return;
      await db.update(automationRuns).set({ status: "failed", finishedAt: new Date() }).where(eq(automationRuns.id, run.id));
      log.warn("automation run step outcome unknown — needs reconciliation", { runId: run.id, nodeId: node.id });
      return;
    }
    await completeStep(db, step.id, WORKER_ID, result.output);

    const successors = nextNodeIds(graph, node.id, result.branch);
    for (const nodeId of successors) {
      await db
        .insert(automationRunSteps)
        .values({ automationRunId: run.id, nodeId, status: "pending", idempotencyKey: buildIdempotencyKey(run.id, nodeId) })
        .onConflictDoNothing();
    }
    if (successors.length > 0) {
      await enqueueAutomationRunAdvance(config, payload);
    } else {
      const remaining = await db
        .select()
        .from(automationRunSteps)
        .where(eq(automationRunSteps.automationRunId, run.id));
      const stillPending = (remaining as { status: string }[]).some(
        (s) => s.status === "pending" || s.status === "claimed" || s.status === "running"
      );
      if (!stillPending) {
        await db.update(automationRuns).set({ status: "succeeded", finishedAt: new Date() }).where(eq(automationRuns.id, run.id));
      } else {
        await enqueueAutomationRunAdvance(config, payload);
      }
    }
  } catch (err) {
    if (err instanceof LeaseLostError) {
      // completeStep (or, in principle, another lease-gated call above) lost the race — another
      // worker's reclaim/re-claim already owns this step. Not this worker's job to touch
      // run/step status any further.
      log.info("step lease lost — another worker already claimed it, standing down", { runId: run.id, nodeId: node.id });
      return;
    }
    if (err instanceof AmbiguousOutcomeError) {
      const recorded = await failStepSafely(db, step.id, WORKER_ID, err.message, "outcome_unknown", run.id, node.id);
      if (!recorded) return;
      await db.update(automationRuns).set({ status: "failed", finishedAt: new Date() }).where(eq(automationRuns.id, run.id));
      log.warn("automation run step outcome unknown — needs reconciliation", { runId: run.id, nodeId: node.id });
      return;
    }
    const message = err instanceof Error ? err.message : String(err);
    const statusCode = (err as { statusCode?: number })?.statusCode;
    const isPolicyGatewayPause = statusCode === 403 || statusCode === 409;
    if (isPolicyGatewayPause) {
      await db.update(automationRuns).set({ status: "awaiting_approval" }).where(eq(automationRuns.id, run.id));
      log.info("automation run paused for approval", { runId: run.id, nodeId: node.id });
      return;
    }
    const recorded = await failStepSafely(db, step.id, WORKER_ID, message, "failed", run.id, node.id);
    if (!recorded) return;
    await db.update(automationRuns).set({ status: "failed", finishedAt: new Date() }).where(eq(automationRuns.id, run.id));
    log.error("automation run step failed", err, { runId: run.id, nodeId: node.id });
  }
}

const RECLAIM_SWEEP_INTERVAL_MS = 30_000;

export async function startAutomationRunWorker(config: Env): Promise<() => Promise<void>> {
  if (!config.DATABASE_URL) {
    log.warn("Automation run worker not started — DATABASE_URL not set");
    return async () => {};
  }
  if (!(await isRedisAvailable(config))) {
    log.warn("Automation run worker not started — Redis unavailable");
    return async () => {};
  }

  const { db, sql } = createDb(config.DATABASE_URL);

  const worker = new Worker<AutomationRunAdvancePayload>(
    AUTOMATION_RUN_QUEUE,
    async (job) => {
      await advanceAutomationRun(db, config, job.data);
    },
    { connection: redisBullMqConnection(config.REDIS_URL), concurrency: 5 }
  );

  worker.on("failed", (job, err) => {
    log.error("automation-run advance job failed", err, { automationRunId: job?.data?.automationRunId });
  });

  const sweepTimer = setInterval(() => {
    reclaimExpiredLeases(db, automationRunSteps)
      .then(async (result) => {
        if (result.requeuedIds.length === 0 && result.failedIds.length === 0) return;
        log.info("automation run steps reclaimed", {
          requeued: result.requeuedIds.length,
          failed: result.failedIds.length,
        });

        // A requeued step (back to "pending") needs an advance job re-enqueued for its run —
        // advanceAutomationRun is purely push-driven (only runs from a BullMQ "advance" job), so
        // without this the step would sit pending forever with nothing to pick it up again. A
        // failed step (attempt cap hit) doesn't need this: the run is left in whatever state it
        // was in and recovery goes through the existing manual retryFailedSteps() path instead.
        if (result.requeuedIds.length === 0) return;
        const affectedRuns = await db
          .selectDistinct({ automationRunId: automationRunSteps.automationRunId, workspaceId: automationRuns.workspaceId })
          .from(automationRunSteps)
          .innerJoin(automationRuns, eq(automationRunSteps.automationRunId, automationRuns.id))
          .where(inArray(automationRunSteps.id, result.requeuedIds));
        for (const { automationRunId, workspaceId } of affectedRuns) {
          await enqueueAutomationRunAdvance(config, { automationRunId, workspaceId });
        }
      })
      .catch((err) => log.error("automation run reclaim sweep failed", err));
  }, RECLAIM_SWEEP_INTERVAL_MS);

  log.info("Automation run worker started", { queue: AUTOMATION_RUN_QUEUE });

  return async () => {
    clearInterval(sweepTimer);
    await worker.close();
    await sql.end();
  };
}

async function main() {
  const config = loadEnv();
  const stop = await startAutomationRunWorker(config);
  const shutdown = async () => {
    await stop();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

const isMain = process.argv[1]?.includes("automation-run.worker") || process.env.AUTOMATION_RUN_WORKER_STANDALONE === "true";
if (isMain) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
