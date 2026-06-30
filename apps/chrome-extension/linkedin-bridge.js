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

    let responded = false;
    function reply(profile) {
      if (responded) return;
      responded = true;
      sendResponse(profile);
    }

    const timer = globalThis.setTimeout(() => {
      try {
        reply(scrape());
      } catch {
        reply({ error: "scrape_timeout", linkedinUrl: location.href });
      }
    }, 10_000);

    void (async () => {
      try {
        for (let attempt = 0; attempt < 8; attempt += 1) {
          const profile = scrape();
          if (profile.error === "not_a_profile" || profile.fullName) {
            globalThis.clearTimeout(timer);
            reply(profile);
            return;
          }
          await sleep(400);
        }
        globalThis.clearTimeout(timer);
        reply(scrape());
      } catch (error) {
        globalThis.clearTimeout(timer);
        reply({ error: String(error), linkedinUrl: location.href });
      }
    })();

    return true;
  });
})();
