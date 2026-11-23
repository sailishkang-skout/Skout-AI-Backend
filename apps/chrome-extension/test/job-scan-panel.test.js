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

import { jobScanLiveText, runItemText, workflowSteps } from "../capture-panel.js";

describe("scan controls and workflow steps in the panel", () => {
  it("disables Start while any scan runs, and names it", () => {
    expect(jobScanButtonState({ tab: company("acme"), active: { name: "Globex" } })).toMatchObject({ disabled: true, reason: expect.stringMatching(/job scan for Globex is running/) });
  });

  it("shows what the running scan has found, skipped and failed", () => {
    expect(jobScanLiveText({ name: "Acme", text: "verification scan, results page 3", found: 75, expected: 240, skipped: 2, failed: 1 }))
      .toBe("Acme: verification scan, results page 3 · 75 of about 240 found · 2 skipped · 1 failed");
    expect(jobScanLiveText(null)).toBe("");
  });

  it("lists the four steps with their own status, counts and errors", () => {
    const steps = workflowSteps({ workflow: true, step: "people", status: "running", stepDetail: {
      company: { status: "done" }, jobs: { status: "partial", found: 40, updated: 3, failed: 1, note: "60 remaining" },
      people: { status: "running", captured: 250, duplicates: 12 },
    } });
    expect(steps.map((step) => [step.key, step.status])).toEqual([["company", "done"], ["jobs", "partial"], ["people", "running"], ["verify", "pending"]]);
    expect(steps[1].text).toBe("40 found · 3 updated · 1 failed — 60 remaining");
    expect(steps[2]).toMatchObject({ current: true, text: "250 captured · 12 duplicates" });
    expect(workflowSteps({ status: "running" })).toEqual([]);
  });

  it("says which step a company is on, and does not call it complete until it is verified", () => {
    expect(runItemText({ workflow: true, step: "jobs", status: "running" })).toBe("Step 2 of 4 · Job roles · working…");
    expect(runItemText({ workflow: true, step: "company", status: "review" })).toBe("Step 1 of 4 · Company profile · review and save above");
    expect(runItemText({ workflow: true, step: "verify", status: "done" })).toBe("Complete · verified in the workspace");
    expect(runItemText({ workflow: true, step: "verify", status: "done", moreRemain: true })).toMatch(/more people remaining/);
    expect(runItemText({ workflow: true, step: "people", status: "failed", error: "No people" })).toBe("Stopped at Employees: No people");
  });
});
