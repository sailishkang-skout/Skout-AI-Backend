import { describe, expect, it, vi } from "vitest";
import type { CompanyCandidate } from "@skout/scraper-contracts";
import type { ProspectDocument } from "@skout/opensearch";
import { generateCompanyId } from "@skout/shared";
import { enrichDocsWithGrowth, growthPct } from "./growth.js";

/** insert() always succeeds and records what was written; select() resolves `pastSnapshot`. */
function mockDb(pastSnapshot: { employeeCount: number | null }[] = []) {
  const inserts: { table: unknown; values: unknown }[] = [];
  const db = {
    insert: vi.fn((table: unknown) => ({
      values: vi.fn(async (values: unknown) => {
        inserts.push({ table, values });
      }),
    })),
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          orderBy: vi.fn(() => ({
            limit: vi.fn().mockResolvedValue(pastSnapshot),
          })),
        })),
      })),
    })),
  };
  return { db, inserts };
}

function doc(overrides: Partial<ProspectDocument> = {}): ProspectDocument {
  return {
    prospectId: "p1",
    companyId: "company-hash-acme",
    companyDomain: "acme.com",
    ...overrides,
  } as ProspectDocument;
}

describe("growthPct", () => {
  it("computes a rounded percent change", () => {
    expect(growthPct(120, 100)).toBe(20);
  });

  it("returns undefined when there's no past value", () => {
    expect(growthPct(120, 0)).toBeUndefined();
  });
});

describe("enrichDocsWithGrowth", () => {
  it("persists each company's collectSignals() output via recordSignals", async () => {
    const { db, inserts } = mockDb();
    const company: CompanyCandidate = {
      domain: "acme.com",
      scrapedAt: "2026-01-01T00:00:00.000Z",
      source: "company-web",
      signals: [{ type: "recent_hiring", observedAt: "2026-01-01T00:00:00.000Z", detail: "hiring" }],
    } as CompanyCandidate;

    await enrichDocsWithGrowth(db as never, [company], []);

    const values = inserts.flatMap((i) => i.values as { entityId: string; signalType: string }[]);
    expect(values).toContainEqual(
      expect.objectContaining({ entityId: generateCompanyId("acme.com"), signalType: "recent_hiring" })
    );
  });

  it("does not touch the doc or the db when there's no employeeCount to compute growth from", async () => {
    const { db, inserts } = mockDb();
    const docs = [doc({ employeeCount: undefined })];

    const result = await enrichDocsWithGrowth(db as never, [], docs);

    expect(result[0]).toBe(docs[0]);
    expect(inserts).toHaveLength(0);
  });

  it("dedupes headcount-growth signal persistence across multiple docs for the same company", async () => {
    // A past snapshot lower than the current employeeCount so growth is actually computed for
    // every window — this is what makes the dedup guard in growth.ts load-bearing.
    const { db, inserts } = mockDb([{ employeeCount: 80 }]);
    const docs = [
      doc({ prospectId: "p1", companyId: "company-hash-acme", employeeCount: 100 }),
      doc({ prospectId: "p2", companyId: "company-hash-acme", employeeCount: 100 }),
    ];

    const result = await enrichDocsWithGrowth(db as never, [], docs);

    expect(result[0].headcountGrowth).toBe(25);
    expect(result[1].headcountGrowth).toBe(25);

    // Both docs independently computed growth signals, but recordSignals must only have
    // persisted them once for the shared companyId — not once per doc.
    const signalRows = inserts.flatMap((i) => i.values as { entityId: string; signalType: string }[]);
    const growthRows = signalRows.filter((r) => r.signalType === "headcount_growth");
    expect(growthRows).toHaveLength(3); // one row per GROWTH_WINDOWS_MONTHS entry (3/6/12), not doubled
    expect(growthRows.every((r) => r.entityId === "company-hash-acme")).toBe(true);
  });
});
