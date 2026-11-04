import { describe, expect, it, vi } from "vitest";
import {
  evaluateFieldConflict,
  isProtectedField,
  recordCrmConflict,
  resolveCrmConflict,
} from "./crm-conflict.service.js";

describe("Protected fields", () => {
  it("recognizes protected system-derived fields", () => {
    expect(isProtectedField("lifecycleStage")).toBe(true);
    expect(isProtectedField("commercialState")).toBe(true);
    expect(isProtectedField("healthScore")).toBe(true);
    expect(isProtectedField("accountStatus")).toBe(true);
    expect(isProtectedField("autoApproved")).toBe(true);
    expect(isProtectedField("riskScore")).toBe(true);
  });

  it("recognizes non-protected syncable fields", () => {
    expect(isProtectedField("firstName")).toBe(false);
    expect(isProtectedField("lastName")).toBe(false);
    expect(isProtectedField("email")).toBe(false);
    expect(isProtectedField("phone")).toBe(false);
    expect(isProtectedField("amount")).toBe(false);
  });
});

describe("evaluateFieldConflict — 4 policies", () => {
  it("never overwrites protected fields regardless of policy", () => {
    const decision = evaluateFieldConflict({
      fieldName: "lifecycleStage",
      skoutValue: "lead",
      externalValue: "customer",
      policy: "external_wins",
      isFieldProtected: true,
    });
    expect(decision.action).toBe("keep_skout");
    expect(decision.reason).toContain("protected system-derived field");
  });

  it("keeps Skout value when values are already identical", () => {
    const decision = evaluateFieldConflict({
      fieldName: "title",
      skoutValue: "CTO",
      externalValue: " CTO ",
      policy: "external_wins",
    });
    expect(decision.action).toBe("keep_skout");
    expect(decision.reason).toBe("Values are identical");
  });

  it("applies external value when Skout has no value", () => {
    const decision = evaluateFieldConflict({
      fieldName: "phone",
      skoutValue: null,
      externalValue: "+1-555-0100",
      policy: "skout_wins",
    });
    expect(decision.action).toBe("apply_external");
  });

  it("keeps Skout value when external value is empty", () => {
    const decision = evaluateFieldConflict({
      fieldName: "phone",
      skoutValue: "+1-555-0100",
      externalValue: "",
      policy: "external_wins",
    });
    expect(decision.action).toBe("keep_skout");
  });

  it("skout_wins policy keeps Skout value", () => {
    const decision = evaluateFieldConflict({
      fieldName: "title",
      skoutValue: "VP Engineering",
      externalValue: "Chief Architect",
      policy: "skout_wins",
    });
    expect(decision.action).toBe("keep_skout");
    expect(decision.reason).toBe("Policy is skout_wins");
  });

  it("external_wins policy applies incoming external value", () => {
    const decision = evaluateFieldConflict({
      fieldName: "title",
      skoutValue: "VP Engineering",
      externalValue: "Chief Architect",
      policy: "external_wins",
    });
    expect(decision.action).toBe("apply_external");
    expect(decision.reason).toBe("Policy is external_wins");
  });

  it("most_recent policy picks the newer edit", () => {
    const earlier = new Date("2026-01-01T10:00:00Z");
    const later = new Date("2026-01-01T12:00:00Z");

    // External is newer
    const extNewer = evaluateFieldConflict({
      fieldName: "amount",
      skoutValue: "1000",
      externalValue: "2000",
      skoutUpdatedAt: earlier,
      externalUpdatedAt: later,
      policy: "most_recent",
    });
    expect(extNewer.action).toBe("apply_external");
    expect(extNewer.reason).toContain("External edit is newer");

    // Skout is newer
    const skoutNewer = evaluateFieldConflict({
      fieldName: "amount",
      skoutValue: "3000",
      externalValue: "2000",
      skoutUpdatedAt: later,
      externalUpdatedAt: earlier,
      policy: "most_recent",
    });
    expect(skoutNewer.action).toBe("keep_skout");
    expect(skoutNewer.reason).toContain("Skout edit is newer or equal");
  });

  it("manual_review policy blocks overwrite when values differ", () => {
    const decision = evaluateFieldConflict({
      fieldName: "amount",
      skoutValue: "10000",
      externalValue: "15000",
      policy: "manual_review",
    });
    expect(decision.action).toBe("manual_review");
    expect(decision.reason).toContain("manual_review and values differ");
  });
});
