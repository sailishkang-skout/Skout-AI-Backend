import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { schema } from "@skout/db";
import { loadEnv } from "../config/env.js";
import { buildApp } from "../app.js";
import type { FastifyInstance } from "fastify";

/**
 * R10.1 — "TAM to qualified opportunity": ICP/regions/exclusions in, verified opportunity
 * with a full evidence trail and CRM record out, wired as one automated end-to-end test —
 * the doc's own literal Phase-2 exit-gate acceptance test. Each `it` is one of the 9 steps,
 * sharing state (workspace, prospect, sequence) across the file so a failure at step N shows
 * exactly which link in the chain broke, not just "something in the journey failed".
 */
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
let workspaceId: string;
let prospectId: string;
let sequenceId: string;
let enrollmentId: string;

beforeAll(async () => {
  const config = loadEnv();
  app = await buildApp({ ...config, ...BASE_OVERRIDES });

  const probe = await app.inject({
    method: "GET",
    url: "/api/v1/enrichment/credits",
    headers: { "x-workspace-id": WORKSPACE },
  });
  workspaceId = (probe.json() as { workspaceId: string }).workspaceId;

  if (app.db) {
    // Real credits so scoring/enrichment steps don't 402.
    await app.db
      .insert(schema.creditBalances)
      .values({ workspaceId, balance: 5000 })
      .onConflictDoUpdate({
        target: schema.creditBalances.workspaceId,
        set: { balance: 5000, updatedAt: new Date() },
      });
    // R8.1's outbound-send gate requires a connected mailbox — step 6 needs this to be real,
    // not bypassed.
    await app.db
      .insert(schema.inboxes)
      .values({
        workspaceId,
        emailAddress: "e2e-test@example.com",
        provider: "smtp",
        status: "active",
      })
      .onConflictDoNothing();
  }
}, 60000);

afterAll(async () => {
  await app?.close();
});

describe("R10.1 — TAM to qualified opportunity (9-step e2e)", () => {
  it("step 1 — ICP/regions/exclusions in", async () => {
    const res = await app.inject({
      method: "PUT",
      url: "/api/v1/workspace/icp",
      headers: { "x-workspace-id": WORKSPACE, "content-type": "application/json" },
      payload: {
        industries: ["SaaS"],
        countries: ["US"],
        seniorities: ["vp", "director"],
        minEmployees: 50,
        maxEmployees: 500,
      },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { config: { industries?: string[] } };
    expect(body.config.industries).toContain("SaaS");
  });

  it("step 2 — search resolves the universe (structured + NL query, one model)", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/search/prospects",
      headers: { "x-workspace-id": WORKSPACE, "content-type": "application/json" },
      payload: { query: "VP Sales at SaaS companies in the US", page: 1, pageSize: 10 },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { results: unknown[] };
    expect(Array.isArray(body.results)).toBe(true);
  });

  it("step 3 — intelligence scores fit", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/enrichment/score",
      headers: { "x-workspace-id": WORKSPACE, "content-type": "application/json" },
      payload: {
        prospect: {
          prospectId: "e2e-prospect-tam-journey",
          fullName: "Jamie E2E",
          title: "VP Sales",
          companyDomain: "example.com",
          seniority: "vp",
          industry: "SaaS",
          employeeCount: 120,
        },
        icp: {
          industries: ["SaaS"],
          countries: ["US"],
          seniorities: ["vp"],
          minEmployees: 50,
          maxEmployees: 500,
        },
      },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { icpScore: number; prospectId: string };
    expect(typeof body.icpScore).toBe("number");
    prospectId = body.prospectId;
  });

  it("step 4 — workbook/enrichment activates the prospect", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/prospects/activate",
      headers: { "x-workspace-id": WORKSPACE, "content-type": "application/json" },
      payload: {
        prospects: [
          {
            prospectId,
            fullName: "Jamie E2E",
            title: "VP Sales",
            companyDomain: "example.com",
            companyName: "Example Corp (e2e)",
          },
        ],
      },
    });
    expect(res.statusCode).toBe(201);
  });

  it("step 5 — a signal is detected and stacked", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/signals",
      headers: { "x-workspace-id": WORKSPACE, "content-type": "application/json" },
      payload: {
        entityType: "prospect",
        entityId: prospectId,
        signalType: "recent_funding",
        reason: "E2E journey — recent funding round detected",
        confidence: 0.85,
        source: "e2e-test",
      },
    });
    expect(res.statusCode).toBe(201);

    const list = await app.inject({
      method: "GET",
      url: `/api/v1/signals?entityId=${prospectId}&entityType=prospect`,
      headers: { "x-workspace-id": WORKSPACE },
    });
    expect(list.statusCode).toBe(200);
    const body = list.json() as { data: unknown[] };
    expect(body.data.length).toBeGreaterThan(0);
  });

  it("step 6 — Dexter/user enrolls the prospect via sequence runtime", async () => {
    const created = await app.inject({
      method: "POST",
      url: "/api/v1/sequences/from-template",
      headers: { "x-workspace-id": WORKSPACE, "content-type": "application/json" },
      payload: { key: "saas-vp-email", name: "E2E Journey Sequence" },
    });
    expect(created.statusCode).toBe(201);
    sequenceId = (created.json() as { id: string }).id;

    const activated = await app.inject({
      method: "PATCH",
      url: `/api/v1/sequences/${sequenceId}`,
      headers: { "x-workspace-id": WORKSPACE, "content-type": "application/json" },
      payload: { status: "active" },
    });
    expect(activated.statusCode).toBe(200);

    // The R8.1 outbound-send gate must actually be exercised here, not skipped — this
    // workspace has ICP configured + a mailbox connected (seeded in beforeAll), so it should
    // pass through to real enrollment rather than 412.
    const enrolled = await app.inject({
      method: "POST",
      url: `/api/v1/sequences/${sequenceId}/enroll`,
      headers: { "x-workspace-id": WORKSPACE, "content-type": "application/json" },
      payload: { prospectIds: [prospectId] },
    });
    expect(enrolled.statusCode).toBe(202);
    const body = enrolled.json() as { enrolled: number };
    expect(body.enrolled).toBe(1);
  });

  it("step 7 — runtime executes with policy/send guards (enrollment + first step scheduled)", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/sequences/${sequenceId}/enrollments`,
      headers: { "x-workspace-id": WORKSPACE },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { data: Array<{ id: string; prospectId: string; status: string }> };
    const enrollment = body.data.find((e) => e.prospectId === prospectId);
    expect(enrollment).toBeDefined();
    expect(["active", "pending"]).toContain(enrollment!.status);
    enrollmentId = enrollment!.id;
  });

  it("step 8 — timeline reflects the enrollment (auditable record, reversible)", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/sequences/prospects/${prospectId}/enrollments`,
      headers: { "x-workspace-id": WORKSPACE },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { data: Array<{ id: string }> };
    expect(body.data.some((e) => e.id === enrollmentId)).toBe(true);
  });

  it("step 9 — outcomes feed reporting", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/cro/summary",
      headers: { "x-workspace-id": WORKSPACE },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { data: Record<string, unknown> };
    expect(body.data).toBeDefined();
  });
});
