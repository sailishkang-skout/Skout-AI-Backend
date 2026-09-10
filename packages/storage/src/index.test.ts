import { describe, expect, it } from "vitest";
import { scrapeKey } from "./index.js";

describe("scrapeKey", () => {
  it("builds raw zone keys with date partition", () => {
    const key = scrapeKey("raw", "company-web", "job-123");
    expect(key).toMatch(/^raw\/company-web\/\d{4}-\d{2}-\d{2}\/job-123\/records\.jsonl$/);
  });

  it("builds manifest keys without filename suffix", () => {
    const key = scrapeKey("manifests", "company-web", "job-123");
    expect(key).toMatch(/^manifests\/company-web\/\d{4}-\d{2}-\d{2}\/job-123\.json$/);
  });
});
