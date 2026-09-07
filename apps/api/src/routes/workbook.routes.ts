import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { InsufficientCreditsError } from "../services/enrichment/index.js";
import {
  activateWorkbook,
  createWorkbook,
  getWorkbook,
  listWorkbooks,
  updateWorkbook,
} from "../services/workbook.service.js";
import {
  getRunRows,
  getWorkbookRun,
  listWorkbookRuns,
  pauseWorkbookRun,
  rerunFailedRows,
  resumeWorkbookRun,
  startWorkbookRun,
} from "../services/workbook-run.service.js";
import { HttpError, errorResponse, requireWorkspaceId } from "../utils/http.js";

const ENRICH_FIELDS = ["company", "email", "validation", "phone"] as const;

const createWorkbookSchema = z.object({
  name: z.string().min(1).max(200),
  fields: z.array(z.enum(ENRICH_FIELDS)).min(1),
  emailQualityThreshold: z.number().min(0).max(1).optional(),
  budgetCreditsPerRun: z.number().int().positive().optional(),
});

const updateWorkbookSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  fields: z.array(z.enum(ENRICH_FIELDS)).min(1).optional(),
  emailQualityThreshold: z.number().min(0).max(1).nullable().optional(),
  budgetCreditsPerRun: z.number().int().positive().nullable().optional(),
});

const startRunSchema = z.object({
  listId: z.string().uuid(),
  mode: z.enum(["sample", "selected", "changed_rows", "scheduled"]),
  selectedProspectIds: z.array(z.string()).optional(),
});

function handleError(err: unknown, reply: { status: (code: number) => { send: (body: unknown) => unknown } }) {
  if (err instanceof InsufficientCreditsError) {
    return reply.status(402).send({ error: "insufficient_credits", required: err.required, available: err.available });
  }
  if (err instanceof HttpError) {
    return reply.status(err.statusCode).send(errorResponse(err.message, err.statusCode));
  }
  throw err;
}

/** 8.3 Enrichment workbooks — a named waterfall config plus pausable/resumable batch runs. */
export async function workbookRoutes(app: FastifyInstance) {
  app.post("/workbooks", async (request, reply) => {
    const workspaceId = requireWorkspaceId(request);
    const body = createWorkbookSchema.parse(request.body ?? {});
    if (!app.db) return reply.status(503).send({ error: "database_unavailable" });
    const workbook = await createWorkbook(app.db, workspaceId, body);
    return reply.status(201).send(workbook);
  });

  app.get("/workbooks", async (request, reply) => {
    const workspaceId = requireWorkspaceId(request);
    if (!app.db) return reply.send({ data: [], total: 0 });
    const data = await listWorkbooks(app.db, workspaceId);
    return reply.send({ data, total: data.length });
  });

  app.get("/workbooks/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const workspaceId = requireWorkspaceId(request);
    if (!app.db) return reply.status(503).send({ error: "database_unavailable" });
    const workbook = await getWorkbook(app.db, workspaceId, id);
    if (!workbook) return reply.status(404).send({ error: "workbook_not_found" });
    return reply.send(workbook);
  });

  app.patch("/workbooks/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const workspaceId = requireWorkspaceId(request);
    const body = updateWorkbookSchema.parse(request.body ?? {});
    if (!app.db) return reply.status(503).send({ error: "database_unavailable" });
    const workbook = await updateWorkbook(app.db, workspaceId, id, body);
    if (!workbook) return reply.status(404).send({ error: "workbook_not_found" });
    return reply.send(workbook);
  });

  /** Explicit production-activation step — never an implicit side effect of a sample run. */
  app.post("/workbooks/:id/activate", async (request, reply) => {
    const { id } = request.params as { id: string };
    const workspaceId = requireWorkspaceId(request);
    if (!app.db) return reply.status(503).send({ error: "database_unavailable" });
    try {
      const workbook = await activateWorkbook(app.db, workspaceId, id);
      return reply.send(workbook);
    } catch (err) {
      return handleError(err, reply);
    }
  });

  app.post("/workbooks/:id/runs", async (request, reply) => {
    const { id } = request.params as { id: string };
    const workspaceId = requireWorkspaceId(request);
    const body = startRunSchema.parse(request.body ?? {});
    if (!app.db) return reply.status(503).send({ error: "database_unavailable" });
    try {
      const run = await startWorkbookRun(app.db, app.config, workspaceId, id, body);
      return reply.status(201).send(run);
    } catch (err) {
      return handleError(err, reply);
    }
  });

  app.get("/workbooks/:id/runs", async (request, reply) => {
    const { id } = request.params as { id: string };
    const workspaceId = requireWorkspaceId(request);
    if (!app.db) return reply.send({ data: [], total: 0 });
    const data = await listWorkbookRuns(app.db, workspaceId, id);
    return reply.send({ data, total: data.length });
  });

  app.get("/workbooks/:id/runs/:runId", async (request, reply) => {
    const { runId } = request.params as { id: string; runId: string };
    const workspaceId = requireWorkspaceId(request);
    if (!app.db) return reply.status(503).send({ error: "database_unavailable" });
    const run = await getWorkbookRun(app.db, workspaceId, runId);
    if (!run) return reply.status(404).send({ error: "run_not_found" });
    return reply.send(run);
  });

  /** §8.3 Task ADI-12 — the grid's data source: one row per target prospect, fixed-field
   * values plus every flexible column's computed cell for this run. */
  app.get("/workbooks/:id/runs/:runId/rows", async (request, reply) => {
    const { runId } = request.params as { id: string; runId: string };
    const workspaceId = requireWorkspaceId(request);
    if (!app.db) return reply.status(503).send({ error: "database_unavailable" });
    const rows = await getRunRows(app.db, workspaceId, runId);
    if (!rows) return reply.status(404).send({ error: "run_not_found" });
    return reply.send({ data: rows, total: rows.length });
  });

  app.post("/workbooks/:id/runs/:runId/pause", async (request, reply) => {
    const { runId } = request.params as { id: string; runId: string };
    const workspaceId = requireWorkspaceId(request);
    if (!app.db) return reply.status(503).send({ error: "database_unavailable" });
    try {
      const run = await pauseWorkbookRun(app.db, workspaceId, runId);
      return reply.send(run);
    } catch (err) {
      return handleError(err, reply);
    }
  });

  app.post("/workbooks/:id/runs/:runId/resume", async (request, reply) => {
    const { runId } = request.params as { id: string; runId: string };
    const workspaceId = requireWorkspaceId(request);
    if (!app.db) return reply.status(503).send({ error: "database_unavailable" });
    try {
      const run = await resumeWorkbookRun(app.db, app.config, workspaceId, runId);
      return reply.send(run);
    } catch (err) {
      return handleError(err, reply);
    }
  });

  /** Reruns only the failed rows from this run — never the whole workbook. */
  app.post("/workbooks/:id/runs/:runId/rerun-failed", async (request, reply) => {
    const { runId } = request.params as { id: string; runId: string };
    const workspaceId = requireWorkspaceId(request);
    if (!app.db) return reply.status(503).send({ error: "database_unavailable" });
    try {
      const run = await rerunFailedRows(app.db, app.config, workspaceId, runId);
      return reply.status(201).send(run);
    } catch (err) {
      return handleError(err, reply);
    }
  });
}
