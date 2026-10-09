import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import type { Env } from "../config/env.js";

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

// The enrich route checks enrichment:capture and writes an audit row (ENR-01); both need a db.
// They are stubbed here so this test stays about event emission.
vi.mock("@skout/auth", async (importOriginal) => {
  const real = await importOriginal<typeof import("@skout/auth")>();
  return { ...real, assertPermission: vi.fn().mockResolvedValue(undefined), recordPrivilegedAction: vi.fn().mockResolvedValue(undefined) };
});

const { prospectRoutes } = await import("./prospect.routes.js");

const STUB_DB = {};

async function buildTestApp(db: unknown = null): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  app.decorate("config", {} as Env);
  app.decorate("db", db as never);
  app.addHook("preHandler", async (req) => {
    req.userId = "test-user-id";
    req.workspaceId = "test-workspace-id";
  });
  await app.register(prospectRoutes);
  await app.ready();
  return app;
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
      url: "/prospects/manual",
      payload: { fullName: "Jane Doe", companyDomain: "acme.com", autoEnrich: true },
    });

    expect(res.statusCode).toBe(201);
    expect(mockEmitSkoutEvent).toHaveBeenCalledWith(
      null,
      {},
      expect.objectContaining({ type: "enrichment.completed", tenantId: "test-workspace-id" })
    );
  });

  it("emits enrichment.completed on POST /prospects/:id/enrich (manual enrich flow)", async () => {
    mockEnrichProspect.mockResolvedValue({ id: "job-2", status: "completed", creditsUsed: 2, results: {}, attempts: 1 });
    await app.close();
    app = await buildTestApp(STUB_DB);

    const res = await app.inject({
      method: "POST",
      url: "/prospects/p-1/enrich",
      payload: { prospect: { companyDomain: "acme.com" } },
    });

    expect(res.statusCode).toBe(202);
    expect(mockEmitSkoutEvent).toHaveBeenCalledWith(
      STUB_DB,
      {},
      expect.objectContaining({ type: "enrichment.completed", tenantId: "test-workspace-id", aggregateId: "p-1" })
    );
  });
});
