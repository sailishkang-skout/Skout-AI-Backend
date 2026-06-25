import { describe, expect, it } from "vitest";
import { companyToProspectDoc, recordsToDocs, buildBulkBatch } from "./index.js";

describe("ingestor", () => {
  it("maps company candidates to prospect documents with hiring + firmographics", () => {
    const doc = companyToProspectDoc({
      domain: "Acme.com",
      companyName: "Acme",
      employeeCount: 120,
      employeeBucket: "51-200",
      isHiring: true,
      foundedDate: "2015-01-01",
      companyStage: "series_b",
      scrapedAt: "2026-01-01T00:00:00.000Z",
      source: "company-web",
    });
    expect(doc.companyDomain).toBe("acme.com");
    expect(doc.companyName).toBe("Acme");
    expect(doc.currentlyHiring).toBe(true);
    expect(doc.foundedYear).toBe(2015);
    expect(doc.employeeBucket).toBe("51-200");
  });

  it("recordsToDocs handles mixed records", () => {
    const docs = recordsToDocs([
      { domain: "foo.com", companyName: "Foo", scrapedAt: "2026-01-01T00:00:00.000Z", source: "company-web" },
      {
        companyDomain: "bar.com",
        fullName: "Jane",
        scrapedAt: "2026-01-01T00:00:00.000Z",
        source: "linkedin",
      },
    ]);
    expect(docs).toHaveLength(2);
  });

  it("deduplicates bulk batch by prospect id", () => {
    const { docs, summary } = buildBulkBatch([
      {
        companyDomain: "dup.com",
        fullName: "A",
        email: "a@dup.com",
        scrapedAt: "2026-01-01T00:00:00.000Z",
        source: "linkedin",
      },
      {
        companyDomain: "dup.com",
        fullName: "A",
        email: "a@dup.com",
        scrapedAt: "2026-01-01T00:00:00.000Z",
        source: "linkedin",
      },
    ]);
    expect(docs).toHaveLength(1);
    expect(summary.skippedDuplicate).toBe(1);
  });
});
