import { describe, expect, it, vi } from "vitest";
import type { Signal } from "@skout/scraper-contracts";
import { recordSignals } from "./signals-store.js";

function mockDb(insertImpl: (values: unknown) => Promise<unknown>) {
  return {
    insert: vi.fn(() => ({ values: vi.fn(insertImpl) })),
  };
}

describe("recordSignals", () => {
  it("does nothing when there are no signals", async () => {
    const db = mockDb(async () => {
      throw new Error("should not be called");
    });
    await recordSignals(db as never, "entity-1", []);
    expect(db.insert).not.toHaveBeenCalled();
  });

  it("inserts one row per signal, mapping fields to the unified schema", async () => {
    let inserted: unknown;
    const db = mockDb(async (values) => {
      inserted = values;
    });
    const signals: Signal[] = [
      { type: "recent_hiring", observedAt: "2026-01-01T00:00:00.000Z", detail: "5 open roles", source: "linkedin_jobs" },
      { type: "recent_funding", observedAt: "2026-01-02T00:00:00.000Z", detail: "Series A" },
    ];

    await recordSignals(db as never, "company-hash-1", signals);

    expect(db.insert).toHaveBeenCalledTimes(1);
    expect(inserted).toEqual([
      {
        entityType: "company",
        entityId: "company-hash-1",
        signalType: "recent_hiring",
        value: { detail: "5 open roles" },
        detectedAt: new Date("2026-01-01T00:00:00.000Z"),
        source: "linkedin_jobs",
        provenance: { source: "linkedin_jobs" },
      },
      {
        entityType: "company",
        entityId: "company-hash-1",
        signalType: "recent_funding",
        value: { detail: "Series A" },
        detectedAt: new Date("2026-01-02T00:00:00.000Z"),
        source: null,
        provenance: {},
      },
    ]);
  });

  it("swallows a missing-table error and warns instead of throwing", async () => {
    const db = mockDb(async () => {
      throw new Error('relation "signals" does not exist');
    });
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    await expect(
      recordSignals(db as never, "company-hash-1", [
        { type: "tech_adoption", observedAt: "2026-01-01T00:00:00.000Z" },
      ])
    ).resolves.toBeUndefined();

    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("signals table missing"));
    warnSpy.mockRestore();
  });

  it("rethrows unrelated database errors", async () => {
    const db = mockDb(async () => {
      throw new Error("connection reset");
    });
    await expect(
      recordSignals(db as never, "company-hash-1", [
        { type: "tech_adoption", observedAt: "2026-01-01T00:00:00.000Z" },
      ])
    ).rejects.toThrow("connection reset");
  });
});
