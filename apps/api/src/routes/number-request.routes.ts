import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { errorResponse } from "../utils/http.js";
import { HttpError } from "@skout/auth";
import { buildNumberRequestService } from "../services/number-request.service.js";
import {
  isTelnyxNumbersConfigured,
  searchAvailablePhoneNumbers,
  listNumberRequirements,
} from "../services/telnyx-numbers.client.js";

const createSchema = z.object({
  country: z.string().min(2).max(2),
  region: z.string().max(80).optional(),
  city: z.string().max(120).optional(),
  areaCode: z.string().max(16).optional(),
  numberType: z.enum(["local", "mobile", "national", "toll_free", "shared_cost"]).optional(),
  quantity: z.number().int().min(1).max(10).optional(),
  requestedCapabilities: z.array(z.enum(["voice", "sms", "mms", "fax"])).optional(),
  phoneNumber: z.string().min(8).max(20).optional(),
  idempotencyKey: z.string().min(8).max(120).optional(),
});

const searchSchema = z.object({
  country: z.string().min(2).max(2),
  numberType: z.string().optional(),
  areaCode: z.string().optional(),
  city: z.string().optional(),
  region: z.string().optional(),
  features: z.string().optional(),
});

const requirementsSchema = z.object({
  country: z.string().min(2).max(2),
  numberType: z.string().default("local"),
});

const idParams = z.object({ id: z.string().uuid() });

/** §8.11 / §9.0 — in-app Telnyx number marketplace. */
export async function numberRequestRoutes(app: FastifyInstance) {
  const service = () => buildNumberRequestService(app.db ?? null, app.config);

  app.get("/numbers/config", async (request, reply) => {
    if (!request.workspaceId) return reply.code(401).send(errorResponse("Unauthorized", 401));
    return reply.send({
      data: {
        marketplaceEnabled: isTelnyxNumbersConfigured(app.config),
        connectionAssigned: Boolean(app.config.TELNYX_CONNECTION_ID),
        messagingProfileAssigned: Boolean(app.config.TELNYX_MESSAGING_PROFILE_ID),
      },
    });
  });

  app.get("/numbers/available", async (request, reply) => {
    if (!request.workspaceId) return reply.code(401).send(errorResponse("Unauthorized", 401));
    if (!isTelnyxNumbersConfigured(app.config)) {
      return reply.code(503).send(errorResponse("Telnyx is not configured (TELNYX_API_KEY)", 503));
    }
    const parsed = searchSchema.safeParse(request.query ?? {});
    if (!parsed.success) {
      return reply.code(400).send(errorResponse("Invalid search query", 400, parsed.error.flatten()));
    }
    try {
      const data = await searchAvailablePhoneNumbers(app.config, {
        countryCode: parsed.data.country,
        phoneNumberType: parsed.data.numberType,
        areaCode: parsed.data.areaCode,
        city: parsed.data.city,
        administrativeArea: parsed.data.region,
        features: parsed.data.features
          ? parsed.data.features.split(",").map((s) => s.trim()).filter(Boolean)
          : undefined,
      });
      return reply.send({ data });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Telnyx search failed";
      return reply.code(502).send(errorResponse(message, 502));
    }
  });

  app.get("/numbers/requirements", async (request, reply) => {
    if (!request.workspaceId) return reply.code(401).send(errorResponse("Unauthorized", 401));
    if (!isTelnyxNumbersConfigured(app.config)) {
      return reply.code(503).send(errorResponse("Telnyx is not configured (TELNYX_API_KEY)", 503));
    }
    const parsed = requirementsSchema.safeParse(request.query ?? {});
    if (!parsed.success) {
      return reply.code(400).send(errorResponse("Invalid requirements query", 400, parsed.error.flatten()));
    }
    try {
      const data = await listNumberRequirements(app.config, {
        countryCode: parsed.data.country,
        phoneNumberType: parsed.data.numberType,
      });
      return reply.send({ data });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Telnyx requirements lookup failed";
      return reply.code(502).send(errorResponse(message, 502));
    }
  });

  app.get("/numbers/requests", async (request, reply) => {
    if (!request.workspaceId) return reply.code(401).send(errorResponse("Unauthorized", 401));
    const svc = service();
    if (!svc) return reply.code(503).send(errorResponse("Database unavailable", 503));
    const data = await svc.list(request.workspaceId);
    return reply.send({ data, total: data.length });
  });

  app.post("/numbers/requests", async (request, reply) => {
    if (!request.workspaceId || !request.userId) {
      return reply.code(401).send(errorResponse("Unauthorized", 401));
    }
    const svc = service();
    if (!svc) return reply.code(503).send(errorResponse("Database unavailable", 503));
    const parsed = createSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send(errorResponse("Invalid number request", 400, parsed.error.flatten()));
    }
    try {
      const row = await svc.create(request.workspaceId, request.userId, parsed.data);
      return reply.code(201).send({ data: row });
    } catch (err) {
      return sendErr(reply, err);
    }
  });

  app.get("/numbers/requests/:id", async (request, reply) => {
    if (!request.workspaceId) return reply.code(401).send(errorResponse("Unauthorized", 401));
    const svc = service();
    if (!svc) return reply.code(503).send(errorResponse("Database unavailable", 503));
    const { id } = idParams.parse(request.params);
    try {
      const data = await svc.get(request.workspaceId, id);
      return reply.send({ data });
    } catch (err) {
      return sendErr(reply, err);
    }
  });

  app.post("/numbers/requests/:id/select", async (request, reply) => {
    if (!request.workspaceId || !request.userId) {
      return reply.code(401).send(errorResponse("Unauthorized", 401));
    }
    const svc = service();
    if (!svc) return reply.code(503).send(errorResponse("Database unavailable", 503));
    const { id } = idParams.parse(request.params);
    const body = z.object({ phoneNumber: z.string().min(8).max(20) }).safeParse(request.body ?? {});
    if (!body.success) {
      return reply.code(400).send(errorResponse("phoneNumber is required", 400));
    }
    try {
      const data = await svc.selectNumber(request.workspaceId, id, request.userId, body.data.phoneNumber);
      return reply.send({ data });
    } catch (err) {
      return sendErr(reply, err);
    }
  });

  app.post("/numbers/requests/:id/documents", async (request, reply) => {
    if (!request.workspaceId || !request.userId) {
      return reply.code(401).send(errorResponse("Unauthorized", 401));
    }
    const svc = service();
    if (!svc) return reply.code(503).send(errorResponse("Database unavailable", 503));
    const { id } = idParams.parse(request.params);
    const body = z
      .object({
        filename: z.string().min(1).max(200),
        contentBase64: z.string().min(8),
        requirementId: z.string().optional(),
      })
      .safeParse(request.body ?? {});
    if (!body.success) {
      return reply.code(400).send(errorResponse("filename and contentBase64 are required", 400));
    }
    try {
      const data = await svc.uploadDocument(request.workspaceId, id, request.userId, body.data);
      return reply.send({ data });
    } catch (err) {
      return sendErr(reply, err);
    }
  });

  app.post("/numbers/requests/:id/compliance", async (request, reply) => {
    if (!request.workspaceId || !request.userId) {
      return reply.code(401).send(errorResponse("Unauthorized", 401));
    }
    const svc = service();
    if (!svc) return reply.code(503).send(errorResponse("Database unavailable", 503));
    const { id } = idParams.parse(request.params);
    const body = z
      .object({
        documents: z
          .array(
            z.object({
              requirementId: z.string().optional(),
              telnyxDocumentId: z.string().optional(),
              filename: z.string().optional(),
              contentBase64: z.string().optional(),
              note: z.string().optional(),
            })
          )
          .default([]),
      })
      .safeParse(request.body ?? {});
    if (!body.success) {
      return reply.code(400).send(errorResponse("Invalid compliance payload", 400));
    }
    try {
      const data = await svc.submitCompliance(
        request.workspaceId,
        id,
        request.userId,
        body.data.documents
      );
      return reply.send({ data });
    } catch (err) {
      return sendErr(reply, err);
    }
  });

  app.post("/numbers/requests/:id/order", async (request, reply) => {
    if (!request.workspaceId || !request.userId) {
      return reply.code(401).send(errorResponse("Unauthorized", 401));
    }
    const svc = service();
    if (!svc) return reply.code(503).send(errorResponse("Database unavailable", 503));
    const { id } = idParams.parse(request.params);
    try {
      const data = await svc.order(request.workspaceId, id, request.userId);
      return reply.send({ data });
    } catch (err) {
      return sendErr(reply, err);
    }
  });

  app.post("/numbers/requests/:id/refresh", async (request, reply) => {
    if (!request.workspaceId || !request.userId) {
      return reply.code(401).send(errorResponse("Unauthorized", 401));
    }
    const svc = service();
    if (!svc) return reply.code(503).send(errorResponse("Database unavailable", 503));
    const { id } = idParams.parse(request.params);
    try {
      const data = await svc.refresh(request.workspaceId, id, request.userId);
      return reply.send({ data });
    } catch (err) {
      return sendErr(reply, err);
    }
  });

  app.post("/numbers/requests/:id/cancel", async (request, reply) => {
    if (!request.workspaceId || !request.userId) {
      return reply.code(401).send(errorResponse("Unauthorized", 401));
    }
    const svc = service();
    if (!svc) return reply.code(503).send(errorResponse("Database unavailable", 503));
    const { id } = idParams.parse(request.params);
    const reason = z.object({ reason: z.string().optional() }).safeParse(request.body ?? {});
    try {
      const data = await svc.cancel(
        request.workspaceId,
        id,
        request.userId,
        reason.success ? reason.data.reason : undefined
      );
      return reply.send({ data });
    } catch (err) {
      return sendErr(reply, err);
    }
  });
}

function sendErr(reply: { code: (n: number) => { send: (b: unknown) => unknown } }, err: unknown) {
  if (err instanceof HttpError) {
    return reply.code(err.statusCode).send(errorResponse(err.message, err.statusCode));
  }
  throw err;
}
