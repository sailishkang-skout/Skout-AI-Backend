import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { schema } from "@skout/db";
import { and, eq, isNull, like } from "drizzle-orm";
import { loadEnv } from "../config/env.js";
import { buildApp } from "../app.js";
import { ensureDemoIcp } from "../test/ensure-demo-icp.js";
import { buildTestAuth } from "@skout/auth";
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

const TEST_USER_ID = "00000000-0000-4000-8000-000000000002"; // Valid UUID for test user
let testAuth: ReturnType<typeof buildTestAuth>;

beforeAll(async () => {
  const config = loadEnv();
  app = await buildApp({ ...config, ...BASE_OVERRIDES });
  await ensureDemoIcp(app, WORKSPACE);
  
  // Build test auth with proper permissions for enrichment endpoints
  testAuth = buildTestAuth({ workspaceId: WORKSPACE, userId: TEST_USER_ID, role: "owner" });

  // Stub auth provisions its own workspace and ignores x-workspace-id. Local runs can
  // deplete that balance — top it up so credit-gated enrich/score tests stay green.
  if (app.db) {
          // The fixed test workspace only exists where packages/db seed.ts ran (CI runs only
          // seed-model-versions), so create it here; the role and credit rows reference it.
          await app.db
            .insert(schema.workspaces)
            .values({ id: WORKSPACE, name: "Enrichment test workspace", slug: "enrichment-test-workspace" })
            .onConflictDoNothing();
          // First create the test user in the users table to satisfy foreign key constraints
          await app.db
            .insert(schema.users)
            .values({
              id: TEST_USER_ID,
              email: "test-enrichment@example.com",
              fullName: "Enrichment Test User",
              status: "active",
            })
            .onConflictDoNothing();
          
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
    const gateApp = await buildApp({ ...config, ...BASE_OVERRIDES, ENRICHMENT_PHONE_SCORE_GATE: -1 });
    const gateTestAuth = buildTestAuth({ workspaceId: WORKSPACE, userId: TEST_USER_ID, role: "owner" });
    try {
      await ensureDemoIcp(gateApp, WORKSPACE);
      
      // Add same permissions for gateApp test user
      if (gateApp.db) {
        // First create the test user in the users table to satisfy foreign key constraints
        await gateApp.db
          .insert(schema.users)
          .values({
            id: TEST_USER_ID,
            email: "test-enrichment@example.com",
            fullName: "Enrichment Test User",
            status: "active",
          })
          .onConflictDoNothing();
          
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
    // The app-wide onSend hook adds the standard error envelope to legacy route responses.
    expect(get.json()).toMatchObject({
      error: "job_not_found",
      code: "job_not_found",
      message: "job_not_found",
      statusCode: 404,
      retryable: false,
    });
    expect(get.json().request_id).toEqual(expect.any(String));
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
    expect(retry.json()).toMatchObject({
      error: "job_not_found",
      code: "job_not_found",
      message: "job_not_found",
      statusCode: 404,
      retryable: false,
    });
    expect(retry.json().request_id).toEqual(expect.any(String));
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
      headers: { "x-workspace-id": WORKSPACE, "content-type": "application/json" },
      payload: { prospect: { prospectId, companyDomain: domain, fullName } },
    });

    const enrich = await app.inject({
      method: "POST",
      url: `/api/v1/prospects/${prospectId}/enrich`,
      headers: { "x-workspace-id": WORKSPACE, "content-type": "application/json" },
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
});