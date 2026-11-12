import { describe, expect, it } from "vitest";
import { buildSearchQuery } from "@skout/opensearch";
import { capturedPersonDocument, isLinkedinCapture } from "./capture-search-index.js";

describe("capturedPersonDocument", () => {
  it("maps a captured profile into a shared search document", () => {
    const doc = capturedPersonDocument(
      "p-1",
      "c-1",
      {
        fullName: "Sahil Sawal",
        headline: "Software Engineer at Uber",
        companyName: "Uber",
        companyDomain: "uber.com",
        currentCompanies: [{ name: "Uber", title: "Software Engineer" }],
        previousCompanies: [{ name: "Lyft" }, { name: "Google" }],
        educations: [{ school: "IIT Delhi" }],
        skills: [{ name: "TypeScript", endorsements: 4 }],
        locationName: "Bengaluru, Karnataka, India",
        linkedinUrl: "https://www.linkedin.com/in/sahil/",
        email: "s@example.com",
      },
      new Date("2026-11-12T00:00:00Z")
    );
    expect(doc).toMatchObject({
      dataSource: "linkedin_capture",
      title: "Software Engineer",
      companyName: "Uber",
      previousCompany: "Lyft, Google",
      schools: ["IIT Delhi"],
      skills: ["TypeScript"],
      city: "Bengaluru",
      country: "India",
      email: "s@example.com",
    });
    expect(doc).not.toHaveProperty("workspaceId");
  });

  it("recognises captured snapshots only", () => {
    expect(isLinkedinCapture({ captureSource: "linkedin-public-profile" })).toBe(true);
    expect(isLinkedinCapture({ linkedinPublicId: "sahil" })).toBe(true);
    expect(isLinkedinCapture({ fullName: "Imported" })).toBe(false);
  });
});

describe("search", () => {
  it("finds captures from every workspace and searches skills and schools", () => {
    const q = JSON.stringify(buildSearchQuery({ query: "typescript", dataSource: ["vendor", "linkedin_capture"] }));
    expect(q).not.toContain("workspaceId");
    expect(q).toContain('"terms":{"dataSource":["vendor","linkedin_capture"]}');
    expect(q).toContain('"skills"');
    expect(q).toContain('"schools"');
  });
});
