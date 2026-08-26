import { timingSafeEqual } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { and, eq } from "drizzle-orm";
import { schema } from "@skout/db";
import { HttpError } from "@skout/auth";

const { contacts, companies, deals } = schema;

function timingSafeEqualStrings(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) {
    timingSafeEqual(bufA, bufA);
    return false;
  }
  return timingSafeEqual(bufA, bufB);
}

/**
 * §5 / §7.1 Wave 2 — internal service-to-service CRM reads for apps/api.
 * Auth: `X-Internal-Service-Token` matching CRM `INTERNAL_SERVICE_TOKEN`.
 * Workspace scoping via `X-Workspace-Id` header (required).
 */
export async function internalCrmRoutes(app: FastifyInstance) {
  function assertInternal(request: { headers: Record<string, unknown> }) {
    const expected = app.config.INTERNAL_SERVICE_TOKEN;
    if (!expected) throw new HttpError("internal_api_disabled", 503);
    const provided = String(request.headers["x-internal-service-token"] ?? "");
    if (!provided || !timingSafeEqualStrings(provided, expected)) {
      throw new HttpError("unauthorized", 401);
    }
  }

  function workspaceIdFrom(request: { headers: Record<string, unknown> }): string {
    const ws = String(request.headers["x-workspace-id"] ?? "");
    if (!ws) throw new HttpError("workspace_required", 400);
    return ws;
  }

  app.get<{ Params: { id: string } }>("/contacts/:id", async (request) => {
    assertInternal(request);
    const workspaceId = workspaceIdFrom(request);
    if (!app.db) throw new HttpError("database_unavailable", 503);
    const [row] = await app.db
      .select()
      .from(contacts)
      .where(and(eq(contacts.id, request.params.id), eq(contacts.workspaceId, workspaceId)))
      .limit(1);
    if (!row) throw new HttpError("contact_not_found", 404);
    return { data: row };
  });

  app.get<{ Params: { prospectId: string } }>("/contacts/by-prospect/:prospectId", async (request) => {
    assertInternal(request);
    const workspaceId = workspaceIdFrom(request);
    if (!app.db) throw new HttpError("database_unavailable", 503);
    const [row] = await app.db
      .select()
      .from(contacts)
      .where(
        and(eq(contacts.sourceProspectId, request.params.prospectId), eq(contacts.workspaceId, workspaceId))
      )
      .limit(1);
    if (!row) throw new HttpError("contact_not_found", 404);
    return { data: row };
  });

  app.get<{ Params: { id: string } }>("/companies/:id", async (request) => {
    assertInternal(request);
    const workspaceId = workspaceIdFrom(request);
    if (!app.db) throw new HttpError("database_unavailable", 503);
    const [row] = await app.db
      .select()
      .from(companies)
      .where(and(eq(companies.id, request.params.id), eq(companies.workspaceId, workspaceId)))
      .limit(1);
    if (!row) throw new HttpError("company_not_found", 404);
    return { data: row };
  });

  app.get<{ Params: { id: string } }>("/deals/:id/summary", async (request) => {
    assertInternal(request);
    const workspaceId = workspaceIdFrom(request);
    if (!app.db) throw new HttpError("database_unavailable", 503);
    const [row] = await app.db
      .select({
        id: deals.id,
        name: deals.name,
        stageId: deals.stageId,
        amount: deals.amount,
        currency: deals.currency,
        companyId: deals.companyId,
        status: deals.status,
      })
      .from(deals)
      .where(and(eq(deals.id, request.params.id), eq(deals.workspaceId, workspaceId)))
      .limit(1);
    if (!row) throw new HttpError("deal_not_found", 404);
    return { data: row };
  });
}
