import { describe, expect, it } from "vitest";
import { isVerifiedEmailStatus, snapshotFromCorpusDoc, stripUnverifiedEmail } from "./verified-email.js";

describe("verified-email", () => {
  it("strips email when not verified", () => {
    const out = stripUnverifiedEmail({
      prospectId: "p1",
      companyDomain: "acme.com",
      email: "jane@acme.com",
    });
    expect(out.email).toBeUndefined();
  });

  it("keeps email when status is valid", () => {
    const out = stripUnverifiedEmail({
      prospectId: "p1",
      companyDomain: "acme.com",
      email: "jane@acme.com",
      emailStatus: "valid",
    });
    expect(out.email).toBe("jane@acme.com");
  });

  it("does not copy corpus email into activation snapshots", () => {
    const snap = snapshotFromCorpusDoc({
      prospectId: "p1",
      companyId: "c1",
      companyDomain: "acme.com",
      fullName: "Jane",
      email: "jane@acme.com",
      linkedinUrl: "https://linkedin.com/in/jane",
    });
    expect(snap.email).toBeUndefined();
    expect(snap.linkedinUrl).toBe("https://linkedin.com/in/jane");
  });

  it("recognizes valid status", () => {
    expect(isVerifiedEmailStatus("valid")).toBe(true);
    expect(isVerifiedEmailStatus("invalid")).toBe(false);
  });
});
