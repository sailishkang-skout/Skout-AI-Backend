/** Lightweight handler — always safe to re-inject after extension reload. */
(function initLinkedInBridge() {
  if (globalThis.__SKOUT_LINKEDIN_BRIDGE__) return;
  globalThis.__SKOUT_LINKEDIN_BRIDGE__ = true;

  const scrape =
    globalThis.__SKOUT_SCRAPE_LINKEDIN__ ||
    function fallbackScrape() {
      return { error: "scraper_missing", linkedinUrl: location.href };
    };

  function sleep(ms) {
    return new Promise((resolve) => globalThis.setTimeout(resolve, ms));
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message.type !== "read-profile") return false;

    void (async () => {
      for (let attempt = 0; attempt < 20; attempt += 1) {
        const profile = scrape();
        if (profile.error === "not_a_profile" || profile.fullName) {
          sendResponse(profile);
          return;
        }
        await sleep(600);
      }
      sendResponse(scrape());
    })();

    return true;
  });
})();
