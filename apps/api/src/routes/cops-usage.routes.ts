import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { HttpError } from "../utils/http.js";
import { getUsage, meterAiAction, refundAiAction } from "../services/cops-usage.service.js";

/**
 * COPS-14 metered usage. User-triggered AI actions are counted here, before the handler runs, so
 * one rule covers every AI route; at 80% of the plan a warning header is added, at 100% the call
 * is refused with 429 USAGE_LIMIT_REACHED. Background AI (reply tagging) is not counted.
 */
const METERED_AI = [
  /^\/api\/v1\/ai\/chat$/,
  /^\/api\/v1\/ai\/drafts$/,
  /^\/api\/v1\/ai\/generate-email$/,
  /^\/api\/v1\/ai\/next-best-action$/,
  /^\/api\/v1\/ai\/audit$/,
  /^\/api\/v1\/accounts\/[0-9a-f-]{36}\/recommendations\/generate$/,
];
export const isMeteredAi = (method: string, url: string) => method === "POST" && METERED_AI.some((re) => re.test(url.split("?")[0]!));

/** Call on the /api/v1 scope itself: a hook inside a child plugin would only see that plugin's routes. */
export function registerAiMetering(app: FastifyInstance) {
  const metered = new WeakSet<FastifyRequest>();
  // A request refused for bad input never reached the AI, so it gives the action back.
  app.addHook("onResponse", async (request, reply) => {
    if (!metered.has(request) || !app.db || !request.workspaceId) return;
    if (reply.statusCode === 400 || reply.statusCode === 422) {
      await refundAiAction(app.db, request.workspaceId).catch((err) => request.log.warn({ err }, "AI usage refund failed"));
    }
  });
  app.addHook("preHandler", async (request: FastifyRequest, reply: FastifyReply) => {
    if (!isMeteredAi(request.method, request.url) || !request.workspaceId || !app.db) return;
    try {
      const m = await meterAiAction(app.db, request.workspaceId);
      metered.add(request);
      reply.header("X-Usage-AI-Actions", `${m.used}/${m.limit}`);
      if (m.warn) reply.header("X-Usage-Warning", "ai_actions");
    } catch (err) {
      if (err instanceof HttpError && err.statusCode === 429) {
        return reply.code(429).send({ ok: false, code: "USAGE_LIMIT_REACHED", message: err.message, details: err.details, retryable: false });
      }
      // Metering must never take an AI feature down; a counter failure is logged and let through.
      request.log.warn({ err }, "AI usage metering failed");
    }
  });
}

export async function copsUsageRoutes(app: FastifyInstance) {
  const db = () => {
    if (!app.db) throw new HttpError("Database not available", 503);
    return app.db;
  };
  app.get("/cops/usage", async (request) => ({ data: await getUsage(db(), request.workspaceId!) }));
}
