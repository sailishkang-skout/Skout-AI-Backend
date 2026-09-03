import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import { generateEmailCandidates } from "@skout/pal";
import {
  EmailIntelUnavailableError,
  generatePatterns,
  getWarmupStatus,
  isEmailIntelConfigured,
  verifyEmailResolved,
} from "../services/email-intel.service.js";
import {
  discoverEmailResolved,
  hasDiscoverFallback,
  normalizeDiscoverDomain,
} from "../services/discover-email.service.js";
import { HttpError } from "../utils/http.js";
import { recordEvidence } from "../services/evidence.service.js";
import { mapEmailIntelObservationToCanonical } from "../services/email-intel-evidence-map.js";

const verifyBodySchema = z.object({
  email: z.string().min(1),
});

const verifyBatchBodySchema = z.object({
  emails: z.array(z.string().min(1)).min(1),
});

const discoverBodySchema = z.object({
  firstName: z.string().min(1),
  lastName: z.string().optional(),
  domain: z.string().min(1),
  maxVerifications: z.number().int().positive().optional(),
  verify: z.boolean().optional(),
});

const patternsBodySchema = z.object({
  firstName: z.string().min(1),
  lastName: z.string().min(1),
  domain: z.string().min(1),
});

/** @deprecated see startWarmup/getWarmupStatus in email-intel.service.ts */
const warmupStatusQuerySchema = z.object({
  domain: z.string().min(1),
});

function routeUnavailable(reply: FastifyReply, err: EmailIntelUnavailableError) {
  if (err.upstreamStatus === 501) {
    return reply.code(501).send({
      error: "email_intel_not_implemented",
      message: err.message,
      details: err.upstreamBody ?? null,
    });
  }
  return reply.code(502).send({
    error: "email_intel_unavailable",
    message: err.message,
    details: err.upstreamBody ?? null,
  });
}

function routeHttpError(reply: FastifyReply, err: HttpError) {
  return reply.code(err.statusCode).send({
    error: err.message,
    message: typeof err.details === "string" ? err.details : err.message,
    details: err.details ?? null,
  });
}

export async function emailIntelRoutes(app: FastifyInstance) {
  app.addHook("onRequest", async (request, reply) => {
    const path = request.url.split("?")[0] ?? "";
    const needsProvider =
      path.endsWith("/discover") ||
      path.endsWith("/verify") ||
      path.endsWith("/verify/batch") ||
      path.endsWith("/patterns");
    if (!needsProvider) return;

    // Allow local mock mode even if no external provider is configured
    if (!isEmailIntelConfigured(app.config) && !hasDiscoverFallback(app.config) && process.env.NODE_ENV !== "development") {
      return reply.code(503).send({
        error: "email_intel_not_configured",
        message: "Set EMAIL_INTEL_SERVICE_URL or HUNTER_API_KEY to use email intelligence.",
      });
    }
  });

  app.post("/email-intel/verify", async (request, reply) => {
    const body = verifyBodySchema.safeParse(request.body);
    if (!body.success) {
      return reply.code(400).send({ error: "invalid_request", details: body.error.flatten() });
    }
    try {
      const result = await verifyEmailResolved(app.config, body.data.email);
      // §5.3 — dual-write verification outcome into canonical ledger when workspace is known
      if (app.db && request.workspaceId) {
        try {
          const domain = body.data.email.includes("@") ? body.data.email.split("@")[1] : null;
          const outcome =
            result && typeof result === "object" && "status" in result
              ? String((result as { status?: string }).status ?? "UNKNOWN")
              : "UNKNOWN";
          const mailboxExists =
            result && typeof result === "object" && "mailboxExists" in result
              ? Boolean((result as { mailboxExists?: boolean }).mailboxExists)
              : null;
          await recordEvidence(
            app.db,
            mapEmailIntelObservationToCanonical(request.workspaceId, {
              email: body.data.email,
              domain,
              source: "API",
              outcome: outcome.toUpperCase().includes("VALID") || outcome === "deliverable" ? "SUCCESS" : "UNKNOWN",
              mailboxExists,
              metadata: result,
            })
          );
        } catch (err) {
          app.log.warn({ err }, "canonical evidence dual-write failed for email-intel verify");
        }
      }
      return reply.send(result);
    } catch (err) {
      if (err instanceof HttpError) return routeHttpError(reply, err);
      if (err instanceof EmailIntelUnavailableError) return routeUnavailable(reply, err);
      throw err;
    }
  });

  app.post("/email-intel/verify/batch", async (request, reply) => {
    const body = verifyBatchBodySchema.safeParse(request.body);
    if (!body.success) {
      return reply.code(400).send({ error: "invalid_request", details: body.error.flatten() });
    }
    const results = await Promise.allSettled(
      body.data.emails.map((email) => verifyEmailResolved(app.config, email))
    );
    const mapped = results.map((r, i) =>
      r.status === "fulfilled"
        ? r.value
        : { success: false, email: body.data.emails[i], error: r.reason instanceof Error ? r.reason.message : String(r.reason) }
    );
    return reply.send({ success: true, count: mapped.length, results: mapped });
  });

  app.post("/email-intel/discover", async (request, reply) => {
    const body = discoverBodySchema.safeParse(request.body);
    if (!body.success) {
      return reply.code(400).send({ error: "invalid_request", details: body.error.flatten() });
    }
    try {
      return reply.send(await discoverEmailResolved(app.config, body.data));
    } catch (err) {
      if (err instanceof HttpError) return routeHttpError(reply, err);
      if (err instanceof EmailIntelUnavailableError) return routeUnavailable(reply, err);
      throw err;
    }
  });

  app.post("/email-intel/patterns", async (request, reply) => {
    const body = patternsBodySchema.safeParse(request.body);
    if (!body.success) {
      return reply.code(400).send({ error: "invalid_request", details: body.error.flatten() });
    }
    const domain = normalizeDiscoverDomain(body.data.domain);
    const payload = { ...body.data, domain };
    try {
      if (isEmailIntelConfigured(app.config)) {
        return reply.send(await generatePatterns(app.config, payload));
      }
      const emails = generateEmailCandidates(`${payload.firstName} ${payload.lastName}`, domain);
      return reply.send({
        success: true,
        domain,
        person: { first_name: payload.firstName, last_name: payload.lastName },
        patterns: emails.map((email, index) => ({
          pattern: email.split("@")[0] ?? "pattern",
          email,
          priority: index + 1,
        })),
        provider: "local-fallback",
      });
    } catch (err) {
      if (err instanceof HttpError) return routeHttpError(reply, err);
      if (err instanceof EmailIntelUnavailableError) return routeUnavailable(reply, err);
      throw err;
    }
  });

  /** @deprecated zero real callers (grep-confirmed) — see EmailIntelWarmupStartResult in email-intel.service.ts. */
  app.post("/email-intel/warmup/start", async (_request, reply) => {
    return reply.code(501).send({
      error: "warmup_not_implemented",
      message: "Domain warm-up is scaffolded in the email-intelligence service and not live yet.",
      enabled: false,
      phase: "scaffold",
    });
  });

  /** @deprecated only the frontend's deprecated /intelligence/email/warmup page calls this. */
  app.get("/email-intel/warmup/status", async (request, reply) => {
    const query = warmupStatusQuerySchema.safeParse(request.query);
    if (!query.success) {
      return reply.code(400).send({ error: "invalid_request", details: query.error.flatten() });
    }
    const domain = normalizeDiscoverDomain(query.data.domain);
    if (!isEmailIntelConfigured(app.config)) {
      return reply.send({
        success: true,
        domain,
        enabled: false,
        phase: "scaffold",
        score: null,
        dayInProgram: null,
      });
    }
    try {
      return reply.send(await getWarmupStatus(app.config, domain));
    } catch (err) {
      if (err instanceof EmailIntelUnavailableError) {
        return reply.send({
          success: true,
          domain,
          enabled: false,
          phase: "scaffold",
          score: null,
          dayInProgram: null,
        });
      }
      throw err;
    }
  });
}