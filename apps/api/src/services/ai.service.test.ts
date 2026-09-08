import { describe, expect, it, vi, beforeEach } from "vitest";
import type { WorkspaceToolRunner } from "./ai-workspace-tools.service.js";

const mockCreate = vi.fn();

vi.mock("openai", () => ({
  default: class MockOpenAI {
    chat = { completions: { create: (...args: unknown[]) => mockCreate(...args) } };
  },
}));

/** §8.13 SP-13 — explain_score is read-only and never goes through the preview/confirm gate
 * (see ai-workspace-tools.service.ts's previewBuilders, which has no entry for it), so its
 * structured result only ever reaches the model as a tool-role message in the completion loop.
 * Without this capture, the UI has no way to render a real breakdown card — only the model's own
 * paraphrase of the numbers, which is exactly the "wasted opportunity" the ticket names. */
describe("AiService.chat — scoreBreakdown capture (§8.13 SP-13)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  function fakeToolRunner(runOutput: string): WorkspaceToolRunner {
    return {
      tools: [{ type: "function", function: { name: "explain_score", parameters: {} } }],
      run: vi.fn().mockResolvedValue(runOutput),
      getCreatedExports: vi.fn().mockReturnValue([]),
      getCreatedSequenceIds: vi.fn().mockReturnValue([]),
      getPendingToolPreview: vi.fn().mockReturnValue(null),
    } as unknown as WorkspaceToolRunner;
  }

  const scoreBreakdownValue = {
    prospectId: "p-1",
    icp: {
      score: 72,
      band: "medium",
      version: "v3",
      source: "heuristic",
      dimensions: { industry: { score: 80, matched: true, explanation: "SaaS is in target industries" } },
      reasoning: "Strong industry fit.",
    },
    signalStack: {
      score: 41,
      band: "warm",
      distinctSignalTypes: 2,
      reachableDecisionMaker: true,
      contributingSignals: [
        { id: "sig-1", signalType: "recent_funding", confidence: 0.8, detectedAt: "2026-01-01T00:00:00Z", weight: 1.2 },
      ],
      weights: { defaultConfidence: 0.6 },
    },
  };

  it("captures explain_score's parsed tool output and returns it as scoreBreakdown", async () => {
    const { aiService } = await import("./ai.service.js");

    // Round 1: model calls explain_score. Round 2: model gives its final JSON reply.
    mockCreate
      .mockResolvedValueOnce({
        choices: [
          {
            message: {
              content: null,
              tool_calls: [
                { id: "call-1", type: "function", function: { name: "explain_score", arguments: '{"prospectId":"p-1"}' } },
              ],
            },
          },
        ],
      })
      .mockResolvedValueOnce({
        choices: [
          {
            message: {
              content: JSON.stringify({ reply: "Scores 72 on ICP fit.", action: { type: "none" } }),
            },
          },
        ],
      });

    const toolRunner = fakeToolRunner(JSON.stringify({ value: scoreBreakdownValue, evidenceId: "ev-1" }));

    const result = await aiService.chat(
      { messages: [{ role: "user", content: "why does this prospect score 72?" }], toolRunner },
      "test-api-key"
    );

    expect(result.scoreBreakdown).toEqual(scoreBreakdownValue);
    expect(result.reply).toBe("Scores 72 on ICP fit.");
  });

  it("leaves scoreBreakdown undefined when no explain_score call happens", async () => {
    const { aiService } = await import("./ai.service.js");

    mockCreate.mockResolvedValueOnce({
      choices: [{ message: { content: JSON.stringify({ reply: "Hi!", action: { type: "none" } }) } }],
    });

    const toolRunner = fakeToolRunner(JSON.stringify({ ok: true }));

    const result = await aiService.chat({ messages: [{ role: "user", content: "hi" }], toolRunner }, "test-api-key");

    expect(result.scoreBreakdown).toBeUndefined();
  });

  it("leaves scoreBreakdown undefined when explain_score's own output is an error, not a real breakdown", async () => {
    const { aiService } = await import("./ai.service.js");

    mockCreate
      .mockResolvedValueOnce({
        choices: [
          {
            message: {
              content: null,
              tool_calls: [
                { id: "call-1", type: "function", function: { name: "explain_score", arguments: '{"prospectId":"missing"}' } },
              ],
            },
          },
        ],
      })
      .mockResolvedValueOnce({
        choices: [{ message: { content: JSON.stringify({ reply: "Couldn't find that prospect.", action: { type: "none" } }) } }],
      });

    const toolRunner = fakeToolRunner(JSON.stringify({ error: "prospect_not_found" }));

    const result = await aiService.chat(
      { messages: [{ role: "user", content: "why does prospect X score high?" }], toolRunner },
      "test-api-key"
    );

    expect(result.scoreBreakdown).toBeUndefined();
  });
});
