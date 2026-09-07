import { eq } from "drizzle-orm";
import { createLogger } from "@skout/observability";
import type { Db } from "@skout/db";
import { schema } from "@skout/db";
import type { FieldResult } from "@skout/pal";
import type { Env } from "../config/env.js";
import { buildEnrichmentService, InsufficientCreditsError } from "./enrichment/index.js";
import { getWorkbook } from "./workbook.service.js";
import { emitSkoutEvent } from "./skout-event.service.js";
import { listColumns } from "./workbook-column.service.js";
import { computeColumnsForRow } from "./workbook-column-compute.service.js";

/** §8.3 Task ADI-12 — flattens this row's PAL results into the `{{key}}` context flexible
 * columns can reference (see workbook-column-compute.service.ts). `company` is special-cased
 * since its value lives in `valueJson` (a firmographics object), not `value` (see FieldResult's
 * doc comment in packages/pal/src/types.ts). Also seeds identity fields already on the
 * snapshot, which don't come through the waterfall at all when unchanged. */
function buildFieldContext(results: FieldResult[], snapshot: Record<string, unknown>): Record<string, string | undefined> {
  const context: Record<string, string | undefined> = {
    fullName: typeof snapshot.fullName === "string" ? snapshot.fullName : undefined,
    title: typeof snapshot.title === "string" ? snapshot.title : undefined,
    companyDomain: typeof snapshot.companyDomain === "string" ? snapshot.companyDomain : undefined,
  };
  for (const r of results) {
    if (r.field === "company") {
      const firm = r.valueJson as { companyName?: string } | undefined;
      context.company = firm?.companyName ?? r.value;
    } else {
      context[r.field] = r.value;
    }
  }
  return context;
}

const { enrichmentWorkbookRuns, enrichmentBatches } = schema;
const log = createLogger("workbook-run.runner");

/**
 * Processes one workbook run's target rows through the existing enrichProspect/job
 * pipeline. Resumable: starts at `processedRows`, since targetProspectIds is fixed at
 * run creation, so re-entering after a pause never reprocesses or skips a row. Stops
 * early (leaving the run "partial") on a cooperative pause request, on hitting the
 * workbook's per-run credit budget, or if the workspace runs out of credits entirely —
 * a single missing row never fails the whole run.
 */
export async function runWorkbookRunJob(db: Db, config: Env, runId: string, workspaceId: string): Promise<void> {
  const [run] = await db.select().from(enrichmentWorkbookRuns).where(eq(enrichmentWorkbookRuns.id, runId));
  if (!run) {
    log.error("workbook run not found", { runId });
    return;
  }
  if (run.status === "paused") return; // re-enqueued before resume flipped it back to running

  const workbook = await getWorkbook(db, workspaceId, run.workbookId);
  if (!workbook) {
    await db
      .update(enrichmentWorkbookRuns)
      .set({ status: "failed", errorMessage: "workbook_not_found", completedAt: new Date() })
      .where(eq(enrichmentWorkbookRuns.id, runId));
    return;
  }

  await db
    .update(enrichmentWorkbookRuns)
    .set({ status: "running", startedAt: run.startedAt ?? new Date() })
    .where(eq(enrichmentWorkbookRuns.id, runId));

  const targetIds = run.targetProspectIds as string[];

  let batchId: string;
  if (run.batchId) {
    batchId = run.batchId;
  } else {
    const [batch] = await db
      .insert(enrichmentBatches)
      .values({
        workspaceId,
        listId: run.listId,
        total: targetIds.length,
        done: 0,
        failed: 0,
        status: "running",
      })
      .returning();
    batchId = batch!.id;
    await db.update(enrichmentWorkbookRuns).set({ batchId }).where(eq(enrichmentWorkbookRuns.id, runId));
  }

  // §8.3 Task ADI-12 — loaded once per run, not per row; the vast majority of workbooks have
  // zero flexible columns, so this is a no-op read for them.
  const columns = await listColumns(db, workspaceId, workbook.id);

  const enrichmentService = buildEnrichmentService(db, config);
  let processedRows = run.processedRows;
  let succeededRows = run.succeededRows;
  let failedRows = run.failedRows;
  let creditsUsed = run.creditsUsed;
  let stoppedReason: "paused" | "budget_exhausted" | "insufficient_credits" | null = null;

  for (let i = processedRows; i < targetIds.length; i++) {
    const [current] = await db
      .select({ status: enrichmentWorkbookRuns.status })
      .from(enrichmentWorkbookRuns)
      .where(eq(enrichmentWorkbookRuns.id, runId));
    if (current?.status === "paused") {
      stoppedReason = "paused";
      break;
    }

    const prospectId = targetIds[i]!;
    const activation = await enrichmentService.getActivation(workspaceId, prospectId);
    if (!activation) {
      failedRows += 1;
    } else {
      const snap = activation.snapshot as Record<string, unknown>;
      try {
        const job = await enrichmentService.enrichProspect(
          workspaceId,
          { ...snap, prospectId, companyDomain: (snap.companyDomain as string) ?? "" },
          {
            fields: workbook.fields,
            batchId,
            trigger: "workbook",
            emailQualityThreshold: workbook.emailQualityThreshold ?? undefined,
          }
        );
        creditsUsed += job.creditsUsed;
        if (job.status === "completed") succeededRows += 1;
        else failedRows += 1;

        // §8.3 Task ADI-12 — a second, parallel pass over the fixed-field results this row just
        // produced. Never affects succeededRows/failedRows or stoppedReason: a flexible-column
        // failure is a per-cell concern (see computeColumnsForRow's own non-throwing contract),
        // not a reason to mark the whole row failed the way an enrichProspect error is.
        if (columns.length > 0 && job.status === "completed") {
          const fieldContext = buildFieldContext(job.results, snap);
          await computeColumnsForRow(db, config, workspaceId, runId, columns, prospectId, fieldContext);
        }
      } catch (err) {
        if (err instanceof InsufficientCreditsError) {
          stoppedReason = "insufficient_credits";
          break;
        }
        log.warn("workbook row failed", { runId, prospectId, err });
        failedRows += 1;
      }
    }

    processedRows += 1;
    await db
      .update(enrichmentWorkbookRuns)
      .set({ processedRows, succeededRows, failedRows, creditsUsed })
      .where(eq(enrichmentWorkbookRuns.id, runId));

    if (run.creditsBudget != null && creditsUsed >= run.creditsBudget) {
      stoppedReason = "budget_exhausted";
      break;
    }
  }

  if (stoppedReason === "paused") {
    log.info("workbook run paused", { runId, processedRows });
    await db.update(enrichmentBatches).set({ done: succeededRows, failed: failedRows }).where(eq(enrichmentBatches.id, batchId));
    return;
  }

  const finished = processedRows >= targetIds.length;
  const finalStatus = finished
    ? failedRows === 0
      ? "completed"
      : failedRows === targetIds.length
        ? "failed"
        : "partial"
    : "partial";

  await db
    .update(enrichmentWorkbookRuns)
    .set({
      status: finalStatus,
      errorMessage: stoppedReason,
      completedAt: new Date(),
    })
    .where(eq(enrichmentWorkbookRuns.id, runId));

  await db
    .update(enrichmentBatches)
    .set({ done: succeededRows, failed: failedRows, status: finalStatus === "failed" ? "failed" : "completed" })
    .where(eq(enrichmentBatches.id, batchId));

  await emitSkoutEvent(db, config, {
    type: "enrichment.completed",
    tenantId: workspaceId,
    aggregateId: runId,
    data: {
      workspaceId,
      runId,
      workbookId: run.workbookId,
      batchId,
      status: finalStatus,
      processedRows,
      succeededRows,
      failedRows,
      creditsUsed,
      stoppedReason,
    },
  }).catch((err: unknown) => log.warn("workbook-run: failed to emit enrichment.completed", { runId, err }));

  log.info("workbook run finished", {
    runId,
    status: finalStatus,
    processedRows,
    succeededRows,
    failedRows,
    creditsUsed,
    stoppedReason,
  });
}
