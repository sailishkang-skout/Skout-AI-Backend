import type { FastifyError, FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { HttpError } from "../utils/http.js";
import { availableCredits } from "../services/api-credits.service.js";
import { setPublicApiSecurityHeaders } from "../routes/public-api.routes.js";
import { PublicApiError, isPublicApiErrorCode, publicApiError, publicRequestId, type PublicApiErrorCode } from "./errors.js";
import { runPipeline, type PublicApiDeps, type PublicEndpoint } from "./pipeline.js";
import { assertEndpointScope, PUBLIC_API_SCOPE_MAP } from "./scopes.js";

/** 1 MB request body limit (CONV-10, PRD §9.5). */
export const PUBLIC_API_BODY_LIMIT = 1_048_576;

export interface PublicApiPluginOptions {
  deps: PublicApiDeps;
  endpoints: PublicEndpoint[];
  /** The scope map endpoints are checked against; tests pass their own for dummy endpoints. */
  scopeMap?: Record<string, string>;
}

/** Maps any error to a public API error code and message, never leaking internals (PRD §9.5). */
function toPublicError(err: unknown): { code: PublicApiErrorCode; message: string; status: number; details?: Record<string, unknown> } {
  if (err instanceof PublicApiError) return { code: err.code, message: err.message, status: err.statusCode, details: err.details };
  if (err instanceof HttpError && isPublicApiErrorCode(err.message)) {
    const d = (err.details ?? {}) as Record<string, unknown>;
    const { message, ...rest } = d;
    return { code: err.message, message: typeof message === "string" ? message : err.message.replace(/_/g, " "), status: err.statusCode, details: rest };
  }
  const fe = err as Partial<FastifyError>;
  if (fe?.code === "FST_ERR_CTP_BODY_TOO_LARGE") return { code: "invalid_request", message: "The request body is larger than 1 MB.", status: 413 };
  if (fe?.code === "FST_ERR_CTP_INVALID_MEDIA_TYPE") return { code: "invalid_request", message: "Send JSON (Content-Type: application/json).", status: 415 };
  if (fe?.statusCode === 400 || fe?.code === "FST_ERR_CTP_EMPTY_JSON_BODY" || err instanceof SyntaxError) {
    return { code: "invalid_request", message: "The request body is not valid JSON.", status: 422 };
  }
  return { code: "internal_error", message: "Something went wrong on our side. Nothing was charged; try again.", status: 500 };
}

/**
 * The public API (PAPI-040): an encapsulated Fastify plugin under /api/public/v1 with its own error
 * format (CONV-6), request ids (CONV-3), credit headers (CONV-4), security headers and no CORS
 * (PRD §9.3, §9.5), a 1 MB body limit and a 30 s time limit. Behind PUBLIC_API_ENABLED: while it is
 * off, only the health check answers. Authentication happens before this, in the onRequest hook.
 */
export async function publicApiPlugin(app: FastifyInstance, opts: PublicApiPluginOptions) {
  const { deps } = opts;

  // An empty body with Content-Type: application/json (common on DELETE and GET) means "no body",
  // not invalid JSON. Scoped to the public API routes.
  app.removeContentTypeParser("application/json");
  app.addContentTypeParser("application/json", { parseAs: "string", bodyLimit: PUBLIC_API_BODY_LIMIT }, (_req, body, done) => {
    const text = typeof body === "string" ? body : body.toString("utf8");
    if (text.trim() === "") return done(null, undefined);
    try {
      done(null, JSON.parse(text));
    } catch {
      done(new PublicApiError("invalid_request", "The request body is not valid JSON."), undefined);
    }
  });

  app.addHook("onRequest", async (request, reply) => {
    (request as FastifyRequest & { publicStartedAt?: number }).publicStartedAt = Date.now();
    const path = request.url.split("?")[0]!;
    if (!deps.enabled && !path.endsWith("/health")) {
      request.publicErrorCode = "not_found";
      const { status, body } = publicApiError("not_found", "The public API is not available yet.", publicRequestId(request.id));
      return reply.code(status).send(body);
    }
  });

  app.addHook("onSend", async (request, reply, payload) => {
    setPublicApiSecurityHeaders(reply);
    reply.header("x-request-id", publicRequestId(request.id));
    // The public API never sets cookies or CORS headers, whatever an upstream hook may have added.
    reply.removeHeader("set-cookie");
    for (const h of Object.keys(reply.getHeaders())) if (h.toLowerCase().startsWith("access-control-")) reply.removeHeader(h);
    if (!reply.hasHeader("x-credits-charged")) reply.header("x-credits-charged", String(request.publicApi?.creditsCharged ?? 0));
    return payload;
  });

  app.addHook("onResponse", async (request, reply) => {
    if (!deps.logRequest) return;
    const started = (request as FastifyRequest & { publicStartedAt?: number }).publicStartedAt ?? Date.now();
    const errorCode = request.publicErrorCode ?? null;
    try {
      await deps.logRequest({
        requestId: publicRequestId(request.id),
        workspaceId: request.publicApiKey?.workspaceId ?? null,
        apiKeyId: request.publicApiKey?.id ?? null,
        method: request.method,
        // The route pattern, never the raw URL (ids and query strings stay out of the log).
        endpoint: request.publicApi?.endpoint ?? (request.routeOptions?.url ? request.routeOptions.url.replace(/^\/api\/public\/v1/, "") || "/" : "unmatched"),
        statusCode: reply.statusCode,
        errorCode,
        creditsCharged: request.publicApi?.creditsCharged ?? 0,
        priceApplied: request.publicApi?.priceApplied ?? null,
        latencyMs: Date.now() - started,
        ip: request.ip,
        userAgent: (request.headers["user-agent"] as string | undefined) ?? null,
      });
    } catch (err) {
      request.log.warn({ err }, "public API request log failed");
    }
  });

  app.setErrorHandler(async (err, request: FastifyRequest, reply: FastifyReply) => {
    const e = toPublicError(err);
    if (e.code === "internal_error") request.log.error({ err }, "public API request failed");
    request.publicErrorCode = e.code;
    const { body } = publicApiError(e.code, e.message, publicRequestId(request.id));
    if (e.details && Object.keys(e.details).length > 0 && e.code !== "internal_error") {
      Object.assign(body.error, { details: e.details });
    }
    if (request.publicApiKey && request.publicApiKey.type === "live") {
      const left = await availableCredits(deps.db, request.publicApiKey.workspaceId).catch(() => null);
      if (left) reply.header("x-credits-remaining", String(left.balance));
    }
    reply.header("x-credits-charged", "0");
    return reply.code(e.status).send(body);
  });

  app.setNotFoundHandler(async (request, reply) => {
    request.publicErrorCode = "not_found";
    const { status, body } = publicApiError("not_found", `No endpoint ${request.method} ${request.url.split("?")[0]}.`, publicRequestId(request.id));
    return reply.code(status).send(body);
  });

  // Unauthenticated liveness check, used to prove the www edge reaches the API and not the website.
  app.get("/health", async () => ({ status: "ok", service: "skout-public-api", version: "v1" }));

  for (const ep of opts.endpoints) {
    // PAPI-045: an endpoint whose scope isn't in the static map doesn't start.
    assertEndpointScope(ep, opts.scopeMap ?? PUBLIC_API_SCOPE_MAP);
    app.route({
      method: ep.method,
      url: ep.path,
      bodyLimit: PUBLIC_API_BODY_LIMIT,
      handler: async (request, reply) => runPipeline(deps, ep, request, reply),
    });
  }
}
