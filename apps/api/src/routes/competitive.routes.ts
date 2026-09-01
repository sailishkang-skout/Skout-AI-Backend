import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { eq, desc } from "drizzle-orm";
import { schema } from "@skout/db";
import { errorResponse } from "../utils/http.js";
import { REGIONAL_TAM_MIN_DEALS, getRegionalTamGate } from "../services/regional-tam-gate.service.js";
import { buildCompetitivePositioningPolicy } from "../services/competitive-positioning.service.js";

const { competitiveWinLossDeals, competitiveWinLossOwners } = schema;

const GENERATION_MS = Date.parse("2026-08-25T00:00:00.000Z");
const DUE_MS = GENERATION_MS + 15 * 24 * 60 * 60 * 1000;
const MIN_DEALS = REGIONAL_TAM_MIN_DEALS;

const dealSchema = z.object({
  accountName: z.string().min(1).max(500),
  outcome: z.enum(["won", "lost"]),
  competitors: z.string().max(2000).optional(),
  differentiatorCited: z.string().max(2000).optional(),
  evidenceOrRegionalMaterial: z.boolean().optional(),
  notes: z.string().max(5000).optional(),
});

/**
 * §2 — Competitive win-loss process surface.
 * Product owner MUST be the authenticated workspace member (cannot invent names).
 * Status becomes `complete` when ≥4 real deals are recorded in Postgres.
 */
export async function competitiveRoutes(app: FastifyInstance) {
  app.get("/competitive/win-loss", async (request, reply) => {
    if (!request.workspaceId || !app.db) return reply.code(401).send(errorResponse("Unauthorized", 401));

    const [owner] = await app.db
      .select()
      .from(competitiveWinLossOwners)
      .where(eq(competitiveWinLossOwners.workspaceId, request.workspaceId))
      .limit(1);

    const deals = await app.db
      .select()
      .from(competitiveWinLossDeals)
      .where(eq(competitiveWinLossDeals.workspaceId, request.workspaceId))
      .orderBy(desc(competitiveWinLossDeals.createdAt));

    const dealsReviewed = deals.length;
    const status = dealsReviewed >= MIN_DEALS ? "complete" : "in_progress";
    const gate = dealsReviewed >= MIN_DEALS ? "validated" : "not_validated";
    const positioning = buildCompetitivePositioningPolicy(gate, dealsReviewed);

    return reply.send({
      data: owner
        ? {
            workspaceId: request.workspaceId,
            productOwnerUserId: owner.productOwnerUserId,
            assignedAt: owner.assignedAt.toISOString(),
            dueAt: owner.dueAt.toISOString(),
            status,
            dealsReviewed,
          }
        : null,
      deals: deals.map((d) => ({
        id: d.id,
        accountName: d.accountName,
        outcome: d.outcome,
        competitors: d.competitors,
        differentiatorCited: d.differentiatorCited,
        evidenceOrRegionalMaterial: d.evidenceOrRegionalMaterial,
        notes: d.notes,
        createdAt: d.createdAt.toISOString(),
      })),
      positioning,
      defaults: {
        generatedAt: new Date(GENERATION_MS).toISOString(),
        dueAt: new Date(DUE_MS).toISOString(),
        minDeals: MIN_DEALS,
        whyRequired:
          "Real won/lost deals validate Regional TAM and evidence-backed positioning before build/marketing claims.",
        ownerRule: "Product owner must be the logged-in workspace member who calls assign.",
        templatePath: "docs/templates/competitive-win-loss.md",
        processDocPath: "docs/ops/competitive-win-loss-process.md",
        adrPath: "docs/adr/0012-competitive-positioning-proposed-until-validated.md",
        gapPath:
          dealsReviewed < MIN_DEALS
            ? "Document gap in template § Gap documentation; run pilot feedback track."
            : null,
      },
    });
  });

  app.post("/competitive/win-loss/assign", async (request, reply) => {
    if (!request.workspaceId || !request.userId || !app.db) {
      return reply.code(401).send(errorResponse("Unauthorized", 401));
    }

    const now = new Date();
    const dueAt = new Date(Math.max(DUE_MS, now.getTime() + 15 * 24 * 60 * 60 * 1000));

    const [owner] = await app.db
      .insert(competitiveWinLossOwners)
      .values({
        workspaceId: request.workspaceId,
        productOwnerUserId: request.userId,
        assignedAt: now,
        dueAt,
      })
      .onConflictDoUpdate({
        target: competitiveWinLossOwners.workspaceId,
        set: { productOwnerUserId: request.userId, assignedAt: now, dueAt },
      })
      .returning();

    const deals = await app.db
      .select({ id: competitiveWinLossDeals.id })
      .from(competitiveWinLossDeals)
      .where(eq(competitiveWinLossDeals.workspaceId, request.workspaceId));

    return reply.code(201).send({
      data: {
        workspaceId: owner!.workspaceId,
        productOwnerUserId: owner!.productOwnerUserId,
        assignedAt: owner!.assignedAt.toISOString(),
        dueAt: owner!.dueAt.toISOString(),
        status: deals.length >= MIN_DEALS ? "complete" : "in_progress",
        dealsReviewed: deals.length,
      },
    });
  });

  app.post("/competitive/win-loss/deals", async (request, reply) => {
    if (!request.workspaceId || !request.userId || !app.db) {
      return reply.code(401).send(errorResponse("Unauthorized", 401));
    }
    const parsed = dealSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      return reply.status(400).send(errorResponse("Invalid deal payload", 400, parsed.error.flatten()));
    }

    const [row] = await app.db
      .insert(competitiveWinLossDeals)
      .values({
        workspaceId: request.workspaceId,
        accountName: parsed.data.accountName,
        outcome: parsed.data.outcome,
        competitors: parsed.data.competitors,
        differentiatorCited: parsed.data.differentiatorCited,
        evidenceOrRegionalMaterial: parsed.data.evidenceOrRegionalMaterial ?? false,
        notes: parsed.data.notes,
        recordedBy: request.userId,
      })
      .returning();

    const count = await app.db
      .select({ id: competitiveWinLossDeals.id })
      .from(competitiveWinLossDeals)
      .where(eq(competitiveWinLossDeals.workspaceId, request.workspaceId));

    const gate = await getRegionalTamGate(app.db, request.workspaceId);

    if (count.length === MIN_DEALS) {
      const { emitSkoutEvent } = await import("../services/skout-event.service.js");
      await emitSkoutEvent(app.db, app.config, {
        type: "tam.approved",
        tenantId: request.workspaceId,
        aggregateId: request.workspaceId,
        data: { dealsReviewed: count.length, minDeals: MIN_DEALS },
      });
    }

    return reply.code(201).send({
      data: row,
      dealsReviewed: count.length,
      status: count.length >= MIN_DEALS ? "complete" : "in_progress",
      regionalTamGate: gate.gate,
      positioning: buildCompetitivePositioningPolicy(gate.gate, count.length),
    });
  });
}
