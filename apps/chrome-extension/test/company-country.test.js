import { describe, expect, it } from "vitest";
import { loadCapturePage } from "./helpers/capture-dom.js";

const extract = loadCapturePage({ url: "https://www.linkedin.com/company/acme/about/", html: "<main></main>", files: ["capture/extract-common.js"], chrome: { runtime: { id: "t", onMessage: { addListener() {} } } } }).SkoutCaptureExtract;
const resolve = (headquarter, structured) => extract.resolveCompanyCountry({ headquarter, structured });

describe("company country: the page first, then the headquarters, never a guess", () => {
  it("uses what the page states itself and says so", () => {
    expect(resolve("Dublin, Ireland")).toEqual({ country: "Ireland", source: "linkedin_page" });
    expect(resolve("Toronto, ON, Canada")).toEqual({ country: "Canada", source: "linkedin_page" });
    expect(resolve("Somewhere", "US")).toEqual({ country: "United States", source: "linkedin_page" });
    expect(resolve("Menlo Park, CA", "in")).toEqual({ country: "India", source: "linkedin_page" });
  });

  it("falls back to the country of the headquarters' state, province or city, and says it did", () => {
    expect(resolve("Menlo Park, CA")).toEqual({ country: "United States", source: "headquarters" });
    expect(resolve("Austin, Texas")).toEqual({ country: "United States", source: "headquarters" });
    expect(resolve("Pune, Maharashtra")).toEqual({ country: "India", source: "headquarters" });
    expect(resolve("Toronto, Ontario")).toEqual({ country: "Canada", source: "headquarters" });
    expect(resolve("Bengaluru")).toEqual({ country: "India", source: "headquarters" });
    expect(resolve("San Francisco Bay Area")).toEqual({ country: "United States", source: "headquarters" });
  });

  it("works the same for every company, not only Meta", () => {
    for (const [hq, country] of [["Menlo Park, California", "United States"], ["Seattle, WA", "United States"], ["Stockholm", "Sweden"], ["Sydney, New South Wales", "Australia"], ["Gurugram, Haryana", "India"], ["Dubai", "United Arab Emirates"]]) {
      expect(resolve(hq).country).toBe(country);
    }
  });

  it("leaves an ambiguous place unresolved instead of guessing, but resolves it once a state or country follows", () => {
    for (const hq of ["Cambridge", "Birmingham", "Portland", "Valencia", "Georgia", "Springfield"]) expect(resolve(hq)).toEqual({ country: undefined, source: undefined });
    expect(resolve("Cambridge, MA").country).toBe("United States");
    expect(resolve("Cambridge, England").country).toBe("United Kingdom");
    expect(resolve("London, Ontario").country).toBe("Canada");
    expect(resolve("Portland, Oregon").country).toBe("United States");
  });

  it("does not invent a country from nothing, or from a name that is not a place", () => {
    expect(resolve(undefined)).toEqual({ country: undefined, source: undefined });
    expect(resolve("")).toEqual({ country: undefined, source: undefined });
    expect(resolve("Remote")).toEqual({ country: undefined, source: undefined });
    expect(resolve("Acme Holdings")).toEqual({ country: undefined, source: undefined });
    expect(extract.countryFromCode("ZZ")).toBeUndefined();
  });
});
