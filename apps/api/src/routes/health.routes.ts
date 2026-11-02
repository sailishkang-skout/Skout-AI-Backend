import { timingSafeEqual } from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { formatJourneyMetricsPrometheus } from "../services/journey-metrics.js";
import { enrichmentMetricsPrometheus } from "../services/enrichment/ops.service.js";

/** §11.2 — published SLO targets (see docs/slo-targets.md). */
const SLO_TARGETS = {
  health: { availability: 0.999, p95Ms: 100 },
  authenticatedCrud: { availability: 0.995, p95Ms: 500 },
  enrichmentAi: { availability: 0.99, p95Ms: 5000 },
  warmupHealth: { availability: 0.999, p95Ms: 200 },
  sequenceEnroll: { availability: 0.995, p95Ms: 1000 },
  rpoMinutes: 5,
  rtoMinutes: 60,
  freshness: {
    evidenceLedgerMinutes: 5,
    openSearchIndexHours: 24,
    hubspotSyncMinutes: 15,
    signalToTimelineMinutes: 10,
  },
  lockedAt: "2026-08-26",
} as const;

const startedAt = Date.now();

/** Constant-time check of `Authorization: Bearer <token>`. */
function hasMetricsToken(request: FastifyRequest, token: string): boolean {
  const header = request.headers.authorization;
  if (typeof header !== "string" || !header.startsWith("Bearer ")) return false;
  const given = Buffer.from(header.slice(7).trim());
  const expected = Buffer.from(token);
  return given.length === expected.length && timingSafeEqual(given, expected);
}
let healthHits = 0;

export async function healthRoutes(app: FastifyInstance) {
  app.get("/health", async () => {
    healthHits += 1;
    return {
      status: "ok",
      service: "skout-api",
      timestamp: new Date().toISOString(),
    };
  });

  /** Machine-readable SLO target envelope for smoke/ops. */
  app.get("/slo", async () => ({
    status: "ok",
    service: "skout-api",
    doc: "docs/slo-targets.md",
    targets: SLO_TARGETS,
    timestamp: new Date().toISOString(),
  }));

  /**
   * Prometheus-compatible scrape for Datadog Agent / Grafana Agent.
   * Import docs/ops/datadog-slo-dashboard.json for a starter dashboard.
 * Requires METRICS_TOKEN as a bearer token when set; disabled in production without it.
   */
  app.get("/metrics", async (request, reply) => {
    // Metrics expose internal counters, so they are never public in production.
    const token = app.config.METRICS_TOKEN;
    if (token ? !hasMetricsToken(request, token) : app.config.NODE_ENV === "production") {
      return reply.code(404).send({ ok: false, error: "NOT_FOUND", code: "NOT_FOUND", message: "Not found" });
    }
    const uptime = (Date.now() - startedAt) / 1000;
    const body = [
      "# HELP skout_api_up 1 if process is serving",
      "# TYPE skout_api_up gauge",
      "skout_api_up 1",
      "# HELP skout_api_uptime_seconds Process uptime",
      "# TYPE skout_api_uptime_seconds counter",
      `skout_api_uptime_seconds ${uptime.toFixed(1)}`,
      "# HELP skout_api_health_hits_total Health endpoint hits since boot",
      "# TYPE skout_api_health_hits_total counter",
      `skout_api_health_hits_total ${healthHits}`,
      "# HELP skout_slo_health_p95_ms Target p95 for /health",
      "# TYPE skout_slo_health_p95_ms gauge",
      `skout_slo_health_p95_ms ${SLO_TARGETS.health.p95Ms}`,
      "# HELP skout_slo_crud_p95_ms Target p95 for authenticated CRUD",
      "# TYPE skout_slo_crud_p95_ms gauge",
      `skout_slo_crud_p95_ms ${SLO_TARGETS.authenticatedCrud.p95Ms}`,
      formatJourneyMetricsPrometheus(),
      // ENR-06 — capture-run, job, provider-error and queue-lag gauges.
      await enrichmentMetricsPrometheus(app.db),
      "",
    ].join("\n");
    return reply.type("text/plain; version=0.0.4").send(body);
  });
}
