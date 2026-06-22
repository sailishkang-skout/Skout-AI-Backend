import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { ZodError } from "zod";
import { prospectRoutes } from "./prospect.routes.js";
import type { Env } from "../config/env.js";

// ---------------------------------------------------------------------------
// Mock @skout/opensearch
// ---------------------------------------------------------------------------
vi.mock("@skout/opensearch", async (importOriginal) => {
  const real = await importOriginal<typeof import("@skout/opensearch")>();
  return {
    ...real,
    bulkUpsertProspects: vi.fn(),
  };
});

import * as osModule from "@skout/opensearch";
const mockedUpsert = vi.mocked(osModule.bulkUpsertProspects);

// ---------------------------------------------------------------------------
// Env stubs
// ---------------------------------------------------------------------------
const noOsEnv = {
  OPENSEARCH_URL: undefined,
  OPENSEARCH_INDEX: "prospects",
} as unknown as Env;

const osEnv = {
  OPENSEARCH_URL: "https://fake-opensearch:9200",
  OPENSEARCH_USERNAME: "user",
  OPENSEARCH_PASSWORD: "pass",
  OPENSEARCH_INDEX: "prospects",
} as unknown as Env;

// ---------------------------------------------------------------------------
// Test app builder
// ---------------------------------------------------------------------------
async function buildTestApp(env: Env): Promise<FastifyInstance> {
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

  await app.register(prospectRoutes);
  await app.ready();
  return app;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe("POST /prospects/manual", () => {
  let app: FastifyInstance;

  afterEach(async () => {
    await app.close();
    vi.clearAllMocks();
  });

  describe("when OpenSearch is not configured", () => {
    beforeEach(async () => {
      app = await buildTestApp(noOsEnv);
    });

    it("returns 503", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/prospects/manual",
        payload: { fullName: "Jane Smith" },
      });
      expect(res.statusCode).toBe(503);
      expect(res.json().error).toBe("Search index not configured");
    });
  });

  describe("when OpenSearch is configured", () => {
    beforeEach(async () => {
      app = await buildTestApp(osEnv);
      mockedUpsert.mockResolvedValue({ ingested: 1, failed: 0 });
    });

    it("returns 201 with prospectId, companyId and message", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/prospects/manual",
        payload: { fullName: "Jane Smith", companyDomain: "acme.com" },
      });
      expect(res.statusCode).toBe(201);
      const body = res.json();
      expect(body).toHaveProperty("prospectId");
      expect(body).toHaveProperty("companyId");
      expect(body.message).toBe("Prospect added to search index");
    });

    it("calls bulkUpsertProspects with the correct document", async () => {
      await app.inject({
        method: "POST",
        url: "/prospects/manual",
        payload: {
          fullName: "Jane Smith",
          jobTitle: "VP Sales",
          email: "jane@acme.com",
          companyDomain: "acme.com",
          companyName: "Acme Corp",
          industry: "Software & SaaS",
          country: "US",
          seniority: "vp",
          department: "Sales",
          currentlyHiring: true,
          employeeCount: 250,
        },
      });

      expect(mockedUpsert).toHaveBeenCalledOnce();
      const [, docs] = mockedUpsert.mock.calls[0];
      const doc = docs[0];
      expect(doc.fullName).toBe("Jane Smith");
      expect(doc.title).toBe("VP Sales");
      expect(doc.email).toBe("jane@acme.com");
      expect(doc.companyDomain).toBe("acme.com");
      expect(doc.companyName).toBe("Acme Corp");
      expect(doc.industry).toBe("Software & SaaS");
      expect(doc.country).toBe("US");
      expect(doc.seniority).toBe("vp");
      expect(doc.department).toBe("Sales");
      expect(doc.currentlyHiring).toBe(true);
      expect(doc.employeeCount).toBe(250);
      expect(doc.updatedAt).toBeTruthy();
    });

    it("generates a stable prospectId from domain + email", async () => {
      const res1 = await app.inject({
        method: "POST",
        url: "/prospects/manual",
        payload: { fullName: "Jane Smith", email: "jane@acme.com", companyDomain: "acme.com" },
      });
      vi.clearAllMocks();
      mockedUpsert.mockResolvedValue({ ingested: 1, failed: 0 });

      const res2 = await app.inject({
        method: "POST",
        url: "/prospects/manual",
        payload: { fullName: "Jane Smith", email: "jane@acme.com", companyDomain: "acme.com" },
      });

      expect(res1.json().prospectId).toBe(res2.json().prospectId);
    });

    it("generates a stable prospectId from domain + name when no email", async () => {
      const res1 = await app.inject({
        method: "POST",
        url: "/prospects/manual",
        payload: { fullName: "John Doe", companyDomain: "example.com" },
      });
      vi.clearAllMocks();
      mockedUpsert.mockResolvedValue({ ingested: 1, failed: 0 });

      const res2 = await app.inject({
        method: "POST",
        url: "/prospects/manual",
        payload: { fullName: "John Doe", companyDomain: "example.com" },
      });

      expect(res1.json().prospectId).toBe(res2.json().prospectId);
    });

    it("uses unknown.com as domain fallback when companyDomain is omitted", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/prospects/manual",
        payload: { fullName: "No Domain" },
      });
      expect(res.statusCode).toBe(201);
      const [, docs] = mockedUpsert.mock.calls[0];
      expect(docs[0].companyDomain).toBe("unknown.com");
    });

    it("passes all optional fields through to the OpenSearch document", async () => {
      await app.inject({
        method: "POST",
        url: "/prospects/manual",
        payload: {
          fullName: "Alex Turner",
          companyDomain: "startup.io",
          phone: "+1 555 000 0000",
          linkedinUrl: "https://linkedin.com/in/alexturner",
          jobFunction: "AE",
          yearsAtCompany: 3,
          yearsInRole: 1,
          previousCompany: "Salesforce",
          subIndustry: "CRM",
          state: "CA",
          city: "San Francisco",
          companyStage: "series_b",
          lastFundingRound: "series_b",
          hiringDepartments: ["Engineering", "Sales"],
        },
      });

      const [, docs] = mockedUpsert.mock.calls[0];
      const doc = docs[0];
      expect(doc.phone).toBe("+1 555 000 0000");
      expect(doc.linkedinUrl).toBe("https://linkedin.com/in/alexturner");
      expect(doc.jobFunction).toBe("AE");
      expect(doc.yearsAtCompany).toBe(3);
      expect(doc.yearsInRole).toBe(1);
      expect(doc.previousCompany).toBe("Salesforce");
      expect(doc.subIndustry).toBe("CRM");
      expect(doc.state).toBe("CA");
      expect(doc.city).toBe("San Francisco");
      expect(doc.companyStage).toBe("series_b");
      expect(doc.lastFundingRound).toBe("series_b");
    });
  });

  describe("validation errors", () => {
    beforeEach(async () => {
      app = await buildTestApp(osEnv);
    });

    it("returns 400 when fullName is missing", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/prospects/manual",
        payload: { companyDomain: "acme.com" },
      });
      expect(res.statusCode).toBe(400);
      const body = res.json();
      expect(body.error).toBe("validation_error");
      expect(body.issues[0].path).toContain("fullName");
    });

    it("returns 400 when fullName is empty string", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/prospects/manual",
        payload: { fullName: "" },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBe("validation_error");
    });

    it("returns 400 when email is invalid format", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/prospects/manual",
        payload: { fullName: "Jane", email: "not-an-email" },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().issues[0].path).toContain("email");
    });

    it("returns 400 when linkedinUrl is not a valid URL", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/prospects/manual",
        payload: { fullName: "Jane", linkedinUrl: "not-a-url" },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().issues[0].path).toContain("linkedinUrl");
    });

    it("returns 400 when employeeCount is less than 1", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/prospects/manual",
        payload: { fullName: "Jane", employeeCount: 0 },
      });
      expect(res.statusCode).toBe(400);
    });

    it("returns 400 when yearsAtCompany is negative", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/prospects/manual",
        payload: { fullName: "Jane", yearsAtCompany: -1 },
      });
      expect(res.statusCode).toBe(400);
    });

    it("returns 400 when body is completely empty", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/prospects/manual",
        payload: {},
      });
      expect(res.statusCode).toBe(400);
    });
  });

  describe("OpenSearch failure handling", () => {
    beforeEach(async () => {
      app = await buildTestApp(osEnv);
    });

    it("returns 500 when OpenSearch throws", async () => {
      mockedUpsert.mockRejectedValueOnce(new Error("connection refused"));

      const res = await app.inject({
        method: "POST",
        url: "/prospects/manual",
        payload: { fullName: "Jane Smith", companyDomain: "acme.com" },
      });

      expect(res.statusCode).toBe(500);
    });
  });
});
