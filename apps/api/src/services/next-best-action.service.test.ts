import { describe, expect, it, vi, beforeEach } from "vitest";

const mockCreate = vi.fn();
vi.mock("openai", () => ({
  OpenAI: vi.fn().mockImplementation(() => ({
    chat: { completions: { create: mockCreate } },
  })),
}));
vi.mock("./evidence.service.js", () => ({
  recordEvidence: vi.fn().mockResolvedValue({ id: "evidence-1" }),
}));
vi.mock("./signal.service.js", () => ({
  listSignalsForEntity: vi.fn().mockResolvedValue([]),
}));

import { suggestNextBestAction } from "./next-best-action.service.js";
import type { Env } from "../config/env.js";

const config = { OPENROUTER_API_KEY: "test-key" } as unknown as Env;

/** Minimal DB stub for gatherContext's "deal" path (deal -> no company -> activities -> tasks;
 * the contact-only branches — meeting lookup, sourceProspectId/score/signal lookup — never run
 * since contactId stays null for a deal). */
function makeDb(dealRow: Record<string, unknown> | undefined) {
  const results = [[dealRow].filter(Boolean), [], []]; // deal, activities, tasks
  let call = 0;
  const select = vi.fn().mockImplementation(() => {
    const result = results[Math.min(call, results.length - 1)];
    call++;
    const chain: Record<string, unknown> = {};
    chain.from = vi.fn().mockReturnValue(chain);
    chain.where = vi.fn().mockReturnValue(chain);
    chain.orderBy = vi.fn().mockReturnValue(chain);
    chain.limit = vi.fn().mockResolvedValue(result);
    return chain;
  });
  return { select } as never;
}

describe("suggestNextBestAction — §6.0 delegation to intelligence-layer.service.ts", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns a suggestion parsed via the shared Intelligence Layer step-6 function", async () => {
    mockCreate.mockResolvedValue({
      choices: [
        {
          message: {
            content: JSON.stringify({
              actionType: "call",
              headline: "Call about the paused pilot",
              rationale: "No activity in 14 days",
            }),
          },
        },
      ],
    });
    const db = makeDb({ id: "deal-1", name: "Acme Deal", status: "open", amount: 1000, currency: "USD", companyId: null });

    const result = await suggestNextBestAction(db, config, "ws-1", "deal", "deal-1");

    expect(result).not.toBeNull();
    expect(result?.suggestion).toEqual({
      actionType: "call",
      headline: "Call about the paused pilot",
      rationale: "No activity in 14 days",
      draftMessage: undefined,
    });
  });

  it("falls back to a wait suggestion when the model returns malformed JSON — proves the shared parser's fallback still wires through", async () => {
    mockCreate.mockResolvedValue({ choices: [{ message: { content: "not valid json" } }] });
    const db = makeDb({ id: "deal-1", name: "Acme Deal", status: "open", amount: 1000, currency: "USD", companyId: null });

    const result = await suggestNextBestAction(db, config, "ws-1", "deal", "deal-1");

    expect(result?.suggestion.actionType).toBe("wait");
    expect(result?.suggestion.headline).toBe("Could not parse a suggestion");
  });

  it("returns null when the entity doesn't exist, without calling the LLM", async () => {
    const db = makeDb(undefined);

    const result = await suggestNextBestAction(db, config, "ws-1", "deal", "missing-deal");

    expect(result).toBeNull();
    expect(mockCreate).not.toHaveBeenCalled();
  });
});
