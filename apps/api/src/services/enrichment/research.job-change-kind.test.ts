import { describe, expect, it } from "vitest";
import { classifyJobChange } from "./research.service.js";

const role = (company: string | null, title: string | null = null) => ({ company, title });

describe("classifyJobChange", () => {
  it("does not call someone gone when the new role was not captured", () => {
    // Sahil: Skout AI before, nothing recorded after, and the latest capture still lists Skout AI.
    expect(classifyJobChange(role("Skout AI", "AI Forward Deployed Engineer (FDE)"), role(null), ["Skout AI"])).toBe("no_change");
    // No current employers read at all: no evidence of leaving.
    expect(classifyJobChange(role("Skout AI"), role(null), [])).toBe("no_change");
  });

  it("is not a move when before and now are the same company and title", () => {
    expect(classifyJobChange(role("Skout AI", "FDE"), role("Skout AI + 1 more", "FDE"))).toBe("no_change");
    expect(classifyJobChange(role("Skout AI", "FDE"), role("Skout AI"))).toBe("no_change");
  });

  it("reports a left company only when the latest capture names other current employers", () => {
    expect(classifyJobChange(role("Hooli"), role(null), ["Initech"])).toBe("left_company");
  });

  it("still reports a new company and a new role", () => {
    expect(classifyJobChange(role("Hooli", "AE"), role("Initech", "AE"))).toBe("new_company");
    expect(classifyJobChange(role("Initech", "AE"), role("Initech", "Sales Manager"))).toBe("new_role");
  });
});
