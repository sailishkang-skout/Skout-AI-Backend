import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { FastifyInstance } from "fastify";
import { loadEnv } from "../config/env.js";

const WORKSPACE = "00000000-0000-4000-8000-000000000001";

// §7.3 — regression coverage for the event-spine audit: both the "activate + autoEnrich"
// and the manual "/prospects/:id/enrich" paths must emit enrichment.completed. Before this
// fix, only the bulk workbook-run path did, so a manually-enriched prospect never showed up
// on the Dexter event spine even though the enrichment itself succeeded.
const mockEnrichProspect = vi.fn();
const mockActivate = vi.fn();
const mockAddListMembers = vi.fn();

vi.mock("../services/enrichment/index.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("../services/enrichment/index.js")>();
  return {
    ...real,
    buildEnrichmentService: () => ({
      activate: mockActivate,
      addListMembers: mockAddListMembers,
      enrichProspect: mockEnrichProspect,
    }),
  };
});

const mockEmitSkoutEvent = vi.fn().mockResolvedValue(undefined);
vi.mock("../services/skout-event.service.js", () => ({
  emitSkoutEvent: (...args: unknown[]) => mockEmitSkoutEvent(...args),
}));

async function buildTestApp(): Promise<FastifyInstance> {
  const { buildApp } = await import("../app.js");
  return buildApp({
    ...loadEnv(),
    CLERK_SECRET_KEY: undefined,
    LOG_LEVEL: "fatal",
    AI_SERVICE_URL: undefined as unknown as string,
    REDIS_URL: undefined as unknown as string,
    OPENSEARCH_URL: undefined,
  });
}

describe("enrichment.completed emission (§7.3 event-spine audit)", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    mockActivate.mockResolvedValue(undefined);
    mockAddListMembers.mockResolvedValue(true);
    app = await buildTestApp();
  });

  afterEach(async () => {
    await app.close();
    vi.clearAllMocks();
  });

  it("emits enrichment.completed when POST /prospects/manual runs with autoEnrich", async () => {
    mockEnrichProspect.mockResolvedValue({ id: "job-1", status: "completed", creditsUsed: 2 });

    const res = await app.inject({
      method: "POST",
      url: "/api/v1/prospects/manual",
      headers: { "x-workspace-id": WORKSPACE },
      payload: { fullName: "Jane Doe", companyDomain: "acme.com", autoEnrich: true },
    });

    expect(res.statusCode).toBe(201);
    expect(mockEmitSkoutEvent).toHaveBeenCalledWith(
      expect.any(Object),
      expect.any(Object),
      expect.objectContaining({ type: "enrichment.completed", tenantId: WORKSPACE })
    );
  });

  it("emits enrichment.completed on POST /prospects/:id/enrich (manual enrich flow)", async () => {
    mockEnrichProspect.mockResolvedValue({ id: "job-2", status: "completed", creditsUsed: 2, results: {}, attempts: 1 });

    const res = await app.inject({
      method: "POST",
      url: "/api/v1/prospects/p-1/enrich",
      headers: { "x-workspace-id": WORKSPACE },
      payload: { prospect: { companyDomain: "acme.com" } },
    });

    expect(res.statusCode).toBe(202);
    expect(mockEmitSkoutEvent).toHaveBeenCalledWith(
      expect.any(Object),
      expect.any(Object),
      expect.objectContaining({ type: "enrichment.completed", tenantId: WORKSPACE, aggregateId: "p-1" })
    );
  });
});
