import { describe, expect, it, vi } from "vitest";
import { listSignalsForEntity } from "./signal.service.js";

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
