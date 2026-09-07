import { Worker, Queue } from "bullmq";
import { and, asc, eq, isNull } from "drizzle-orm";
import { createDb, schema } from "@skout/db";
import type { Db } from "@skout/db";
import { createLogger, withSpan } from "@skout/observability";
import { createEvent } from "@skout/shared";
import type { Env } from "../config/env.js";
import { loadEnv } from "../config/env.js";
import { isRedisAvailable, redisBullMqConnection } from "../lib/redis.js";
import { executeActivationRules } from "../services/activation-rules.service.js";
import {
  computeSignalStackScore,
  listSignalsForEntity,
  signalStackWeightsFromEnv,
  signalStrengthByType,
  toSignalRecord,
} from "../services/signal.service.js";
import { enqueueDexterEvent } from "./dexter-events.queue.js";

const log = createLogger("signal-activation-sweep.worker");

const QUEUE_NAME = "signal-activation-sweep";
const BATCH_SIZE = 200;

type SignalRow = typeof schema.signals.$inferSelect;

/**
 * SS-08 — the real-time counterpart to `list-score.runner.ts`'s activation-rule firing, which
 * previously only ran when a human clicked "score list." This is the missing half: the moment a
 * signal lands (from the corpus scraper at company-level, or a workspace-local producer at
 * prospect-level), find every activated prospect it's relevant to and give `executeActivationRules`
 * a chance to fire — no more waiting on an unrelated scoring job to notice the signal exists.
 *
 * Company-level signals (recent_hiring, recent_funding, leadership_change, news_mention,
 * tech_adoption, ...) fan out to every prospect activated at that company — mirroring
 * signal-alert-sweep.worker.ts's owner-lookup pattern, since a company signal is relevant to
 * everyone activated there, not just one entity row.
 *
 * A rule can only fire against a prospect that's already been scored (activation_rules threshold
 * against `prospect_scores.score`) — this sweep does not itself score anyone. That matches
 * existing behavior: a signal alone was never enough to trigger `enroll_sequence`, a score was
 * always required too. What's new is that the check now happens on signal arrival instead of only
 * on the next list-score run.
 *
 * Also emits a `signal.high_strength` Dexter event (SS-08) — independent of any prospect's
 * score — for any signal whose own stack-weight clears `DEXTER_SIGNAL_TRIGGER_MIN_STRENGTH`,
 * once per workspace it touches. dexter-orchestrator.worker.ts's `TRIGGERABLE_EVENT_TYPES`
 * allowlists this event type, so a `dexter_triggers` row can turn it into a real (workspace-level)
 * plan proposal — previously Dexter's proposal flow had no path from a signal at all.
 */
export async function matchAndActivateSignal(
  db: Db,
  config: Env,
  signal: SignalRow
): Promise<{ matched: number; executed: number; failed: number }> {
  const { prospectActivations, prospectScores } = schema;

  const ownerColumn = signal.entityType === "prospect" ? prospectActivations.prospectId : prospectActivations.companyId;

  const owners = await db
    .select({ workspaceId: prospectActivations.workspaceId, prospectId: prospectActivations.prospectId })
    .from(prospectActivations)
    .where(eq(ownerColumn, signal.entityId));

  // SS-08 — the signal's own stack-weight in isolation (not folded into any one prospect's
  // other signals), so "is this signal itself strong enough to interest Dexter" doesn't depend
  // on which prospect happens to own it. Computed once, reused for every workspace below.
  const soloStackScore = computeSignalStackScore([toSignalRecord(signal)], {
    weights: signalStackWeightsFromEnv(config),
  });
  const soloStrength = signalStrengthByType(soloStackScore)[signal.signalType] ?? 0;
  const notifiedWorkspaces = new Set<string>();

  const seen = new Set<string>();
  let matched = 0;
  let executed = 0;
  let failed = 0;

  for (const owner of owners) {
    // Dexter's plan-proposal trigger is workspace-level, not gated on this prospect's own score —
    // emit once per distinct workspace the signal touches, ahead of (and independent of) the
    // per-prospect activation-rule pass below.
    if (soloStrength >= config.DEXTER_SIGNAL_TRIGGER_MIN_STRENGTH && !notifiedWorkspaces.has(owner.workspaceId)) {
      notifiedWorkspaces.add(owner.workspaceId);
      try {
        await enqueueDexterEvent(
          config,
          createEvent({
            type: "signal.high_strength",
            tenantId: owner.workspaceId,
            aggregateId: signal.id,
            data: {
              signalId: signal.id,
              signalType: signal.signalType,
              entityType: signal.entityType,
              entityId: signal.entityId,
              strength: soloStrength,
            },
          })
        );
      } catch (err) {
        log.warn("failed to emit signal.high_strength", { err, signalId: signal.id, workspaceId: owner.workspaceId });
      }
    }

    const key = `${owner.workspaceId}:${owner.prospectId}`;
    if (seen.has(key)) continue;
    seen.add(key);

    const [prospectScoreRow] = await db
      .select({ score: prospectScores.score })
      .from(prospectScores)
      .where(and(eq(prospectScores.workspaceId, owner.workspaceId), eq(prospectScores.prospectId, owner.prospectId)));
    if (!prospectScoreRow || prospectScoreRow.score == null) continue; // never scored — nothing to threshold against

    // Union the triggering signal's own type (company-level signals aren't visible to a
    // prospect-scoped lookup below) with whatever's already active for this prospect directly.
    const prospectSignals = await listSignalsForEntity(db, owner.prospectId, { entityType: "prospect" });
    const activeSignalTypes = [...new Set([signal.signalType, ...prospectSignals.map((s) => s.signalType)])];

    // SS-08 — fold the triggering row itself in (it won't appear in `prospectSignals` when it's
    // company-level) so `minSignalStrength` rules see its actual confidence/strength/recency,
    // not just its bare type.
    const stackScore = computeSignalStackScore([...prospectSignals, toSignalRecord(signal)], {
      weights: signalStackWeightsFromEnv(config),
    });

    try {
      const outcome = await executeActivationRules(
        db,
        config,
        owner.workspaceId,
        owner.prospectId,
        prospectScoreRow.score,
        activeSignalTypes,
        signalStrengthByType(stackScore)
      );
      matched += outcome.matched;
      executed += outcome.executed;
      failed += outcome.failed;
    } catch (err) {
      failed++;
      log.error("activation rule pass failed for signal-triggered prospect", err, {
        workspaceId: owner.workspaceId,
        prospectId: owner.prospectId,
        signalId: signal.id,
        signalType: signal.signalType,
      });
    }
  }

  return { matched, executed, failed };
}

export async function startSignalActivationSweepWorker(config: Env) {
  if (!config.DATABASE_URL) {
    log.warn("DATABASE_URL not set — signal activation sweep worker disabled");
    return () => Promise.resolve();
  }

  if (!(await isRedisAvailable(config))) {
    log.warn("Redis unavailable — signal activation sweep worker disabled");
    return () => Promise.resolve();
  }

  const connection = redisBullMqConnection(config.REDIS_URL);
  const queue = new Queue(QUEUE_NAME, { connection });

  const cronExpression = `*/${config.SIGNAL_ACTIVATION_SWEEP_INTERVAL_MINUTES} * * * *`;
  await queue.upsertJobScheduler(
    "signal-activation-sweep-all",
    { pattern: cronExpression },
    { name: "signal-activation-sweep-all", data: {} }
  );

  const { db } = createDb(config.DATABASE_URL);
  const { signals } = schema;

  const worker = new Worker(
    QUEUE_NAME,
    async () => {
      // Self-triggered on a cron schedule; root span (no upstream trace exists).
      await withSpan("signal-activation-sweep.tick", async () => {
        const pending = await db
          .select()
          .from(signals)
          .where(isNull(signals.activationCheckedAt))
          .orderBy(asc(signals.createdAt))
          .limit(BATCH_SIZE);

        if (pending.length === 0) return;

        let totalExecuted = 0;
        for (const signal of pending) {
          try {
            const outcome = await matchAndActivateSignal(db, config, signal);
            totalExecuted += outcome.executed;
          } catch (err) {
            log.error(`Failed to match/activate for signal ${signal.id}`, { signalId: signal.id, err });
          } finally {
            // Always mark processed, matched or not, so a signal with no activated prospects (or
            // no matching rule) doesn't get re-scanned by every sweep tick forever.
            await db.update(signals).set({ activationCheckedAt: new Date() }).where(eq(signals.id, signal.id));
          }
        }

        log.info(`Signal activation sweep processed ${pending.length} signal(s), executed ${totalExecuted} action(s)`);
      });
    },
    { connection, concurrency: 1 }
  );

  worker.on("failed", (job, err) => {
    log.error("Signal activation sweep job failed", { jobId: job?.id, err });
  });

  log.info(`Signal activation sweep worker started (cron: ${cronExpression})`);

  return async () => {
    await worker.close();
    await queue.close();
  };
}

if (
  process.argv[1]?.endsWith("signal-activation-sweep.worker.ts") ||
  process.argv[1]?.endsWith("signal-activation-sweep.worker.js")
) {
  const config = loadEnv();
  startSignalActivationSweepWorker(config).then(() => {
    log.info("Signal activation sweep worker running standalone");
  });
}
