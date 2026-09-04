import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createDb, schema } from "@skout/db";
import { loadEnv } from "../config/env.js";
import { buildApp } from "../app.js";
import type { FastifyInstance } from "fastify";

const WORKSPACE = "00000000-0000-4000-8000-000000000001";
const SAMPLE_COMPANY_ID = "00000000-0000-4000-8000-000000000002";
const SAMPLE_CONTACT_ID = "00000000-0000-4000-8000-000000000003";

function asUser(email: string) {
  return { "x-stub-user-email": email };
}

/** Under stub auth, request.workspaceId always comes from the provisioned stub user, not the
 * x-workspace-id header — resolve it the same way (by the stub's clerkUserId) so fixtures land
 * in the workspace the route will actually look them up in. */
async function resolveStubWorkspaceId(db: ReturnType<typeof createDb>["db"], email: string): Promise<string> {
  const [user] = await db.select({ id: schema.users.id }).from(schema.users).where(eq(schema.users.email, email)).limit(1);
  if (!user) throw new Error(`stub user for ${email} was not provisioned`);
  const [membership] = await db
    .select({ workspaceId: schema.workspaceMembers.workspaceId })
    .from(schema.workspaceMembers)
    .where(eq(schema.workspaceMembers.userId, user.id))
    .limit(1);
  if (!membership) throw new Error(`no workspace membership for stub user ${email}`);
  return membership.workspaceId;
}

const BASE_OVERRIDES = {
  CLERK_SECRET_KEY: undefined as unknown as string,
  LOG_LEVEL: "fatal" as const,
};

let app: FastifyInstance;

beforeAll(async () => {
  const config = loadEnv();
  app = await buildApp({ ...config, ...BASE_OVERRIDES });
});

afterAll(async () => {
  await app?.close();
});

describe("§8.4 — Account 360 & Person 360 Routes", () => {
  it("GET /api/v1/account-360/:companyId — returns 404 cleanly when record is not found", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/account-360/${SAMPLE_COMPANY_ID}`,
      headers: { "x-workspace-id": WORKSPACE },
    });
    expect(res.statusCode).toBe(404);
  });

  it("GET /api/v1/person-360/:contactId — returns 404 cleanly when record is not found", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/person-360/${SAMPLE_CONTACT_ID}`,
      headers: { "x-workspace-id": WORKSPACE },
    });
    expect(res.statusCode).toBe(404);
  });
});

describe("§8.2 SS-05 — GET /api/v1/account-360/:companyId/evidence", () => {
  it("returns 404 cleanly when the account is not found", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/account-360/${SAMPLE_COMPANY_ID}/evidence`,
      headers: { "x-workspace-id": WORKSPACE },
    });
    expect(res.statusCode).toBe(404);
  });

  it("returns evidence grouped by attribute with confidence/freshness tiers for a real account", async () => {
    const config = loadEnv();
    const { db } = createDb(config.DATABASE_URL ?? "postgresql://postgres:postgres@localhost:5432/skout");
    const email = `a360-evidence-${Date.now()}@test.com`;

    // Provision the stub user/workspace first (a no-op request is enough to trigger it).
    await app.inject({ method: "GET", url: `/api/v1/account-360/${SAMPLE_COMPANY_ID}`, headers: asUser(email) });
    const workspaceId = await resolveStubWorkspaceId(db, email);

    const [company] = await db
      .insert(schema.companies)
      .values({ workspaceId, name: "Evidence Panel Inc" })
      .returning();
    await db.insert(schema.evidenceLedger).values({
      workspaceId,
      entityType: "company",
      entityId: company!.id,
      attribute: "industry",
      value: "SaaS",
      source: "clearbit",
      observedAt: new Date(),
      confidence: 0.3,
      freshnessExpiresAt: new Date(Date.now() - 1000),
    });

    const res = await app.inject({
      method: "GET",
      url: `/api/v1/account-360/${company!.id}/evidence`,
      headers: asUser(email),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.data.companyId).toBe(company!.id);
    expect(body.data.evidence).toHaveLength(1);
    const group = body.data.evidence[0];
    expect(group.attribute).toBe("industry");
    expect(group.entries[0].source).toBe("clearbit");
    expect(group.entries[0].confidenceTier).toBe("low");
    expect(group.entries[0].freshnessStatus).toBe("expired");
  });
});
