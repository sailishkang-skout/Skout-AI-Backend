// Read one rendered company-filtered search page at a time. LinkedIn navigates
// to a new document between pages, so the background worker owns pagination.
(() => {
  if (globalThis.__SKOUT_COMPANY_PEOPLE_READER__) return;
  globalThis.__SKOUT_COMPANY_PEOPLE_READER__ = true;
  const compact = node => node?.textContent?.replace(/\s+/g, ' ').trim() || undefined;
  const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
  /** LinkedIn shows at most 100 result pages (10 people each) for one search. */
  const LAST_PAGE = 100;
  const PAGE_SIZE = 10;

  function profileFromRow(row) {
    if (!row) return undefined;
    const candidates = Array.from(row.querySelectorAll('a[href*="/in/"]')).map(link => {
      try {
        const url = new URL(link.getAttribute('href'), location.origin);
        const parts = url.pathname.split('/').filter(Boolean);
        if (url.hostname !== 'www.linkedin.com' || parts[0] !== 'in' || !parts[1]) return undefined;
        // The visible name: the link's own heading/span, never the "View X's profile" hidden text.
        const visible = link.querySelector('span[aria-hidden="true"]') || link.querySelector('p') || link.querySelector('span');
        const label = compact(visible) || compact(link) || link.getAttribute('aria-label');
        const fullName = label?.replace(/^view\s+/i, '').replace(/[’']s\s+profile$/i, '').split(/\s*•/)[0]?.trim();
        return {publicId:parts[1],sourceUrl:`${url.origin}/in/${parts[1]}/`,fullName};
      } catch { return undefined; }
    }).filter(candidate => candidate?.fullName && candidate.fullName.length <= 80 &&
      !/\b(mutual connection|other mutual|followers?)\b/i.test(candidate.fullName) &&
      !/^(view|message|connect|follow|linkedin member)$/i.test(candidate.fullName));
    const profile = candidates[0];
    if (!profile) return undefined;
    const lines = Array.from(row.querySelectorAll('p, [data-view-name*="subtitle" i], .entity-result__primary-subtitle')).map(compact).filter(Boolean);
    return {...profile,headline:lines.find(line => line !== profile.fullName && !line.startsWith(profile.fullName) && !/mutual connection|followers?|^(connect|message|follow)$/i.test(line) && line.length < 250),associationSource:'company-search-result'};
  }

  function pageNumber() {
    const selected = document.querySelector('main button[aria-current="true"], main [aria-current="page"]')?.getAttribute('aria-label')?.match(/page\s+(\d+)/i);
    const fromUrl = new URL(location.href).searchParams.get('page');
    return Number(fromUrl || selected?.[1] || 1);
  }

  function nextButton() {
    return Array.from(document.querySelectorAll('main button, main a')).find(button =>
      /^next$/i.test(button.getAttribute('aria-label') || button.textContent?.trim() || '') && !button.disabled &&
      button.getAttribute('aria-disabled') !== 'true');
  }

  /** Every result card: any row holding a profile link (old and new search layouts). */
  function collect() {
    const people = new Map();
    const rows = new Set();
    for (const link of document.querySelectorAll('main a[href*="/in/"]')) {
      const row = link.closest('li, [role="listitem"], [data-chameleon-result-urn], [data-view-name*="search-entity" i], .entity-result');
      if (row && !row.closest('aside')) rows.add(row);
    }
    for (const row of rows) {
      const profile = profileFromRow(row);
      if (profile && !people.has(profile.publicId)) people.set(profile.publicId, profile);
    }
    return people;
  }

  async function readPage() {
    // LinkedIn renders a few cards first and the rest as the page scrolls. Scroll down step by
    // step and read until the count stops growing (or a full page of 10 is seen).
    let people = new Map();
    let stable = 0;
    window.scrollTo(0, 0);
    for (let attempt = 0; attempt < 40; attempt++) {
      const found = collect();
      stable = found.size && found.size === people.size ? stable + 1 : 0;
      if (found.size >= people.size) people = found;
      const atBottom = window.scrollY + window.innerHeight >= document.documentElement.scrollHeight - 8;
      if (people.size >= PAGE_SIZE || (people.size && stable >= 3 && atBottom)) break;
      const mainText = compact(document.querySelector('main')) || '';
      if (!people.size && /no results found|we couldn't find any results|no matching results/i.test(mainText)) {
        return {ok:true,url:location.href,page:pageNumber(),peopleProfiles:[],hasNext:false};
      }
      if (/something went wrong on our end|try refreshing the page/i.test(document.body?.innerText || '')) break;
      window.scrollBy({top: Math.max(400, Math.floor(window.innerHeight * 0.7)), behavior: 'auto'});
      await pause(450);
    }
    if (!people.size) return {ok:false,error:'LinkedIn did not render readable cards on this results page.'};
    const page = pageNumber();
    // A full page usually has a next one even when the Next button has not rendered yet; an empty
    // next page then ends the search.
    const hasNext = page < LAST_PAGE && (Boolean(nextButton()) || people.size >= PAGE_SIZE);
    return {ok:true,url:location.href,page,peopleProfiles:[...people.values()],hasNext};
  }

  /** The URL of the next results page: the same search with page + 1. */
  function nextPageUrl() {
    const url = new URL(location.href);
    url.searchParams.set('page', String(pageNumber() + 1));
    return url.href;
  }

  chrome.runtime.onMessage.addListener((request,sender,respond) => {
    if (sender.id !== chrome.runtime.id) return;
    if (request.type === 'COMPANY_PEOPLE_READER_READY') { respond({ok:true,url:location.href,page:pageNumber()}); return; }
    if (request.type === 'COLLECT_COMPANY_PEOPLE_PAGE') {
      readPage().then(respond).catch(error => respond({ok:false,error:error.message}));
      return true;
    }
    if (request.type === 'ADVANCE_COMPANY_PEOPLE_PAGE') {
      if (pageNumber() >= LAST_PAGE) { respond({ok:false,error:'LinkedIn shows at most 100 result pages.'}); return; }
      // Open the next page by its address: it does not depend on the Next button rendering.
      const next = nextPageUrl();
      respond({ok:true});
      setTimeout(() => location.assign(next), 0);
    }
  });
  globalThis.SkoutCompanyPeopleSearch = {profileFromRow, collect, readPage, nextPageUrl, pageNumber};
})();
