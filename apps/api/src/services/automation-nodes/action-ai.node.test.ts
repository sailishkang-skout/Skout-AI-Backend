import { describe, expect, it, vi, beforeEach } from "vitest";
import type { Env } from "../../config/env.js";

const generateEmail = vi.fn();
vi.mock("../ai.service.js", () => ({
  aiService: { generateEmail: (...args: unknown[]) => generateEmail(...args) },
}));

const create = vi.fn();
vi.mock("../ai-draft.service.js", () => ({
  buildAiDraftService: () => ({ create: (...args: unknown[]) => create(...args) }),
}));

const { aiActionNodeHandler } = await import("./action-ai.node.js");

const config = { OPENROUTER_API_KEY: "key" } as Env;

beforeEach(() => {
  vi.clearAllMocks();
});

describe("aiActionNodeHandler", () => {
  it("generates a draft via the shared Content Studio path and persists it via ai-draft.service", async () => {
    generateEmail.mockResolvedValue({ html: "<p>hi</p>", subject: "Quick question" });
    create.mockResolvedValue({ id: "draft-1", subject: "Quick question", status: "pending_review" });

    const result = await aiActionNodeHandler({
      db: {} as never,
      config,
      workspaceId: "ws-1",
      runId: "run-1",
      isSimulation: false,
      node: { id: "n1", type: "action_ai", config: { prospectId: "p-1", prompt: "Follow up after demo" } },
      priorOutputs: {},
    });

    expect(generateEmail).toHaveBeenCalledWith("Follow up after demo", "key");
    expect(create).toHaveBeenCalledWith(
      "ws-1",
      expect.objectContaining({ prospectId: "p-1", subject: "Quick question", body: "<p>hi</p>" })
    );
    expect(result.output).toEqual({ draftId: "draft-1", subject: "Quick question", status: "pending_review" });
  });

  it("throws a clear error when prospectId is missing", async () => {
    await expect(
      aiActionNodeHandler({
        db: {} as never,
        config,
        workspaceId: "ws-1",
        runId: "run-1",
        isSimulation: false,
        node: { id: "n1", type: "action_ai", config: { prompt: "Follow up" } },
        priorOutputs: {},
      })
    ).rejects.toThrow(/prospectId/);
    expect(generateEmail).not.toHaveBeenCalled();
  });

  it("throws a clear error when prompt is missing or blank", async () => {
    await expect(
      aiActionNodeHandler({
        db: {} as never,
        config,
        workspaceId: "ws-1",
        runId: "run-1",
        isSimulation: false,
        node: { id: "n1", type: "action_ai", config: { prospectId: "p-1", prompt: "   " } },
        priorOutputs: {},
      })
    ).rejects.toThrow(/prompt/);
    expect(generateEmail).not.toHaveBeenCalled();
  });

  it("skips generation and persistence in simulation mode", async () => {
    const result = await aiActionNodeHandler({
      db: {} as never,
      config,
      workspaceId: "ws-1",
      runId: "run-1",
      isSimulation: true,
      node: { id: "n1", type: "action_ai", config: { prospectId: "p-1", prompt: "Follow up" } },
      priorOutputs: {},
    });
    expect(generateEmail).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
    expect(result.output.simulated).toBe(true);
  });
});
