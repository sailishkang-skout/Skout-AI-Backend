import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { getMemberPermissions } from "@skout/auth";
import { COPS_DASHBOARDS, COPS_METRICS, copsErrorBody, getMetric, resolveCorrelationId, type CopsDashboard } from "@skout/shared";
import { DashboardError, dashboard, drill, type DashboardFilters } from "../services/cops-dashboards.service.js";
import { funnelCohorts } from "../services/cops-funnel.service.js";
import { feedStatus } from "../services/cops-analytics-feed.service.js";

/**
 * COPS-13 analytics (Bible p.59, p.87-88): the metric catalog, role dashboards, drill-through and
 * funnel cohorts. Dashboards need analytics:read (Finance, which has no analytics grant, reaches
 * its own dashboard with billing:read). Each KPI also needs the read permission of its resource:
 * without it the KPI is restricted, and its drill-through is 403. Errors use the COPS envelope.
 */
const filterSchema = z
  .object({
    from: z.string().datetime({ offset: true }).optional(),
    to: z.string().datetime({ offset: true }).optional(),
    segment: z.enum(["smb", "mid_market", "enterprise"]).optional(),
    owner: z.string().uuid().optional(),
    geo: z.string().min(1).max(100).optional(),
  })
  .strict();
const pageSchema = z.object({ cursor: z.string().max(40).optional(), limit: z.coerce.number().int().min(1).max(200).optional() });

const STATUS: Record<DashboardError["code"], number> = { VALIDATION_FAILED: 422, NOT_FOUND: 404, FORBIDDEN: 403 };

export async function copsAnalyticsRoutes(app: FastifyInstance) {
  const db = () => {
    if (!app.db) throw new DashboardError("NOT_FOUND", "Database not available");
    return app.db;
  };
  const permsOf = (ws: string, user: string) => getMemberPermissions(db(), ws, user);

  type Req = { workspaceId?: string; userId?: string; headers: Record<string, unknown> };
  type Reply = { status: (code: number) => Reply; send: (body: unknown) => unknown };

  async function guarded(request: Req, reply: Reply, allowed: (granted: string[]) => boolean, fn: (granted: string[]) => Promise<unknown>) {
    const requestId = resolveCorrelationId(request.headers["x-request-id"] as string | undefined);
    if (!request.workspaceId || !request.userId) return reply.status(401).send(copsErrorBody({ code: "UNAUTHENTICATED", message: "Missing workspace context", requestId }));
    const granted = await permsOf(request.workspaceId, request.userId);
    if (!allowed(granted)) {
      return reply.status(403).send(copsErrorBody({ code: "FORBIDDEN", message: "You do not have permission to see this dashboard", requestId, details: { required_permission: "analytics:read" } }));
    }
    try {
      return reply.status(200).send({ data: await fn(granted) });
    } catch (error) {
      if (error instanceof z.ZodError) {
        return reply.status(422).send(
          copsErrorBody({
            code: "VALIDATION_FAILED",
            message: error.issues[0]?.message ?? "Invalid request",
            requestId,
            details: { fields: error.issues.map((i) => ({ path: i.path.join(".") || "query", message: i.message })) },
          })
        );
      }
      if (error instanceof DashboardError) return reply.status(STATUS[error.code]).send(copsErrorBody({ code: error.code, message: error.message, requestId }));
      throw error;
    }
  }

  const canReadResource = (granted: string[]) => (resource: string) => granted.includes(`${resource}:read`);
  const dashboardAllowed = (key: CopsDashboard) => (granted: string[]) => granted.includes("analytics:read") || (key === "finance" && granted.includes("billing:read"));

  app.get("/cops/metrics/catalog", async (request, reply) =>
    guarded(request, reply, (g) => g.includes("analytics:read") || g.includes("billing:read"), async () => COPS_METRICS)
  );

  app.get("/cops/dashboards/:dashboard", async (request, reply) => {
    const parsed = z.object({ dashboard: z.enum(COPS_DASHBOARDS) }).safeParse(request.params);
    const key = parsed.success ? parsed.data.dashboard : "leadership";
    return guarded(request, reply, dashboardAllowed(key), async (granted) => {
      if (!parsed.success) throw new DashboardError("NOT_FOUND", "Unknown dashboard");
      const f = filterSchema.parse(request.query ?? {}) as DashboardFilters;
      return dashboard(db(), request.workspaceId!, key, f, canReadResource(granted));
    });
  });

  app.get("/cops/dashboards/kpis/:metricId/drill", async (request, reply) => {
    const { metricId } = z.object({ metricId: z.string().min(1).max(80) }).parse(request.params);
    const def = getMetric(metricId);
    return guarded(
      request,
      reply,
      (g) => g.includes("analytics:read") || (def?.dashboards.includes("finance") === true && g.includes("billing:read")),
      async (granted) => {
        if (!def) throw new DashboardError("NOT_FOUND", "Unknown metric");
        if (!canReadResource(granted)(def.resource)) throw new DashboardError("FORBIDDEN", `This metric needs ${def.resource}:read`);
        const q = (request.query ?? {}) as Record<string, unknown>;
        const { cursor, limit, ...rest } = q;
        const f = filterSchema.parse(rest) as DashboardFilters;
        return drill(db(), request.workspaceId!, def.id, f, pageSchema.parse({ cursor, limit }));
      }
    );
  });

  app.get("/cops/funnel", async (request, reply) =>
    guarded(request, reply, (g) => g.includes("analytics:read"), async () => funnelCohorts(db(), request.workspaceId!, filterSchema.parse(request.query ?? {}) as DashboardFilters))
  );

  /** Warehouse feed health (analytics:admin): whether it is on and how far behind this workspace's events are. */
  app.get("/cops/analytics/feed", async (request, reply) =>
    guarded(request, reply, (g) => g.includes("analytics:admin"), async () => feedStatus(db(), { apiKey: app.config.POSTHOG_API_KEY }, request.workspaceId!))
  );
}
