import { describe, expect, it } from "vitest";
import { buildSearchQuery } from "@skout/opensearch";
import { capturedDocId, capturedPersonDocument, isLinkedinCapture } from "./capture-search-index.js";

describe("capturedPersonDocument", () => {
  it("maps a captured profile into a workspace-private search document", () => {
    const doc = capturedPersonDocument(
      "ws-1",
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
      workspaceId: "ws-1",
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
    expect(capturedDocId("ws-1", "p-1")).toBe("capture:ws-1:p-1");
  });

  it("recognises captured snapshots only", () => {
    expect(isLinkedinCapture({ captureSource: "linkedin-public-profile" })).toBe(true);
    expect(isLinkedinCapture({ linkedinPublicId: "sahil" })).toBe(true);
    expect(isLinkedinCapture({ fullName: "Imported" })).toBe(false);
  });
});

describe("search visibility", () => {
  const filters = (q: unknown) => JSON.stringify(q);
  it("hides workspace-private documents without a workspace", () => {
    const q = filters(buildSearchQuery({ query: "uber" }));
    expect(q).toContain('"must_not":[{"exists":{"field":"workspaceId"}}]');
    expect(q).not.toContain('"term":{"workspaceId"');
  });
  it("includes the searching workspace's own captures and searches skills and schools", () => {
    const q = filters(buildSearchQuery({ query: "typescript", workspaceId: "ws-1", dataSource: ["vendor", "linkedin_capture"] }));
    expect(q).toContain('"term":{"workspaceId":"ws-1"}');
    expect(q).toContain('"terms":{"dataSource":["vendor","linkedin_capture"]}');
    expect(q).toContain('"skills"');
    expect(q).toContain('"schools"');
  });
});
