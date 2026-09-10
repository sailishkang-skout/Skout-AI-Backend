import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb, schema, type Db } from "@skout/db";
import { eq } from "drizzle-orm";
import { loadEnv } from "../config/env.js";
import { buildApp } from "../app.js";
import type { FastifyInstance } from "fastify";

const hasDatabase = Boolean(process.env.DATABASE_URL);

describe.skipIf(!hasDatabase)("Promotion candidates E2E", () => {
  let app: FastifyInstance;
  let db: Db;
  let closeDb: () => Promise<void>;

  beforeAll(async () => {
    const config = loadEnv();
    app = await buildApp({ ...config, CLERK_SECRET_KEY: undefined, AUTH_STUB: true, LOG_LEVEL: "fatal" });
    const created = createDb(config.DATABASE_URL!);
    db = created.db;
    closeDb = () => created.sql.end();
  }, 60000);

  afterAll(async () => {
    await app?.close();
    await closeDb?.();
  });

  function asUser(email: string) {
    return { "x-stub-user-email": email };
  }

  async function getWorkspaceIdFor(headers: Record<string, string>): Promise<string> {
    const res = await app.inject({ method: "GET", url: "/api/v1/companies", headers });
    return (res.json() as { workspaceId: string }).workspaceId;
  }

  it("lists a pending candidate and promotes it into company/contact/deal", async () => {
    const headers = asUser(`promotion-e2e-${randomUUID()}@example.com`);
    const workspaceId = await getWorkspaceIdFor(headers);
    await db
      .update(schema.workspaces)
      .set({ dealPromotionThreshold: 80 })
      .where(eq(schema.workspaces.id, workspaceId));

    const prospectId = `prospect-${randomUUID()}`;
    await db.insert(schema.prospectActivations).values({
      workspaceId,
      prospectId,
      companyId: `company-${randomUUID()}`,
      snapshot: { fullName: "Alice Chen", companyName: "Acme Inc", companyDomain: "acme.com" },
    });
    const [candidate] = await db
      .insert(schema.promotionCandidates)
      .values({ workspaceId, prospectId, score: 92, status: "pending" })
      .returning();

    const listResponse = await app.inject({
      method: "GET",
      url: "/api/v1/promotion-candidates",
      headers,
    });
    expect(listResponse.statusCode).toBe(200);
    const listed = listResponse.json().data;
    expect(listed.some((c: { id: string }) => c.id === candidate.id)).toBe(true);

    const promoteResponse = await app.inject({
      method: "POST",
      url: `/api/v1/promotion-candidates/${candidate.id}/promote`,
      headers,
    });
    expect(promoteResponse.statusCode).toBe(201);
    const { companyId, contactId, dealId } = promoteResponse.json();
    expect(companyId).toBeTruthy();
    expect(contactId).toBeTruthy();
    expect(dealId).toBeTruthy();

    const [updatedCandidate] = await db
      .select()
      .from(schema.promotionCandidates)
      .where(eq(schema.promotionCandidates.id, candidate.id));
    expect(updatedCandidate.status).toBe("promoted");

    const secondPromote = await app.inject({
      method: "POST",
      url: `/api/v1/promotion-candidates/${candidate.id}/promote`,
      headers,
    });
    expect(secondPromote.statusCode).toBe(409);
  });
});
