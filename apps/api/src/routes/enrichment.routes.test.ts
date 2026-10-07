/**
 * §5.2 / §7.1 DOCUMENTED READ-MODEL EXCEPTION (Enterprise Completion Plan) — see
 * docs/adr/0003-read-model-exceptions.md. ENR-01 test fixtures access prospect↔CRM linkage.
 *   - Tables touched directly: contacts, companies (both owned by apps/crm)
 *     - read AND write
 *   - Owning service: apps/crm (test fixtures require direct access for setup)
 *   - Reason: integration tests validate enrichment→CRM identity linking end-to-end;
 *     required to assert cross-service state consistency in test fixtures.
 *   - Review date: revisit once apps/crm's internal API surface fully shipped (Wave 2)
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { schema } from "@skout/db";
import { and, desc, eq, isNull, like } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { loadEnv } from "../config/env.js";
import { buildApp } from "../app.js";
import { ensureDemoIcp } from "../test/ensure-demo-icp.js";
import { ensureDemoWorkspace } from "../services/demo-workspace.js";
import { buildTestAuth, buildTestAuthEnv } from "@skout/auth";
import type { FastifyInstance } from "fastify";

const WORKSPACE = "00000000-0000-4000-8000-000000000001";

const BASE_OVERRIDES = {
  CLERK_SECRET_KEY: undefined as unknown as string,
  LOG_LEVEL: "fatal" as const,
  AI_SERVICE_URL: undefined as unknown as string,
  CLICKHOUSE_URL: undefined as unknown as string,
  HUNTER_API_KEY: undefined as unknown as string,
  MILLIONVERIFIER_API_KEY: undefined as unknown as string,
  ZEROBOUNCE_API_KEY: undefined as unknown as string,
  NEVERBOUNCE_API_KEY: undefined as unknown as string,
  PDL_API_KEY: undefined as unknown as string,
  REVENUEBASE_API_KEY: undefined as unknown as string,
  EXPLORIUM_API_KEY: undefined as unknown as string,
  CORESIGNAL_API_KEY: undefined as unknown as string,
  DATAGMA_API_KEY: undefined as unknown as string,
  CONTACTOUT_API_KEY: undefined as unknown as string,
  COGNISM_API_KEY: undefined as unknown as string,
  KASPR_API_KEY: undefined as unknown as string,
  LUSHA_API_KEY: undefined as unknown as string,
};

let app: FastifyInstance;

const TEST_USER_ID = randomUUID();
const TEST_USER_EMAIL = `enrichment-api-test-${TEST_USER_ID}@example.com`;
let testAuth: ReturnType<typeof buildTestAuth>;

beforeAll(async () => {
  const config = loadEnv();
  app = await buildApp({ ...config, ...BASE_OVERRIDES, ...buildTestAuthEnv() });
  if (!app.db) throw new Error("database_unavailable");
  await ensureDemoWorkspace(app.db, WORKSPACE);
  await ensureDemoIcp(app, WORKSPACE);
  
  // Build test auth with proper permissions for enrichment endpoints
  testAuth = buildTestAuth({
    workspaceId: WORKSPACE,
    userId: TEST_USER_ID,
    email: TEST_USER_EMAIL,
    role: "owner",
  });

  // Keep the deterministic test workspace and user provisioned for authenticated route checks.
  if (app.db) {
          // First create the test user in the users table to satisfy foreign key constraints
          await app.db
            .insert(schema.users)
            .values({
              id: TEST_USER_ID,
              email: TEST_USER_EMAIL,
              fullName: "Enrichment Test User",
              status: "active",
            })
            .onConflictDoNothing();

          await app.db
            .insert(schema.workspaceMembers)
            .values({ workspaceId: WORKSPACE, userId: TEST_USER_ID, role: "owner" })
            .onConflictDoUpdate({
              target: [schema.workspaceMembers.workspaceId, schema.workspaceMembers.userId],
              set: { role: "owner" },
            });
          
          // Look up the system owner role that's already seeded
        const [ownerRole] = await app.db
          .select({ id: schema.roles.id })
          .from(schema.roles)
          .where(and(eq(schema.roles.key, "owner"), isNull(schema.roles.workspaceId)))
          .limit(1);

        if (ownerRole) {
          // Assign the owner role to the test user
          await app.db
            .insert(schema.workspaceMemberRoles)
            .values({
              workspaceId: WORKSPACE,
              userId: TEST_USER_ID,
              roleId: ownerRole.id,
            })
            .onConflictDoNothing();
          
          // Also ensure the owner role has all enrichment permissions
          const enrichmentPermissions = await app.db
            .select({ key: schema.permissions.key })
            .from(schema.permissions)
            .where(like(schema.permissions.key, "enrichment:%"));
          
          for (const perm of enrichmentPermissions) {
            await app.db
              .insert(schema.rolePermissions)
              .values({ roleId: ownerRole.id, permissionKey: perm.key })
              .onConflictDoNothing();
          }
        }

          // Top up credit balance for test workspace
            await app.db
              .insert(schema.creditBalances)
              .values({ workspaceId: WORKSPACE, balance: 5000 })
              .onConflictDoUpdate({
                target: schema.creditBalances.workspaceId,
                set: { balance: 5000, updatedAt: new Date() },
              });
  }
}, 60000);

afterAll(async () => {
  await app?.close();
});

describe("enrichment API (strategy §5–§9, Tier 2 activation)", () => {
  it("returns credit balance for workspace", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/enrichment/credits",
      headers: { 
        "x-workspace-id": WORKSPACE,
        "Authorization": testAuth.bearer
      },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { balance: number };
    expect(body.balance).toBeGreaterThan(0);
  });

  it("enriches a prospect: firmographics + email + verification (§5, §8)", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/prospects/acme-prospect/enrich",
      headers: { 
        "x-workspace-id": WORKSPACE, 
        "content-type": "application/json",
        "Authorization": testAuth.bearer
      },
      payload: {
        prospect: {
          fullName: "John Smith",
          companyDomain: "acme.com",
          title: "VP Sales",
          industry: "Software",
          country: "US",
          employeeCount: 250,
        },
        fields: ["company", "email", "validation"],
      },
    });
    expect(res.statusCode).toBe(202);
    const body = res.json() as {
      status: string;
      creditsUsed: number;
      results: { field: string; isPrimary?: boolean }[];
    };
    expect(body.status).toBe("completed");
    expect(body.creditsUsed).toBeGreaterThan(0);
    expect(body.results.some((r) => r.field === "company")).toBe(true);
    expect(body.results.some((r) => r.field === "email")).toBe(true);
    expect(body.results.some((r) => r.field === "email_status")).toBe(true);
  });

  it("skips phone when lead score is below gate (§6, default gate=80)", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/prospects/low-score-phone-gate/enrich",
      headers: { 
        "x-workspace-id": WORKSPACE, 
        "content-type": "application/json",
        "Authorization": testAuth.bearer
      },
      payload: {
        prospect: { fullName: "Jane Doe", companyDomain: "example.com", industry: "Retail", country: "US" },
        fields: ["phone"],
      },
    });
    expect(res.statusCode).toBe(202);
    const body = res.json() as { results: { field: string; validationStatus?: string }[]; creditsUsed: number };
    expect(body.results.some((r) => r.field === "phone" && r.validationStatus === "skipped")).toBe(true);
    expect(body.creditsUsed).toBe(0);
  });

  it("allows phone when gate is overridden via env (§6)", async () => {
    const config = loadEnv();
    const gateApp = await buildApp({
      ...config,
      ...BASE_OVERRIDES,
      ...buildTestAuthEnv(),
      ENRICHMENT_PHONE_SCORE_GATE: -1,
    });
    const gateTestAuth = buildTestAuth({
      workspaceId: WORKSPACE,
      userId: TEST_USER_ID,
      email: TEST_USER_EMAIL,
      role: "owner",
    });
    try {
      if (!gateApp.db) throw new Error("database_unavailable");
      await ensureDemoWorkspace(gateApp.db, WORKSPACE);
      await ensureDemoIcp(gateApp, WORKSPACE);
      
      // Add same permissions for gateApp test user
      if (gateApp.db) {
        // First create the test user in the users table to satisfy foreign key constraints
        await gateApp.db
          .insert(schema.users)
          .values({
            id: TEST_USER_ID,
            email: TEST_USER_EMAIL,
            fullName: "Enrichment Test User",
            status: "active",
          })
          .onConflictDoNothing();

        await gateApp.db
          .insert(schema.workspaceMembers)
          .values({ workspaceId: WORKSPACE, userId: TEST_USER_ID, role: "owner" })
          .onConflictDoUpdate({
            target: [schema.workspaceMembers.workspaceId, schema.workspaceMembers.userId],
            set: { role: "owner" },
          });
          
        // Look up the system owner role that's already seeded
        const [ownerRole] = await gateApp.db
          .select({ id: schema.roles.id })
          .from(schema.roles)
          .where(and(eq(schema.roles.key, "owner"), isNull(schema.roles.workspaceId)))
          .limit(1);

        if (ownerRole) {
          // Assign the owner role to the test user
          await gateApp.db
            .insert(schema.workspaceMemberRoles)
            .values({
              workspaceId: WORKSPACE,
              userId: TEST_USER_ID,
              roleId: ownerRole.id,
            })
            .onConflictDoNothing();
          
          // Also ensure the owner role has all enrichment permissions
          const enrichmentPermissions = await gateApp.db
            .select({ key: schema.permissions.key })
            .from(schema.permissions)
            .where(like(schema.permissions.key, "enrichment:%"));
          
          for (const perm of enrichmentPermissions) {
            await gateApp.db
              .insert(schema.rolePermissions)
              .values({ roleId: ownerRole.id, permissionKey: perm.key })
              .onConflictDoNothing();
          }
        }
          
        // Top up credit balance for test workspace in gateApp
        await gateApp.db
          .insert(schema.creditBalances)
          .values({ workspaceId: WORKSPACE, balance: 5000 })
          .onConflictDoUpdate({
            target: schema.creditBalances.workspaceId,
            set: { balance: 5000, updatedAt: new Date() },
          });
      }

      const res = await gateApp.inject({
        method: "POST",
        url: "/api/v1/prospects/gate-test/enrich",
        headers: { 
          "x-workspace-id": WORKSPACE, 
          "content-type": "application/json",
          "Authorization": gateTestAuth.bearer
        },
        payload: {
          prospect: { fullName: "John Smith", companyDomain: "acme.com" },
          fields: ["phone"],
        },
      });
      expect(res.statusCode).toBe(202);
      const body = res.json() as { results: { field: string; isPrimary?: boolean }[] };
      expect(body.results.some((r) => r.field === "phone" && r.isPrimary !== false)).toBe(true);
    } finally {
      await gateApp.close();
    }
  }, 60000);

  it("activates prospects without external spend (§8 Tier 2 add-to-workspace)", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/prospects/activate",
      headers: { 
        "x-workspace-id": WORKSPACE, 
        "content-type": "application/json",
        "Authorization": testAuth.bearer
      },
      payload: {
        prospects: [{ fullName: "Amy Lee", companyDomain: "foo.com", title: "CEO" }],
      },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ activated: 1 });
  });

  it("scores a prospect against ICP (§9)", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/enrichment/score",
      headers: { 
        "x-workspace-id": WORKSPACE, 
        "content-type": "application/json",
        "Authorization": testAuth.bearer
      },
      payload: {
        prospect: {
          companyDomain: "acme.com",
          title: "VP Sales",
          seniority: "vp",
          industry: "Software",
          country: "US",
          employeeCount: 250,
          signals: ["recent_hiring"],
        },
        icp: {
          industries: ["Software"],
          countries: ["US"],
          seniorities: ["vp"],
          minEmployees: 50,
          maxEmployees: 500,
        },
      },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      icpScore: number;
      icpBand: string;
      intentScore: number;
      outreachReadiness: string;
    };
    expect(body.icpScore).toBeGreaterThanOrEqual(0);
    expect(body.icpScore).toBeLessThanOrEqual(100);
    expect(["strong", "medium", "weak"]).toContain(body.icpBand);
    expect(body.intentScore).toBeGreaterThan(0);
    expect(body.outreachReadiness).toBeTruthy();
  });

  it("creates a list and bulk-enriches members (§8 user intent trigger)", async () => {
    const create = await app.inject({
      method: "POST",
      url: "/api/v1/lists",
      headers: { 
        "x-workspace-id": WORKSPACE, 
        "content-type": "application/json",
        "Authorization": testAuth.bearer
      },
      payload: { name: "Test List", mode: "static" },
    });
    expect(create.statusCode).toBe(201);
    const list = create.json() as { id: string; prospectCount: number };

    const members = await app.inject({
      method: "POST",
      url: `/api/v1/lists/${list.id}/members`,
      headers: { 
        "x-workspace-id": WORKSPACE, 
        "content-type": "application/json",
        "Authorization": testAuth.bearer
      },
      payload: {
        prospects: [
          {
            prospectId: "prospect-amy",
            fullName: "Amy Lee",
            companyDomain: "foo.com",
            title: "CEO",
          },
          {
            prospectId: "prospect-bob",
            fullName: "Bob Ray",
            companyDomain: "bar.com",
            title: "VP Marketing",
          },
        ],
      },
    });
    expect(members.statusCode).toBe(200);

    const enrich = await app.inject({
      method: "POST",
      url: `/api/v1/lists/${list.id}/enrich`,
      headers: { 
        "x-workspace-id": WORKSPACE, 
        "content-type": "application/json",
        "Authorization": testAuth.bearer
      },
      payload: { fields: ["company", "email", "validation"] },
    });
    expect(enrich.statusCode).toBe(202);
    const batch = enrich.json() as { batchId: string; status: string; total: number };
    expect(batch.total).toBe(2);
    expect(batch.status).toBe("completed");

    const jobs = await app.inject({
      method: "GET",
      url: "/api/v1/enrichment/jobs",
      headers: { 
        "x-workspace-id": WORKSPACE,
        "Authorization": testAuth.bearer
      },
    });
    expect(jobs.statusCode).toBe(200);
    const jobList = jobs.json() as { data: unknown[]; total: number };
    expect(jobList.total).toBeGreaterThanOrEqual(2);
  });

  it("lists enrichment jobs and fetches job by id", async () => {
    const enrich = await app.inject({
      method: "POST",
      url: "/api/v1/prospects/job-fetch-test/enrich",
      headers: { 
        "x-workspace-id": WORKSPACE, 
        "content-type": "application/json",
        "Authorization": testAuth.bearer
      },
      payload: {
        prospect: { fullName: "Test User", companyDomain: "test.com" },
        fields: ["company"],
      },
    });
    const { jobId } = enrich.json() as { jobId: string };

    const get = await app.inject({
      method: "GET",
      url: `/api/v1/enrichment/jobs/${jobId}`,
      headers: { 
        "x-workspace-id": WORKSPACE,
        "Authorization": testAuth.bearer
      },
    });
    expect(get.statusCode).toBe(200);
    expect(get.json()).toMatchObject({ id: jobId, status: "completed" });
  });

  it("returns 404 (not a raw DB error) for a non-uuid job id, e.g. the frontend's optimistic-update placeholder", async () => {
    const get = await app.inject({
      method: "GET",
      url: "/api/v1/enrichment/jobs/optimistic-1787639887967",
      headers: { 
        "x-workspace-id": WORKSPACE,
        "Authorization": testAuth.bearer
      },
    });
    expect(get.statusCode).toBe(404);
    // The app-wide onSend hook (app.ts) normalizes every {error} reply into {error, message,
    // statusCode} — this asserts the real response shape, not just this route's own .send() call.
    expect(get.json()).toEqual({ error: "job_not_found", message: "job_not_found", statusCode: 404 });
  });

  it("returns 404 for a retry against a non-uuid job id", async () => {
    const retry = await app.inject({
      method: "POST",
      url: "/api/v1/enrichment/jobs/optimistic-1787639887967/retry",
      headers: { 
        "x-workspace-id": WORKSPACE,
        "Authorization": testAuth.bearer
      },
    });
    expect(retry.statusCode).toBe(404);
    expect(retry.json()).toEqual({ error: "job_not_found", message: "job_not_found", statusCode: 404 });
  });

  it("does not persist unverified email on activation snapshot (E4.3)", async () => {
    const { createHash } = await import("node:crypto");

    function hashInt(value: string): number {
      return parseInt(createHash("sha256").update(value).digest("hex").slice(0, 8), 16);
    }

    function firstCandidate(fullName: string, domain: string): string {
      const parts = fullName.trim().split(/\s+/);
      const first = (parts[0] ?? "user").toLowerCase();
      const last = (parts[parts.length - 1] ?? first).toLowerCase();
      return `${first}.${last}@${domain}`;
    }

    let fullName = "Invalid Probe";
    let domain = "probe-invalid.com";
    for (let i = 0; i < 300; i++) {
      const candidateDomain = `probe-${i}.com`;
      const candidateName = `Probe Invalid ${i}`;
      const [email] = [firstCandidate(candidateName, candidateDomain)];
      if (email && hashInt(email) % 100 >= 85) {
        fullName = candidateName;
        domain = candidateDomain;
        break;
      }
    }

    const prospectId = `verified-only-${domain.replace(/\./g, "-")}`;

    await app.inject({
      method: "POST",
      url: "/api/v1/prospects/activate",
      headers: {
        "x-workspace-id": WORKSPACE,
        "content-type": "application/json",
        authorization: testAuth.bearer,
      },
      payload: { prospect: { prospectId, companyDomain: domain, fullName } },
    });

    const enrich = await app.inject({
      method: "POST",
      url: `/api/v1/prospects/${prospectId}/enrich`,
      headers: {
        "x-workspace-id": WORKSPACE,
        "content-type": "application/json",
        authorization: testAuth.bearer,
      },
      payload: {
        prospect: { fullName, companyDomain: domain },
        fields: ["email", "validation"],
      },
    });
    expect(enrich.statusCode).toBe(202);
    const enriched = enrich.json() as {
      results: { field: string; value?: string; isPrimary?: boolean }[];
    };
    const status = enriched.results.find((r) => r.field === "email_status")?.value;
    const primaryEmail = enriched.results.find((r) => r.field === "email" && r.isPrimary);
    if (status !== "valid") {
      expect(primaryEmail).toBeUndefined();
    }
  });

  it("GET /enrichment/efficiency returns a 7-day, non-negative daily series for the caller's workspace", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/enrichment/efficiency",
      headers: { 
        "x-workspace-id": WORKSPACE,
        "Authorization": testAuth.bearer
      },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { workspaceId: string; data: { date: string; spent: number; found: number }[] };
    expect(typeof body.workspaceId).toBe("string");
    expect(body.data).toHaveLength(7);
    for (const point of body.data) {
      expect(point.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(point.spent).toBeGreaterThanOrEqual(0);
      expect(point.found).toBeGreaterThanOrEqual(0);
    }
  });

  it("requires auth for enrichment routes, rejects unknown CORS origins, and rate-limits scoring", async () => {
    const config = loadEnv();
    const strictApp = await buildApp({
      ...config,
      ...BASE_OVERRIDES,
      ...buildTestAuthEnv(),
    });
    try {
      const unauthenticated = await strictApp.inject({
        method: "GET",
        url: "/api/v1/enrichment/people",
      });
      expect(unauthenticated.statusCode).toBe(401);

      const rejectedOrigin = await strictApp.inject({
        method: "GET",
        url: "/api/v1/enrichment/people",
        headers: { origin: "https://untrusted.example" },
      });
      expect(rejectedOrigin.headers["access-control-allow-origin"]).toBeUndefined();

      const allowedOrigin = config.CORS_ORIGIN[0];
      expect(allowedOrigin).toBeTruthy();
      const allowed = await strictApp.inject({
        method: "GET",
        url: "/api/v1/enrichment/people",
        headers: { origin: allowedOrigin! },
      });
      expect(allowed.headers["access-control-allow-origin"]).toBe(allowedOrigin);

      const deniedRequests = await Promise.all(
        Array.from({ length: 10 }, () =>
          strictApp.inject({ method: "POST", url: "/api/v1/enrichment/score", payload: {} })
        )
      );
      expect(deniedRequests.every((response) => response.statusCode === 401)).toBe(true);
      const limited = await strictApp.inject({
        method: "POST",
        url: "/api/v1/enrichment/score",
        payload: {},
      });
      expect(limited.statusCode).toBe(429);
    } finally {
      await strictApp.close();
    }
  });

  it("does not expose or delete a prospect across workspace boundaries, even with a forged workspace header", async () => {
    if (!app.db) throw new Error("database_unavailable");
    const otherWorkspaceId = randomUUID();
    const otherUserId = randomUUID();
    const otherEmail = `enrichment-boundary-${randomUUID()}@example.com`;
    const prospectId = `workspace-a-${randomUUID()}`;

    await app.db.insert(schema.workspaces).values({
      id: otherWorkspaceId,
      name: "Enrichment boundary test",
      slug: `enrichment-boundary-${randomUUID()}`,
    });
    await app.db.insert(schema.users).values({
      id: otherUserId,
      clerkUserId: otherUserId,
      email: otherEmail,
      fullName: "Boundary Test User",
      status: "active",
    });
    await app.db.insert(schema.workspaceMembers).values({
      workspaceId: otherWorkspaceId,
      userId: otherUserId,
      role: "owner",
    });

    const [ownerRole] = await app.db
      .select({ id: schema.roles.id })
      .from(schema.roles)
      .where(and(eq(schema.roles.key, "owner"), isNull(schema.roles.workspaceId)))
      .limit(1);
    if (!ownerRole) throw new Error("system_owner_role_missing");

    await app.db.insert(schema.workspaceMemberRoles).values({
      workspaceId: otherWorkspaceId,
      userId: otherUserId,
      roleId: ownerRole.id,
    });
    const permissionRows = await app.db
      .select({ key: schema.permissions.key })
      .from(schema.permissions)
      .where(like(schema.permissions.key, "enrichment:%"));
    if (permissionRows.length) {
      await app.db.insert(schema.rolePermissions)
        .values(permissionRows.map(({ key }) => ({ roleId: ownerRole.id, permissionKey: key })))
        .onConflictDoNothing();
    }
    await app.db.insert(schema.prospectActivations).values({
      workspaceId: WORKSPACE,
      prospectId,
      companyId: "foreign-company",
      snapshot: { fullName: "Workspace A only", companyDomain: "workspace-a.example" },
    });

    const otherAuth = buildTestAuth({
      workspaceId: otherWorkspaceId,
      userId: otherUserId,
      email: otherEmail,
      role: "owner",
    });
    const headers = {
      authorization: otherAuth.bearer,
      "x-stub-user-email": otherEmail,
      "x-workspace-id": WORKSPACE,
    };

    try {
      const forgedWorkspaceList = await app.inject({
        method: "GET",
        url: "/api/v1/enrichment/people",
        headers,
      });
      expect(forgedWorkspaceList.statusCode).toBe(403);

      const ownWorkspaceList = await app.inject({
        method: "GET",
        url: "/api/v1/enrichment/people",
        headers: { ...headers, "x-workspace-id": otherWorkspaceId },
      });
      expect(ownWorkspaceList.statusCode).toBe(200);
      expect(ownWorkspaceList.json().workspaceId).toBe(otherWorkspaceId);
      expect(JSON.stringify(ownWorkspaceList.json())).not.toContain(prospectId);

      const remove = await app.inject({
        method: "DELETE",
        url: `/api/v1/enrichment/people/${encodeURIComponent(prospectId)}`,
        headers,
      });
      expect(remove.statusCode).toBe(403);
      const sourceRecord = await app.db.query.prospectActivations.findFirst({
        where: (prospect, { and: whereAnd, eq: whereEq }) =>
          whereAnd(whereEq(prospect.workspaceId, WORKSPACE), whereEq(prospect.prospectId, prospectId)),
      });
      expect(sourceRecord).toBeDefined();
    } finally {
      await app.db.delete(schema.prospectActivations).where(
        and(eq(schema.prospectActivations.workspaceId, WORKSPACE), eq(schema.prospectActivations.prospectId, prospectId))
      );
      await app.db.delete(schema.workspaces).where(eq(schema.workspaces.id, otherWorkspaceId));
      await app.db.delete(schema.users).where(eq(schema.users.id, otherUserId));
    }
  });

  it("denies enrichment access to a workspace member without the required RBAC grant", async () => {
    if (!app.db) throw new Error("database_unavailable");
    const userId = randomUUID();
    const email = `enrichment-denied-${userId}@example.com`;
    await app.db.insert(schema.users).values({
      id: userId,
      clerkUserId: userId,
      email,
      fullName: "Permission Denied User",
      status: "active",
    });
    await app.db.insert(schema.workspaceMembers).values({
      workspaceId: WORKSPACE,
      userId,
      role: "member",
    });

    try {
      const auth = buildTestAuth({ workspaceId: WORKSPACE, userId, email, role: "member" });
      const response = await app.inject({
        method: "GET",
        url: "/api/v1/enrichment/people",
        headers: { authorization: auth.bearer },
      });
      expect(response.statusCode).toBe(403);
    } finally {
      await app.db.delete(schema.workspaceMemberRoles).where(
        and(eq(schema.workspaceMemberRoles.workspaceId, WORKSPACE), eq(schema.workspaceMemberRoles.userId, userId))
      );
      await app.db.delete(schema.workspaceMembers).where(
        and(eq(schema.workspaceMembers.workspaceId, WORKSPACE), eq(schema.workspaceMembers.userId, userId))
      );
      await app.db.delete(schema.users).where(eq(schema.users.id, userId));
    }
  });

  it("audits workspace capture, export, and delete operations", async () => {
    if (!app.db) throw new Error("database_unavailable");
    const prospectId = `audit-capture-${randomUUID()}`;
    const headers = {
      "content-type": "application/json",
      "x-workspace-id": WORKSPACE,
      authorization: testAuth.bearer,
    };
    const capture = await app.inject({
      method: "POST",
      url: "/api/v1/prospects/activate",
      headers,
      payload: {
        prospects: [{ prospectId, fullName: "Audit Capture", companyDomain: "audit-capture.example" }],
      },
    });
    expect(capture.statusCode).toBe(201);

    const [contact] = await app.db
      .select({ id: schema.contacts.id, companyId: schema.contacts.companyId, employmentStatus: schema.contacts.employmentStatus })
      .from(schema.contacts)
      .where(and(
        eq(schema.contacts.workspaceId, WORKSPACE),
        eq(schema.contacts.sourceProspectId, prospectId)
      ))
      .limit(1);
    expect(contact).toBeDefined();
    if (!contact) throw new Error("captured_contact_missing");
    expect(contact.employmentStatus).toBe("discovery_candidate");
    expect(contact.companyId).toBeTruthy();
    const discovery = await app.db
      .select()
      .from(schema.companyPersonDiscoveries)
      .where(and(
        eq(schema.companyPersonDiscoveries.workspaceId, WORKSPACE),
        eq(schema.companyPersonDiscoveries.contactId, contact.id)
      ));
    expect(discovery).toHaveLength(1);

    const exported = await app.inject({
      method: "POST",
      url: "/api/v1/enrichment/export",
      headers,
      payload: { type: "people", ids: [prospectId] },
    });
    expect(exported.statusCode).toBe(200);
    expect(exported.body).toContain(prospectId);

    const deleted = await app.inject({
      method: "DELETE",
      url: `/api/v1/enrichment/people/${encodeURIComponent(prospectId)}`,
      headers,
    });
    expect(deleted.statusCode).toBe(200);

    const remainingDiscoveries = await app.db
      .select()
      .from(schema.companyPersonDiscoveries)
      .where(and(
        eq(schema.companyPersonDiscoveries.workspaceId, WORKSPACE),
        eq(schema.companyPersonDiscoveries.contactId, contact.id)
      ));
    expect(remainingDiscoveries).toHaveLength(0);

    const actions = await app.db
      .select({
        action: schema.auditLogs.action,
        beforeState: schema.auditLogs.beforeState,
        afterState: schema.auditLogs.afterState,
      })
      .from(schema.auditLogs)
      .where(eq(schema.auditLogs.workspaceId, WORKSPACE));
    const afterStates = actions.map((row) => row.afterState as Record<string, unknown> | null);
    expect(actions.some((row, index) => row.action === "enrichment.capture" && afterStates[index]?.prospectId === prospectId)).toBe(true);
    expect(actions.some((row) => row.action === "enrichment.export")).toBe(true);
    expect(actions.some((row) => {
      const beforeState = row.beforeState as Record<string, unknown> | null;
      return row.action === "enrichment.delete" && beforeState?.prospectId === prospectId;
    })).toBe(true);
  });

  it("audits provider connection changes without returning credential material", async () => {
    if (!app.db) throw new Error("database_unavailable");
    const [account] = await app.db
      .insert(schema.linkedinAccounts)
      .values({
        workspaceId: WORKSPACE,
        unipileAccountId: `audit-${randomUUID()}`,
        displayName: "Audit Test Account",
        channel: "linkedin",
      })
      .returning();
    if (!account) throw new Error("test_linkedin_account_missing");
    const response = await app.inject({
      method: "DELETE",
      url: `/api/v1/linkedin/accounts/${account.id}`,
      headers: { authorization: testAuth.bearer },
    });
    expect(response.statusCode).toBe(204);
    expect(response.body).toBe("");

    const [audit] = await app.db
      .select({ action: schema.auditLogs.action, entityId: schema.auditLogs.entityId })
      .from(schema.auditLogs)
      .where(and(
        eq(schema.auditLogs.workspaceId, WORKSPACE),
        eq(schema.auditLogs.action, "linkedin_account.disconnect"),
        eq(schema.auditLogs.entityId, account.id)
      ))
      .limit(1);
    expect(audit).toEqual({ action: "linkedin_account.disconnect", entityId: account.id });
    expect(response.body).not.toContain(account.unipileAccountId);
  });

  it("audits a successful workspace re-enrichment retry", async () => {
    if (!app.db) throw new Error("database_unavailable");
    const prospectId = `audit-retry-${randomUUID()}`;
    const [activation] = await app.db
      .insert(schema.prospectActivations)
      .values({
        workspaceId: WORKSPACE,
        prospectId,
        companyId: "audit-retry-company",
        snapshot: { fullName: "Retry Audit", companyDomain: "retry-audit.example" },
      })
      .returning({ id: schema.prospectActivations.id });
    if (!activation) throw new Error("retry_activation_missing");

    const [job] = await app.db
      .insert(schema.enrichmentJobs)
      .values({
        workspaceId: WORKSPACE,
        prospectId,
        activationId: activation.id,
        status: "failed",
        fieldsRequested: [],
      })
      .returning({ id: schema.enrichmentJobs.id });
    if (!job) throw new Error("retry_job_missing");

    try {
      const response = await app.inject({
        method: "POST",
        url: `/api/v1/enrichment/jobs/${job.id}/retry`,
        headers: { authorization: testAuth.bearer },
      });
      expect(response.statusCode).toBe(202);

      const [audit] = await app.db
        .select({ action: schema.auditLogs.action, afterState: schema.auditLogs.afterState })
        .from(schema.auditLogs)
        .where(and(
          eq(schema.auditLogs.workspaceId, WORKSPACE),
          eq(schema.auditLogs.action, "enrichment.re-enrich")
        ))
        .orderBy(desc(schema.auditLogs.createdAt))
        .limit(1);
      expect(audit?.action).toBe("enrichment.re-enrich");
      expect((audit?.afterState as Record<string, unknown> | null)?.prospectId).toBe(prospectId);
    } finally {
      await app.db.delete(schema.enrichmentJobs).where(
        and(eq(schema.enrichmentJobs.workspaceId, WORKSPACE), eq(schema.enrichmentJobs.prospectId, prospectId))
      );
      await app.db.delete(schema.prospectActivations).where(
        and(eq(schema.prospectActivations.workspaceId, WORKSPACE), eq(schema.prospectActivations.prospectId, prospectId))
      );
    }
  });
});