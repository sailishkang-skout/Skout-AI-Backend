/** Scrape visible LinkedIn people search / Sales Nav result cards on the current page. */
(function initLinkedInSearchScraper() {
  function clean(text) {
    return (text || "").replace(/\s+/g, " ").trim();
  }

  function normalizeProfileUrl(href) {
    try {
      const url = new URL(href, location.origin);
      const match = url.pathname.match(/\/in\/([^/?#]+)/i);
      if (!match) return null;
      return `${url.origin}/in/${decodeURIComponent(match[1])}`.replace(/\/$/, "");
    } catch {
      return null;
    }
  }

  function parseSubtitle(subtitle) {
    const text = clean(subtitle);
    if (!text) return { title: "", companyName: "" };
    if (text.includes(" at ")) {
      const idx = text.indexOf(" at ");
      return {
        title: text.slice(0, idx).trim(),
        companyName: text.slice(idx + 4).trim(),
      };
    }
    const parts = text.split(" · ");
    return { title: parts[0]?.trim() || text, companyName: "" };
  }

  function resultContainer(link) {
    return link.closest(
      [
        "li.reusable-search__result-container",
        'li[data-view-name="search-entity-result-universal-template"]',
        "li.artdeco-list__item",
        "div[data-chameleon-result-urn]",
        "div.entity-result",
        "li",
      ].join(", ")
    );
  }

  function extractName(link) {
    const hidden = link.querySelector('span[aria-hidden="true"]');
    let name = clean(hidden?.textContent || link.textContent);
    name = name.replace(/^View\s+.+'s profile$/i, "").trim();
    name = name.replace(/\s*(•|·)\s*1st\s*$/i, "").trim();
    return name;
  }

  function isSearchResultsPage() {
    return (
      /linkedin\.com\/search\/results\/people/i.test(location.href) ||
      /linkedin\.com\/sales\/search\/people/i.test(location.href) ||
      /linkedin\.com\/sales\/lists\/people/i.test(location.href)
    );
  }

  function scrapeSearchResults() {
    const root = document.querySelector("main") || document.body;
    const results = [];
    const seen = new Set();

    for (const link of root.querySelectorAll('a[href*="/in/"]')) {
      const linkedinUrl = normalizeProfileUrl(link.href);
      if (!linkedinUrl || seen.has(linkedinUrl)) continue;

      const container = resultContainer(link);
      if (!container) continue;

      const fullName = extractName(link);
      if (!fullName || fullName.length < 2) continue;

      const subtitleEl = container.querySelector(
        [
          ".entity-result__primary-subtitle",
          ".artdeco-entity-lockup__subtitle",
          ".entity-result__summary",
          ".entity-result__secondary-subtitle",
        ].join(", ")
      );
      const { title, companyName } = parseSubtitle(subtitleEl?.textContent || "");

      seen.add(linkedinUrl);
      results.push({ fullName, title, companyName, linkedinUrl });
    }

    return {
      results,
      count: results.length,
      pageUrl: location.href.split("?")[0],
    };
  }

  globalThis.__SKOUT_IS_LINKEDIN_SEARCH__ = isSearchResultsPage;
  globalThis.__SKOUT_SCRAPE_LINKEDIN_SEARCH__ = scrapeSearchResults;
})();
