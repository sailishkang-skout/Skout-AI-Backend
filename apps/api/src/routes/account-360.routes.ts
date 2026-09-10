import type { FastifyInstance } from "fastify";
import { desc, eq } from "drizzle-orm";
import { z } from "zod";
import { schema, scopedTo, scopedById } from "@skout/db";
import { errorResponse, HttpError } from "../utils/http.js";
import { getEvidence } from "../services/evidence.service.js";
import { createRegionalBriefService } from "../services/regional-brief.service.js";

const { companies, contacts, deals, activities, signals } = schema;

const LOW_CONFIDENCE_THRESHOLD = 0.5;

/**
 * §5.3/§8.4 — group an entity's evidence-ledger rows by attribute, keeping only the most
 * recent row per attribute (rows already arrive most-recent-first from getEvidence) so the
 * caller sees "what backs the current value" rather than the full observation history.
 */
function toFieldEvidence(rows: Awaited<ReturnType<typeof getEvidence>>) {
  const byAttribute: Record<
    string,
    {
      value: unknown;
      chosenValue: unknown;
      source: string;
      confidence: number;
      observedAt: string;
      freshnessExpiresAt: string | null;
      isStale: boolean;
      isLowConfidence: boolean;
    }
  > = {};

  for (const row of rows) {
    if (byAttribute[row.attribute]) continue; // most recent already kept
    const isStale = row.freshnessExpiresAt ? row.freshnessExpiresAt.getTime() < Date.now() : false;
    byAttribute[row.attribute] = {
      value: row.value,
      chosenValue: row.chosenValue ?? null,
      source: row.source,
      confidence: row.confidence,
      observedAt: row.observedAt.toISOString(),
      freshnessExpiresAt: row.freshnessExpiresAt ? row.freshnessExpiresAt.toISOString() : null,
      isStale,
      isLowConfidence: row.confidence < LOW_CONFIDENCE_THRESHOLD,
    };
  }
  return byAttribute;
}

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
        .where(scopedById(companies, request.workspaceId, companyId))
        .limit(1);
      if (!company) return reply.code(404).send(errorResponse("Company not found", 404));

      const companyContacts = await app.db
        .select()
        .from(contacts)
        .where(scopedTo(contacts, request.workspaceId, eq(contacts.companyId, companyId)))
        .limit(50);

      const companyDeals = await app.db
        .select()
        .from(deals)
        .where(scopedTo(deals, request.workspaceId, eq(deals.companyId, companyId)))
        .limit(50);

      const timeline = await app.db
        .select()
        .from(activities)
        .where(
          scopedTo(activities, request.workspaceId, eq(activities.entityType, "company"), eq(activities.entityId, companyId))
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

      // §5.3 — evidence-ledger rows backing this company's resolved fields (source/confidence/freshness).
      let fieldEvidence: ReturnType<typeof toFieldEvidence> = {};
      try {
        const evidenceRows = await getEvidence(app.db, {
          workspaceId: request.workspaceId,
          entityType: "company",
          entityId: companyId,
        });
        fieldEvidence = toFieldEvidence(evidenceRows);
      } catch {
        fieldEvidence = {};
      }

      // §6.2 — regional intelligence (market economics/business practice/channel policy) for
      // the account's resolved country. `company.location` is free text, so resolution is
      // best-effort: an unresolvable location (e.g. "San Francisco, CA") yields null, not an error.
      let regionalIntelligence = null;
      if (company.location) {
        try {
          const regionalBriefSvc = createRegionalBriefService(app.db, app.config);
          regionalIntelligence = await regionalBriefSvc.resolveRegionalBrief({
            countryIso: company.location,
            workspaceId: request.workspaceId,
          });
        } catch (err) {
          if (!(err instanceof HttpError)) throw err;
          regionalIntelligence = null;
        }
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
          fieldEvidence,
          regionalIntelligence,
          view: "account_360",
        },
      });
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
        .where(scopedById(contacts, request.workspaceId, contactId))
        .limit(1);
      if (!contact) return reply.code(404).send(errorResponse("Contact not found", 404));

      let company = null;
      if (contact.companyId) {
        const [c] = await app.db
          .select()
          .from(companies)
          .where(scopedById(companies, request.workspaceId, contact.companyId))
          .limit(1);
        company = c ?? null;
      }

      const timeline = await app.db
        .select()
        .from(activities)
        .where(
          scopedTo(activities, request.workspaceId, eq(activities.entityType, "contact"), eq(activities.entityId, contactId))
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
