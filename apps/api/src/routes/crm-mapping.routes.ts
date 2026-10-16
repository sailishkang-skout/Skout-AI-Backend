import type { FastifyInstance } from "fastify";
import { getCrmConnector } from "../services/crm-connector.registry.js";
import {
  getCrmMappingHistory,
  getDefaultCrmMappings,
  getResolvedCrmMapping,
  saveCrmMappings,
  testMappingTransformation,
  validateMapping,
  type CrmObjectMapping,
} from "../services/crm-mapping.service.js";
import { errorResponse, HttpError, requireWorkspaceId } from "../utils/http.js";
import { createDefaultCredentialsStore, ensureFreshTokens } from "../services/crm-export.runner.js";
import { fetchHubSpotDealPipelines, fetchHubSpotPropertyNames } from "../services/hubspot.client.js";
import { getStageMap, listSkoutStages, saveStageMap } from "../services/crm-stage-map.service.js";
import { sendHttpError } from "./crm-admin-gate.js";
import { crmAdminGate } from "./crm-admin-gate.js";

export async function crmMappingRoutes(app: FastifyInstance) {
  app.addHook("preHandler", crmAdminGate(app));

  /** The provider's live property names per object type, or null when they cannot be read now. */
  async function liveProperties(workspaceId: string, provider: string): Promise<Record<"contact" | "deal", string[]> | null> {
    if (provider !== "hubspot" || !app.db) return null;
    try {
      const tokens = await ensureFreshTokens(app.db, app.config, createDefaultCredentialsStore(app.config), workspaceId);
      const [contact, deal] = await Promise.all([
        fetchHubSpotPropertyNames(tokens.accessToken, "contacts"),
        fetchHubSpotPropertyNames(tokens.accessToken, "deals"),
      ]);
      return { contact, deal };
    } catch {
      return null;
    }
  }

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

    if (!body.contact && !body.deal) {
      return reply.status(422).send(errorResponse("Send a contact or deal mapping", 422));
    }

    // Checked against the provider's live properties when they can be read, so a mapping to a
    // field the portal does not have is refused instead of syncing nothing.
    const live = await liveProperties(workspaceId, provider);
    const validationErrors: string[] = [];
    for (const entityType of ["contact", "deal"] as const) {
      const mapping = body[entityType];
      if (!mapping) continue;
      const res = validateMapping(mapping, live?.[entityType], entityType);
      validationErrors.push(...res.errors.map((e) => `${entityType}: ${e}`));
      validationErrors.push(
        ...res.missingExternalProperties.map((f) => `${entityType}: ${provider} has no property ${f}`)
      );
    }

    if (validationErrors.length > 0) {
      return reply.status(422).send(errorResponse("Invalid mapping configuration", 422, validationErrors));
    }

    try {
      await saveCrmMappings(app.db, workspaceId, provider, body, request.userId);

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

    const validation = validateMapping(mapping, undefined, body.entityType);
    if (!validation.valid) {
      return reply.status(422).send(errorResponse("Mapping to test is invalid", 422, validation.errors));
    }

    const result = testMappingTransformation(mapping, sample, body.direction);
    return reply.send({ data: result });
  });

  /**
   * GET /crm/:provider/mappings/history?entityType=contact
   * Earlier versions of a mapping, newest first.
   */
  app.get("/crm/:provider/mappings/history", async (request, reply) => {
    const workspaceId = requireWorkspaceId(request);
    const { provider } = request.params as { provider: string };
    const { entityType } = (request.query ?? {}) as { entityType?: string };

    if (!getCrmConnector(provider)) {
      return reply.status(404).send(errorResponse(`Unsupported CRM provider: ${provider}`, 404));
    }
    if (entityType !== "contact" && entityType !== "deal") {
      return reply.status(400).send(errorResponse("entityType must be 'contact' or 'deal'", 400));
    }
    if (!app.db) {
      return reply.status(503).send(errorResponse("Database unavailable", 503));
    }

    const history = await getCrmMappingHistory(app.db, workspaceId, provider, entityType);
    return reply.send({ data: history });
  });

  /**
   * GET /crm/:provider/stage-map
   * The HubSpot stage -> Skout stage map, with both sides' stages to pick from (HubSpot's are null
   * when they cannot be read now).
   */
  app.get("/crm/:provider/stage-map", async (request, reply) => {
    const workspaceId = requireWorkspaceId(request);
    const { provider } = request.params as { provider: string };
    if (provider !== "hubspot") {
      return reply.status(404).send(errorResponse(`Unsupported CRM provider: ${provider}`, 404));
    }
    if (!app.db) {
      return reply.status(503).send(errorResponse("Database unavailable", 503));
    }
    let providerPipelines: Awaited<ReturnType<typeof fetchHubSpotDealPipelines>> | null = null;
    try {
      const tokens = await ensureFreshTokens(app.db, app.config, createDefaultCredentialsStore(app.config), workspaceId);
      providerPipelines = await fetchHubSpotDealPipelines(tokens.accessToken);
    } catch {
      providerPipelines = null;
    }
    const [map, skoutStages] = await Promise.all([getStageMap(app.db, workspaceId, provider), listSkoutStages(app.db, workspaceId)]);
    return reply.send({ data: { map, providerPipelines, skoutStages } });
  });

  /**
   * PUT /crm/:provider/stage-map  { map: { "<hubspot stage id>": "<skout stage id>" } }
   * Used when a deal is first pulled from HubSpot; an existing deal's stage is never changed by a pull.
   */
  app.put("/crm/:provider/stage-map", async (request, reply) => {
    const workspaceId = requireWorkspaceId(request);
    const { provider } = request.params as { provider: string };
    if (provider !== "hubspot") {
      return reply.status(404).send(errorResponse(`Unsupported CRM provider: ${provider}`, 404));
    }
    if (!app.db) {
      return reply.status(503).send(errorResponse("Database unavailable", 503));
    }
    const body = (request.body ?? {}) as { map?: unknown };
    const map = body.map;
    const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (
      !map ||
      typeof map !== "object" ||
      Array.isArray(map) ||
      Object.keys(map).length > 500 ||
      !Object.entries(map as Record<string, unknown>).every(([k, v]) => k.length > 0 && k.length <= 200 && typeof v === "string" && uuid.test(v))
    ) {
      return reply.status(422).send(errorResponse("map must be an object of HubSpot stage id to Skout stage id (uuid)", 422));
    }
    try {
      const saved = await saveStageMap(app.db, workspaceId, provider, map as Record<string, string>, request.userId);
      return reply.send({ ok: true, data: { map: saved } });
    } catch (err) {
      if (sendHttpError(reply, err)) return reply;
      throw err;
    }
  });
}
