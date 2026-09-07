import { describe, expect, it } from "vitest";
import { crmSyncOwnedPatch } from "./crm-sync-fields.js";

describe("crmSyncOwnedPatch", () => {
  it("keeps only CRM-sync-owned fields for a contact", () => {
    const out = crmSyncOwnedPatch("contact", {
      firstName: "Ada",
      retentionClassification: "healthy",
      title: "Engineer",
    });
    expect(out).toEqual({ firstName: "Ada", title: "Engineer" });
  });

  it("keeps only CRM-sync-owned fields for a deal", () => {
    const out = crmSyncOwnedPatch("deal", { amount: "1000", stageId: "stage-1" });
    expect(out).toEqual({ amount: "1000" });
  });

  it("returns an empty object when nothing in the patch is owned", () => {
    expect(crmSyncOwnedPatch("contact", { companyId: "c-1" })).toEqual({});
  });

  it("returns an empty object for an empty patch", () => {
    expect(crmSyncOwnedPatch("deal", {})).toEqual({});
  });
});
