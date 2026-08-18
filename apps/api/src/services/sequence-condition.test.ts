import { describe, expect, it } from "vitest";
import {
  assignExperimentVariant,
  evaluateConditionExpression,
  expressionFromSingle,
  parseConditionExpression,
} from "./sequence-condition.js";

describe("assignExperimentVariant", () => {
  it("is deterministic for the same prospect + experiment", () => {
    const a = assignExperimentVariant("exp-1", "prospect-42");
    const b = assignExperimentVariant("exp-1", "prospect-42");
    expect(a).toBe(b);
  });

  it("splits roughly 50/50 across many prospects", () => {
    let a = 0;
    let b = 0;
    for (let i = 0; i < 400; i++) {
      if (assignExperimentVariant("exp-split", `p-${i}`) === "A") a++;
      else b++;
    }
    expect(a).toBeGreaterThan(140);
    expect(b).toBeGreaterThan(140);
  });
});

describe("evaluateConditionExpression", () => {
  it("evaluates AND / OR / NOT", async () => {
    const expr = parseConditionExpression({
      op: "and",
      clauses: [
        { type: "linkedin_invite_accepted" },
        { op: "or", clauses: [{ type: "email_opened" }, { type: "email_clicked" }] },
        { type: "has_email", not: true },
      ],
    });
    expect(expr).not.toBeNull();
    const result = await evaluateConditionExpression(expr!, async (type) => {
      if (type === "linkedin_invite_accepted") return true;
      if (type === "email_opened") return false;
      if (type === "email_clicked") return true;
      if (type === "has_email") return false;
      return false;
    });
    expect(result.passed).toBe(true);
  });

  it("expressionFromSingle wraps a leaf", () => {
    expect(expressionFromSingle("email_replied")).toEqual({ type: "email_replied" });
  });

  it("parses and threads value through the engagement-count leaf types", async () => {
    const expr = parseConditionExpression({ type: "email_opened_count_gte", value: 5 });
    expect(expr).toEqual({ type: "email_opened_count_gte", value: 5 });
    const result = await evaluateConditionExpression(expr!, async (type, value) => {
      expect(type).toBe("email_opened_count_gte");
      expect(value).toBe(5);
      return true;
    });
    expect(result.passed).toBe(true);
  });

  it("rejects an unknown leaf type", () => {
    expect(parseConditionExpression({ type: "not_a_real_condition" })).toBeNull();
  });
});
