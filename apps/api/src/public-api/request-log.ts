import { schema, type Db } from "@skout/db";
import { createLogger } from "@skout/observability";
import type { RequestLogEntry } from "./pipeline.js";

const log = createLogger("public-api.request-log");

/**
 * The request log (PAPI-044, public API PRD §9.7, CRED-12): one api_request_log row per public API
 * request, rejected ones included, with the prices that applied. Metadata only: no request or
 * response body, no raw URL (the endpoint is its route pattern), no headers but the user agent.
 * A failed write is logged and never affects the response, which has already been sent.
 */
export function createRequestLogWriter(db: Db) {
  return async (e: RequestLogEntry): Promise<void> => {
    try {
      await db.insert(schema.apiRequestLog).values({
        requestId: e.requestId,
        workspaceId: e.workspaceId,
        apiKeyId: e.apiKeyId,
        method: e.method,
        endpoint: e.endpoint.slice(0, 200),
        statusCode: e.statusCode,
        errorCode: e.errorCode,
        creditsCharged: Math.max(0, e.creditsCharged),
        priceApplied: e.priceApplied,
        latencyMs: Math.max(0, Math.round(e.latencyMs)),
        ip: e.ip.slice(0, 64),
        userAgent: e.userAgent ? e.userAgent.slice(0, 300) : null,
      });
    } catch (err) {
      log.warn("could not write the public API request log", { requestId: e.requestId, err: (err as Error).message });
    }
  };
}
