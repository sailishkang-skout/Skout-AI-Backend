import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  EmailIntelUnavailableError,
  discoverEmail,
  generatePatterns,
  getWarmupStatus,
  isEmailIntelConfigured,
  startWarmup,
  verifyEmail,
  verifyEmailBatch,
} from "../services/email-intel.service.js";

/*
==================================================
EMAIL INTELLIGENCE PROXY ROUTES
==================================================

Thin forwarding routes to the internal Email
Intelligence service (see email-intel.service.ts).
Gives the frontend/CRM a stable public entrypoint
without exposing the internal CloudMap DNS name
directly.

Business-logic questions — e.g. whether this should
replace the existing ZeroBounce/NeverBounce/
MillionVerifier providers in the enrichment waterfall
(see services/enrichment/index.ts:resolveEmailVerifier)
— are explicitly out of scope here; this only exposes
the new service's own richer verification/discovery
surface as its own API.
==================================================
*/

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

const warmupStartBodySchema = z.object({
  domain: z.string().min(1),
  mailbox: z.string().min(1).optional(),
});

const warmupStatusQuerySchema = z.object({
  domain: z.string().min(1),
});

export async function emailIntelRoutes(app: FastifyInstance) {
  app.addHook("onRequest", async (request, reply) => {
    if (!isEmailIntelConfigured(app.config)) {
      return reply.code(503).send({ error: "email_intel_not_configured" });
    }
  });

  app.post("/email-intel/verify", async (request, reply) => {
    const body = verifyBodySchema.safeParse(request.body);
    if (!body.success) {
      return reply.code(400).send({ error: "invalid_request", details: body.error.flatten() });
    }
    try {
      return reply.send(await verifyEmail(app.config, body.data.email));
    } catch (err) {
      if (err instanceof EmailIntelUnavailableError) {
        return reply.code(502).send({ error: "email_intel_unavailable" });
      }
      throw err;
    }
  });

  app.post("/email-intel/verify/batch", async (request, reply) => {
    const body = verifyBatchBodySchema.safeParse(request.body);
    if (!body.success) {
      return reply.code(400).send({ error: "invalid_request", details: body.error.flatten() });
    }
    try {
      return reply.send(await verifyEmailBatch(app.config, body.data.emails));
    } catch (err) {
      if (err instanceof EmailIntelUnavailableError) {
        return reply.code(502).send({ error: "email_intel_unavailable" });
      }
      throw err;
    }
  });

  app.post("/email-intel/discover", async (request, reply) => {
    const body = discoverBodySchema.safeParse(request.body);
    if (!body.success) {
      return reply.code(400).send({ error: "invalid_request", details: body.error.flatten() });
    }
    try {
      return reply.send(await discoverEmail(app.config, body.data));
    } catch (err) {
      if (err instanceof EmailIntelUnavailableError) {
        return reply.code(502).send({ error: "email_intel_unavailable" });
      }
      throw err;
    }
  });

  app.post("/email-intel/patterns", async (request, reply) => {
    const body = patternsBodySchema.safeParse(request.body);
    if (!body.success) {
      return reply.code(400).send({ error: "invalid_request", details: body.error.flatten() });
    }
    try {
      return reply.send(await generatePatterns(app.config, body.data));
    } catch (err) {
      if (err instanceof EmailIntelUnavailableError) {
        return reply.code(502).send({ error: "email_intel_unavailable" });
      }
      throw err;
    }
  });

  app.post("/email-intel/warmup/start", async (request, reply) => {
    const body = warmupStartBodySchema.safeParse(request.body);
    if (!body.success) {
      return reply.code(400).send({ error: "invalid_request", details: body.error.flatten() });
    }
    try {
      return reply.send(await startWarmup(app.config, body.data));
    } catch (err) {
      if (err instanceof EmailIntelUnavailableError) {
        return reply.code(502).send({ error: "email_intel_unavailable" });
      }
      throw err;
    }
  });

  app.get("/email-intel/warmup/status", async (request, reply) => {
    const query = warmupStatusQuerySchema.safeParse(request.query);
    if (!query.success) {
      return reply.code(400).send({ error: "invalid_request", details: query.error.flatten() });
    }
    try {
      return reply.send(await getWarmupStatus(app.config, query.data.domain));
    } catch (err) {
      if (err instanceof EmailIntelUnavailableError) {
        return reply.code(502).send({ error: "email_intel_unavailable" });
      }
      throw err;
    }
  });
}
