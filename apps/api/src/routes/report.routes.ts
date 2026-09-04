import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { HttpError, errorResponse, requireWorkspaceId } from "../utils/http.js";
import { REPORT_CADENCE_VALUES } from "../services/report-cadence.js";
import {
  createReportSchedule,
  deleteReportSchedule,
  getReportSchedule,
  listReportSchedules,
  updateReportSchedule,
} from "../services/report-schedule.service.js";
import {
  deliverReportSchedule,
  getReportSnapshot,
  listReportSnapshots,
} from "../services/report-delivery.service.js";
import {
  getForecast,
  getForecastDetail,
  listForecasts,
  refreshModelForecast,
  setManagerAdjustment,
  setRepCommitment,
} from "../services/forecast.service.js";
import {
  buildBoardPackInput,
  generateBoardPack,
  PDF_CONTENT_TYPE,
  renderBoardPack,
  XLSX_CONTENT_TYPE,
  type BoardPackFormat,
} from "../services/board-pack-export.service.js";
import { queryGtmLearningOutcomes, runGtmLearningAggregation } from "../services/gtm-learning.service.js";

const gtmLearningQuerySchema = z.object({
  channel: z.string().max(50).optional(),
  signalType: z.string().max(100).optional(),
  variantKey: z.string().max(10).optional(),
  sequenceId: z.string().uuid().optional(),
  icpPriority: z.string().max(50).optional(),
  limit: z.coerce.number().int().min(1).max(1000).optional(),
});

const createScheduleSchema = z.object({
  name: z.string().min(1).max(200),
  cadence: z.enum(REPORT_CADENCE_VALUES),
  recipientEmails: z.array(z.string().email()).min(1),
  enabled: z.boolean().optional(),
});

const updateScheduleSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  cadence: z.enum(REPORT_CADENCE_VALUES).optional(),
  recipientEmails: z.array(z.string().email()).min(1).optional(),
  enabled: z.boolean().optional(),
});

const forecastFigureSchema = z.object({
  amount: z.number(),
  reason: z.string().min(1).max(2000),
});

const boardPackExportSchema = z.object({
  format: z.enum(["pdf", "xlsx"]).default("pdf"),
  periodLabel: z.string().min(1).max(32).optional(),
});

function formatFromQuery(query: unknown): BoardPackFormat {
  const raw = (query as { format?: string } | undefined)?.format;
  return raw === "xlsx" ? "xlsx" : "pdf";
}

function handleError(err: unknown, reply: { status: (code: number) => { send: (body: unknown) => unknown } }) {
  if (err instanceof HttpError) {
    return reply.status(err.statusCode).send(errorResponse(err.message, err.statusCode));
  }
  throw err;
}

/** 8.15 — scheduled report delivery (snapshot/version history) and the forecasting split. */
export async function reportRoutes(app: FastifyInstance) {
  app.post("/report-schedules", async (request, reply) => {
    const workspaceId = requireWorkspaceId(request);
    const body = createScheduleSchema.parse(request.body ?? {});
    if (!app.db) return reply.status(503).send({ error: "database_unavailable" });
    const schedule = await createReportSchedule(app.db, workspaceId, body);
    return reply.status(201).send(schedule);
  });

  app.get("/report-schedules", async (request, reply) => {
    const workspaceId = requireWorkspaceId(request);
    if (!app.db) return reply.send({ data: [], total: 0 });
    const data = await listReportSchedules(app.db, workspaceId);
    return reply.send({ data, total: data.length });
  });

  app.get("/report-schedules/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const workspaceId = requireWorkspaceId(request);
    if (!app.db) return reply.status(503).send({ error: "database_unavailable" });
    const schedule = await getReportSchedule(app.db, workspaceId, id);
    if (!schedule) return reply.status(404).send({ error: "schedule_not_found" });
    return reply.send(schedule);
  });

  app.patch("/report-schedules/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const workspaceId = requireWorkspaceId(request);
    const body = updateScheduleSchema.parse(request.body ?? {});
    if (!app.db) return reply.status(503).send({ error: "database_unavailable" });
    const schedule = await updateReportSchedule(app.db, workspaceId, id, body);
    if (!schedule) return reply.status(404).send({ error: "schedule_not_found" });
    return reply.send(schedule);
  });

  app.delete("/report-schedules/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const workspaceId = requireWorkspaceId(request);
    if (!app.db) return reply.status(503).send({ error: "database_unavailable" });
    const deleted = await deleteReportSchedule(app.db, workspaceId, id);
    if (!deleted) return reply.status(404).send({ error: "schedule_not_found" });
    return reply.status(204).send();
  });

  /** Trigger delivery right now, outside the schedule's normal cadence (e.g. for testing). */
  app.post("/report-schedules/:id/deliver", async (request, reply) => {
    const { id } = request.params as { id: string };
    const workspaceId = requireWorkspaceId(request);
    if (!app.db) return reply.status(503).send({ error: "database_unavailable" });
    try {
      const result = await deliverReportSchedule(app.db, app.config, workspaceId, id);
      return reply.send(result);
    } catch (err) {
      return handleError(err, reply);
    }
  });

  app.get("/report-schedules/:id/snapshots", async (request, reply) => {
    const { id } = request.params as { id: string };
    const workspaceId = requireWorkspaceId(request);
    if (!app.db) return reply.send({ data: [], total: 0 });
    const data = await listReportSnapshots(app.db, workspaceId, id);
    return reply.send({ data, total: data.length });
  });

  app.get("/report-schedules/:id/snapshots/:snapshotId", async (request, reply) => {
    const { snapshotId } = request.params as { id: string; snapshotId: string };
    const workspaceId = requireWorkspaceId(request);
    if (!app.db) return reply.status(503).send({ error: "database_unavailable" });
    const snapshot = await getReportSnapshot(app.db, workspaceId, snapshotId);
    if (!snapshot) return reply.status(404).send({ error: "snapshot_not_found" });
    return reply.send(snapshot);
  });

  /** 8.15 task 33 — board-pack export of a specific historical snapshot (PDF or XLSX). */
  app.get("/report-schedules/:id/snapshots/:snapshotId/export", async (request, reply) => {
    const { snapshotId } = request.params as { id: string; snapshotId: string };
    const workspaceId = requireWorkspaceId(request);
    const format = formatFromQuery(request.query);
    if (!app.db) return reply.status(503).send({ error: "database_unavailable" });
    const snapshot = await getReportSnapshot(app.db, workspaceId, snapshotId);
    if (!snapshot) return reply.status(404).send({ error: "snapshot_not_found" });

    const periodLabel = new Date(snapshot.generatedAt).toISOString().slice(0, 7);
    const forecast = await getForecast(app.db, workspaceId, periodLabel);
    const input = buildBoardPackInput(snapshot, forecast);
    const buffer = await renderBoardPack(input, format);

    reply.header("Content-Type", format === "xlsx" ? XLSX_CONTENT_TYPE : PDF_CONTENT_TYPE);
    reply.header("Content-Disposition", `attachment; filename="board-pack-v${snapshot.version}.${format}"`);
    return reply.send(buffer);
  });

  /** 8.15 task 33 — ad-hoc board-pack export from the live rollup (also saves a snapshot). */
  app.post("/board-pack/export", async (request, reply) => {
    const workspaceId = requireWorkspaceId(request);
    const body = boardPackExportSchema.parse(request.body ?? {});
    if (!app.db) return reply.status(503).send({ error: "database_unavailable" });

    const { buffer, filename, contentType } = await generateBoardPack(app.db, app.config, workspaceId, body);

    reply.header("Content-Type", contentType);
    reply.header("Content-Disposition", `attachment; filename="${filename}"`);
    return reply.send(buffer);
  });

  // --- Forecasting split (model / manager-adjusted / rep-committed) ---

  app.post("/forecasts/:periodLabel/refresh-model", async (request, reply) => {
    const { periodLabel } = request.params as { periodLabel: string };
    const workspaceId = requireWorkspaceId(request);
    if (!app.db) return reply.status(503).send({ error: "database_unavailable" });
    const forecast = await refreshModelForecast(app.db, app.config, workspaceId, periodLabel);
    return reply.send(forecast);
  });

  app.get("/forecasts", async (request, reply) => {
    const workspaceId = requireWorkspaceId(request);
    if (!app.db) return reply.send({ data: [], total: 0 });
    const data = await listForecasts(app.db, workspaceId);
    return reply.send({ data, total: data.length });
  });

  /** §8.15 SS-03 — the detail view: adds the historical uncertainty band and the open-pipeline
   * data-gaps list on top of the plain model/manager/rep figures `getForecast` returns. */
  app.get("/forecasts/:periodLabel", async (request, reply) => {
    const { periodLabel } = request.params as { periodLabel: string };
    const workspaceId = requireWorkspaceId(request);
    if (!app.db) return reply.status(503).send({ error: "database_unavailable" });
    const forecast = await getForecastDetail(app.db, workspaceId, periodLabel);
    if (!forecast) return reply.status(404).send({ error: "forecast_not_found" });
    return reply.send(forecast);
  });

  app.put("/forecasts/:periodLabel/manager-adjustment", async (request, reply) => {
    const { periodLabel } = request.params as { periodLabel: string };
    const workspaceId = requireWorkspaceId(request);
    const body = forecastFigureSchema.parse(request.body ?? {});
    if (!app.db) return reply.status(503).send({ error: "database_unavailable" });
    try {
      const forecast = await setManagerAdjustment(app.db, workspaceId, periodLabel, {
        ...body,
        userId: request.userId,
      });
      return reply.send(forecast);
    } catch (err) {
      return handleError(err, reply);
    }
  });

  app.put("/forecasts/:periodLabel/rep-commitment", async (request, reply) => {
    const { periodLabel } = request.params as { periodLabel: string };
    const workspaceId = requireWorkspaceId(request);
    const body = forecastFigureSchema.parse(request.body ?? {});
    if (!app.db) return reply.status(503).send({ error: "database_unavailable" });
    try {
      const forecast = await setRepCommitment(app.db, workspaceId, periodLabel, {
        ...body,
        userId: request.userId,
      });
      return reply.send(forecast);
    } catch (err) {
      return handleError(err, reply);
    }
  });

  // §8.15 SP-10 — GTM-learning cross-tab: slice by any combination of ICP/signal/message/
  // sequence/channel; the sweep worker keeps the table current on its own schedule, this is
  // read-only.
  app.get("/gtm-learning-outcomes", async (request, reply) => {
    const workspaceId = requireWorkspaceId(request);
    if (!app.db) return reply.send({ data: [], total: 0 });
    const query = gtmLearningQuerySchema.parse(request.query ?? {});
    const { limit, ...filters } = query;
    const data = await queryGtmLearningOutcomes(app.db, workspaceId, filters, limit);
    return reply.send({ data, total: data.length });
  });

  // On-demand refresh — useful right after a backfill/test-data seed, without waiting for the
  // next scheduled sweep tick.
  app.post("/gtm-learning-outcomes/refresh", async (request, reply) => {
    const workspaceId = requireWorkspaceId(request);
    if (!app.db) return reply.status(503).send({ error: "database_unavailable" });
    const result = await runGtmLearningAggregation(app.db, workspaceId);
    return reply.send({ data: result });
  });
}
