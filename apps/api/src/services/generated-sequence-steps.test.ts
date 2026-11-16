import { describe, expect, it } from "vitest";
import { normalizeGeneratedSteps } from "./generated-sequence-steps.js";

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
