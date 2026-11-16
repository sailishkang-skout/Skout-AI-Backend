import { beforeEach, describe, expect, it, vi } from "vitest";

const mockCreate = vi.fn();

vi.mock("openai", () => ({
  default: class MockOpenAI {
    chat = { completions: { create: (...args: unknown[]) => mockCreate(...args) } };
  },
}));

const completion = (body: unknown) => ({ choices: [{ message: { content: JSON.stringify(body) } }] });
const email = (subject: string) => ({ stepType: "email", delayDays: 2, subject, bodyTemplate: "<p>x</p>" });

/** What gpt-4o-mini actually returned for "15 steps with conditions": too few steps, empty conditions. */
const flatAndShort = {
  name: "Healthcare VPs",
  steps: [
    email("a"),
    { stepType: "condition", conditionType: "email_opened" },
    email("b"),
    { stepType: "condition", conditionType: "email_replied" },
    email("c"),
  ],
};

/** A valid 6-step answer using nested yes/no lists. */
const sixValid = {
  name: "Healthcare VPs",
  steps: [
    email("a"),
    {
      stepType: "condition",
      conditionType: "email_opened",
      conditionWaitDays: 3,
      yes: [email("b")],
      no: [{ stepType: "linkedin", delayDays: 1, linkedinAction: "connect", bodyTemplate: "hi" }],
    },
    email("c"),
    { stepType: "goal", goalLabel: "Meeting booked" },
  ],
};

describe("AiService.generateSequence — structure checks and retries", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("sends the problems back and returns the corrected answer", async () => {
    mockCreate.mockResolvedValueOnce(completion(flatAndShort)).mockResolvedValueOnce(completion(sixValid));
    const { aiService } = await import("./ai.service.js");

    const out = await aiService.generateSequence(
      { goal: "Create a 6 step sequence for VPs with conditions", channels: ["email", "linkedin"] },
      "key"
    );

    expect(mockCreate).toHaveBeenCalledTimes(2);
    const retryMessages = mockCreate.mock.calls[1]![0].messages as { role: string; content: string }[];
    const feedback = retryMessages.at(-1)!.content;
    expect(feedback).toMatch(/exactly 6 steps but the sequence has 5/);
    expect(feedback).toMatch(/Condition at step 2/);
    expect(feedback).toMatch(/last step must be a goal/i);

    expect(out.steps).toHaveLength(6);
    expect(out.steps.map((s) => `${s.stepType}${s.branch ? "[" + s.branch + "]" : ""}`)).toEqual([
      "email",
      "condition",
      "email[yes]",
      "linkedin[no]",
      "email",
      "goal",
    ]);
  });

  it("stops after three attempts and still returns the best answer, ending on a goal", async () => {
    mockCreate.mockResolvedValue(completion(flatAndShort));
    const { aiService } = await import("./ai.service.js");

    const out = await aiService.generateSequence({ goal: "a 15 step sequence with conditions" }, "key");

    expect(mockCreate).toHaveBeenCalledTimes(3);
    expect(out.steps.at(-1)).toMatchObject({ stepType: "goal" });
  });

  it("when no attempt is exact, returns the one closest to the requested count", async () => {
    const valid = (n: number) => ({
      name: "S",
      steps: [...Array.from({ length: n - 1 }, (_, i) => email(String(i))), { stepType: "goal", goalLabel: "Meeting booked" }],
    });
    mockCreate
      .mockResolvedValueOnce(completion(valid(10)))
      .mockResolvedValueOnce(completion(valid(14)))
      .mockResolvedValueOnce(completion(valid(18)));
    const { aiService } = await import("./ai.service.js");

    const out = await aiService.generateSequence({ goal: "a 15 step sequence", channels: ["email"] }, "key");

    expect(mockCreate).toHaveBeenCalledTimes(3);
    expect(out.steps).toHaveLength(14);
  });

  it("makes one call when the first answer is already right", async () => {
    mockCreate.mockResolvedValueOnce(completion(sixValid));
    const { aiService } = await import("./ai.service.js");

    await aiService.generateSequence({ goal: "a 6 step sequence", channels: ["email", "linkedin"] }, "key");

    expect(mockCreate).toHaveBeenCalledTimes(1);
  });

  it("removes LinkedIn steps nested inside a branch when the sequence is email only, and asks for a fix", async () => {
    mockCreate.mockResolvedValue(completion(sixValid));
    const { aiService } = await import("./ai.service.js");

    const out = await aiService.generateSequence({ goal: "outreach to VPs", channels: ["email"] }, "key");

    expect(out.steps.some((s) => s.stepType === "linkedin")).toBe(false);
    const feedback = (mockCreate.mock.calls[1]![0].messages as { content: string }[]).at(-1)!.content;
    expect(feedback).toMatch(/email only/);
  });

  it("uses AI_SEQUENCE_MODEL when set", async () => {
    process.env.AI_SEQUENCE_MODEL = "openai/gpt-4.1";
    try {
      mockCreate.mockResolvedValueOnce(completion(sixValid));
      const { aiService } = await import("./ai.service.js");
      await aiService.generateSequence({ goal: "a 6 step sequence", channels: ["email", "linkedin"] }, "key");
      expect(mockCreate.mock.calls[0]![0].model).toBe("openai/gpt-4.1");
    } finally {
      delete process.env.AI_SEQUENCE_MODEL;
    }
  });
});
