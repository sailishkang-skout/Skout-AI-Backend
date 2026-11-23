import { describe, expect, it } from "vitest";
import { jobScanButtonState, jobScanCountsText, jobScanCheckpointKey, jobScanStatusLabel } from "../capture-panel.js";

const company = (slug) => ({ id: 5, kind: "company", url: `https://www.linkedin.com/company/${slug}/jobs/` });

describe("the Scan job roles button", () => {
  it("works for any company page, taking the company from the page that is open", () => {
    for (const slug of ["meta", "acme-corp", "10667"]) {
      expect(jobScanButtonState({ tab: company(slug) })).toMatchObject({ companyId: slug, disabled: false, label: "Scan job roles", reason: "" });
    }
  });

  it("is not blocked by an unsaved review of another company, only by a real conflict, and says why", () => {
    const tab = company("acme");
    const now = Date.now();
    expect(jobScanButtonState({ tab, progress: { active: true, at: now }, now }).reason).toMatch(/Another capture or scan is running/);
    // A progress record nobody has updated for minutes is a stuck one: it does not block the button.
    expect(jobScanButtonState({ tab, progress: { active: true, at: now - 10 * 60 * 1000 }, now }).disabled).toBe(false);
    expect(jobScanButtonState({ tab, halt: { reason: "LinkedIn warned" } })).toMatchObject({ disabled: true, reason: expect.stringMatching(/LinkedIn showed a warning/) });
    expect(jobScanButtonState({ tab, saving: true }).disabled).toBe(true);
    expect(jobScanButtonState({ tab: { id: 1, kind: "person", url: "https://www.linkedin.com/in/jo/" } })).toMatchObject({ disabled: true, reason: expect.stringMatching(/Open a company page/) });
    expect(jobScanButtonState({ tab: null }).disabled).toBe(true);
  });

  it("offers to resume when the last scan of this company did not finish", () => {
    expect(jobScanButtonState({ tab: company("acme"), checkpoint: { nextStart: 50 } }).label).toBe("Resume job scan");
    expect(jobScanCheckpointKey("acme")).toBe("skoutJobScanCheckpoint:acme");
  });
});

describe("what a scan reports", () => {
  it("shows captured, new, updated, skipped, failed and remaining counts", () => {
    expect(jobScanCountsText({ jobsFound: 180, jobsNew: 12, jobsUpdated: 3, counts: { found: 180, expected: 240, skipped: 2, failed: 1, remaining: 4, resumed: true } }))
      .toBe("180 of 240 roles captured · 12 new · 3 updated · 2 skipped (another company) · 1 failed · 60 remaining · resumed");
    expect(jobScanCountsText({ jobsFound: 1, counts: { found: 1 } })).toBe("1 role captured");
    expect(jobScanCountsText(null)).toBe("");
  });

  it("calls a scan complete only when every pass finished", () => {
    expect(jobScanStatusLabel({ status: "completed", jobs: [{}], passes: [{ complete: true }, { complete: false }] })).toBe("Partial capture");
    expect(jobScanStatusLabel({ status: "completed", jobs: [{}], passes: [{ complete: true }, { complete: true }] })).toBe("Completed & verified");
  });
});
