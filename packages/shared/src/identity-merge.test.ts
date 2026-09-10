import { describe, expect, it } from "vitest";
import { MERGE_PROPOSAL_MIN_SCORE, jaroWinkler, scoreCandidateMatch } from "./identity-merge.js";

describe("jaroWinkler", () => {
  it("returns 1 for identical strings (case/whitespace-insensitive)", () => {
    expect(jaroWinkler("Acme Corp", "  acme corp ")).toBe(1);
  });

  it("returns 0 when either string is empty", () => {
    expect(jaroWinkler("", "Acme")).toBe(0);
    expect(jaroWinkler("Acme", "")).toBe(0);
  });

  it("scores near-matches higher than unrelated strings", () => {
    const nearMatch = jaroWinkler("Jonathan Smith", "Jon Smith");
    const unrelated = jaroWinkler("Jonathan Smith", "Priya Patel");
    expect(nearMatch).toBeGreaterThan(unrelated);
  });

  it("gives typo-distance names a high but non-1 score", () => {
    const score = jaroWinkler("Micheal Chen", "Michael Chen");
    expect(score).toBeGreaterThan(0.9);
    expect(score).toBeLessThan(1);
  });
});

describe("scoreCandidateMatch", () => {
  it("scores an exact match at 1", () => {
    const candidate = { name: "Jordan Lee", domain: "acme.com", title: "VP Sales", location: "Austin, TX" };
    const { score } = scoreCandidateMatch(candidate, { ...candidate });
    expect(score).toBe(1);
  });

  it("ignores signals missing from either side rather than penalizing to zero", () => {
    const { score, signals } = scoreCandidateMatch({ name: "Jordan Lee" }, { name: "Jordan Lee" });
    expect(score).toBe(1);
    expect(signals).toHaveLength(1);
    expect(signals[0].signal).toBe("name");
  });

  it("returns a score of 0 when no comparable signals exist on either side", () => {
    const { score, signals } = scoreCandidateMatch({}, { title: "VP Sales" });
    expect(score).toBe(0);
    expect(signals).toHaveLength(0);
  });

  it("scores an unrelated pair below the merge-proposal threshold", () => {
    const { score } = scoreCandidateMatch(
      { name: "Jordan Lee", domain: "acme.com" },
      { name: "Priya Patel", domain: "globex.com" }
    );
    expect(score).toBeLessThan(MERGE_PROPOSAL_MIN_SCORE);
  });

  it("scores a clear match above the merge-proposal threshold", () => {
    const { score } = scoreCandidateMatch(
      { name: "Jordan Lee", domain: "acme.com", title: "VP Sales" },
      { name: "Jordan A. Lee", domain: "acme.com", title: "VP of Sales" }
    );
    expect(score).toBeGreaterThanOrEqual(MERGE_PROPOSAL_MIN_SCORE);
  });

  it("domain comparison is exact-match only, not fuzzy", () => {
    const { signals } = scoreCandidateMatch({ domain: "acme.com" }, { domain: "acme.co" });
    const domainSignal = signals.find((s) => s.signal === "domain");
    expect(domainSignal?.contribution).toBe(0);
  });
});
