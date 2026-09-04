import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { errorResponse } from "../utils/http.js";
import { applyManualEntityPatch } from "../services/crm-native-entity.service.js";

const contactPatchSchema = z
  .object({
    firstName: z.string().min(1).optional(),
    lastName: z.string().optional(),
    email: z.string().email().optional(),
    phone: z.string().optional(),
    title: z.string().optional(),
  })
  .refine((patch) => Object.keys(patch).length > 0, { message: "At least one field is required" });

const dealPatchSchema = z
  .object({
    name: z.string().min(1).optional(),
    amount: z.string().optional(),
  })
  .refine((patch) => Object.keys(patch).length > 0, { message: "At least one field is required" });

/**
 * §8.12 Task ADI-10 — the first manual field-edit surface for native CRM contacts/deals in this
 * codebase (previously every write to `contacts`/`deals` came from HubSpot inbound sync,
 * enrichment auto-fill, or identity-merge — none of which represent a human editing a field).
 * Also the trigger side of CRM push-back: a successful edit here queues an outbound write for
 * whichever fields are CRM-sync-owned (see crm-native-entity.service.ts).
 */
export async function crmNativeRoutes(app: FastifyInstance) {
  app.patch<{ Params: { id: string } }>("/crm/contacts/:id", async (request, reply) => {
    if (!request.workspaceId) return reply.code(401).send(errorResponse("Unauthorized", 401));
    if (!app.db) return reply.code(503).send(errorResponse("Database unavailable", 503));

    const parsed = contactPatchSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      return reply.status(400).send(errorResponse("Invalid contact patch", 400, parsed.error.flatten()));
    }

    const updated = await applyManualEntityPatch(app.db, request.workspaceId, "contact", request.params.id, parsed.data);
    if (!updated) return reply.code(404).send(errorResponse("contact_not_found", 404));
    return reply.send({ data: updated });
  });

  app.patch<{ Params: { id: string } }>("/crm/deals/:id", async (request, reply) => {
    if (!request.workspaceId) return reply.code(401).send(errorResponse("Unauthorized", 401));
    if (!app.db) return reply.code(503).send(errorResponse("Database unavailable", 503));

    const parsed = dealPatchSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      return reply.status(400).send(errorResponse("Invalid deal patch", 400, parsed.error.flatten()));
    }

    const updated = await applyManualEntityPatch(app.db, request.workspaceId, "deal", request.params.id, parsed.data);
    if (!updated) return reply.code(404).send(errorResponse("deal_not_found", 404));
    return reply.send({ data: updated });
  });
}
