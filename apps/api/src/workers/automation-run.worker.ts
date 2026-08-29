import { Worker } from "bullmq";
import type { Db } from "@skout/db";
import { schema } from "@skout/db";
import { eq } from "drizzle-orm";
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
import { getNodeHandler } from "../services/automation-nodes/registry.js";
import { interpolateConfig } from "../services/automation-nodes/interpolate.js";
import { nextNodeIds, type AutomationGraph } from "../services/automation-graph.js";
import { AUTOMATION_RUN_QUEUE, enqueueAutomationRunAdvance, type AutomationRunAdvancePayload } from "./automation-run.queue.js";

const { automationRuns, automationVersions, automationRunSteps } = schema;
const log = createLogger("automation-run.worker");
const WORKER_ID = `worker-${process.pid}`;

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
    await failStep(db, step.id, `node ${step.nodeId} not found in graph`);
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
    const result = await handler({
      db,
      config,
      workspaceId: run.workspaceId,
      runId: run.id,
      isSimulation: run.isSimulation,
      node: interpolatedNode,
      priorOutputs,
    });
    await completeStep(db, step.id, result.output);

    const successors = nextNodeIds(graph, node.id, result.branch);
    for (const nodeId of successors) {
      await db.insert(automationRunSteps).values({ automationRunId: run.id, nodeId, status: "pending" });
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
    const message = err instanceof Error ? err.message : String(err);
    const statusCode = (err as { statusCode?: number })?.statusCode;
    const isPolicyGatewayPause = statusCode === 403 || statusCode === 409;
    if (isPolicyGatewayPause) {
      await db.update(automationRuns).set({ status: "awaiting_approval" }).where(eq(automationRuns.id, run.id));
      log.info("automation run paused for approval", { runId: run.id, nodeId: node.id });
      return;
    }
    await failStep(db, step.id, message);
    await db.update(automationRuns).set({ status: "failed", finishedAt: new Date() }).where(eq(automationRuns.id, run.id));
    log.error("automation run step failed", err, { runId: run.id, nodeId: node.id });
  }
}

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

  log.info("Automation run worker started", { queue: AUTOMATION_RUN_QUEUE });

  return async () => {
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
