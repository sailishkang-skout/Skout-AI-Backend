import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { errorResponse } from "../utils/http.js";

/**
 * §2 — Competitive win-loss process surface.
 * Product owner MUST be the authenticated workspace member (cannot invent names).
 * Due date is generation/assign time + 15 days.
 */
const GENERATION_MS = Date.parse("2026-08-25T00:00:00.000Z");
const DUE_MS = GENERATION_MS + 15 * 24 * 60 * 60 * 1000;

type WinLossState = {
  workspaceId: string;
  productOwnerUserId: string;
  productOwnerEmail: string | null;
  assignedAt: string;
  dueAt: string;
  status: "in_progress" | "complete";
  dealsReviewed: number;
};

/** In-process store (per API instance). Durable CRM paste still lives in the markdown template. */
const byWorkspace = new Map<string, WinLossState>();

export async function competitiveRoutes(app: FastifyInstance) {
  app.get("/competitive/win-loss", async (request, reply) => {
    if (!request.workspaceId) return reply.code(401).send(errorResponse("Unauthorized", 401));
    const row = byWorkspace.get(request.workspaceId) ?? null;
    return reply.send({
      data: row,
      defaults: {
        generatedAt: new Date(GENERATION_MS).toISOString(),
        dueAt: new Date(DUE_MS).toISOString(),
        minDeals: 4,
        whyRequired:
          "Real won/lost deals validate Regional TAM and evidence-backed positioning before build/marketing claims.",
        ownerRule: "Product owner must be the logged-in workspace member who calls assign.",
        templatePath: "docs/templates/competitive-win-loss.md",
      },
    });
  });

  app.post("/competitive/win-loss/assign", async (request, reply) => {
    if (!request.workspaceId || !request.userId) {
      return reply.code(401).send(errorResponse("Unauthorized", 401));
    }
    const body = z
      .object({ dealsReviewed: z.number().int().min(0).max(500).optional() })
      .safeParse(request.body ?? {});
    if (!body.success) {
      return reply.status(400).send(errorResponse("Invalid payload", 400, body.error.flatten()));
    }

    const now = new Date();
    const dueAt = new Date(Math.max(DUE_MS, now.getTime() + 15 * 24 * 60 * 60 * 1000));
    const state: WinLossState = {
      workspaceId: request.workspaceId,
      productOwnerUserId: request.userId,
      productOwnerEmail: request.userEmail ?? null,
      assignedAt: now.toISOString(),
      dueAt: dueAt.toISOString(),
      status: (body.data.dealsReviewed ?? 0) >= 4 ? "complete" : "in_progress",
      dealsReviewed: body.data.dealsReviewed ?? 0,
    };
    byWorkspace.set(request.workspaceId, state);
    return reply.code(201).send({ data: state });
  });
}
