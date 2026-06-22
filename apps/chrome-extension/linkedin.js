/** Shared LinkedIn profile scraping — used by content script and popup injection. */
export function scrapeLinkedInProfile() {
  const linkedinUrl = window.location.href.split("?")[0];
  const isProfile =
    /linkedin\.com\/in\//i.test(linkedinUrl) || /linkedin\.com\/pub\//i.test(linkedinUrl);

  if (!isProfile) {
    return { error: "not_a_profile", linkedinUrl };
  }

  const ogTitle = document.querySelector('meta[property="og:title"]')?.getAttribute("content") ?? "";
  const ogName = ogTitle.split("|")[0]?.trim() ?? "";

  const fullName =
    document.querySelector("h1.text-heading-xlarge")?.textContent?.trim() ||
    document.querySelector("h1.inline.t-24")?.textContent?.trim() ||
    document.querySelector("main section h1")?.textContent?.trim() ||
    document.querySelector("main h1")?.textContent?.trim() ||
    document.querySelector('[data-view-name="profile-top-card"] h1')?.textContent?.trim() ||
    ogName ||
    "";

  const title =
    document.querySelector(".text-body-medium.break-words")?.textContent?.trim() ||
    document.querySelector("div[data-generated-suggestion-target]")?.textContent?.trim() ||
    document.querySelector(".pv-text-details__left-panel .text-body-medium")?.textContent?.trim() ||
    document.querySelector('[data-view-name="profile-top-card"] .text-body-medium")?.textContent?.trim() ||
    "";

  const companyName =
    document.querySelector(".pv-text-details__right-panel a")?.textContent?.trim() ||
    document.querySelector("button[aria-label*='company'] span")?.textContent?.trim() ||
    document.querySelector('[data-view-name="profile-top-card"] a[href*="/company/"]')?.textContent?.trim() ||
    "";

  return { fullName, title, companyName, linkedinUrl };
}
