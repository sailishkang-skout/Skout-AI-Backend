import { randomUUID } from "node:crypto";
import { and, eq, isNull, or } from "drizzle-orm";
import { createDb } from "./client.js";
import { resolveDatabaseUrl } from "./database-url.js";
import { auditLogs } from "./schema/audit.js";
import { copsLifecycleStates } from "./schema/cops-platform.js";
import { deals, pipelineStages } from "./schema/crm.js";

/**
 * COPS-02 backfill. Before the stage route kept deal status in step with the lifecycle, a deal moved
 * to a Closed Won / Closed Lost stage kept status "open" and its opportunity lifecycle state was not
 * moved to won / lost. This aligns both for every deal sitting in a closed stage.
 *
 * Dry run by default; pass --apply to write. Idempotent: a deal already aligned is skipped. Each
 * change writes one audit row (lifecycle.backfilled) with the before and after values.
 *
 *   pnpm --filter @skout/db backfill-deal-closed-status            # dry run
 *   pnpm --filter @skout/db backfill-deal-closed-status -- --apply # write
 */
const apply = process.argv.includes("--apply");
// One correlation id per run, so every row this backfill writes can be found together.
const runId = randomUUID();
const { db, sql } = createDb(resolveDatabaseUrl());

async function main() {
  const rows = await db
    .select({
      id: deals.id,
      workspaceId: deals.workspaceId,
      status: deals.status,
      isClosedWon: pipelineStages.isClosedWon,
      isClosedLost: pipelineStages.isClosedLost,
      lifecycle: copsLifecycleStates.state,
    })
    .from(deals)
    .innerJoin(pipelineStages, eq(pipelineStages.id, deals.stageId))
    .leftJoin(
      copsLifecycleStates,
      and(
        eq(copsLifecycleStates.workspaceId, deals.workspaceId),
        eq(copsLifecycleStates.dimension, "opportunity"),
        eq(copsLifecycleStates.entityId, deals.id)
      )
    )
    .where(and(or(eq(pipelineStages.isClosedWon, true), eq(pipelineStages.isClosedLost, true)), isNull(deals.deletedAt)));

  const toFix = rows
    .map((r) => ({ ...r, target: r.isClosedWon ? "won" : "lost" }))
    .filter((r) => r.status !== r.target || r.lifecycle !== r.target);

  console.log(`${rows.length} deals in closed stages; ${toFix.length} need alignment.`);
  for (const r of toFix.slice(0, 20)) {
    console.log(`  ${r.id}: status ${r.status} -> ${r.target}, lifecycle ${r.lifecycle ?? "(none)"} -> ${r.target}`);
  }
  if (toFix.length > 20) console.log(`  ...and ${toFix.length - 20} more`);
  if (!apply) {
    console.log("Dry run. Re-run with --apply to write.");
    return;
  }

  let done = 0;
  for (const r of toFix) {
    await db.transaction(async (tx) => {
      await tx.update(deals).set({ status: r.target, updatedAt: new Date() }).where(eq(deals.id, r.id));
      await tx
        .insert(copsLifecycleStates)
        .values({ workspaceId: r.workspaceId, dimension: "opportunity", entityId: r.id, state: r.target })
        .onConflictDoUpdate({
          target: [copsLifecycleStates.workspaceId, copsLifecycleStates.dimension, copsLifecycleStates.entityId],
          set: { state: r.target, updatedAt: new Date() },
        });
      await tx.insert(auditLogs).values({
        workspaceId: r.workspaceId,
        actorType: "system",
        entityType: "opportunity",
        entityId: r.id,
        action: "lifecycle.backfilled",
        beforeState: { status: r.status, lifecycle: r.lifecycle },
        afterState: { status: r.target, lifecycle: r.target },
        reason: "Deal was in a closed stage before stage moves kept status and lifecycle in step",
        correlationId: runId,
        sourceChannel: "system",
      });
    });
    done++;
  }
  console.log(`Aligned ${done} deals.`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => sql.end());

