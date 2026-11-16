import { describe, expect, it } from "vitest";
import { describeSeedStatus, missingFrom, seedForced, seedStatusComplete } from "./seed-guard.js";

describe("seedForced", () => {
  it("is off unless FORCE_SEED is explicitly truthy", () => {
    expect(seedForced({})).toBe(false);
    expect(seedForced({ FORCE_SEED: "" })).toBe(false);
    expect(seedForced({ FORCE_SEED: "0" })).toBe(false);
    expect(seedForced({ FORCE_SEED: "false" })).toBe(false);
  });

  it("accepts 1 / true / yes in any case", () => {
    for (const v of ["1", "true", "TRUE", " yes "]) expect(seedForced({ FORCE_SEED: v })).toBe(true);
  });
});

describe("missingFrom", () => {
  it("returns only what is absent, once each, in order", () => {
    expect(missingFrom(["a", "b", "c", "b", "d"], new Set(["a", "d"]))).toEqual(["b", "c"]);
  });

  it("returns nothing when everything is present", () => {
    expect(missingFrom(["a", "b"], new Set(["a", "b", "extra"]))).toEqual([]);
  });
});

describe("seed status", () => {
  const complete = [
    { label: "regions", expected: 19, missing: 0 },
    { label: "countries", expected: 250, missing: 0 },
  ];

  it("is complete only when nothing is missing anywhere", () => {
    expect(seedStatusComplete(complete)).toBe(true);
    expect(seedStatusComplete([...complete, { label: "tam", expected: 5000, missing: 1 }])).toBe(false);
  });

  it("describes progress for the deploy log", () => {
    expect(describeSeedStatus([...complete, { label: "tam", expected: 5000, missing: 120 }])).toBe(
      "regions 19/19, countries 250/250, tam 4880/5000"
    );
  });
});
