import { describe, expect, it, vi } from "vitest";
import { createDashboardService } from "./dashboard.service.js";
import type { Env } from "../config/env.js";

const CONFIG = {} as Env;

function whereResolves(result: unknown[]) {
  const c: Record<string, unknown> = {};
  c.from = vi.fn().mockReturnValue(c);
  c.where = vi.fn().mockResolvedValue(result);
  return c;
}

function groupByResolves(result: unknown[]) {
  const c: Record<string, unknown> = {};
  c.from = vi.fn().mockReturnValue(c);
  c.where = vi.fn().mockReturnValue(c);
  c.groupBy = vi.fn().mockResolvedValue(result);
  return c;
}

describe("DashboardService.getFunnel", () => {
  it("returns all-zero counts with no queries when db is unavailable", async () => {
    const svc = createDashboardService(null, CONFIG);
    const result = await svc.getFunnel("ws-1");
    expect(result).toEqual({ discovered: 0, enriched: 0, inSequence: 0, replied: 0, activeInSequence: 0 });
  });

  it("aggregates discovered/enriched/inSequence/replied/activeInSequence from their respective tables", async () => {
    const db = {
      select: vi
        .fn()
        .mockReturnValueOnce(whereResolves([{ discovered: 12 }]))
        .mockReturnValueOnce(
          groupByResolves([
            { action: "enrichment", total: 5 },
            { action: "ai_score", total: 2 },
            { action: "search", total: 9 }, // not enrichment — must not be counted
          ])
        )
        .mockReturnValueOnce(whereResolves([{ inSequence: 8 }]))
        .mockReturnValueOnce(whereResolves([{ replied: 3 }]))
        .mockReturnValueOnce(whereResolves([{ activeInSequence: 20 }])),
    };

    const svc = createDashboardService(db as never, CONFIG);
    const result = await svc.getFunnel("ws-1");

    expect(result).toEqual({ discovered: 12, enriched: 7, inSequence: 8, replied: 3, activeInSequence: 20 });
  });
});
