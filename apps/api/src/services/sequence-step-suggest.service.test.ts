import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  getSequenceById,
  listEnrolledLists,
  suggestStepContent,
  buildAudienceSummary,
  computeOutcomeInsights,
  pinAiClaim,
} = vi.hoisted(() => ({
  getSequenceById: vi.fn(),
  listEnrolledLists: vi.fn(),
  suggestStepContent: vi.fn(),
  buildAudienceSummary: vi.fn(),
  computeOutcomeInsights: vi.fn(),
  pinAiClaim: vi.fn(),
}));

vi.mock("./sequence.service.js", () => ({
  SequenceService: class {
    getSequenceById = getSequenceById;
    listEnrolledLists = listEnrolledLists;
  },
}));
vi.mock("./ai.service.js", () => ({ aiService: { suggestStepContent } }));
vi.mock("./sequence-generate.service.js", () => ({ buildAudienceSummary }));
vi.mock("./outcome-insights.service.js", () => ({
  computeOutcomeInsights,
  insightsToPrompt: (i: unknown) => (i ? "- reply rate 4%" : null),
}));
vi.mock("./ai-evidence.service.js", () => ({ pinAiClaim }));

import { suggestStepForSequence } from "./sequence-step-suggest.service.js";

const db = {} as never;
const config = { OPENROUTER_API_KEY: "sk-test" } as never;
const WS = "ws-1";
const SEQ = "seq-1";

function step(id: string, order: number, over: Record<string, unknown> = {}) {
  return {
    id,
    sequenceId: SEQ,
    stepOrder: order,
    stepType: "email",
    delayDays: 0,
    delayUnit: "days",
    linkedinAction: null,
    subject: null,
    bodyTemplate: null,
    ...over,
  };
}

const sequence = {
  id: SEQ,
  name: "Q3 SaaS CFO Outreach",
  steps: [
    step("s3", 3, { stepType: "wait", delayDays: 3 }),
    step("s1", 1, { subject: "Quick idea", bodyTemplate: "<p>Hi {{firstName}}</p>" }),
    step("s2", 2, { stepType: "linkedin", linkedinAction: "connect", delayDays: 1 }),
    step("s4", 4, { subject: "Following up" }),
  ],
};

describe("suggestStepForSequence", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getSequenceById.mockResolvedValue(sequence);
    listEnrolledLists.mockResolvedValue([]);
    buildAudienceSummary.mockResolvedValue(null);
    computeOutcomeInsights.mockResolvedValue(null);
    suggestStepContent.mockResolvedValue([{ angle: "Warm intro", body: "Hi {{firstName}}" }]);
    pinAiClaim.mockResolvedValue({ evidenceId: "ev-1", modelVersionId: "mv-1", promptVersionId: "pv-1" });
  });

  it("builds context from the sequence name and the steps around the target step", async () => {
    await suggestStepForSequence(db, config, WS, SEQ, {
      target: { stepType: "linkedin", linkedinAction: "connect" },
      stepId: "s2",
    });

    const ctx = suggestStepContent.mock.calls[0]![0];
    expect(ctx.sequenceName).toBe("Q3 SaaS CFO Outreach");
    expect(ctx.position).toBe(2);
    expect(ctx.total).toBe(4);
    expect(ctx.before).toHaveLength(1);
    expect(ctx.before[0]).toContain("Quick idea");
    expect(ctx.after.map((l: string) => l.split(" · ")[0])).toEqual(["Step 3", "Step 4"]);
    expect(suggestStepContent.mock.calls[0]![1]).toBe("sk-test");
  });

  it("treats a missing stepId as a new step appended to the end", async () => {
    await suggestStepForSequence(db, config, WS, SEQ, { target: { stepType: "email" } });
    const ctx = suggestStepContent.mock.calls[0]![0];
    expect(ctx.position).toBe(5);
    expect(ctx.total).toBe(5);
    expect(ctx.before).toHaveLength(4);
    expect(ctx.after).toEqual([]);
  });

  it("404s for an unknown sequence or a step that is not in it", async () => {
    getSequenceById.mockResolvedValueOnce(null);
    await expect(
      suggestStepForSequence(db, config, WS, SEQ, { target: { stepType: "email" } })
    ).rejects.toMatchObject({ statusCode: 404, message: "sequence_not_found" });

    await expect(
      suggestStepForSequence(db, config, WS, SEQ, { target: { stepType: "email" }, stepId: "nope" })
    ).rejects.toMatchObject({ statusCode: 404, message: "step_not_found" });
    expect(suggestStepContent).not.toHaveBeenCalled();
  });

  it("scopes every lookup to the caller's workspace", async () => {
    await suggestStepForSequence(db, config, WS, SEQ, { target: { stepType: "email" }, stepId: "s1" });
    expect(getSequenceById).toHaveBeenCalledWith(WS, SEQ);
  });

  it("adds audience from the first enrolled list and workspace insights when available", async () => {
    listEnrolledLists.mockResolvedValueOnce([{ listId: "list-1", listName: "CFOs" }]);
    buildAudienceSummary.mockResolvedValueOnce("Common titles: CFO.");
    computeOutcomeInsights.mockResolvedValueOnce({ any: "thing" });

    await suggestStepForSequence(db, config, WS, SEQ, { target: { stepType: "email" }, stepId: "s1" });

    expect(buildAudienceSummary).toHaveBeenCalledWith(db, WS, "list-1");
    const ctx = suggestStepContent.mock.calls[0]![0];
    expect(ctx.audience).toBe("Common titles: CFO.");
    expect(ctx.insights).toBe("- reply rate 4%");
  });

  it("still suggests when audience or insights lookups fail", async () => {
    listEnrolledLists.mockRejectedValueOnce(new Error("db blip"));
    computeOutcomeInsights.mockRejectedValueOnce(new Error("db blip"));

    const res = await suggestStepForSequence(db, config, WS, SEQ, { target: { stepType: "email" }, stepId: "s1" });

    expect(res.suggestions).toHaveLength(1);
    const ctx = suggestStepContent.mock.calls[0]![0];
    expect(ctx.audience).toBeNull();
    expect(ctx.insights).toBeNull();
  });

  it("forwards angles to avoid, pins the generation and returns the evidence envelope", async () => {
    const res = await suggestStepForSequence(db, config, WS, SEQ, {
      target: { stepType: "email" },
      stepId: "s1",
      excludeAngles: ["Warm intro"],
    });

    expect(suggestStepContent.mock.calls[0]![0].excludeAngles).toEqual(["Warm intro"]);
    expect(pinAiClaim).toHaveBeenCalledWith(
      db,
      expect.objectContaining({
        workspaceId: WS,
        entityType: "sequence",
        entityId: SEQ,
        versionName: "sequence-step-suggest",
      })
    );
    expect(res).toEqual({
      suggestions: [{ angle: "Warm intro", body: "Hi {{firstName}}" }],
      evidenceId: "ev-1",
      modelVersionId: "mv-1",
      promptVersionId: "pv-1",
    });
  });
});
