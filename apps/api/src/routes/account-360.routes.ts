import type { FastifyInstance } from "fastify";
import { and, desc, eq } from "drizzle-orm";
import { z } from "zod";
import { schema } from "@skout/db";
import { errorResponse } from "../utils/http.js";
import { getAccountEvidence } from "../services/evidence.service.js";

const { companies, contacts, deals, activities, signals } = schema;

/**
 * §8.4 — Account 360 / Person 360 read models (compose CRM + signals + timeline).
 */
export async function account360Routes(app: FastifyInstance) {
  app.get("/account-360/:companyId", async (request, reply) => {
    if (!request.workspaceId) return reply.code(401).send(errorResponse("Unauthorized", 401));
    if (!app.db) return reply.code(404).send(errorResponse("Company not found", 404));

    try {
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

      // Buying Committee Influence Map classification
      const buyingCommittee = companyContacts.map((c) => {
        const titleLower = (c.title ?? "").toLowerCase();
        let role = "Evaluator";
        if (titleLower.includes("vp") || titleLower.includes("chief") || titleLower.includes("head") || titleLower.includes("ceo") || titleLower.includes("cxo")) {
          role = "Decision Maker";
        } else if (titleLower.includes("director") || titleLower.includes("lead") || titleLower.includes("manager")) {
          role = "Champion";
        } else if (titleLower.includes("procurement") || titleLower.includes("legal") || titleLower.includes("security")) {
          role = "Blocker / Gatekeeper";
        }
        return {
          id: c.id,
          fullName: `${c.firstName ?? ""} ${c.lastName ?? ""}`.trim() || "Unknown Contact",
          title: c.title ?? "Unknown Title",
          email: c.email,
          phone: c.phone,
          role,
        };
      });

      return reply.send({
        data: {
          company,
          contacts: companyContacts,
          buyingCommittee,
          deals: companyDeals,
          timeline,
          signals: signalRows,
          view: "account_360",
        },
      });
    } catch {
      return reply.code(404).send(errorResponse("Company not found", 404));
    }
  });

  /**
   * §8.2 SS-05 — "why this account" evidence panel. Scoped to the evidence_ledger rows already
   * recorded against this company (see evidence.service.ts's getAccountEvidence), grouped by
   * attribute with pre-computed confidence/freshness tiers so the Discover/Account 360 frontend
   * can render source + confidence + freshness per fact without re-deriving thresholds itself.
   */
  app.get("/account-360/:companyId/evidence", async (request, reply) => {
    if (!request.workspaceId) return reply.code(401).send(errorResponse("Unauthorized", 401));
    if (!app.db) return reply.code(404).send(errorResponse("Company not found", 404));

    try {
      const { companyId } = z.object({ companyId: z.string().uuid() }).parse(request.params);

      const [company] = await app.db
        .select({ id: companies.id })
        .from(companies)
        .where(and(eq(companies.id, companyId), eq(companies.workspaceId, request.workspaceId)))
        .limit(1);
      if (!company) return reply.code(404).send(errorResponse("Company not found", 404));

      const evidence = await getAccountEvidence(app.db, request.workspaceId, companyId);

      return reply.send({ data: { companyId, evidence } });
    } catch {
      return reply.code(404).send(errorResponse("Company not found", 404));
    }
  });

  app.get("/person-360/:contactId", async (request, reply) => {
    if (!request.workspaceId) return reply.code(401).send(errorResponse("Unauthorized", 401));
    if (!app.db) return reply.code(404).send(errorResponse("Contact not found", 404));

    try {
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

      // Professional Facts vs Inferred/Intent Context separation
      const professionalFacts = {
        fullName: `${contact.firstName ?? ""} ${contact.lastName ?? ""}`.trim() || "Unknown Contact",
        email: contact.email,
        phone: contact.phone,
        title: contact.title,
        companyName: company?.name,
        companyDomain: company?.domain,
      };

      const inferredContext = {
        signalsCount: signalRows.length,
        activityCount: timeline.length,
        signals: signalRows,
      };

      return reply.send({
        data: {
          contact,
          company,
          professionalFacts,
          inferredContext,
          timeline,
          signals: signalRows,
          view: "person_360",
        },
      });
    } catch {
      return reply.code(404).send(errorResponse("Contact not found", 404));
    }
  });
}
