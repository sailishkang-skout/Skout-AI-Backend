import { describe, expect, it } from "vitest";
import {
  ensureGoalEnd,
  normalizeGeneratedSteps,
  requestedStepCount,
  validateSequenceStructure,
} from "./generated-sequence-steps.js";

describe("normalizeGeneratedSteps", () => {
  it("keeps condition steps and their yes/no branches instead of flattening them to emails", () => {
    const steps = normalizeGeneratedSteps([
      { stepType: "email", delayDays: 0, subject: "Hi", bodyTemplate: "<p>Hi</p>" },
      { stepType: "condition", delayDays: 0, conditionType: "email_opened", conditionWaitDays: 3 },
      { stepType: "email", delayDays: 1, branch: "yes", subject: "Saw you opened", bodyTemplate: "<p>a</p>" },
      { stepType: "linkedin", delayDays: 1, branch: "no", linkedinAction: "connect", bodyTemplate: "hey" },
      { stepType: "goal", delayDays: 0, goalLabel: "Meeting booked" },
    ]);

    expect(steps.map((s) => s.stepType)).toEqual(["email", "condition", "email", "linkedin", "goal"]);
    expect(steps[1]).toMatchObject({ conditionType: "email_opened", conditionWaitDays: 3 });
    expect(steps[1]!.subject).toBeUndefined();
    expect(steps[1]!.bodyTemplate).toBeUndefined();
    expect(steps[2]!.branch).toBe("yes");
    expect(steps[3]!.branch).toBe("no");
    expect(steps[4]!.goalLabel).toBe("Meeting booked");
  });

  it("keeps every step of a long sequence", () => {
    const raw = Array.from({ length: 14 }, (_, i) => ({ stepType: "email", delayDays: i === 0 ? 0 : 2 }));
    expect(normalizeGeneratedSteps(raw)).toHaveLength(14);
  });

  it("falls back to a valid condition type and drops branch labels with no preceding condition", () => {
    const steps = normalizeGeneratedSteps([
      { stepType: "email", delayDays: 0, branch: "yes" },
      { stepType: "condition", conditionType: "made_up" },
    ]);
    expect(steps[0]!.branch).toBeNull();
    expect(steps[1]!.conditionType).toBe("email_replied");
    expect(steps[1]!.conditionWaitDays).toBe(2);
  });

  it("fills placeholder copy only when fillDefaults is set", () => {
    const raw = [{ stepType: "email", delayDays: 0 }, { stepType: "wait", delayDays: 2 }];
    expect(normalizeGeneratedSteps(raw)[0]!.subject).toBeUndefined();
    const filled = normalizeGeneratedSteps(raw, { fillDefaults: true });
    expect(filled[0]!.subject).toBe("Quick question");
    expect(filled[0]!.bodyTemplate).toContain("{{unsubscribeUrl}}");
    expect(filled[1]!.bodyTemplate).toBeUndefined();
  });

  it("forces the first step to fire immediately and defaults later missing delays", () => {
    const steps = normalizeGeneratedSteps([{ stepType: "email", delayDays: 5 }, { stepType: "email" }]);
    expect(steps[0]!.delayDays).toBe(0);
    expect(steps[1]!.delayDays).toBe(3);
  });
});

describe("nested yes/no branches", () => {
  it("flattens a condition's yes/no lists into branch-tagged steps right after the condition", () => {
    const steps = normalizeGeneratedSteps([
      { stepType: "email", delayDays: 0, subject: "Hi", bodyTemplate: "<p>a</p>" },
      {
        stepType: "condition",
        conditionType: "email_opened",
        conditionWaitDays: 3,
        yes: [{ stepType: "email", delayDays: 1, subject: "Thanks for opening" }],
        no: [
          { stepType: "linkedin", delayDays: 1, linkedinAction: "connect" },
          { stepType: "email", delayDays: 3, subject: "Another angle" },
        ],
      },
      { stepType: "goal", goalLabel: "Meeting booked" },
    ]);
    expect(steps.map((s) => `${s.stepType}${s.branch ? "[" + s.branch + "]" : ""}`)).toEqual([
      "email",
      "condition",
      "email[yes]",
      "linkedin[no]",
      "email[no]",
      "goal",
    ]);
    expect(steps[1]).not.toHaveProperty("yes");
  });

  it("keeps working for the flat form with branch tags", () => {
    const steps = normalizeGeneratedSteps([
      { stepType: "condition", conditionType: "email_replied" },
      { stepType: "goal", branch: "yes", goalLabel: "Meeting booked" },
      { stepType: "email", branch: "no", subject: "Last try" },
    ]);
    expect(steps.map((s) => s.branch ?? null)).toEqual([null, "yes", "no"]);
  });

  it("does not nest conditions inside a branch: the inner condition is dropped and its steps stay in the branch", () => {
    const steps = normalizeGeneratedSteps([
      {
        stepType: "condition",
        conditionType: "email_opened",
        yes: [
          { stepType: "condition", conditionType: "email_clicked", yes: [{ stepType: "call" }], no: [{ stepType: "email", subject: "x" }] },
        ],
        no: [{ stepType: "email", subject: "y" }],
      },
    ]);
    expect(steps.filter((s) => s.stepType === "condition")).toHaveLength(1);
    expect(steps.map((s) => `${s.stepType}${s.branch ? "[" + s.branch + "]" : ""}`)).toEqual([
      "condition",
      "call[yes]",
      "email[yes]",
      "email[no]",
    ]);
  });
});

describe("validateSequenceStructure", () => {
  it("accepts conditions that have steps on both paths and a goal at the end", () => {
    const steps = normalizeGeneratedSteps([
      { stepType: "email" },
      { stepType: "condition", conditionType: "email_opened", yes: [{ stepType: "email" }], no: [{ stepType: "email" }] },
      { stepType: "goal" },
    ]);
    expect(validateSequenceStructure(steps)).toEqual([]);
  });

  it("reports a condition with no steps on one or both paths", () => {
    const steps = normalizeGeneratedSteps([
      { stepType: "email" },
      { stepType: "condition", conditionType: "email_opened" },
      { stepType: "email" },
      { stepType: "condition", conditionType: "email_replied", yes: [{ stepType: "goal" }] },
      { stepType: "goal" },
    ]);
    const problems = validateSequenceStructure(steps);
    expect(problems.some((p) => /step 2.*yes and no/i.test(p))).toBe(true);
    expect(problems.some((p) => /step 4.*no/i.test(p))).toBe(true);
  });

  it("reports a missing final goal", () => {
    const steps = normalizeGeneratedSteps([{ stepType: "email" }, { stepType: "email" }]);
    expect(validateSequenceStructure(steps).some((p) => /last step.*goal/i.test(p))).toBe(true);
  });
});

describe("ensureGoalEnd", () => {
  it("appends a goal when the sequence does not end on one", () => {
    const out = ensureGoalEnd(normalizeGeneratedSteps([{ stepType: "email" }]));
    expect(out.at(-1)).toMatchObject({ stepType: "goal", goalLabel: "Meeting booked", delayDays: 0 });
    expect(out.at(-1)!.branch ?? null).toBeNull();
  });

  it("leaves a sequence that already ends on a goal alone", () => {
    const steps = normalizeGeneratedSteps([{ stepType: "email" }, { stepType: "goal", goalLabel: "Demo booked" }]);
    expect(ensureGoalEnd(steps)).toEqual(steps);
  });
});

describe("requestedStepCount", () => {
  it("reads the step count the user asked for", () => {
    expect(requestedStepCount("Create a 15 step sequence to reach out to VPs")).toBe(15);
    expect(requestedStepCount("build a 12-step cadence")).toBe(12);
    expect(requestedStepCount("I want 8 steps with conditions")).toBe(8);
  });

  it("returns null when no count is given or it is implausible", () => {
    expect(requestedStepCount("Reach out to CFOs at banks")).toBeNull();
    expect(requestedStepCount("a 1 step sequence")).toBeNull();
    expect(requestedStepCount("a 99 step sequence")).toBeNull();
  });
});
