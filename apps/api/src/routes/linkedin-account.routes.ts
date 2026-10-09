import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { buildLinkedinAccountService } from "../services/linkedin-account.service.js";
import { UnipileError } from "../services/unipile.client.js";
import { HttpError, requireWorkspaceId } from "../utils/http.js";
import { assertPermission, recordPrivilegedAction } from "@skout/auth";

const channelSchema = z.enum(["linkedin", "whatsapp"]);

export async function linkedinAccountRoutes(app: FastifyInstance) {
  app.get("/linkedin/accounts", async (request, reply) => {
    if (!app.db) return reply.status(503).send({ error: "database_unavailable" });
    const workspaceId = requireWorkspaceId(request);
    if (!request.userId) throw new HttpError("unauthorized", 401);
    await assertPermission(app.db, workspaceId, request.userId, "enrichment:capture");
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
    if (!app.db) return reply.status(503).send({ error: "database_unavailable" });
    const workspaceId = requireWorkspaceId(request);
    if (!request.userId) throw new HttpError("unauthorized", 401);
    await assertPermission(app.db, workspaceId, request.userId, "enrichment:capture");
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
    await recordPrivilegedAction(app.db, {
      workspaceId,
      actorId: request.userId,
      action: "linkedin_account.connect",
      entityType: "linkedin_account",
      entityId: account.id,
      afterState: { displayName: body.displayName, channel: body.channel, unipileAccountId: body.unipileAccountId }
    });
    return reply.status(201).send(account);
  });

  app.post("/linkedin/accounts/hosted-auth", { config: { rateLimit: { max: 5, timeWindow: 60000 } } }, async (request, reply) => {
    if (!app.db) return reply.status(503).send({ error: "database_unavailable" });
    const workspaceId = requireWorkspaceId(request);
    if (!request.userId) throw new HttpError("unauthorized", 401);
    await assertPermission(app.db, workspaceId, request.userId, "enrichment:capture");
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

  /** Pull accounts already linked in Unipile into th
   * kspace (webhook fallback). */
  app.post("/linkedin/accounts/sync", async (request, reply) => {
    if (!app.db) return reply.status(503).send({ error: "database_unavailable" });
    const workspaceId = requireWorkspaceId(request);
    if (!request.userId) throw new HttpError("unauthorized", 401);
    await assertPermission(app.db, workspaceId, request.userId, "enrichment:capture");
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
      let status = 500;
      let message = "unipile_sync_failed";
      
      if (err instanceof HttpError) {
        status = err.statusCode;
        message = err.message;
      } else if (err instanceof UnipileError) {
        status = err.status;
        message = err.message;
      } else if (err instanceof Error) {
        message = err.message;
      }
      
      return reply.status(status >= 400 && status < 600 ? status : 500).send({ error: message });
    }
  });

  app.patch("/linkedin/accounts/:id", async (request, reply) => {
    if (!app.db) return reply.status(503).send({ error: "database_unavailable" });
    const { id } = request.params as { id: string };
    const workspaceId = requireWorkspaceId(request);
    if (!request.userId) throw new HttpError("unauthorized", 401);
    await assertPermission(app.db, workspaceId, request.userId, "enrichment:capture");
    const svc = buildLinkedinAccountService(app.db, app.config);
    if (!svc) return reply.status(503).send({ error: "database_unavailable" });
    const body = z.object({ status: z.enum(["active", "paused"]) }).parse(request.body ?? {});
    const account = await svc.setStatus(workspaceId, id, body.status);
    if (!account) return reply.status(404).send({ error: "linkedin_account_not_found" });
    await recordPrivilegedAction(app.db, {
      workspaceId,
      actorId: request.userId,
      action: "linkedin_account.status_update",
      entityType: "linkedin_account",
      entityId: id,
      afterState: { status: body.status }
    });
    return reply.send(account);
  });

  app.delete("/linkedin/accounts/:id", async (request, reply) => {
    if (!app.db) return reply.status(503).send({ error: "database_unavailable" });
    const { id } = request.params as { id: string };
    const workspaceId = requireWorkspaceId(request);
    if (!request.userId) throw new HttpError("unauthorized", 401);
    await assertPermission(app.db, workspaceId, request.userId, "enrichment:capture");
    const svc = buildLinkedinAccountService(app.db, app.config);
    if (!svc) return reply.status(503).send({ error: "database_unavailable" });
    await svc.disconnect(workspaceId, id);
    await recordPrivilegedAction(app.db, {
      workspaceId,
      actorId: request.userId,
      action: "linkedin_account.disconnect",
      entityType: "linkedin_account",
      entityId: id
    });
    return reply.status(204).send();
  });
}