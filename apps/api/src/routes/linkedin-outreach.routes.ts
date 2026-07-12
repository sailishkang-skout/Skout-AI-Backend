import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { buildLinkedinOutreachService } from "../services/linkedin-outreach.service.js";

export async function linkedinOutreachRoutes(app: FastifyInstance) {
  // GET /linkedin/outreach/pending — Chrome extension polls this
  app.get("/linkedin/outreach/pending", async (request, reply) => {
    const workspaceId = request.workspaceId ?? "unknown";
    const svc = buildLinkedinOutreachService(app.db, app.config);
    if (!svc) return reply.send({ workspaceId, data: [], total: 0 });
    const q = request.query as { limit?: string };
    const limit = q.limit ? Number(q.limit) : 10;
    const data = await svc.listPending(workspaceId, Number.isFinite(limit) ? limit : 10);
    return reply.send({ workspaceId, data, total: data.length });
  });

  // POST /linkedin/outreach/:id/claim — mark processing before send
  app.post("/linkedin/outreach/:id/claim", async (request, reply) => {
    const { id } = request.params as { id: string };
    const workspaceId = request.workspaceId ?? "unknown";
    const svc = buildLinkedinOutreachService(app.db, app.config);
    if (!svc) return reply.status(503).send({ error: "database_unavailable" });
    const job = await svc.claimJob(workspaceId, id);
    return reply.send(job);
  });

  // POST /linkedin/outreach/:id/complete
  app.post("/linkedin/outreach/:id/complete", async (request, reply) => {
    const { id } = request.params as { id: string };
    const workspaceId = request.workspaceId ?? "unknown";
    const svc = buildLinkedinOutreachService(app.db, app.config);
    if (!svc) return reply.status(503).send({ error: "database_unavailable" });
    const job = await svc.completeJob(workspaceId, id);
    return reply.send(job);
  });

  // POST /linkedin/outreach/:id/fail
  app.post("/linkedin/outreach/:id/fail", async (request, reply) => {
    const { id } = request.params as { id: string };
    const workspaceId = request.workspaceId ?? "unknown";
    const svc = buildLinkedinOutreachService(app.db, app.config);
    if (!svc) return reply.status(503).send({ error: "database_unavailable" });
    const body = z
      .object({ reason: z.string().min(1).max(500).default("linkedin_send_failed") })
      .parse(request.body ?? {});
    const job = await svc.failJob(workspaceId, id, body.reason);
    return reply.send(job);
  });
}
