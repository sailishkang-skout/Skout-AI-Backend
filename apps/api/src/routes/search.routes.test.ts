import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { ZodError } from "zod";
import { searchRoutes } from "./search.routes.js";
import type { Env } from "../config/env.js";

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
async function buildTestApp(env: Env = baseEnv): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });

  app.decorate("config", env);

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
    req.workspaceId = "test-workspace-id";
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

  afterEach(async () => {
    await app.close();
    vi.clearAllMocks();
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

    it("falls back to demo data when OpenSearch throws", async () => {
      mockedSearch.mockRejectedValueOnce(new Error("connection refused"));

      const res = await app.inject({ method: "POST", url: "/search/prospects", payload: {} });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.results.length).toBeGreaterThan(0);
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
});

describe("GET /search/prospects/:id", () => {
  let app: FastifyInstance;

  afterEach(async () => {
    await app.close();
    vi.clearAllMocks();
  });

  it("returns demo prospect when OpenSearch is not configured", async () => {
    app = await buildTestApp(baseEnv);
    const res = await app.inject({ method: "GET", url: "/search/prospects/some-id" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toHaveProperty("prospectId");
    expect(body).toHaveProperty("fullName");
    expect(body).toHaveProperty("title");
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

  it("returns demo prospect when OpenSearch returns null", async () => {
    app = await buildTestApp(osEnv);
    mockedGetById.mockResolvedValueOnce(null);

    const res = await app.inject({ method: "GET", url: "/search/prospects/missing-id" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.prospectId).toBe("missing-id");
  });
});
