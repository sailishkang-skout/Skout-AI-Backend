import { describe, expect, it } from "vitest";
import { acrossRuns, percentile, rng, summarize } from "./stats.js";

describe("stats", () => {
  it("uses nearest-rank percentiles", () => {
    const s = Array.from({ length: 100 }, (_, i) => i + 1);
    expect(percentile(s, 50)).toBe(50);
    expect(percentile(s, 95)).toBe(95);
    expect(percentile(s, 99)).toBe(99);
    expect(percentile(s, 100)).toBe(100);
    expect(percentile([7], 95)).toBe(7);
    expect(percentile([], 95)).toBeNaN();
  });

  it("summarizes unsorted samples", () => {
    const r = summarize([5, 1, 9, 3, 7]);
    expect(r).toMatchObject({ n: 5, min: 1, max: 9, p50: 5, mean: 5 });
  });

  it("produces the same sequence for the same seed and a different one otherwise", () => {
    const a = rng(1);
    const b = rng(1);
    const c = rng(2);
    const first = [a(), a(), a()];
    expect([b(), b(), b()]).toEqual(first);
    expect([c(), c(), c()]).not.toEqual(first);
    expect(first.every((x) => x >= 0 && x < 1)).toBe(true);
  });

  it("reports min / median / max across repeated runs", () => {
    expect(acrossRuns([12, 10, 11])).toEqual({ min: 10, median: 11, max: 12 });
  });
});
