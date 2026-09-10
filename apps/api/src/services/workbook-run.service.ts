import { and, desc, eq, inArray } from "drizzle-orm";
import type { Db } from "@skout/db";
import { schema, scopedTo, scopedById } from "@skout/db";
import type { Env } from "../config/env.js";
import { HttpError } from "../utils/http.js";
import { buildEnrichmentService, InsufficientCreditsError } from "./enrichment/index.js";
import { getWorkbook } from "./workbook.service.js";
import { getColumnValuesForRun, listColumns } from "./workbook-column.service.js";
import { enqueueWorkbookRunJob } from "../workers/workbook-run.queue.js";

const { enrichmentWorkbookRuns, enrichmentJobs, prospectActivations } = schema;

export type RunMode = "sample" | "selected" | "changed_rows" | "scheduled";
export type RunStatus = "pending" | "running" | "paused" | "completed" | "partial" | "failed";

/** First N members of the list — enough to validate a workbook without spending on the whole list. */
const SAMPLE_SIZE = 10;
/** Conservative per-row floor used only for the upfront balance check; real cost is metered per-row as usual. */
const MIN_CREDIT_PER_ROW = 1;

export interface WorkbookRunRecord {
  id: string;
  workbookId: string;
  workspaceId: string;
  listId: string;
  mode: RunMode;
  targetProspectIds: string[];
  batchId: string | null;
  status: RunStatus;
  totalRows: number;
  processedRows: number;
  succeededRows: number;
  failedRows: number;
  creditsBudget: number | null;
  creditsUsed: number;
  rerunOfRunId: string | null;
  errorMessage: string | null;
  queuedAt: string;
  startedAt: string | null;
  pausedAt: string | null;
  completedAt: string | null;
}

function serialize(row: typeof enrichmentWorkbookRuns.$inferSelect): WorkbookRunRecord {
  return {
    id: row.id,
    workbookId: row.workbookId,
    workspaceId: row.workspaceId,
    listId: row.listId,
    mode: row.mode as RunMode,
    targetProspectIds: row.targetProspectIds as string[],
    batchId: row.batchId,
    status: row.status as RunStatus,
    totalRows: row.totalRows,
    processedRows: row.processedRows,
    succeededRows: row.succeededRows,
    failedRows: row.failedRows,
    creditsBudget: row.creditsBudget,
    creditsUsed: row.creditsUsed,
    rerunOfRunId: row.rerunOfRunId,
    errorMessage: row.errorMessage,
    queuedAt: row.queuedAt.toISOString(),
    startedAt: row.startedAt?.toISOString() ?? null,
    pausedAt: row.pausedAt?.toISOString() ?? null,
    completedAt: row.completedAt?.toISOString() ?? null,
  };
}

async function resolveTargetProspectIds(
  db: Db,
  config: Env,
  workspaceId: string,
  workbookId: string,
  listId: string,
  mode: RunMode,
  selectedProspectIds: string[] | undefined
): Promise<string[]> {
  const enrichmentService = buildEnrichmentService(db, config);
  const memberIds = await enrichmentService.getListMemberIds(workspaceId, listId);
  const memberSet = new Set(memberIds);

  if (mode === "selected") {
    if (!selectedProspectIds?.length) {
      throw new HttpError("selected_prospect_ids_required", 400);
    }
    const resolved = selectedProspectIds.filter((id) => memberSet.has(id));
    if (resolved.length === 0) throw new HttpError("no_matching_list_members", 400);
    return resolved;
  }

  if (mode === "sample") {
    return memberIds.slice(0, SAMPLE_SIZE);
  }

  if (mode === "scheduled") {
    return memberIds;
  }

  // changed_rows: members with no completed job from a prior run of this workbook, or whose
  // activation snapshot has been touched since their last completed enrichment.
  const priorRuns = await db
    .select({ batchId: enrichmentWorkbookRuns.batchId })
    .from(enrichmentWorkbookRuns)
    .where(
      and(
        eq(enrichmentWorkbookRuns.workbookId, workbookId),
        inArray(enrichmentWorkbookRuns.status, ["completed", "partial"])
      )
    );
  const priorBatchIds = priorRuns.map((r) => r.batchId).filter((id): id is string => id != null);

  const lastCompletedByProspect = new Map<string, Date>();
  if (priorBatchIds.length > 0) {
    const completedJobs = await db
      .select({ prospectId: enrichmentJobs.prospectId, completedAt: enrichmentJobs.completedAt })
      .from(enrichmentJobs)
      .where(and(inArray(enrichmentJobs.batchId, priorBatchIds), eq(enrichmentJobs.status, "completed")));
    for (const job of completedJobs) {
      if (!job.completedAt) continue;
      const existing = lastCompletedByProspect.get(job.prospectId);
      if (!existing || job.completedAt > existing) lastCompletedByProspect.set(job.prospectId, job.completedAt);
    }
  }

  const changed: string[] = [];
  for (const prospectId of memberIds) {
    const lastCompleted = lastCompletedByProspect.get(prospectId);
    if (!lastCompleted) {
      changed.push(prospectId);
      continue;
    }
    const activation = await enrichmentService.getActivation(workspaceId, prospectId);
    if (activation && new Date(activation.updatedAt) > lastCompleted) changed.push(prospectId);
  }
  return changed;
}

async function createAndEnqueueRun(
  db: Db,
  config: Env,
  workspaceId: string,
  workbookId: string,
  listId: string,
  mode: RunMode,
  targetProspectIds: string[],
  budgetCreditsPerRun: number | null,
  rerunOfRunId: string | null = null
): Promise<WorkbookRunRecord> {
  if (targetProspectIds.length === 0) throw new HttpError("no_target_rows", 400);

  const enrichmentService = buildEnrichmentService(db, config);
  const balance = await enrichmentService.getCredits(workspaceId);
  const requiredMinimum = targetProspectIds.length * MIN_CREDIT_PER_ROW;
  if (balance < requiredMinimum) {
    throw new InsufficientCreditsError(requiredMinimum, balance);
  }

  const [row] = await db
    .insert(enrichmentWorkbookRuns)
    .values({
      workbookId,
      workspaceId,
      listId,
      mode,
      targetProspectIds,
      status: "pending",
      totalRows: targetProspectIds.length,
      creditsBudget: budgetCreditsPerRun,
      rerunOfRunId,
    })
    .returning();

  await enqueueWorkbookRunJob(config, { runId: row!.id, workspaceId });
  return serialize(row!);
}

export interface StartWorkbookRunInput {
  listId: string;
  mode: RunMode;
  selectedProspectIds?: string[];
}

/**
 * Starts a new run. "sample" mode is always allowed (safe to test a draft workbook);
 * every other mode requires the workbook to be active — production activation is an
 * explicit step, never an implicit side effect of a test run.
 */
export async function startWorkbookRun(
  db: Db,
  config: Env,
  workspaceId: string,
  workbookId: string,
  input: StartWorkbookRunInput
): Promise<WorkbookRunRecord> {
  const workbook = await getWorkbook(db, workspaceId, workbookId);
  if (!workbook) throw new HttpError("workbook_not_found", 404);
  if (input.mode !== "sample" && workbook.status !== "active") {
    throw new HttpError("workbook_not_active", 409);
  }

  const targetProspectIds = await resolveTargetProspectIds(
    db,
    config,
    workspaceId,
    workbookId,
    input.listId,
    input.mode,
    input.selectedProspectIds
  );

  return createAndEnqueueRun(
    db,
    config,
    workspaceId,
    workbookId,
    input.listId,
    input.mode,
    targetProspectIds,
    workbook.budgetCreditsPerRun
  );
}

export async function getWorkbookRun(
  db: Db,
  workspaceId: string,
  runId: string
): Promise<WorkbookRunRecord | null> {
  const [row] = await db
    .select()
    .from(enrichmentWorkbookRuns)
    .where(scopedById(enrichmentWorkbookRuns, workspaceId, runId));
  return row ? serialize(row) : null;
}

export async function listWorkbookRuns(
  db: Db,
  workspaceId: string,
  workbookId: string
): Promise<WorkbookRunRecord[]> {
  const rows = await db
    .select()
    .from(enrichmentWorkbookRuns)
    .where(
      scopedTo(enrichmentWorkbookRuns, workspaceId, eq(enrichmentWorkbookRuns.workbookId, workbookId))
    )
    .orderBy(desc(enrichmentWorkbookRuns.queuedAt));
  return rows.map(serialize);
}

const PAUSABLE_STATUSES = new Set<RunStatus>(["pending", "running"]);

/** Cooperative pause — the runner checks between rows and stops before the next one. */
export async function pauseWorkbookRun(
  db: Db,
  workspaceId: string,
  runId: string
): Promise<WorkbookRunRecord> {
  const run = await getWorkbookRun(db, workspaceId, runId);
  if (!run) throw new HttpError("run_not_found", 404);
  if (!PAUSABLE_STATUSES.has(run.status)) throw new HttpError("run_not_pausable", 409);

  const [row] = await db
    .update(enrichmentWorkbookRuns)
    .set({ status: "paused", pausedAt: new Date() })
    .where(eq(enrichmentWorkbookRuns.id, runId))
    .returning();
  return serialize(row!);
}

/** Resumes from processedRows — targetProspectIds is fixed at start, so the index-based resume is safe. */
export async function resumeWorkbookRun(
  db: Db,
  config: Env,
  workspaceId: string,
  runId: string
): Promise<WorkbookRunRecord> {
  const run = await getWorkbookRun(db, workspaceId, runId);
  if (!run) throw new HttpError("run_not_found", 404);
  if (run.status !== "paused") throw new HttpError("run_not_paused", 409);

  const [row] = await db
    .update(enrichmentWorkbookRuns)
    .set({ status: "running", pausedAt: null })
    .where(eq(enrichmentWorkbookRuns.id, runId))
    .returning();
  await enqueueWorkbookRunJob(config, { runId, workspaceId });
  return serialize(row!);
}

const RERUNNABLE_STATUSES = new Set<RunStatus>(["completed", "partial", "failed"]);

/**
 * Reruns only the rows that didn't complete last time — never the whole workbook.
 * A row counts as failed if it isn't among the prior run's completed enrichmentJobs,
 * which also covers rows that never got a job created at all (e.g. missing activation).
 */
export async function rerunFailedRows(
  db: Db,
  config: Env,
  workspaceId: string,
  runId: string
): Promise<WorkbookRunRecord> {
  const run = await getWorkbookRun(db, workspaceId, runId);
  if (!run) throw new HttpError("run_not_found", 404);
  if (!RERUNNABLE_STATUSES.has(run.status)) throw new HttpError("run_not_rerunnable", 409);
  if (run.failedRows === 0) throw new HttpError("no_failed_rows", 409);

  let completedProspectIds = new Set<string>();
  if (run.batchId) {
    const completedJobs = await db
      .select({ prospectId: enrichmentJobs.prospectId })
      .from(enrichmentJobs)
      .where(and(eq(enrichmentJobs.batchId, run.batchId), eq(enrichmentJobs.status, "completed")));
    completedProspectIds = new Set(completedJobs.map((j) => j.prospectId));
  }
  const failedProspectIds = run.targetProspectIds.filter((id) => !completedProspectIds.has(id));
  if (failedProspectIds.length === 0) throw new HttpError("no_failed_rows", 409);

  const workbook = await getWorkbook(db, workspaceId, run.workbookId);
  if (!workbook) throw new HttpError("workbook_not_found", 404);

  return createAndEnqueueRun(
    db,
    config,
    workspaceId,
    run.workbookId,
    run.listId,
    "selected",
    failedProspectIds,
    workbook.budgetCreditsPerRun,
    run.id
  );
}

export interface RunRowColumnCell {
  status: "pending" | "succeeded" | "failed";
  value: string | null;
  error: string | null;
}

export interface RunRowRecord {
  prospectId: string;
  fullName: string | null;
  companyName: string | null;
  companyDomain: string | null;
  email: string | null;
  phone: string | null;
  title: string | null;
  /** Keyed by the flexible column's `key` — see workbook-column.service.ts. */
  columns: Record<string, RunRowColumnCell>;
}

/**
 * §8.3 Task ADI-12 — the grid's single data source: one row per target prospect, the fixed
 * fields read from the current activation snapshot (the same "current value" source of truth
 * enrichProspect itself folds into — see enrichment/service.ts), plus every flexible column's
 * computed cell for this run. Returns null (not an empty array) when the run itself isn't found,
 * so the route can 404 instead of rendering an empty grid.
 */
export async function getRunRows(db: Db, workspaceId: string, runId: string): Promise<RunRowRecord[] | null> {
  const run = await getWorkbookRun(db, workspaceId, runId);
  if (!run) return null;

  const activations =
    run.targetProspectIds.length === 0
      ? []
      : await db
          .select({ prospectId: prospectActivations.prospectId, snapshot: prospectActivations.snapshot })
          .from(prospectActivations)
          .where(
            scopedTo(prospectActivations, workspaceId, inArray(prospectActivations.prospectId, run.targetProspectIds))
          );
  const snapshotByProspect = new Map(activations.map((a) => [a.prospectId, a.snapshot as Record<string, unknown>]));

  const [columns, columnValues] = await Promise.all([
    listColumns(db, workspaceId, run.workbookId),
    getColumnValuesForRun(db, workspaceId, runId),
  ]);
  const columnKeyById = new Map(columns.map((c) => [c.id, c.key]));

  const cellsByProspect = new Map<string, Record<string, RunRowColumnCell>>();
  for (const v of columnValues) {
    const key = columnKeyById.get(v.columnDefinitionId);
    if (!key) continue;
    const bucket = cellsByProspect.get(v.prospectId) ?? {};
    bucket[key] = { status: v.status, value: v.value, error: v.error };
    cellsByProspect.set(v.prospectId, bucket);
  }

  return run.targetProspectIds.map((prospectId) => {
    const snap = snapshotByProspect.get(prospectId) ?? {};
    const company = snap.company as { companyName?: string } | undefined;
    const str = (v: unknown): string | null => (typeof v === "string" && v.length > 0 ? v : null);
    return {
      prospectId,
      fullName: str(snap.fullName),
      companyName: str(company?.companyName) ?? str(snap.companyName),
      companyDomain: str(snap.companyDomain),
      email: str(snap.email),
      phone: str(snap.phone),
      title: str(snap.title),
      columns: cellsByProspect.get(prospectId) ?? {},
    };
  });
}
