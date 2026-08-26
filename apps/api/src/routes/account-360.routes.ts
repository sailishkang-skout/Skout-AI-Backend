import type { FastifyInstance } from "fastify";
import { and, desc, eq } from "drizzle-orm";
import { z } from "zod";
import { schema } from "@skout/db";
import { errorResponse } from "../utils/http.js";

const { companies, contacts, deals, activities, signals } = schema;

/**
 * §8.4 — Account 360 / Person 360 read models (compose CRM + signals + timeline).
 */
export async function account360Routes(app: FastifyInstance) {
  app.get("/account-360/:companyId", async (request, reply) => {
    if (!request.workspaceId || !app.db) return reply.code(401).send(errorResponse("Unauthorized", 401));
    const { companyId } = z.object({ companyId: z.string().uuid() }).parse(request.params);

    const [company] = await app.db
      .select()
      .from(companies)
      .where(and(eq(companies.id, companyId), eq(companies.workspaceId, request.workspaceId)))
      .limit(1);
    if (!company) return reply.code(404).send(errorResponse("Company not found", 404));

    const companyContacts = await app.db
      .select()
      .from(contacts)
      .where(and(eq(contacts.companyId, companyId), eq(contacts.workspaceId, request.workspaceId)))
      .limit(50);

    const companyDeals = await app.db
      .select()
      .from(deals)
      .where(and(eq(deals.companyId, companyId), eq(deals.workspaceId, request.workspaceId)))
      .limit(50);

    const timeline = await app.db
      .select()
      .from(activities)
      .where(
        and(
          eq(activities.workspaceId, request.workspaceId),
          eq(activities.entityType, "company"),
          eq(activities.entityId, companyId)
        )
      )
      .orderBy(desc(activities.occurredAt))
      .limit(30);

    let signalRows: unknown[] = [];
    try {
      signalRows = await app.db
        .select()
        .from(signals)
        .where(eq(signals.entityId, companyId))
        .orderBy(desc(signals.detectedAt))
        .limit(20);
    } catch {
      signalRows = [];
    }

    return reply.send({
      data: {
        company,
        contacts: companyContacts,
        deals: companyDeals,
        timeline,
        signals: signalRows,
        view: "account_360",
      },
    });
  });

  app.get("/person-360/:contactId", async (request, reply) => {
    if (!request.workspaceId || !app.db) return reply.code(401).send(errorResponse("Unauthorized", 401));
    const { contactId } = z.object({ contactId: z.string().uuid() }).parse(request.params);

    const [contact] = await app.db
      .select()
      .from(contacts)
      .where(and(eq(contacts.id, contactId), eq(contacts.workspaceId, request.workspaceId)))
      .limit(1);
    if (!contact) return reply.code(404).send(errorResponse("Contact not found", 404));

    let company = null;
    if (contact.companyId) {
      const [c] = await app.db
        .select()
        .from(companies)
        .where(and(eq(companies.id, contact.companyId), eq(companies.workspaceId, request.workspaceId)))
        .limit(1);
      company = c ?? null;
    }

    const timeline = await app.db
      .select()
      .from(activities)
      .where(
        and(
          eq(activities.workspaceId, request.workspaceId),
          eq(activities.entityType, "contact"),
          eq(activities.entityId, contactId)
        )
      )
      .orderBy(desc(activities.occurredAt))
      .limit(30);

    let signalRows: unknown[] = [];
    try {
      signalRows = await app.db
        .select()
        .from(signals)
        .where(eq(signals.entityId, contactId))
        .orderBy(desc(signals.detectedAt))
        .limit(20);
    } catch {
      signalRows = [];
    }

    return reply.send({
      data: {
        contact,
        company,
        timeline,
        signals: signalRows,
        view: "person_360",
      },
    });
  });
}
