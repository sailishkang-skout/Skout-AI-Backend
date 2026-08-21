import { describe, expect, it, vi } from "vitest";
import { listSignalsForEntities, listSignalsForEntity, overlaySignalsForMember } from "./signal.service.js";

// select chain that terminates at .limit() (mirrors list.service.test.ts's helper).
function selectChain(result: unknown[]) {
  const c: Record<string, unknown> = {};
  c.from = vi.fn().mockReturnValue(c);
  c.where = vi.fn().mockReturnValue(c);
  c.orderBy = vi.fn().mockReturnValue(c);
  c.limit = vi.fn().mockResolvedValue(result);
  return c;
}

const ROW = {
  id: "sig-1",
  entityType: "company",
  entityId: "company-hash-1",
  signalType: "recent_hiring",
  value: { detail: "5 open roles" },
  confidence: 0.8,
  detectedAt: new Date("2026-01-01T00:00:00.000Z"),
  source: "linkedin_jobs",
  provenance: { source: "linkedin_jobs" },
  createdAt: new Date("2026-01-01T00:05:00.000Z"),
};

describe("listSignalsForEntity", () => {
  it("returns [] when no rows match", async () => {
    const db = { select: vi.fn().mockReturnValue(selectChain([])) };
    const result = await listSignalsForEntity(db as never, "company-hash-1");
    expect(result).toEqual([]);
  });

  it("serializes rows with ISO date strings", async () => {
    const db = { select: vi.fn().mockReturnValue(selectChain([ROW])) };
    const result = await listSignalsForEntity(db as never, "company-hash-1");
    expect(result).toEqual([
      {
        id: "sig-1",
        entityType: "company",
        entityId: "company-hash-1",
        signalType: "recent_hiring",
        value: { detail: "5 open roles" },
        confidence: 0.8,
        detectedAt: "2026-01-01T00:00:00.000Z",
        source: "linkedin_jobs",
        provenance: { source: "linkedin_jobs" },
        createdAt: "2026-01-01T00:05:00.000Z",
      },
    ]);
  });

  it("passes signalType/entityType filters and limit through to the query", async () => {
    const chain = selectChain([ROW]);
    const db = { select: vi.fn().mockReturnValue(chain) };
    await listSignalsForEntity(db as never, "company-hash-1", {
      entityType: "company",
      signalType: "recent_hiring",
      limit: 5,
    });
    expect((chain.limit as ReturnType<typeof vi.fn>)).toHaveBeenCalledWith(5);
  });

  it("defaults the limit to 100 when not provided", async () => {
    const chain = selectChain([]);
    const db = { select: vi.fn().mockReturnValue(chain) };
    await listSignalsForEntity(db as never, "company-hash-1");
    expect((chain.limit as ReturnType<typeof vi.fn>)).toHaveBeenCalledWith(100);
  });
});

function selectOrderChain(result: unknown[]) {
  const c: Record<string, unknown> = {};
  c.from = vi.fn().mockReturnValue(c);
  c.where = vi.fn().mockReturnValue(c);
  c.orderBy = vi.fn().mockResolvedValue(result);
  return c;
}

describe("listSignalsForEntities", () => {
  it("returns an empty map when no ids are given", async () => {
    const db = { select: vi.fn() };
    const result = await listSignalsForEntities(db as never, []);
    expect(result.size).toBe(0);
    expect(db.select).not.toHaveBeenCalled();
  });

  it("groups rows by entityId and keeps newest first", async () => {
    const older = { ...ROW, id: "sig-old", detectedAt: new Date("2025-12-01T00:00:00.000Z") };
    const other = { ...ROW, id: "sig-2", entityId: "company-hash-2", signalType: "recent_funding" };
    const db = { select: vi.fn().mockReturnValue(selectOrderChain([ROW, older, other])) };
    const result = await listSignalsForEntities(db as never, ["company-hash-1", "company-hash-2"]);
    expect(result.get("company-hash-1")?.map((s) => s.id)).toEqual(["sig-1", "sig-old"]);
    expect(result.get("company-hash-2")?.map((s) => s.signalType)).toEqual(["recent_funding"]);
  });
});

describe("overlaySignalsForMember", () => {
  it("merges prospect + company signals and caps at 3 newest", () => {
    const byEntity = new Map([
      [
        "p-1",
        [
          {
            id: "a",
            entityType: "prospect",
            entityId: "p-1",
            signalType: "engagement_decay",
            value: { reason: "no opens" },
            confidence: 0.6,
            detectedAt: "2026-03-01T00:00:00.000Z",
            source: "risk",
            provenance: {},
            createdAt: "2026-03-01T00:00:00.000Z",
          },
        ],
      ],
      [
        "c-1",
        [
          {
            id: "b",
            entityType: "company",
            entityId: "c-1",
            signalType: "recent_funding",
            value: { detail: "Series B" },
            confidence: 0.9,
            detectedAt: "2026-04-01T00:00:00.000Z",
            source: "crunchbase",
            provenance: {},
            createdAt: "2026-04-01T00:00:00.000Z",
          },
          {
            id: "c",
            entityType: "company",
            entityId: "c-1",
            signalType: "tech_adopted",
            value: { tool: "Snowflake" },
            confidence: 0.7,
            detectedAt: "2026-02-01T00:00:00.000Z",
            source: "builtwith",
            provenance: {},
            createdAt: "2026-02-01T00:00:00.000Z",
          },
          {
            id: "d",
            entityType: "company",
            entityId: "c-1",
            signalType: "recent_hiring",
            value: {},
            confidence: null,
            detectedAt: "2026-01-15T00:00:00.000Z",
            source: null,
            provenance: {},
            createdAt: "2026-01-15T00:00:00.000Z",
          },
        ],
      ],
    ]);

    const overlay = overlaySignalsForMember(byEntity, "p-1", "c-1");
    expect(overlay).toEqual([
      { type: "recent_funding", observedAt: "2026-04-01T00:00:00.000Z", detail: "Series B" },
      { type: "engagement_decay", observedAt: "2026-03-01T00:00:00.000Z", detail: "no opens" },
      { type: "tech_adopted", observedAt: "2026-02-01T00:00:00.000Z", detail: "Snowflake" },
    ]);
  });

  it("returns [] when neither entity has signals", () => {
    expect(overlaySignalsForMember(new Map(), "p-1", "c-1")).toEqual([]);
  });
});
