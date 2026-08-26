import { and, desc, eq } from "drizzle-orm";
import type { Db } from "@skout/db";
import { schema } from "@skout/db";
import { HttpError } from "../utils/http.js";
import { incrJourneyMetric } from "./journey-metrics.js";

const { decisionViews, nextBestActionSuggestions, workflowRuns, asyncJobs } = schema;

export async function listDecisionViews(db: Db, workspaceId: string, status?: string) {
  const rows = status
    ? await db
        .select()
        .from(decisionViews)
        .where(and(eq(decisionViews.workspaceId, workspaceId), eq(decisionViews.status, status)))
        .orderBy(desc(decisionViews.createdAt))
        .limit(50)
    : await db
        .select()
        .from(decisionViews)
        .where(eq(decisionViews.workspaceId, workspaceId))
        .orderBy(desc(decisionViews.createdAt))
        .limit(50);
  return rows;
}

export async function getDecisionView(db: Db, workspaceId: string, id: string) {
  const [row] = await db
    .select()
    .from(decisionViews)
    .where(and(eq(decisionViews.id, id), eq(decisionViews.workspaceId, workspaceId)))
    .limit(1);
  if (!row) throw new HttpError("Decision not found", 404);
  return row;
}

/** Materialize a decision view from the latest NBA suggestion for an entity. */
export async function createDecisionFromNba(
  db: Db,
  opts: {
    workspaceId: string;
    entityType: "contact" | "deal";
    entityId: string;
    userId?: string;
  }
) {
  const [suggestion] = await db
    .select()
    .from(nextBestActionSuggestions)
    .where(
      and(
        eq(nextBestActionSuggestions.workspaceId, opts.workspaceId),
        eq(nextBestActionSuggestions.entityType, opts.entityType),
        eq(nextBestActionSuggestions.entityId, opts.entityId)
      )
    )
    .orderBy(desc(nextBestActionSuggestions.createdAt))
    .limit(1);

  const title = suggestion?.headline ?? `Decide next step for ${opts.entityType} ${opts.entityId}`;
  const recommendation = suggestion?.rationale ?? "Review activity and choose an option.";
  const options = [
    { id: "act", label: suggestion?.actionType ?? "act", primary: true },
    { id: "wait", label: "Wait", primary: false },
    { id: "dismiss", label: "Dismiss", primary: false },
  ];

  const [row] = await db
    .insert(decisionViews)
    .values({
      workspaceId: opts.workspaceId,
      title,
      kind: "next_best_action",
      recommendation,
      options,
      evidenceIds: [],
      expectedOutcome: { actionType: suggestion?.actionType ?? null, suggestionId: suggestion?.id ?? null },
      entityType: opts.entityType,
      entityId: opts.entityId,
      createdBy: opts.userId,
    })
    .returning();

  incrJourneyMetric("decisionViewCreate");
  return row!;
}

export async function decideView(
  db: Db,
  workspaceId: string,
  id: string,
  choice: "decided" | "dismissed"
) {
  const [row] = await db
    .update(decisionViews)
    .set({ status: choice === "decided" ? "decided" : "dismissed", decidedAt: new Date(), updatedAt: new Date() })
    .where(and(eq(decisionViews.id, id), eq(decisionViews.workspaceId, workspaceId)))
    .returning();
  if (!row) throw new HttpError("Decision not found", 404);
  return row;
}

export async function startWorkflowRun(
  db: Db,
  opts: {
    workspaceId: string;
    name: string;
    steps?: Array<{ name: string; status?: string }>;
    asyncJobId?: string;
    correlationId?: string;
    userId?: string;
  }
) {
  const [row] = await db
    .insert(workflowRuns)
    .values({
      workspaceId: opts.workspaceId,
      name: opts.name,
      status: "running",
      steps: (opts.steps ?? [{ name: "start", status: "running" }]).map((s) => ({
        name: s.name,
        status: s.status ?? "pending",
      })),
      asyncJobId: opts.asyncJobId,
      correlationId: opts.correlationId,
      createdBy: opts.userId,
      startedAt: new Date(),
    })
    .returning();
  incrJourneyMetric("workflowRunStart");
  return row!;
}

export async function getWorkflowRun(db: Db, workspaceId: string, id: string) {
  const [row] = await db
    .select()
    .from(workflowRuns)
    .where(and(eq(workflowRuns.id, id), eq(workflowRuns.workspaceId, workspaceId)))
    .limit(1);
  if (!row) throw new HttpError("Workflow run not found", 404);

  let asyncJob = null;
  if (row.asyncJobId) {
    const [job] = await db.select().from(asyncJobs).where(eq(asyncJobs.id, row.asyncJobId)).limit(1);
    asyncJob = job ?? null;
  }
  return { ...row, asyncJob };
}

export async function completeWorkflowRun(
  db: Db,
  workspaceId: string,
  id: string,
  status: "completed" | "failed" | "cancelled",
  errorMessage?: string
) {
  const [row] = await db
    .update(workflowRuns)
    .set({ status, errorMessage, completedAt: new Date() })
    .where(and(eq(workflowRuns.id, id), eq(workflowRuns.workspaceId, workspaceId)))
    .returning();
  if (!row) throw new HttpError("Workflow run not found", 404);
  return row;
}

export async function listWorkflowRuns(db: Db, workspaceId: string) {
  return db
    .select()
    .from(workflowRuns)
    .where(eq(workflowRuns.workspaceId, workspaceId))
    .orderBy(desc(workflowRuns.createdAt))
    .limit(50);
}
