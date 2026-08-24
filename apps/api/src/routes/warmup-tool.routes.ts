import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import {
  WarmupToolUnavailableError,
  isWarmupToolConfigured,
  pollIntegrationEvents,
  proxyWarmupOAuthCallback,
  proxyWarmupTool,
} from "../services/warmup-tool.service.js";

function mapUnavailable(reply: FastifyReply, err: WarmupToolUnavailableError) {
  return reply.code(502).send({
    error: "warmup_tool_unavailable",
    message: err.message,
    details: err.upstreamBody ?? null,
  });
}

function requireWorkspace(request: FastifyRequest): string {
  const workspaceId = request.workspaceId;
  if (!workspaceId) {
    throw Object.assign(new Error("workspace_required"), { statusCode: 400 });
  }
  return workspaceId;
}

/**
 * Transparent proxy: /api/v1/warmup-tool/* → Warm-Up Tool /api/v1/*
 * plus OAuth public callbacks and an integration-events poll helper.
 */
export async function warmupToolRoutes(app: FastifyInstance) {
  const notConfigured = (reply: FastifyReply) =>
    reply.code(503).send({
      error: "warmup_tool_not_configured",
      message: "Set WARMUP_TOOL_SERVICE_URL to enable Email Warm-up.",
    });

  app.get("/warmup-tool/oauth/google/callback", async (request, reply) => {
    if (!isWarmupToolConfigured(app.config)) return notConfigured(reply);
    try {
      const q = (request.url.split("?")[1] ?? "").toString();
      const result = await proxyWarmupOAuthCallback(app.config, "google", q);
      if (result.contentType) reply.header("content-type", result.contentType);
      return reply.code(result.status).send(result.body);
    } catch (err) {
      if (err instanceof WarmupToolUnavailableError) return mapUnavailable(reply, err);
      throw err;
    }
  });

  app.get("/warmup-tool/oauth/microsoft/callback", async (request, reply) => {
    if (!isWarmupToolConfigured(app.config)) return notConfigured(reply);
    try {
      const q = (request.url.split("?")[1] ?? "").toString();
      const result = await proxyWarmupOAuthCallback(app.config, "microsoft", q);
      if (result.contentType) reply.header("content-type", result.contentType);
      return reply.code(result.status).send(result.body);
    } catch (err) {
      if (err instanceof WarmupToolUnavailableError) return mapUnavailable(reply, err);
      throw err;
    }
  });

  app.post("/warmup-tool/integration-events/poll", async (request, reply) => {
    if (!isWarmupToolConfigured(app.config)) return notConfigured(reply);
    if (!app.db) {
      return reply.code(503).send({ error: "database_unavailable" });
    }
    try {
      const workspaceId = requireWorkspace(request);
      const body = (request.body ?? {}) as { limit?: number };
      const result = await pollIntegrationEvents(app.db, app.config, workspaceId, {
        limit: body.limit,
      });
      return reply.send(result);
    } catch (err) {
      if (err instanceof WarmupToolUnavailableError) return mapUnavailable(reply, err);
      throw err;
    }
  });

  const proxyHandler = async (request: FastifyRequest, reply: FastifyReply) => {
    if (!isWarmupToolConfigured(app.config)) return notConfigured(reply);
    if (!app.db) {
      return reply.code(503).send({ error: "database_unavailable" });
    }

    try {
      const workspaceId = requireWorkspace(request);
      const params = request.params as { "*"?: string };
      const star = params["*"];
      let upstreamPath: string;
      if (!star) {
        upstreamPath = "/health";
      } else if (star.startsWith("oauth/")) {
        // Handled by dedicated public routes; should not hit here.
        upstreamPath = `/api/v1/${star}`;
      } else {
        upstreamPath = `/api/v1/${star}`;
      }

      const query = request.url.includes("?") ? request.url.slice(request.url.indexOf("?") + 1) : "";

      let body: string | Buffer | null = null;
      if (request.method !== "GET" && request.method !== "HEAD") {
        if (typeof request.rawBody === "string") {
          body = request.rawBody;
        } else if (request.body != null) {
          body = JSON.stringify(request.body);
        }
      }

      const result = await proxyWarmupTool(app.db, app.config, workspaceId, {
        upstreamPath,
        method: request.method,
        query,
        body,
        contentType:
          typeof request.headers["content-type"] === "string"
            ? request.headers["content-type"]
            : null,
      });

      if (result.contentType) reply.header("content-type", result.contentType);
      if (result.contentType?.includes("application/json") || result.body.trim().startsWith("{")) {
        try {
          const parsed = JSON.parse(result.body) as unknown;
          // Normalize Warm-Up Tool { error: { code, message } } into Skout's
          // { error, message, statusCode } so the browser shows real text.
          if (
            result.status >= 400 &&
            parsed &&
            typeof parsed === "object" &&
            "error" in parsed &&
            typeof (parsed as { error: unknown }).error === "object" &&
            (parsed as { error: unknown }).error !== null
          ) {
            const nested = (parsed as { error: { code?: string; message?: string; fieldErrors?: unknown } }).error;
            return reply.code(result.status).send({
              error: nested.code ?? "warmup_tool_error",
              message: nested.message ?? "Warm-Up Tool request failed",
              statusCode: result.status,
              details: nested.fieldErrors ? { fieldErrors: nested.fieldErrors } : null,
            });
          }
          return reply.code(result.status).send(parsed);
        } catch {
          return reply.code(result.status).send(result.body);
        }
      }
      return reply.code(result.status).send(result.body);
    } catch (err) {
      if (err instanceof WarmupToolUnavailableError) return mapUnavailable(reply, err);
      throw err;
    }
  };

  app.all("/warmup-tool", proxyHandler);
  app.all("/warmup-tool/*", proxyHandler);
}
