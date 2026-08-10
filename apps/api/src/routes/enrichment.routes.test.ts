import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { schema } from "@skout/db";
import { loadEnv } from "../config/env.js";
import { buildApp } from "../app.js";
import { ensureDemoIcp } from "../test/ensure-demo-icp.js";
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

beforeAll(async () => {
  const config = loadEnv();
  app = await buildApp({ ...config, ...BASE_OVERRIDES });
  await ensureDemoIcp(app, WORKSPACE);

  // Stub auth provisions its own workspace and ignores x-workspace-id. Local runs can
  // deplete that balance — top it up so credit-gated enrich/score tests stay green.
  if (app.db) {
    const probe = await app.inject({
      method: "GET",
      url: "/api/v1/enrichment/credits",
      headers: { "x-workspace-id": WORKSPACE },
    });
    const { workspaceId } = probe.json() as { workspaceId: string };
    await app.db
      .insert(schema.creditBalances)
      .values({ workspaceId, balance: 5000 })
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
      headers: { "x-workspace-id": WORKSPACE },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { balance: number };
    expect(body.balance).toBeGreaterThan(0);
  });

  it("enriches a prospect: firmographics + email + verification (§5, §8)", async () => {
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
  });

  it("skips phone when lead score is below gate (§6, default gate=80)", async () => {
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
  });

  it("allows phone when gate is overridden via env (§6)", async () => {
    const config = loadEnv();
    const gateApp = await buildApp({ ...config, ...BASE_OVERRIDES, ENRICHMENT_PHONE_SCORE_GATE: -1 });
    try {
      await ensureDemoIcp(gateApp, WORKSPACE);
      const res = await gateApp.inject({
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
    } finally {
      await gateApp.close();
    }
  }, 30000);

  it("activates prospects without external spend (§8 Tier 2 add-to-workspace)", async () => {
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
  });

  it("scores a prospect against ICP (§9)", async () => {
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
  });

  it("creates a list and bulk-enriches members (§8 user intent trigger)", async () => {
    const create = await app.inject({
      method: "POST",
      url: "/api/v1/lists",
      headers: { "x-workspace-id": WORKSPACE, "content-type": "application/json" },
      payload: { name: "Test List", mode: "static" },
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
  });

  it("lists enrichment jobs and fetches job by id", async () => {
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
});
