import { describe, expect, it, vi } from "vitest";
import { EnrichmentService } from "./service.js";
import type { EnrichmentStore } from "./types.js";

vi.mock("./ai-client.js", async () => {
  const actual = await vi.importActual<typeof import("./ai-client.js")>("./ai-client.js");
  return {
    ...actual,
    scoreProspect: vi.fn().mockResolvedValue({
      prospectId: "prospect-1",
      icpScore: 92,
      icpBand: "strong",
      intentScore: 80,
      painPoints: [],
      painPointsRationale: null,
      outreachReadiness: "ready",
      reasoning: "test",
      source: "heuristic",
      dimensions: {},
    }),
  };
});

function makeStore(): EnrichmentStore {
  return {
    getCreditBalance: vi.fn().mockResolvedValue(100),
    addCredits: vi.fn(),
    deductCredits: vi.fn().mockResolvedValue(98),
    upsertActivation: vi.fn(),
    listActivations: vi.fn(),
    getActivation: vi.fn(),
    createList: vi.fn(),
    addListMembers: vi.fn(),
    listLists: vi.fn(),
    getListMemberIds: vi.fn(),
    renameList: vi.fn(),
    deleteList: vi.fn(),
    removeMembersFromList: vi.fn(),
    createJob: vi.fn(),
    updateJob: vi.fn(),
    getJob: vi.fn(),
    listJobs: vi.fn(),
    createBatch: vi.fn(),
    updateBatch: vi.fn(),
    getBatch: vi.fn(),
    setScore: vi.fn().mockResolvedValue({}),
    getScore: vi.fn(),
    getScoresForProspects: vi.fn(),
    getList: vi.fn(),
  } as unknown as EnrichmentStore;
}

describe("EnrichmentService.score afterScore hook", () => {
  it("passes both the score result and the workspaceId to afterScore", async () => {
    const afterScore = vi.fn().mockResolvedValue(undefined);
    const svc = new EnrichmentService(makeStore(), vi.fn(), undefined, undefined, undefined, undefined, afterScore);

    await svc.score("ws-1", { prospectId: "prospect-1", companyDomain: "acme.com" }, { industries: ["Software"] });

    expect(afterScore).toHaveBeenCalledTimes(1);
    const [resultArg, workspaceIdArg] = afterScore.mock.calls[0];
    expect(resultArg.prospectId).toBe("prospect-1");
    expect(workspaceIdArg).toBe("ws-1");
  });
});
