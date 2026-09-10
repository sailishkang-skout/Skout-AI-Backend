import { describe, expect, it } from "vitest";
import { mapEmailIntelObservationToCanonical } from "./email-intel-evidence-map.js";

describe("mapEmailIntelObservationToCanonical", () => {
  it("maps SUCCESS observation with high confidence", () => {
    const row = mapEmailIntelObservationToCanonical("ws-1", {
      email: "A@B.com",
      domain: "b.com",
      source: "SMTP",
      outcome: "SUCCESS",
      mailboxExists: true,
      externalId: "ext-1",
    });
    expect(row.workspaceId).toBe("ws-1");
    expect(row.entityType).toBe("email");
    expect(row.entityId).toBe("a@b.com");
    expect(row.confidence).toBe(0.9);
    expect(row.method).toBe("email_intel_ledger_merge");
    expect((row.value as { emailIntelExternalId: string }).emailIntelExternalId).toBe("ext-1");
  });
});
