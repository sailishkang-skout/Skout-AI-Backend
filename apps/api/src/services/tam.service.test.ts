import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./icp.service.js", () => ({
  getWorkspaceIcp: vi.fn().mockResolvedValue({ industries: ["SaaS"], countries: ["US"], minEmployees: 10 }),
}));

const { createTam } = await import("./tam.service.js");

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
});
