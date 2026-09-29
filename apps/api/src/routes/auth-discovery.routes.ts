/**
 * AUTH-BE-22 — login discovery endpoint for the cohort migration (ADR-0007 D5).
 *
 * POST /auth/discover {email} → { method: "clerk" | "password" | "google" | "microsoft" | "sso" }
 *
 * Behind AUTH_CUSTOM_ENABLED (default off) like the other own-auth routes. Anti-enumeration:
 * - Every well-formed email gets a method (the environment default when no cohort row matches).
 * - The method depends only on auth_login_cohorts, never on whether an account exists (see
 *   login-discovery.service.ts), and every request runs the same single query.
 * - Responses are padded to a fixed minimum latency so query-time jitter doesn't leak anything.
 * - Rate-limited harder than login (5/min vs 15/min per IP).
 * The email is never logged or written to auth_events.
 */
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { errorResponse, successResponse } from "../utils/http.js";
import { fetchCohortRows, pickLoginMethod, splitEmail } from "../services/login-discovery.service.js";

/** Minimum response time for /auth/discover, so fast and slow lookups look the same. */
export const DISCOVERY_MIN_RESPONSE_MS = 150;

const discoverBodySchema = z.object({
  email: z.string().trim().email().max(320),
});

function waitUntil(startedAt: number, minMs: number): Promise<void> {
  const remaining = minMs - (Date.now() - startedAt);
  return remaining > 0 ? new Promise((resolve) => setTimeout(resolve, remaining)) : Promise.resolve();
}

export async function authDiscoveryRoutes(app: FastifyInstance) {
  app.post(
    "/auth/discover",
    { config: { rateLimit: { max: 5, timeWindow: "1 minute" } } },
    async (request, reply) => {
      if (!app.config.AUTH_CUSTOM_ENABLED) {
        return reply.code(404).send(errorResponse("Not found", 404));
      }
      const db = app.db;
      if (!db) return reply.code(503).send(errorResponse("Database unavailable", 503));

      const parsed = discoverBodySchema.safeParse(request.body ?? {});
      if (!parsed.success) {
        return reply.code(400).send(errorResponse("A valid email is required", 400));
      }

      const startedAt = Date.now();
      const { email, domain } = splitEmail(parsed.data.email);
      const rows = await fetchCohortRows(db, email, domain);
      const method = pickLoginMethod(rows, app.config.AUTH_DISCOVERY_DEFAULT_METHOD);
      await waitUntil(startedAt, DISCOVERY_MIN_RESPONSE_MS);
      return reply.send(successResponse({ method }));
    }
  );
}
