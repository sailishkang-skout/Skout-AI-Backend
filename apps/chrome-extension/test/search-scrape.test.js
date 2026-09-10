import { describe, expect, it } from "vitest";

function isSearchResultsPage(url) {
  return (
    /linkedin\.com\/search\/results\/people/i.test(url) ||
    /linkedin\.com\/sales\/search\/people/i.test(url) ||
    /linkedin\.com\/sales\/lists\/people/i.test(url)
  );
}

function normalizeProfileUrl(href, origin = "https://www.linkedin.com") {
  try {
    const url = new URL(href, origin);
    const match = url.pathname.match(/\/in\/([^/?#]+)/i);
    if (!match) return null;
    return `${url.origin}/in/${decodeURIComponent(match[1])}`.replace(/\/$/, "");
  } catch {
    return null;
  }
}

describe("linkedin search scrape helpers", () => {
  it("detects people search URLs", () => {
    expect(isSearchResultsPage("https://www.linkedin.com/search/results/people/?keywords=ceo")).toBe(true);
    expect(isSearchResultsPage("https://www.linkedin.com/sales/search/people")).toBe(true);
    expect(isSearchResultsPage("https://www.linkedin.com/in/jane-doe")).toBe(false);
  });

  it("normalizes profile URLs", () => {
    expect(normalizeProfileUrl("https://www.linkedin.com/in/jane-doe?miniProfileUrn=abc")).toBe(
      "https://www.linkedin.com/in/jane-doe"
    );
    expect(normalizeProfileUrl("https://www.linkedin.com/company/acme")).toBeNull();
  });
});
