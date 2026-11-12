import { describe, expect, it, vi } from "vitest";

const bulkUpsert = vi.fn(async (_cfg: unknown, docs: unknown[]) => ({ ingested: docs.length, failed: 0 }));
vi.mock("@skout/opensearch", async (orig) => ({
  ...(await orig<typeof import("@skout/opensearch")>()),
  ensureCaptureFieldMappings: async () => undefined,
  bulkUpsertProspects: (cfg: unknown, docs: unknown[]) => bulkUpsert(cfg, docs),
}));

import { buildSearchQuery } from "@skout/opensearch";
import { capturedPersonDocument, indexCapturedPeople, isLinkedinCapture } from "./capture-search-index.js";

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

describe("indexCapturedPeople (global backfill)", () => {
  const row = (n: number, workspace: string) => ({
    prospectId: `p${n}`,
    companyId: null,
    snapshot: { fullName: `Person ${n}`, captureSource: "linkedin-public-profile", workspaceMarker: workspace },
    updatedAt: new Date("2026-11-12T00:00:00Z"),
  });

  it("with no workspace pages through every workspace's captures and indexes them all", async () => {
    const pages = [Array.from({ length: 500 }, (_, i) => row(i, i % 2 ? "w1" : "w2")), [row(900, "w3")]];
    const offsets: number[] = [];
    const chain = {
      from: () => chain,
      where: () => chain,
      orderBy: () => chain,
      limit: () => chain,
      offset: async (n: number) => {
        offsets.push(n);
        return pages.shift() ?? [];
      },
    };
    const db = { select: () => chain } as never;
    const res = await indexCapturedPeople(db, { url: "https://os.test" } as never, null);
    expect(res).toEqual({ indexed: 501, failed: 0 });
    expect(offsets).toEqual([0, 500]);
  });
});
