import { describe, expect, it } from "vitest";
import { countryFromPlace, resolveCompanyCountry } from "./company-country.js";

describe("company country", () => {
  it("keeps the country the page gave, with its source", () => {
    expect(resolveCompanyCountry({ captured: "Ireland", headquarter: "Dublin" })).toEqual({ country: "Ireland", source: "linkedin_page" });
    expect(resolveCompanyCountry({ captured: "United States", capturedSource: "headquarters", headquarter: "Menlo Park, CA" })).toEqual({ country: "United States", source: "headquarters" });
  });

  it("derives it from the headquarters when the capture has none, for any company", () => {
    expect(resolveCompanyCountry({ headquarter: "Menlo Park, CA" })).toEqual({ country: "United States", source: "headquarters" });
    expect(resolveCompanyCountry({ headquarter: "Pune, Maharashtra" })).toEqual({ country: "India", source: "headquarters" });
    expect(resolveCompanyCountry({ headquarter: "Stockholm" })).toEqual({ country: "Sweden", source: "headquarters" });
    expect(resolveCompanyCountry({ headquarter: "Dublin, Ireland" })).toEqual({ country: "Ireland", source: "linkedin_page" });
  });

  it("does not guess an ambiguous or unknown place", () => {
    for (const headquarter of ["Cambridge", "Birmingham", "Portland", "Georgia", "Remote", "", undefined, null, 5]) {
      expect(resolveCompanyCountry({ headquarter })).toEqual({ country: null, source: null });
    }
    expect(countryFromPlace("Cambridge, MA")).toBe("United States");
    expect(countryFromPlace("London, Ontario")).toBe("Canada");
    expect(countryFromPlace("Austin, TX")).toBe("United States");
  });
});
