import { describe, expect, it } from "vitest";
import {
  companyCandidateSchema,
  prospectCandidateSchema,
  scrapeJobRequestSchema,
  toEmployeeBucket,
} from "./index.js";

describe("scraper-contracts", () => {
  it("requires a domain on company candidates", () => {
    const result = companyCandidateSchema.safeParse({
      source: "company-web",
      scrapedAt: new Date().toISOString(),
    });
    expect(result.success).toBe(false);
  });

  it("accepts a minimal valid prospect candidate", () => {
    const result = prospectCandidateSchema.safeParse({
      source: "linkedin",
      companyDomain: "acme.com",
      scrapedAt: new Date().toISOString(),
    });
    expect(result.success).toBe(true);
  });

  it("defaults scrape job priority to normal", () => {
    const parsed = scrapeJobRequestSchema.parse({
      source: "company-web",
      seeds: ["acme.com"],
      options: {},
    });
    expect(parsed.options?.priority).toBe("normal");
  });

  it("maps employee counts to buckets", () => {
    expect(toEmployeeBucket(5)).toBe("1-10");
    expect(toEmployeeBucket(75)).toBe("51-200");
    expect(toEmployeeBucket(5000)).toBe("1000+");
    expect(toEmployeeBucket(undefined)).toBeUndefined();
  });
});
