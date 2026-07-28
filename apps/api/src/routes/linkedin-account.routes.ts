import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { buildLinkedinAccountService } from "../services/linkedin-account.service.js";
import { UnipileError } from "../services/unipile.client.js";
import { HttpError } from "../utils/http.js";

const channelSchema = z.enum(["linkedin", "whatsapp"]);

export async function linkedinAccountRoutes(app: FastifyInstance) {
  app.get("/linkedin/accounts", async (request, reply) => {
    const workspaceId = request.workspaceId ?? "unknown";
    const svc = buildLinkedinAccountService(app.db, app.config);
    if (!svc) return reply.send({ workspaceId, data: [], total: 0, unipileConfigured: false });
    const query = z.object({ channel: channelSchema.optional() }).parse(request.query ?? {});
    const data = await svc.list(workspaceId, query.channel);
    return reply.send({
      workspaceId,
      data,
      total: data.length,
      unipileConfigured: await svc.isConfiguredForWorkspace(workspaceId),
    });
  });

  app.post("/linkedin/accounts", async (request, reply) => {
    const workspaceId = request.workspaceId ?? "unknown";
    const svc = buildLinkedinAccountService(app.db, app.config);
    if (!svc) return reply.status(503).send({ error: "database_unavailable" });
    const body = z
      .object({
        unipileAccountId: z.string().min(1).max(200),
        displayName: z.string().max(255).optional(),
        linkedinUrl: z.string().url().optional(),
        phone: z.string().max(32).optional(),
        channel: channelSchema.optional(),
      })
      .parse(request.body ?? {});
    const account = await svc.connect(workspaceId, body);
    return reply.status(201).send(account);
  });

  app.post("/linkedin/accounts/hosted-auth", async (request, reply) => {
    const workspaceId = request.workspaceId ?? "unknown";
    const svc = buildLinkedinAccountService(app.db, app.config);
    if (!svc) return reply.status(503).send({ error: "database_unavailable" });
    const body = z
      .object({
        webBaseUrl: z.string().url(),
        providers: z.array(z.enum(["LINKEDIN", "WHATSAPP"])).min(1).optional(),
      })
      .parse(request.body ?? {});
    const link = await svc.createHostedAuthLink(
      workspaceId,
      body.webBaseUrl,
      body.providers ?? ["LINKEDIN"]
    );
    return reply.send(link);
  });

  /** Pull accounts already linked in Unipile into this workspace (webhook fallback). */
  app.post("/linkedin/accounts/sync", async (request, reply) => {
    const workspaceId = request.workspaceId ?? "unknown";
    const svc = buildLinkedinAccountService(app.db, app.config);
    if (!svc) return reply.status(503).send({ error: "database_unavailable" });
    const body = z.object({ channel: channelSchema.optional() }).parse(request.body ?? {});
    try {
      const result = await svc.syncFromUnipile(workspaceId, body.channel);
      return reply.send({
        workspaceId,
        data: result.imported,
        total: result.total,
        unipileConfigured: true,
      });
    } catch (err) {
      const status = err instanceof HttpError ? err.statusCode : err instanceof UnipileError ? err.status : 500;
      const message =
        err instanceof HttpError
          ? err.message
          : err instanceof UnipileError
            ? err.message
            : "unipile_sync_failed";
      return reply.status(status >= 400 && status < 600 ? status : 500).send({ error: message });
    }
  });

  app.patch("/linkedin/accounts/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const workspaceId = request.workspaceId ?? "unknown";
    const svc = buildLinkedinAccountService(app.db, app.config);
    if (!svc) return reply.status(503).send({ error: "database_unavailable" });
    const body = z.object({ status: z.enum(["active", "paused"]) }).parse(request.body ?? {});
    const account = await svc.setStatus(workspaceId, id, body.status);
    if (!account) return reply.status(404).send({ error: "linkedin_account_not_found" });
    return reply.send(account);
  });

  app.delete("/linkedin/accounts/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const workspaceId = request.workspaceId ?? "unknown";
    const svc = buildLinkedinAccountService(app.db, app.config);
    if (!svc) return reply.status(503).send({ error: "database_unavailable" });
    await svc.disconnect(workspaceId, id);
    return reply.status(204).send();
  });
}
