import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./icp.service.js", () => ({
  getWorkspaceIcp: vi.fn().mockResolvedValue({ industries: ["SaaS"], countries: ["US"], minEmployees: 10 }),
}));

const { buildDataCoverageDisclosure, computeCountryConfidence, createTam } = await import("./tam.service.js");

const ENV = { DEMO_CORPUS_SIZE: 0, OPENSEARCH_URL: undefined } as never;

/** Minimal chainable mock covering the select/insert calls createTam+computeCoverage make. */
function makeDb(activations: { id: string; prospectId: string; companyId: string; snapshot: unknown }[]) {
  const selectQueue: unknown[][] = [
    activations, // prospectActivations for coverage
    [], // enrichmentJobs
    [], // sequenceEnrollments
    [], // inboxThreads
    [], // deals join
  ];
  let i = 0;
  return {
    select: vi.fn(() => ({
      from: vi.fn(() => {
        const chain = {
          innerJoin: vi.fn(() => chain),
          where: vi.fn(() => Promise.resolve(selectQueue[i++] ?? [])),
        };
        return chain;
      }),
    })),
    insert: vi.fn(() => ({
      values: vi.fn((values: unknown) => ({
        returning: vi.fn().mockResolvedValue([
          {
            id: "tam-1",
            workspaceId: "ws-1",
            createdBy: null,
            createdAt: new Date(),
            updatedAt: new Date(),
            ...(values as object),
          },
        ]),
      })),
    })),
  } as any;
}

beforeEach(() => vi.clearAllMocks());

describe("createTam", () => {
  it("computes total/segments from the demo corpus and coverage from matching activations", async () => {
    const db = makeDb([
      { id: "a1", prospectId: "p1", companyId: "c1", snapshot: { industry: "SaaS", country: "US", employeeCount: 50 } },
      { id: "a2", prospectId: "p2", companyId: "c2", snapshot: { industry: "Retail", country: "US", employeeCount: 50 } },
    ]);

    const tam = await createTam(db, ENV, "ws-1", { name: "My TAM" }, "user-1");

    expect(tam.name).toBe("My TAM");
    // Only the SaaS/US/50-employee activation matches the ICP-derived filter (industries=[SaaS]).
    expect(tam.coverage.activated).toBe(1);
    expect(tam.coverage.enriched).toBe(0);
  });

  it("rejects an empty name", async () => {
    const db = makeDb([]);
    await expect(createTam(db, ENV, "ws-1", { name: "  " })).rejects.toThrow();
  });

  it("stamps dataSource=demo_corpus and attaches a matching data-coverage disclosure when no OpenSearch index is configured", async () => {
    const db = makeDb([]);
    const tam = await createTam(db, ENV, "ws-1", { name: "My TAM" });
    expect(tam.dataCoverageDisclosure.source).toBe("demo_corpus");
    expect(tam.dataCoverageDisclosure.note).toContain("synthetic demo corpus");
  });
});

describe("computeCountryConfidence", () => {
  it("labels a large country bucket high-confidence", () => {
    const [result] = computeCountryConfidence([{ dimension: "geo", value: "United States", count: 150 }]);
    expect(result).toMatchObject({ country: "United States", count: 150, confidence: 1, confidenceLabel: "high" });
  });

  it("labels a mid-size country bucket medium-confidence", () => {
    const [result] = computeCountryConfidence([{ dimension: "geo", value: "Germany", count: 40 }]);
    expect(result?.confidenceLabel).toBe("medium");
    expect(result?.confidence).toBe(0.4);
  });

  it("labels a small country bucket low-confidence", () => {
    const [result] = computeCountryConfidence([{ dimension: "geo", value: "Iceland", count: 3 }]);
    expect(result?.confidenceLabel).toBe("low");
    expect(result?.confidence).toBe(0.03);
  });

  it("ignores non-geo dimensions", () => {
    const result = computeCountryConfidence([
      { dimension: "industry", value: "SaaS", count: 500 },
      { dimension: "size", value: "51-200", count: 500 },
    ]);
    expect(result).toEqual([]);
  });
});

describe("buildDataCoverageDisclosure", () => {
  it("discloses a live OpenSearch source with the licensing-coverage caveat", () => {
    const result = buildDataCoverageDisclosure("opensearch");
    expect(result.source).toBe("opensearch");
    expect(result.note).toContain("licensing");
  });

  it("discloses the demo-corpus fallback plainly", () => {
    const result = buildDataCoverageDisclosure("demo_corpus");
    expect(result.note).toContain("not real market data");
  });

  it("discloses unknown source for a TAM computed before source tracking existed", () => {
    const result = buildDataCoverageDisclosure(null);
    expect(result.source).toBeNull();
    expect(result.note).toContain("unknown");
  });
});
