import { beforeEach, describe, expect, it, vi } from "vitest";
import type { StepSuggestionContext } from "./sequence-step-suggestions.js";

const mockCreate = vi.fn();

vi.mock("openai", () => ({
  default: class MockOpenAI {
    chat = { completions: { create: (...args: unknown[]) => mockCreate(...args) } };
  },
}));

const ctx: StepSuggestionContext = {
  sequenceName: "Q3 SaaS CFO Outreach",
  target: { stepType: "linkedin", linkedinAction: "connect" },
  position: 2,
  total: 4,
  before: ["Step 1 · email (+0 days) subject \"Quick idea\""],
  after: [],
};

function completion(content: string) {
  return { choices: [{ message: { content } }] };
}

describe("AiService.suggestStepContent", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("rejects with 503 when no API key is configured", async () => {
    const { aiService } = await import("./ai.service.js");
    await expect(aiService.suggestStepContent(ctx, undefined)).rejects.toMatchObject({ statusCode: 503 });
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it("sends the sequence context to the model and returns sanitised suggestions", async () => {
    mockCreate.mockResolvedValueOnce(
      completion(
        JSON.stringify({
          suggestions: [
            { angle: "Warm intro", body: "Hi {{firstName}}, saw your CFO work — keen to connect." },
            { angle: "Broken", body: "Hi [Your Name]" },
          ],
        })
      )
    );
    const { aiService } = await import("./ai.service.js");

    const result = await aiService.suggestStepContent(ctx, "sk-test");

    expect(result).toEqual([
      { angle: "Warm intro", body: "Hi {{firstName}}, saw your CFO work — keen to connect." },
    ]);
    const req = mockCreate.mock.calls[0]![0] as {
      response_format: { type: string };
      messages: { role: string; content: string }[];
    };
    expect(req.response_format).toEqual({ type: "json_object" });
    const userMsg = req.messages.find((m) => m.role === "user")!.content;
    expect(userMsg).toContain("Q3 SaaS CFO Outreach");
    expect(userMsg).toContain("Quick idea");
  });

  it("rejects with 502 when the model returns nothing usable", async () => {
    mockCreate.mockResolvedValueOnce(completion(JSON.stringify({ suggestions: [{ angle: "x", body: "Hi [Name]" }] })));
    const { aiService } = await import("./ai.service.js");
    await expect(aiService.suggestStepContent(ctx, "sk-test")).rejects.toMatchObject({ statusCode: 502 });
  });

  it("rejects with 502 when the provider call fails", async () => {
    mockCreate.mockRejectedValueOnce(new Error("upstream down"));
    const { aiService } = await import("./ai.service.js");
    await expect(aiService.suggestStepContent(ctx, "sk-test")).rejects.toMatchObject({ statusCode: 502 });
  });
});
