import { describe, expect, it, vi } from "vitest";
import { getEnrichmentEfficiency } from "./analytics.service.js";

function selectChain(rows: unknown[]) {
  const c: Record<string, unknown> = {};
  c.from = vi.fn().mockReturnValue(c);
  c.where = vi.fn().mockResolvedValue(rows);
  return c;
}

/** Mirrors analytics.service.ts's own local-calendar-date dayKey, so test expectations don't
 * depend on the runner's timezone matching UTC. */
function localDayKey(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

describe("getEnrichmentEfficiency", () => {
  it("returns a zero-filled series with no db calls when db is unavailable", async () => {
    const result = await getEnrichmentEfficiency(null, "ws-1", 3);
    expect(result).toHaveLength(3);
    expect(result.every((p) => p.spent === 0 && p.found === 0)).toBe(true);
  });

  it("buckets enrichment credit spend and valid-email counts per day", async () => {
    const today = new Date();
    const yesterday = new Date(today.getTime() - 86_400_000);
    const todayKey = localDayKey(today);
    const yesterdayKey = localDayKey(yesterday);

    const db = {
      select: vi
        .fn()
        .mockReturnValueOnce(
          selectChain([
            { amount: -50, createdAt: today },
            { amount: -20, createdAt: yesterday },
          ])
        )
        .mockReturnValueOnce(selectChain([{ createdAt: today }, { createdAt: today }])),
    };

    const result = await getEnrichmentEfficiency(db as never, "ws-1", 2);
    const byDate = new Map(result.map((p) => [p.date, p]));
    expect(byDate.get(todayKey)).toEqual({ date: todayKey, spent: 50, found: 2 });
    expect(byDate.get(yesterdayKey)).toEqual({ date: yesterdayKey, spent: 20, found: 0 });
  });

  it("ignores positive (top-up) credit_transactions rows when computing spend", async () => {
    const today = new Date();
    const db = {
      select: vi
        .fn()
        .mockReturnValueOnce(selectChain([{ amount: 100, createdAt: today }]))
        .mockReturnValueOnce(selectChain([])),
    };

    const result = await getEnrichmentEfficiency(db as never, "ws-1", 1);
    expect(result[0]!.spent).toBe(0);
  });
});
