import { describe, expect, it, vi, beforeEach } from "vitest";
import type { Env } from "../../config/env.js";

const enrichProspect = vi.fn();
class FakeInsufficientCreditsError extends Error {
  constructor(public readonly required: number, public readonly available: number) {
    super(`Insufficient credits: need ${required}, have ${available}`);
  }
}
vi.mock("../enrichment/index.js", () => ({
  buildEnrichmentService: () => ({ enrichProspect: (...args: unknown[]) => enrichProspect(...args) }),
  InsufficientCreditsError: FakeInsufficientCreditsError,
}));

const { enrichmentActionNodeHandler } = await import("./action-enrichment.node.js");

const config = {} as Env;

beforeEach(() => {
  vi.clearAllMocks();
});

describe("enrichmentActionNodeHandler", () => {
  it("runs the enrichment waterfall via EnrichmentService.enrichProspect and returns the job", async () => {
    enrichProspect.mockResolvedValue({ id: "job-1", status: "completed", creditsUsed: 2, results: [{ field: "email" }] });

    const result = await enrichmentActionNodeHandler({
      db: {} as never,
      config,
      workspaceId: "ws-1",
      runId: "run-1",
      isSimulation: false,
      node: {
        id: "n1",
        type: "action_enrichment",
        config: { companyDomain: "acme.com", prospectId: "p-1", fields: ["email"] },
      },
      priorOutputs: {},
    });

    expect(enrichProspect).toHaveBeenCalledWith(
      "ws-1",
      expect.objectContaining({ companyDomain: "acme.com", prospectId: "p-1" }),
      expect.objectContaining({ fields: ["email"], trigger: "workflow" })
    );
    expect(result.output).toEqual({ jobId: "job-1", status: "completed", creditsUsed: 2, results: [{ field: "email" }] });
  });

  it("throws a clear error when companyDomain is missing", async () => {
    await expect(
      enrichmentActionNodeHandler({
        db: {} as never,
        config,
        workspaceId: "ws-1",
        runId: "run-1",
        isSimulation: false,
        node: { id: "n1", type: "action_enrichment", config: { prospectId: "p-1" } },
        priorOutputs: {},
      })
    ).rejects.toThrow(/companyDomain/);
    expect(enrichProspect).not.toHaveBeenCalled();
  });

  it("surfaces insufficient credits as a 402 instead of a raw thrown error", async () => {
    enrichProspect.mockRejectedValue(new FakeInsufficientCreditsError(1, 0));

    await expect(
      enrichmentActionNodeHandler({
        db: {} as never,
        config,
        workspaceId: "ws-1",
        runId: "run-1",
        isSimulation: false,
        node: { id: "n1", type: "action_enrichment", config: { companyDomain: "acme.com" } },
        priorOutputs: {},
      })
    ).rejects.toMatchObject({ statusCode: 402 });
  });

  it("skips the real enrichment call in simulation mode", async () => {
    const result = await enrichmentActionNodeHandler({
      db: {} as never,
      config,
      workspaceId: "ws-1",
      runId: "run-1",
      isSimulation: true,
      node: { id: "n1", type: "action_enrichment", config: { companyDomain: "acme.com" } },
      priorOutputs: {},
    });
    expect(enrichProspect).not.toHaveBeenCalled();
    expect(result.output.simulated).toBe(true);
  });
});
