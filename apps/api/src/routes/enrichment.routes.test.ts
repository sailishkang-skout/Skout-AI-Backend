import { describe, expect, it } from "vitest";
import { loadEnv } from "../config/env.js";
import { buildApp } from "../app.js";
import { ensureDemoIcp } from "../test/ensure-demo-icp.js";

const WORKSPACE = "00000000-0000-4000-8000-000000000001";

async function buildTestApp(overrides: Record<string, string | number> = {}) {
  const config = loadEnv();
  const app = await buildApp({
    ...config,
    CLERK_SECRET_KEY: undefined,
    LOG_LEVEL: "fatal",
    AI_SERVICE_URL: undefined,
    HUNTER_API_KEY: undefined,
    MILLIONVERIFIER_API_KEY: undefined,
    ZEROBOUNCE_API_KEY: undefined,
    NEVERBOUNCE_API_KEY: undefined,
    PDL_API_KEY: undefined,
    REVENUEBASE_API_KEY: undefined,
    EXPLORIUM_API_KEY: undefined,
    CORESIGNAL_API_KEY: undefined,
    DATAGMA_API_KEY: undefined,
    CONTACTOUT_API_KEY: undefined,
    COGNISM_API_KEY: undefined,
    ...overrides,
  });
  return app;
}

describe("enrichment API (strategy §5–§9, Tier 2 activation)", () => {
  it("returns credit balance for workspace", async () => {
    const app = await buildTestApp();
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/enrichment/credits",
      headers: { "x-workspace-id": WORKSPACE },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { balance: number };
    expect(body.balance).toBeGreaterThan(0);
    await app.close();
  });

  it("enriches a prospect: firmographics + email + verification (§5, §8)", async () => {
    const app = await buildTestApp();
    await ensureDemoIcp(app, WORKSPACE);
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/prospects/acme-prospect/enrich",
      headers: { "x-workspace-id": WORKSPACE, "content-type": "application/json" },
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
    await app.close();
  });

  it("skips phone when lead score is below gate (§6, default gate=80)", async () => {
    const app = await buildTestApp();
    await ensureDemoIcp(app, WORKSPACE);
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/prospects/low-score-phone-gate/enrich",
      headers: { "x-workspace-id": WORKSPACE, "content-type": "application/json" },
      payload: {
        prospect: { fullName: "Jane Doe", companyDomain: "example.com", industry: "Retail", country: "US" },
        fields: ["phone"],
      },
    });
    expect(res.statusCode).toBe(202);
    const body = res.json() as { results: { field: string; validationStatus?: string }[]; creditsUsed: number };
    expect(body.results.some((r) => r.field === "phone" && r.validationStatus === "skipped")).toBe(true);
    expect(body.creditsUsed).toBe(0);
    await app.close();
  });

  it("allows phone when gate is overridden via env (§6)", async () => {
    const app = await buildTestApp({ ENRICHMENT_PHONE_SCORE_GATE: -1 });
    await ensureDemoIcp(app, WORKSPACE);
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/prospects/gate-test/enrich",
      headers: { "x-workspace-id": WORKSPACE, "content-type": "application/json" },
      payload: {
        prospect: { fullName: "John Smith", companyDomain: "acme.com" },
        fields: ["phone"],
      },
    });
    expect(res.statusCode).toBe(202);
    const body = res.json() as { results: { field: string; isPrimary?: boolean }[] };
    expect(body.results.some((r) => r.field === "phone" && r.isPrimary !== false)).toBe(true);
    await app.close();
  });

  it("activates prospects without external spend (§8 Tier 2 add-to-workspace)", async () => {
    const app = await buildTestApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/prospects/activate",
      headers: { "x-workspace-id": WORKSPACE, "content-type": "application/json" },
      payload: {
        prospects: [{ fullName: "Amy Lee", companyDomain: "foo.com", title: "CEO" }],
      },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ activated: 1 });
    await app.close();
  });

  it("scores a prospect against ICP (§9)", async () => {
    const app = await buildTestApp();
    await ensureDemoIcp(app, WORKSPACE);
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/enrichment/score",
      headers: { "x-workspace-id": WORKSPACE, "content-type": "application/json" },
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
    await app.close();
  });

  it("creates a list and bulk-enriches members (§8 user intent trigger)", async () => {
    const app = await buildTestApp();
    await ensureDemoIcp(app, WORKSPACE);
    const create = await app.inject({
      method: "POST",
      url: "/api/v1/lists",
      headers: { "x-workspace-id": WORKSPACE, "content-type": "application/json" },
      payload: { name: "Test List" },
    });
    expect(create.statusCode).toBe(201);
    const list = create.json() as { id: string; prospectCount: number };

    const members = await app.inject({
      method: "POST",
      url: `/api/v1/lists/${list.id}/members`,
      headers: { "x-workspace-id": WORKSPACE, "content-type": "application/json" },
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
      headers: { "x-workspace-id": WORKSPACE, "content-type": "application/json" },
      payload: { fields: ["company", "email", "validation"] },
    });
    expect(enrich.statusCode).toBe(202);
    const batch = enrich.json() as { batchId: string; status: string; total: number };
    expect(batch.total).toBe(2);
    expect(batch.status).toBe("completed");

    const jobs = await app.inject({
      method: "GET",
      url: "/api/v1/enrichment/jobs",
      headers: { "x-workspace-id": WORKSPACE },
    });
    expect(jobs.statusCode).toBe(200);
    const jobList = jobs.json() as { data: unknown[]; total: number };
    expect(jobList.total).toBeGreaterThanOrEqual(2);

    await app.close();
  });

  it("lists enrichment jobs and fetches job by id", async () => {
    const app = await buildTestApp();
    await ensureDemoIcp(app, WORKSPACE);
    const enrich = await app.inject({
      method: "POST",
      url: "/api/v1/prospects/job-fetch-test/enrich",
      headers: { "x-workspace-id": WORKSPACE, "content-type": "application/json" },
      payload: {
        prospect: { fullName: "Test User", companyDomain: "test.com" },
        fields: ["company"],
      },
    });
    const { jobId } = enrich.json() as { jobId: string };

    const get = await app.inject({
      method: "GET",
      url: `/api/v1/enrichment/jobs/${jobId}`,
      headers: { "x-workspace-id": WORKSPACE },
    });
    expect(get.statusCode).toBe(200);
    expect(get.json()).toMatchObject({ id: jobId, status: "completed" });
    await app.close();
  });
});
