import { describe, expect, it } from "vitest";
import { buildCopsAuditRecord, CopsAuditValidationError, type CopsAuditInput } from "./cops-audit.js";

/** Acceptance: "Overrides cannot save without a reason; audit asserted in tests." */
const base: CopsAuditInput = {
  tenantId: "bb214f11-bdb4-4012-add2-dd471a078981",
  actor: { type: "user", id: "6c118a84-68e0-49d2-a386-3fbf6741d4d1" },
  entityType: "lifecycle.commercial",
  entityId: "opp_1",
  action: "transition",
  correlationId: "corr_1",
  sourceChannel: "api",
  override: true,
};

describe("manual overrides require a reason", () => {
  it.each([
    ["missing", undefined],
    ["null", null],
    ["empty", ""],
    ["whitespace only", "   "],
  ])("rejects an override with a %s reason", (_label, reason) => {
    expect(() => buildCopsAuditRecord({ ...base, reason })).toThrow(CopsAuditValidationError);
    try {
      buildCopsAuditRecord({ ...base, reason });
    } catch (err) {
      expect((err as CopsAuditValidationError).field).toBe("reason");
    }
  });

  it("saves an override that has a reason, keeping the reason and override flag on the record", () => {
    const record = buildCopsAuditRecord({ ...base, reason: "Customer escalation approved by CFO" });
    expect(record.override).toBe(true);
    expect(record.reason).toBe("Customer escalation approved by CFO");
  });

  it("does not require a reason for an ordinary, non-override change", () => {
    expect(() => buildCopsAuditRecord({ ...base, override: false, reason: null })).not.toThrow();
  });
});
