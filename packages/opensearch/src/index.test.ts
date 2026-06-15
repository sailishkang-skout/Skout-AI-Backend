import { describe, expect, it } from "vitest";
import { buildSearchQuery } from "./index.js";

describe("buildSearchQuery", () => {
  it("returns match_all when no filters", () => {
    const q = buildSearchQuery({}, 1, 10);
    expect(q.size).toBe(10);
    expect(q.from).toBe(0);
    expect(q.query.bool.must).toEqual([{ match_all: {} }]);
  });

  it("adds term filters and multi_match for query text", () => {
    const q = buildSearchQuery(
      { query: "acme", industry: "Software", country: "US", minEmployees: 50 },
      2,
      25
    );
    expect(q.from).toBe(25);
    expect(q.query.bool.must).toHaveLength(1);
    expect(q.query.bool.filter).toEqual(
      expect.arrayContaining([
        { term: { industry: "Software" } },
        { term: { country: "US" } },
        { range: { employeeCount: { gte: 50 } } },
      ])
    );
  });
});
