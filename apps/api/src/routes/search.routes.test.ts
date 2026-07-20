import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { ZodError } from "zod";
import { searchRoutes } from "./search.routes.js";
import type { Env } from "../config/env.js";
import { clearSearchMemoryCache } from "../services/search-cache.service.js";
import { getStore } from "../services/enrichment/index.js";

// ---------------------------------------------------------------------------
// Mock @skout/opensearch so tests don't hit a real cluster.
// When OPENSEARCH_URL is defined in the test env, the SearchService will call
// these mocked functions instead of making real HTTP requests.
// ---------------------------------------------------------------------------
vi.mock("@skout/opensearch", async (importOriginal) => {
  const real = await importOriginal<typeof import("@skout/opensearch")>();
  return {
    ...real,
    searchProspects: vi.fn(),
    getProspectById: vi.fn(),
  };
});

import * as osModule from "@skout/opensearch";
import { buildDemoCorpus } from "@skout/opensearch";

const mockedSearch = vi.mocked(osModule.searchProspects);
const mockedGetById = vi.mocked(osModule.getProspectById);

// ---------------------------------------------------------------------------
// Minimal Env that satisfies app.config accesses inside SearchService.
// No OPENSEARCH_URL → osConfig() returns null → demo fallback is used.
// ---------------------------------------------------------------------------
const baseEnv = {
  NODE_ENV: "test",
  OPENSEARCH_URL: undefined,
  OPENSEARCH_INDEX: "prospects",
  OPENSEARCH_USERNAME: undefined,
  OPENSEARCH_PASSWORD: undefined,
  REDIS_URL: "redis://127.0.0.1:1",
  SEARCH_CREDIT_COST: 1,
  SEARCH_CACHE_TTL_SECONDS: 300,
  PROSPECT_CACHE_TTL_SECONDS: 60,
  SMART_LIST_CACHE_TTL_SECONDS: 120,
  DEMO_CORPUS_SIZE: 100,
} as unknown as Env;

const osEnv = {
  ...baseEnv,
  OPENSEARCH_URL: "https://fake-opensearch:9200",
  OPENSEARCH_USERNAME: "user",
  OPENSEARCH_PASSWORD: "pass",
} as unknown as Env;

// ---------------------------------------------------------------------------
// Build a lightweight Fastify app that skips full DB/auth setup.
// The stub preHandler mimics what authPlugin sets on every authenticated request.
// ---------------------------------------------------------------------------
async function buildTestApp(
  env: Env = baseEnv,
  workspaceId = "test-workspace-id"
): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });

  app.decorate("config", env);
  app.decorate("db", null);

  app.setErrorHandler((error, _req, reply) => {
    if (error instanceof ZodError) {
      return reply.code(400).send({
        error: "validation_error",
        issues: error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
      });
    }
    const message = error instanceof Error ? error.message : "internal_server_error";
    reply.code(500).send({ error: message });
  });

  app.addHook("preHandler", async (req) => {
    req.userId = "test-user-id";
    req.workspaceId = workspaceId;
  });

  await app.register(searchRoutes);
  await app.ready();
  return app;
}

// ---------------------------------------------------------------------------
// Shared prospect fixture
// ---------------------------------------------------------------------------
const sampleProspect: osModule.ProspectDocument = {
  prospectId: "prospect-001",
  companyId: "company-001",
  fullName: "Sarah Johnson",
  title: "VP Sales",
  seniority: "vp",
  department: "Sales",
  email: "sarah@salesforce.com",
  companyDomain: "salesforce.com",
  companyName: "Salesforce",
  industry: "Software & SaaS",
  country: "US",
  state: "CA",
  city: "San Francisco",
  employeeCount: 73000,
  updatedAt: "2025-01-15T10:00:00.000Z",
};

describe("POST /search/prospects", () => {
  let app: FastifyInstance;

  beforeEach(() => {
    clearSearchMemoryCache();
    vi.clearAllMocks();
  });

  afterEach(async () => {
    await app.close();
  });

  describe("demo fallback (no OpenSearch URL)", () => {
    beforeEach(async () => {
      app = await buildTestApp(baseEnv);
    });

    it("returns 200 with demo results when body is empty", async () => {
      const res = await app.inject({ method: "POST", url: "/search/prospects" });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body).toHaveProperty("results");
      expect(body).toHaveProperty("total");
      expect(body).toHaveProperty("page");
      expect(body).toHaveProperty("pageSize");
    });

    it("returns 200 with demo results when filters are provided", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/search/prospects",
        payload: { filters: { country: "US", seniority: "vp" }, page: 1, pageSize: 10 },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.page).toBe(1);
      expect(body.pageSize).toBe(10);
    });

    it("returns results array with correct shape", async () => {
      const res = await app.inject({ method: "POST", url: "/search/prospects" });
      const body = res.json();
      if (body.results.length > 0) {
        const first = body.results[0];
        expect(first).toHaveProperty("prospectId");
        expect(first).toHaveProperty("companyId");
        expect(first).toHaveProperty("fullName");
        expect(first).toHaveProperty("title");
        expect(first).toHaveProperty("seniority");
        expect(first).toHaveProperty("country");
        expect(first).toHaveProperty("industry");
        expect(first).toHaveProperty("companyDomain");
      }
    });

    it("respects pagination — page 2", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/search/prospects",
        payload: { page: 2, pageSize: 5 },
      });
      const body = res.json();
      expect(body.page).toBe(2);
      expect(body.pageSize).toBe(5);
    });
  });

  describe("validation errors", () => {
    beforeEach(async () => {
      app = await buildTestApp(baseEnv);
    });

    it("returns 400 when seniority is an invalid enum value", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/search/prospects",
        payload: { filters: { seniority: "intern" } },
      });
      expect(res.statusCode).toBe(400);
      const body = res.json();
      expect(body.error).toBe("validation_error");
      expect(body.issues).toBeInstanceOf(Array);
      expect(body.issues[0].path).toContain("seniority");
    });

    it("returns 400 when pageSize exceeds 100", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/search/prospects",
        payload: { pageSize: 200 },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBe("validation_error");
    });

    it("returns 400 when page is 0", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/search/prospects",
        payload: { page: 0 },
      });
      expect(res.statusCode).toBe(400);
    });

    it("returns 400 when minEmployees is negative", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/search/prospects",
        payload: { filters: { minEmployees: -1 } },
      });
      expect(res.statusCode).toBe(400);
    });
  });

  describe("boolean coercion from string", () => {
    beforeEach(async () => {
      app = await buildTestApp(baseEnv);
    });

    it('accepts emailAvailable as string "true" without validation error', async () => {
      const res = await app.inject({
        method: "POST",
        url: "/search/prospects",
        payload: { filters: { emailAvailable: "true" } },
      });
      expect(res.statusCode).toBe(200);
    });

    it('accepts currentlyHiring as string "false" without validation error', async () => {
      const res = await app.inject({
        method: "POST",
        url: "/search/prospects",
        payload: { filters: { currentlyHiring: "false" } },
      });
      expect(res.statusCode).toBe(200);
    });
  });

  describe("OpenSearch integration (mocked)", () => {
    beforeEach(async () => {
      app = await buildTestApp(osEnv);
    });

    it("returns real OpenSearch hits when osSearch resolves", async () => {
      mockedSearch.mockResolvedValueOnce({ hits: [sampleProspect], total: 1 });

      const res = await app.inject({
        method: "POST",
        url: "/search/prospects",
        payload: { filters: { fullName: "Sarah" } },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.total).toBe(1);
      expect(body.results[0].fullName).toBe("Sarah Johnson");
      expect(body.results[0].seniority).toBe("vp");
      expect(body.results[0].country).toBe("US");
    });

    it("maps unknown seniority to 'unknown'", async () => {
      mockedSearch.mockResolvedValueOnce({
        hits: [{ ...sampleProspect, seniority: "astronaut" }],
        total: 1,
      });

      const res = await app.inject({ method: "POST", url: "/search/prospects", payload: {} });
      expect(res.json().results[0].seniority).toBe("unknown");
    });

    it("returns 502 when OpenSearch throws", async () => {
      mockedSearch.mockRejectedValueOnce(new Error("connection refused"));

      const res = await app.inject({ method: "POST", url: "/search/prospects", payload: {} });
      expect(res.statusCode).toBe(502);
      expect(res.json().error).toBe("search_index_unavailable");
    });

    it("passes page and pageSize to opensearch", async () => {
      mockedSearch.mockResolvedValueOnce({ hits: [], total: 0 });

      await app.inject({
        method: "POST",
        url: "/search/prospects",
        payload: { page: 3, pageSize: 15 },
      });

      expect(mockedSearch).toHaveBeenCalledWith(
        expect.any(Object),
        expect.any(Object),
        3,
        15
      );
    });

    it("returns empty results when total is 0", async () => {
      mockedSearch.mockResolvedValueOnce({ hits: [], total: 0 });

      const res = await app.inject({ method: "POST", url: "/search/prospects", payload: {} });
      const body = res.json();
      expect(body.results).toEqual([]);
      expect(body.total).toBe(0);
    });

    it("passes all filter fields through to opensearch", async () => {
      mockedSearch.mockResolvedValueOnce({ hits: [], total: 0 });

      await app.inject({
        method: "POST",
        url: "/search/prospects",
        payload: {
          query: "VP Sales",
          filters: {
            fullName: "Sarah",
            seniority: "vp",
            country: "US",
            industry: "Software & SaaS",
            minEmployees: 100,
            maxEmployees: 5000,
            emailAvailable: true,
            companyStage: "series_b",
            currentlyHiring: true,
          },
          page: 1,
          pageSize: 25,
        },
      });

      expect(mockedSearch).toHaveBeenCalledWith(
        expect.any(Object),
        expect.objectContaining({
          query: "VP Sales",
          fullName: "Sarah",
          seniority: "vp",
          country: "US",
          industry: "Software & SaaS",
          minEmployees: 100,
          maxEmployees: 5000,
          emailAvailable: true,
          companyStage: "series_b",
          currentlyHiring: true,
        }),
        1,
        25
      );
    });
  });

  describe("credits and cache", () => {
    beforeEach(async () => {
      app = await buildTestApp(baseEnv);
    });

    it("deducts one credit on cache miss and returns creditsUsed", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/search/prospects",
        payload: { query: "credit-test-alpha" },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.cached).toBe(false);
      expect(body.creditsUsed).toBe(1);
    });

    it("serves cached results without charging again", async () => {
      const payload = { query: "credit-test-beta", page: 1, pageSize: 25 };
      const first = await app.inject({ method: "POST", url: "/search/prospects", payload });
      const second = await app.inject({ method: "POST", url: "/search/prospects", payload });

      expect(first.json().cached).toBe(false);
      expect(first.json().creditsUsed).toBe(1);
      expect(second.json().cached).toBe(true);
      expect(second.json().creditsUsed).toBe(0);
    });

    it("returns 402 when credits are exhausted", async () => {
      app = await buildTestApp(baseEnv, "ws-zero-credits");
      const store = getStore(null);
      await store.deductCredits("ws-zero-credits", 500, "test_setup");

      const res = await app.inject({
        method: "POST",
        url: "/search/prospects",
        payload: { query: "credit-test-gamma" },
      });

      expect(res.statusCode).toBe(402);
      expect(res.json().error).toBe("insufficient_credits");
    });
  });
});

describe("GET /search/prospects/:id", () => {
  let app: FastifyInstance;

  beforeEach(() => {
    clearSearchMemoryCache();
    vi.clearAllMocks();
  });

  afterEach(async () => {
    await app.close();
  });

  it("returns 404 when prospect is not in corpus", async () => {
    app = await buildTestApp(baseEnv);
    const res = await app.inject({ method: "GET", url: "/search/prospects/some-id" });
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toBe("prospect_not_found");
  });

  it("returns prospect from OpenSearch when found", async () => {
    app = await buildTestApp(osEnv);
    mockedGetById.mockResolvedValueOnce(sampleProspect);

    const res = await app.inject({ method: "GET", url: "/search/prospects/prospect-001" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.prospectId).toBe("prospect-001");
    expect(body.fullName).toBe("Sarah Johnson");
    expect(body.companyDomain).toBe("salesforce.com");
  });

  it("returns 404 when OpenSearch returns null", async () => {
    app = await buildTestApp(osEnv);
    mockedGetById.mockResolvedValueOnce(null);

    const res = await app.inject({ method: "GET", url: "/search/prospects/missing-id" });
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toBe("prospect_not_found");
  });
});

// ---------------------------------------------------------------------------
// Prospect drawer — detail field tests
// Verifies that GET /search/prospects/:id returns the full ProspectDetail
// shape needed by the frontend drawer (all fields beyond the list summary).
// ---------------------------------------------------------------------------

const richProspect: osModule.ProspectDocument = {
  prospectId: "prospect-rich",
  companyId: "company-rich",
  fullName: "Alex Rivera",
  title: "CTO",
  seniority: "c_level",
  department: "Engineering",
  jobFunction: "Technology",
  email: "alex@startup.io",
  phone: "+1 415 555 0100",
  linkedinUrl: "https://linkedin.com/in/alexrivera",
  companyDomain: "startup.io",
  companyName: "Startup Inc",
  industry: "Software & SaaS",
  subIndustry: "DevTools",
  country: "US",
  state: "CA",
  city: "San Francisco",
  employeeCount: 120,
  companyStage: "series_b",
  annualRevenue: 5_000_000,
  lastFundingRound: "series_b",
  lastFundingDate: "2024-06-01",
  totalFunding: 20_000_000,
  currentlyHiring: true,
  yearsAtCompany: 3,
  yearsInRole: 1,
  previousCompany: "Google",
  techStack: [
    { category: "CRM", technology: "Salesforce" },
    { category: "Analytics", technology: "Mixpanel" },
    { category: "Cloud", technology: "AWS" },
    { category: "Database", technology: "PostgreSQL" },
    { category: "Messaging", technology: "Slack" },
    { category: "CI/CD", technology: "GitHub Actions" },
    { category: "Monitoring", technology: "Datadog" },
  ],
  signals: [
    { type: "job_posting", observedAt: "2025-01-01T00:00:00Z", detail: "Hiring engineers" },
    { type: "funding_round", observedAt: "2024-06-01T00:00:00Z" },
    { type: "leadership_change", observedAt: "2024-09-01T00:00:00Z" },
    { type: "product_launch", observedAt: "2024-11-01T00:00:00Z" },
    { type: "expansion", observedAt: "2025-01-10T00:00:00Z" },
    { type: "award", observedAt: "2025-01-12T00:00:00Z" },
  ],
  icpScore: 87,
  intentScore: 72,
  painPoints: ["scaling", "developer tooling"],
  outreachReadiness: "high",
  updatedAt: "2025-01-15T10:00:00.000Z",
};

describe("GET /search/prospects/:id — prospect drawer detail fields", () => {
  let app: FastifyInstance;

  beforeEach(() => {
    clearSearchMemoryCache();
    vi.clearAllMocks();
  });

  afterEach(async () => {
    await app.close();
  });

  describe("contact detail fields", () => {
    it("returns email, phone, and linkedinUrl", async () => {
      app = await buildTestApp(osEnv);
      mockedGetById.mockResolvedValueOnce(richProspect);

      const res = await app.inject({ method: "GET", url: "/search/prospects/prospect-rich" });
      const body = res.json();

      expect(body.email).toBe("alex@startup.io");
      expect(body.phone).toBe("+1 415 555 0100");
      expect(body.linkedinUrl).toBe("https://linkedin.com/in/alexrivera");
    });

    it("returns department and jobFunction", async () => {
      app = await buildTestApp(osEnv);
      mockedGetById.mockResolvedValueOnce(richProspect);

      const res = await app.inject({ method: "GET", url: "/search/prospects/prospect-rich" });
      const body = res.json();

      expect(body.department).toBe("Engineering");
      expect(body.jobFunction).toBe("Technology");
    });

    it("returns experience fields — yearsAtCompany, yearsInRole, previousCompany", async () => {
      app = await buildTestApp(osEnv);
      mockedGetById.mockResolvedValueOnce(richProspect);

      const res = await app.inject({ method: "GET", url: "/search/prospects/prospect-rich" });
      const body = res.json();

      expect(body.yearsAtCompany).toBe(3);
      expect(body.yearsInRole).toBe(1);
      expect(body.previousCompany).toBe("Google");
    });
  });

  describe("company detail fields", () => {
    it("returns subIndustry, state, and city", async () => {
      app = await buildTestApp(osEnv);
      mockedGetById.mockResolvedValueOnce(richProspect);

      const res = await app.inject({ method: "GET", url: "/search/prospects/prospect-rich" });
      const body = res.json();

      expect(body.subIndustry).toBe("DevTools");
      expect(body.state).toBe("CA");
      expect(body.city).toBe("San Francisco");
    });

    it("returns companyStage and funding fields", async () => {
      app = await buildTestApp(osEnv);
      mockedGetById.mockResolvedValueOnce(richProspect);

      const res = await app.inject({ method: "GET", url: "/search/prospects/prospect-rich" });
      const body = res.json();

      expect(body.companyStage).toBe("series_b");
      expect(body.lastFundingRound).toBe("series_b");
      expect(body.lastFundingDate).toBe("2024-06-01");
      expect(body.annualRevenue).toBe(5_000_000);
      expect(body.totalFunding).toBe(20_000_000);
    });

    it("returns currentlyHiring", async () => {
      app = await buildTestApp(osEnv);
      mockedGetById.mockResolvedValueOnce(richProspect);

      const res = await app.inject({ method: "GET", url: "/search/prospects/prospect-rich" });
      expect(res.json().currentlyHiring).toBe(true);
    });

    it("returns updatedAt", async () => {
      app = await buildTestApp(osEnv);
      mockedGetById.mockResolvedValueOnce(richProspect);

      const res = await app.inject({ method: "GET", url: "/search/prospects/prospect-rich" });
      expect(res.json().updatedAt).toBe("2025-01-15T10:00:00.000Z");
    });
  });

  describe("arrays — not truncated unlike list summary", () => {
    it("returns all signals (not capped at 5)", async () => {
      app = await buildTestApp(osEnv);
      mockedGetById.mockResolvedValueOnce(richProspect);

      const res = await app.inject({ method: "GET", url: "/search/prospects/prospect-rich" });
      expect(res.json().signals).toHaveLength(6);
    });

    it("returns all tech stack entries (not capped at 6)", async () => {
      app = await buildTestApp(osEnv);
      mockedGetById.mockResolvedValueOnce(richProspect);

      const res = await app.inject({ method: "GET", url: "/search/prospects/prospect-rich" });
      expect(res.json().techStack).toHaveLength(7);
    });

    it("preserves signal detail text", async () => {
      app = await buildTestApp(osEnv);
      mockedGetById.mockResolvedValueOnce(richProspect);

      const res = await app.inject({ method: "GET", url: "/search/prospects/prospect-rich" });
      const first = res.json().signals[0];
      expect(first.type).toBe("job_posting");
      expect(first.detail).toBe("Hiring engineers");
    });
  });

  describe("scoring fields", () => {
    it("returns icpScore, intentScore, painPoints, and outreachReadiness", async () => {
      app = await buildTestApp(osEnv);
      mockedGetById.mockResolvedValueOnce(richProspect);

      const res = await app.inject({ method: "GET", url: "/search/prospects/prospect-rich" });
      const body = res.json();

      expect(body.icpScore).toBe(87);
      expect(body.intentScore).toBe(72);
      expect(body.painPoints).toEqual(["scaling", "developer tooling"]);
      expect(body.outreachReadiness).toBe("high");
    });
  });

  describe("sparse document — optional fields absent when not stored", () => {
    it("returns 200 and does not include undefined detail fields", async () => {
      app = await buildTestApp(osEnv);
      mockedGetById.mockResolvedValueOnce({
        prospectId: "sparse-001",
        companyId: "co-sparse",
        companyDomain: "sparse.io",
        updatedAt: "2025-01-01T00:00:00Z",
      });

      const res = await app.inject({ method: "GET", url: "/search/prospects/sparse-001" });
      expect(res.statusCode).toBe(200);

      const body = res.json();
      expect(body.prospectId).toBe("sparse-001");
      expect(body.email).toBeUndefined();
      expect(body.phone).toBeUndefined();
      expect(body.linkedinUrl).toBeUndefined();
      expect(body.yearsAtCompany).toBeUndefined();
      expect(body.currentlyHiring).toBeUndefined();
      expect(body.subIndustry).toBeUndefined();
      expect(body.totalFunding).toBeUndefined();
    });
  });

  describe("demo fallback", () => {
    it("includes updatedAt in demo response", async () => {
      app = await buildTestApp(baseEnv);
      const demoId = buildDemoCorpus(1)[0]!.prospectId;
      const res = await app.inject({ method: "GET", url: `/search/prospects/${demoId}` });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toHaveProperty("updatedAt");
    });

    it("returns 404 when OS returns null and id is not in demo corpus", async () => {
      app = await buildTestApp(osEnv);
      mockedGetById.mockResolvedValueOnce(null);

      const res = await app.inject({ method: "GET", url: "/search/prospects/missing-id" });
      expect(res.statusCode).toBe(404);
      expect(res.json().error).toBe("prospect_not_found");
    });
  });

  // -------------------------------------------------------------------------
  // Pain points — stored score fields surfaced on prospect detail (AC: shown
  // on prospect detail with source rationale)
  // -------------------------------------------------------------------------
  describe("pain points — surfaced from score row on prospect detail", () => {
    it("returns painPoints and painPointsRationale from a stored score row", async () => {
      app = await buildTestApp(osEnv);
      mockedGetById.mockResolvedValueOnce(sampleProspect);

      const store = getStore(null);
      await store.setScore({
        workspaceId: "test-workspace-id",
        prospectId: "prospect-001",
        score: 82,
        priority: "warm",
        reasoning: "Strong ICP fit",
        painPoints: ["scaling", "technical_debt"],
        painPointsRationale: "CTO at a SaaS company likely faces scaling and tech-debt challenges.",
        scoredAt: new Date().toISOString(),
      });

      const res = await app.inject({ method: "GET", url: "/search/prospects/prospect-001" });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.painPoints).toEqual(["scaling", "technical_debt"]);
      expect(body.painPointsRationale).toBe("CTO at a SaaS company likely faces scaling and tech-debt challenges.");
    });

    it("returns icpScore and outreachReadiness from the score row alongside pain points", async () => {
      app = await buildTestApp(osEnv);
      mockedGetById.mockResolvedValueOnce(sampleProspect);

      const store = getStore(null);
      await store.setScore({
        workspaceId: "test-workspace-id",
        prospectId: "prospect-001",
        score: 90,
        priority: "ready",
        reasoning: "Perfect fit",
        painPoints: ["hiring"],
        painPointsRationale: "Hiring signal detected.",
        scoredAt: new Date().toISOString(),
      });

      const res = await app.inject({ method: "GET", url: "/search/prospects/prospect-001" });
      const body = res.json();
      expect(body.icpScore).toBe(90);
      expect(body.outreachReadiness).toBe("ready");
      expect(body.painPoints).toEqual(["hiring"]);
    });

    it("returns empty painPoints array when score row has no pain points", async () => {
      app = await buildTestApp(osEnv);
      mockedGetById.mockResolvedValueOnce(sampleProspect);

      const store = getStore(null);
      await store.setScore({
        workspaceId: "test-workspace-id",
        prospectId: "prospect-001",
        score: 55,
        priority: "nurture",
        reasoning: "Partial fit",
        painPoints: [],
        painPointsRationale: null,
        scoredAt: new Date().toISOString(),
      });

      const res = await app.inject({ method: "GET", url: "/search/prospects/prospect-001" });
      const body = res.json();
      expect(body.painPoints).toEqual([]);
      expect(body.painPointsRationale).toBeUndefined();
    });

    it("omits painPointsRationale from response when score row rationale is null", async () => {
      app = await buildTestApp(osEnv);
      mockedGetById.mockResolvedValueOnce(sampleProspect);

      const store = getStore(null);
      await store.setScore({
        workspaceId: "test-workspace-id",
        prospectId: "prospect-001",
        score: 60,
        priority: "warm",
        reasoning: "ok",
        painPoints: ["pipeline"],
        painPointsRationale: null,
        scoredAt: new Date().toISOString(),
      });

      const res = await app.inject({ method: "GET", url: "/search/prospects/prospect-001" });
      expect(res.json().painPointsRationale).toBeUndefined();
    });

    it("does not include painPoints or painPointsRationale when no score row exists", async () => {
      app = await buildTestApp(osEnv, "ws-unscored");
      mockedGetById.mockResolvedValueOnce(sampleProspect);

      const res = await app.inject({ method: "GET", url: "/search/prospects/prospect-001" });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.painPoints).toBeUndefined();
      expect(body.painPointsRationale).toBeUndefined();
    });

    it("score row pain points win over corpus pain points when both exist", async () => {
      app = await buildTestApp(osEnv);
      mockedGetById.mockResolvedValueOnce({
        ...sampleProspect,
        painPoints: ["old_corpus_value"],
      });

      const store = getStore(null);
      await store.setScore({
        workspaceId: "test-workspace-id",
        prospectId: "prospect-001",
        score: 75,
        priority: "warm",
        reasoning: "ok",
        painPoints: ["cost_reduction", "reporting"],
        painPointsRationale: "Derived from LLM scoring.",
        scoredAt: new Date().toISOString(),
      });

      const res = await app.inject({ method: "GET", url: "/search/prospects/prospect-001" });
      const body = res.json();
      expect(body.painPoints).toEqual(["cost_reduction", "reporting"]);
      expect(body.painPointsRationale).toBe("Derived from LLM scoring.");
    });
  });
});
