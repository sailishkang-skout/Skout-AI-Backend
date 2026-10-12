// Read one rendered company-filtered search page at a time. LinkedIn navigates
// to a new document between pages, so the background worker owns pagination.
(() => {
  if (globalThis.__SKOUT_COMPANY_PEOPLE_READER__) return;
  globalThis.__SKOUT_COMPANY_PEOPLE_READER__ = true;
  const compact = node => node?.textContent?.replace(/\s+/g, ' ').trim() || undefined;
  const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

  function profileFromRow(row) {
    if (!row) return undefined;
    const candidates = Array.from(row.querySelectorAll('a[href*="/in/"]')).map(link => {
      try {
        const url = new URL(link.getAttribute('href'), location.origin);
        const parts = url.pathname.split('/').filter(Boolean);
        if (url.hostname !== 'www.linkedin.com' || parts[0] !== 'in' || !parts[1]) return undefined;
        const label = compact(link.querySelector('p')) || compact(link) || link.getAttribute('aria-label');
        return {publicId:parts[1],sourceUrl:`${url.origin}/in/${parts[1]}/`,fullName:label?.split(/\s*•/)[0]?.trim()};
      } catch { return undefined; }
    }).filter(candidate => candidate?.fullName && candidate.fullName.length <= 80 &&
      !/\b(mutual connection|other mutual|followers?)\b/i.test(candidate.fullName) &&
      !/^(view|message|connect|follow)$/i.test(candidate.fullName));
    const profile = candidates[0];
    if (!profile) return undefined;
    const lines = Array.from(row.querySelectorAll('p, [data-view-name*="subtitle" i]')).map(compact).filter(Boolean);
    return {...profile,headline:lines.find(line => line !== profile.fullName && !line.startsWith(profile.fullName) && !/mutual connection|followers?/i.test(line) && line.length < 250),associationSource:'company-search-result'};
  }

  function pageNumber() {
    const selected = document.querySelector('main button[aria-current="true"]')?.getAttribute('aria-label')?.match(/page\s+(\d+)/i);
    const fromUrl = new URL(location.href).searchParams.get('page');
    return Number(selected?.[1] || fromUrl || 1);
  }

  function nextButton() {
    return Array.from(document.querySelectorAll('main button')).find(button =>
      /^next$/i.test(button.getAttribute('aria-label') || button.textContent?.trim() || '') && !button.disabled);
  }

  async function readPage() {
    for (let attempt = 0; attempt < 40; attempt++) {
      const people = new Map();
      const rows = new Set(document.querySelectorAll('main [role="listitem"], main .reusable-search__result-container, main .entity-result, main .search-results-container li, main .search-results__list li'));
      for (const row of rows) {
        const profile = profileFromRow(row);
        if (profile) people.set(profile.publicId, profile);
      }
      if (people.size) return {ok:true,url:location.href,page:pageNumber(),peopleProfiles:[...people.values()],hasNext:!!nextButton()};
      const mainText = compact(document.querySelector('main')) || '';
      if (/no results found|we couldn't find any results/i.test(mainText)) return {ok:true,url:location.href,page:pageNumber(),peopleProfiles:[],hasNext:false};
      if (/something went wrong on our end|try refreshing the page/i.test(document.body?.innerText || '')) break;
      await pause(500);
    }
    return {ok:false,error:'LinkedIn did not render readable cards on this results page.'};
  }

  chrome.runtime.onMessage.addListener((request,sender,respond) => {
    if (sender.id !== chrome.runtime.id) return;
    if (request.type === 'COMPANY_PEOPLE_READER_READY') { respond({ok:true,url:location.href,page:pageNumber()}); return; }
    if (request.type === 'COLLECT_COMPANY_PEOPLE_PAGE') {
      readPage().then(respond).catch(error => respond({ok:false,error:error.message}));
      return true;
    }
    if (request.type === 'ADVANCE_COMPANY_PEOPLE_PAGE') {
      const next = nextButton();
      if (!next) { respond({ok:false,error:'LinkedIn showed no next results page.'}); return; }
      respond({ok:true});
      setTimeout(() => next.click(), 0);
    }
  });
})();
