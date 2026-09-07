import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { HttpError, errorResponse, requireWorkspaceId } from "../utils/http.js";
import {
  WORKBOOK_COLUMN_TYPES,
  createColumn,
  deleteColumn,
  getColumnValuesForRun,
  listColumns,
} from "../services/workbook-column.service.js";

const createColumnSchema = z
  .object({
    key: z.string().min(1).max(64),
    label: z.string().min(1).max(200),
    columnType: z.enum(WORKBOOK_COLUMN_TYPES),
    template: z.string().min(1).optional(),
    promptTemplate: z.string().min(1).optional(),
  })
  .refine((body) => (body.columnType === "derived" ? !!body.template : !!body.promptTemplate), {
    message: "derived columns require `template`; ai_research columns require `promptTemplate`",
  });

function handleError(err: unknown, reply: { status: (code: number) => { send: (body: unknown) => unknown } }) {
  if (err instanceof HttpError) {
    return reply.status(err.statusCode).send(errorResponse(err.message, err.statusCode, err.details));
  }
  throw err;
}

/** §8.3 Task ADI-12 — CRUD for a workbook's flexible (derived/ai_research) columns, plus
 * reading a run's computed cell values for the grid. See
 * docs/superpowers/specs/2026-09-05-workbook-flexible-columns-design.md. */
export async function workbookColumnRoutes(app: FastifyInstance) {
  app.post("/workbooks/:id/columns", async (request, reply) => {
    const { id } = request.params as { id: string };
    const workspaceId = requireWorkspaceId(request);
    const body = createColumnSchema.parse(request.body ?? {});
    if (!app.db) return reply.status(503).send({ error: "database_unavailable" });
    try {
      const column = await createColumn(app.db, workspaceId, id, {
        key: body.key,
        label: body.label,
        columnType: body.columnType,
        config: body.columnType === "derived" ? { template: body.template! } : { promptTemplate: body.promptTemplate! },
      });
      return reply.status(201).send(column);
    } catch (err) {
      return handleError(err, reply);
    }
  });

  app.get("/workbooks/:id/columns", async (request, reply) => {
    const { id } = request.params as { id: string };
    const workspaceId = requireWorkspaceId(request);
    if (!app.db) return reply.send({ data: [], total: 0 });
    const data = await listColumns(app.db, workspaceId, id);
    return reply.send({ data, total: data.length });
  });

  app.delete("/workbooks/:id/columns/:columnId", async (request, reply) => {
    const { id, columnId } = request.params as { id: string; columnId: string };
    const workspaceId = requireWorkspaceId(request);
    if (!app.db) return reply.status(503).send({ error: "database_unavailable" });
    try {
      const deleted = await deleteColumn(app.db, workspaceId, id, columnId);
      if (!deleted) return reply.status(404).send({ error: "column_not_found" });
      return reply.status(204).send();
    } catch (err) {
      return handleError(err, reply);
    }
  });

  /** The grid's data source for flexible-column cells (fixed-field cells still come from the
   * existing run/enrichment surfaces). */
  app.get("/workbooks/:id/runs/:runId/columns", async (request, reply) => {
    const { runId } = request.params as { id: string; runId: string };
    const workspaceId = requireWorkspaceId(request);
    if (!app.db) return reply.send({ data: [], total: 0 });
    const data = await getColumnValuesForRun(app.db, workspaceId, runId);
    return reply.send({ data, total: data.length });
  });
}
