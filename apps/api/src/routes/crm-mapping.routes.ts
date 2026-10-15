import type { FastifyInstance } from "fastify";
import { getCrmConnector } from "../services/crm-connector.registry.js";
import {
  getDefaultCrmMappings,
  getResolvedCrmMapping,
  saveCrmMappings,
  testMappingTransformation,
  validateMapping,
  type CrmObjectMapping,
} from "../services/crm-mapping.service.js";
import { errorResponse, HttpError, requireWorkspaceId } from "../utils/http.js";

export async function crmMappingRoutes(app: FastifyInstance) {
  /**
   * GET /crm/:provider/mappings
   * Returns active field mappings for a provider in the current workspace.
   */
  app.get("/crm/:provider/mappings", async (request, reply) => {
    const workspaceId = requireWorkspaceId(request);
    const { provider } = request.params as { provider: string };

    const connector = getCrmConnector(provider);
    if (!connector) {
      return reply.status(404).send(errorResponse(`Unsupported CRM provider: ${provider}`, 404));
    }

    if (!app.db) {
      return reply.status(503).send(errorResponse("Database unavailable", 503));
    }

    try {
      const contactMapping = await getResolvedCrmMapping(app.db, workspaceId, provider, "contact");
      const dealMapping = await getResolvedCrmMapping(app.db, workspaceId, provider, "deal");

      return reply.send({
        data: {
          provider,
          mappings: {
            contact: contactMapping,
            deal: dealMapping,
          },
        },
      });
    } catch (err) {
      if (err instanceof HttpError) {
        return reply.status(err.statusCode).send(errorResponse(err.message, err.statusCode));
      }
      throw err;
    }
  });

  /**
   * PUT /crm/:provider/mappings
   * Updates custom field mappings for a provider in the current workspace.
   */
  app.put("/crm/:provider/mappings", async (request, reply) => {
    const workspaceId = requireWorkspaceId(request);
    const { provider } = request.params as { provider: string };

    const connector = getCrmConnector(provider);
    if (!connector) {
      return reply.status(404).send(errorResponse(`Unsupported CRM provider: ${provider}`, 404));
    }

    if (!app.db) {
      return reply.status(503).send(errorResponse("Database unavailable", 503));
    }

    const body = (request.body ?? {}) as {
      contact?: CrmObjectMapping;
      deal?: CrmObjectMapping;
    };

    const validationErrors: string[] = [];

    if (body.contact) {
      const res = validateMapping(body.contact);
      if (!res.valid) {
        validationErrors.push(...res.errors.map((e) => `contact: ${e}`));
      }
    }

    if (body.deal) {
      const res = validateMapping(body.deal);
      if (!res.valid) {
        validationErrors.push(...res.errors.map((e) => `deal: ${e}`));
      }
    }

    if (validationErrors.length > 0) {
      return reply.status(400).send(errorResponse("Invalid mapping configuration", 400, validationErrors));
    }

    try {
      await saveCrmMappings(app.db, workspaceId, provider, body);

      const contactMapping = await getResolvedCrmMapping(app.db, workspaceId, provider, "contact");
      const dealMapping = await getResolvedCrmMapping(app.db, workspaceId, provider, "deal");

      return reply.send({
        ok: true,
        data: {
          provider,
          mappings: {
            contact: contactMapping,
            deal: dealMapping,
          },
        },
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("not found")) {
        return reply.status(404).send(errorResponse(msg, 404));
      }
      throw err;
    }
  });

  /**
   * POST /crm/:provider/mappings/test
   * Tests a field mapping transformation against sample data in memory.
   */
  app.post("/crm/:provider/mappings/test", async (request, reply) => {
    const workspaceId = requireWorkspaceId(request);
    const { provider } = request.params as { provider: string };

    const connector = getCrmConnector(provider);
    if (!connector) {
      return reply.status(404).send(errorResponse(`Unsupported CRM provider: ${provider}`, 404));
    }

    const body = (request.body ?? {}) as {
      entityType: "contact" | "deal";
      direction: "inbound" | "outbound";
      sampleData: Record<string, unknown>;
      mapping?: CrmObjectMapping;
    };

    if (!body.entityType || !["contact", "deal"].includes(body.entityType)) {
      return reply.status(400).send(errorResponse("entityType must be 'contact' or 'deal'", 400));
    }

    if (!body.direction || !["inbound", "outbound"].includes(body.direction)) {
      return reply.status(400).send(errorResponse("direction must be 'inbound' or 'outbound'", 400));
    }

    const sample = body.sampleData ?? {};

    let mapping = body.mapping;
    if (!mapping) {
      if (app.db) {
        mapping = await getResolvedCrmMapping(app.db, workspaceId, provider, body.entityType).catch(() => undefined);
      }
      if (!mapping) {
        const defaults = getDefaultCrmMappings(provider);
        mapping = defaults.mappings[body.entityType];
      }
    }

    const validation = validateMapping(mapping);
    if (!validation.valid) {
      return reply.status(400).send(errorResponse("Mapping to test is invalid", 400, validation.errors));
    }

    const result = testMappingTransformation(mapping, sample, body.direction);
    return reply.send({ data: result });
  });
}

