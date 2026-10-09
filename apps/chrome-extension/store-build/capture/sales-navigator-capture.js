// Captures only result cards currently rendered after the user chooses Sales Navigator
// filters. It does not set filters, submit searches, send messages, or access hidden results.
// The only controls it uses are the result list's own scroll position and its page buttons.
globalThis.SkoutSalesNavigatorCapture = (() => {
  // Workload controls, also enforced by the Skout API. Not a LinkedIn safety guarantee.
  const MAX_PAGES = 10;
  const MAX_LEADS = 250;
  const compact = node => node?.textContent?.replace(/\s+/g, ' ').trim() || undefined;
  const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
  const leadIdFromUrl = value => {
    try {
      const parts = new URL(value).pathname.split('/').filter(Boolean);
      return parts[0] === 'sales' && parts[1] === 'lead' && parts[2] ? parts[2].split(',')[0] : undefined;
    } catch { return undefined; }
  };
  const profileIdFromUrl = value => {
    try {
      const url = new URL(value);
      const parts = url.pathname.split('/').filter(Boolean);
      return url.protocol === 'https:' && ['www.linkedin.com','linkedin.com'].includes(url.hostname) &&
        parts[0] === 'in' && parts[1] && parts.length === 2 ? parts[1] : undefined;
    } catch { return undefined; }
  };
  const decodeFilterText = value => {
    let text = value;
    for (let pass = 0; pass < 2; pass++) {
      try { text = decodeURIComponent(text); } catch { break; }
    }
    return text.replace(/\+/g, ' ').trim();
  };
  // Read back from the URL the user's own search produced; filters are never written.
  const appliedFilters = () => {
    const query = new URL(location.href).searchParams.get('query') || '';
    const types = [...query.matchAll(/\(type:([A-Z_]+),values:List\(/g)];
    const filters = [];
    for (let index = 0; index < types.length; index++) {
      const block = query.slice(types[index].index, types[index+1]?.index ?? query.length);
      for (const value of block.matchAll(/text:([^,)]+),selectionType:(INCLUDED|EXCLUDED)/g)) {
        filters.push(`${types[index][1].replace(/_/g,' ').toLowerCase()}: ${decodeFilterText(value[1])} (${value[2].toLowerCase()})`);
      }
    }
    return filters.slice(0,100);
  };
  let running = false;
  async function start() {
    if (running) return;
    running = true;
    try { await capture(); } finally { running = false; }
  }
  async function capture() {
    const ui = globalThis.SkoutCaptureUi.progress('sales');
    const seen = new Set(), peopleProfiles = [];
    const initialCards = [...document.querySelectorAll('main [data-x-search-result="LEAD"]')];
    const selectedOnly = initialCards.some(card => card.parentElement?.querySelector('input[type="checkbox"]:checked'));
    const collectCards = () => {
      const cards = [...document.querySelectorAll('main [data-x-search-result="LEAD"]')];
      const selected = selectedOnly ? cards.filter(card => card.parentElement?.querySelector('input[type="checkbox"]:checked')) : cards;
      // Sales Navigator result cards link to /sales/lead/<opaque-id>, not to
      // /in/<public-id>. Read only the rendered lead cards and retain that URL;
      // never fabricate a public-profile URL from an opaque lead ID.
      for (const row of selected) {
        if (peopleProfiles.length >= MAX_LEADS) break;
        const leadLink = row.querySelector('a[data-lead-search-result^="profile-link"][href*="/sales/lead/"]');
        if (!leadLink) continue;
        const leadId = leadIdFromUrl(leadLink.href);
        if (!leadId || seen.has(leadId)) continue;
        const fullName = compact(row.querySelector('[data-anonymize="person-name"]'));
        if (!fullName || /^(view|message|save)$/i.test(fullName)) continue;
        const profileLink = Array.from(row.querySelectorAll('a[href*="/in/"]')).find(a => profileIdFromUrl(a.href));
        const publicProfileId = profileLink && profileIdFromUrl(profileLink.href);
        const degreeText = compact(row.querySelector('.artdeco-entity-lockup__badge .a11y-text')) ||
          compact(row.querySelector('.artdeco-entity-lockup__degree'));
        const title = compact(row.querySelector('[data-anonymize="title"]'));
        const companyLink = row.querySelector('a[data-anonymize="company-name"]');
        const companyName = compact(companyLink);
        const companyPublicId = companyLink?.href?.match(/^https:\/\/www\.linkedin\.com\/sales\/company\/([^/?#]+)/)?.[1];
        const headline = compact(row.querySelector('.artdeco-entity-lockup__subtitle'));
        const locationName = compact(row.querySelector('[data-anonymize="location"]'));
        const mutualConnectionsText = [...row.querySelectorAll('button,span')]
          .map(node => node.getAttribute('aria-label') || compact(node))
          .find(value => /^\d+ mutual connections?$/i.test(value || ''));
        const activitySignals = [...new Set([...row.querySelectorAll('span,div')]
          .filter(node => !node.children.length).map(compact)
          .filter(value => /^(?:viewed|recently hired|posted on linkedin|last active|reachable)$/i.test(value || '')))];
        const degree = degreeText?.match(/\b([123])(?:st|nd|rd)\b/i)?.[1];
        seen.add(leadId);
        peopleProfiles.push({
          publicId: publicProfileId || `sales-lead:${leadId}`,
          sourceUrl: publicProfileId ? `https://www.linkedin.com/in/${publicProfileId}/` : leadLink.href.split('?')[0],
          fullName,
          headline,
          locationName,
          currentCompanies: companyName ? [{ name: companyName, title, companyPublicId }] : undefined,
          relationshipContext: {
            degree: degree ? Number(degree) : undefined,
            isDirectConnection: /\b1st\b/i.test(degreeText || ''),
            mutualConnectionsText,
            salesNavigatorLeadUrl: leadLink.href.split('?')[0],
            activitySignals: activitySignals.length ? activitySignals : undefined,
          },
        });
      }
    };
    const resultCount = Number(document.body.innerText.match(/\b([\d,]+) results\b/i)?.[1]?.replace(/,/g,'')) || undefined;
    const pageLabel = () => {
      const match = document.body.innerText.match(/\bPage\s+(\d+)\s+of\s+(\d+)\b/i);
      return match ? {current:Number(match[1]),total:Number(match[2])} : undefined;
    };
    const initialPage = pageLabel();
    let pagesRead = 0;
    const updateStatus = () => {
      const page = pageLabel();
      ui.set(`Reading page ${page?.current || '?'} of ${page?.total || '?'}: ${peopleProfiles.length} distinct leads (cap ${MAX_PAGES} pages / ${MAX_LEADS} leads).`);
    };
    // Only pages actually rendered by the signed-in user's selected search
    // are read. The user can stop at any time; no filters are changed.
    for (let pageStep = 0; pageStep < MAX_PAGES && peopleProfiles.length < MAX_LEADS && !ui.stopped; pageStep++) {
      const page = pageLabel();
      const before = document.querySelector('main [data-x-search-result="LEAD"] a[href*="/sales/lead/"]')?.href;
      collectCards();
      pagesRead++;
      updateStatus();
      if (!selectedOnly) {
        const list = document.querySelector('main [data-x-search-result="LEAD"]')?.closest('ol');
        let scroller = list?.parentElement;
        while (scroller && scroller !== document.body &&
          !(scroller.scrollHeight > scroller.clientHeight + 100 && /auto|scroll/.test(getComputedStyle(scroller).overflowY)))
          scroller = scroller.parentElement;
        if (scroller && scroller !== document.body) {
          const originalTop = scroller.scrollTop;
          for (let step = 0; step < 45 && peopleProfiles.length < MAX_LEADS && !ui.stopped; step++) {
            const next = Math.min(scroller.scrollTop + Math.max(300,scroller.clientHeight * .75), scroller.scrollHeight-scroller.clientHeight);
            if (next <= scroller.scrollTop + 1) break;
            scroller.scrollTop = next;
            await pause(700);
            collectCards();
            updateStatus();
          }
          scroller.scrollTop = originalTop;
        }
      }
      // Once a cap is reached, no further results page is opened.
      if (selectedOnly || ui.stopped || !page || page.current >= page.total || pageStep === MAX_PAGES - 1 || peopleProfiles.length >= MAX_LEADS) break;
      const nextPage = page.current + 1;
      const nextButton = [...document.querySelectorAll('button')].find(button =>
        button.getAttribute('aria-label') === `Page ${nextPage}` ||
        (button.textContent?.trim() === `Page ${nextPage}` && button.closest('[aria-label="Page Navigation"]')));
      if (!nextButton || nextButton.disabled) break;
      nextButton.click();
      let changed = false;
      for (let attempt = 0; attempt < 40 && !ui.stopped; attempt++) {
        await pause(350);
        const first = document.querySelector('main [data-x-search-result="LEAD"] a[href*="/sales/lead/"]')?.href;
        if (pageLabel()?.current === nextPage && first && first !== before) { changed = true; break; }
      }
      if (!changed) break;
      await pause(650);
    }
    const stopped = ui.stopped;
    if (!peopleProfiles.length) {
      ui.done('No visible Sales Navigator lead cards were found. Wait for the results to load, then capture again.', true);
      return;
    }
    // Check each lead page, one at a time, for a public link LinkedIn itself shows there.
    const unresolved = peopleProfiles.filter(profile => profile.sourceUrl.includes('/sales/lead/'));
    let cancelled = stopped;
    ui.onStop(() => {
      cancelled = true;
      Promise.resolve(chrome.runtime.sendMessage({type:'CANCEL_SALES_LEAD_LINKS'})).catch(() => {});
    });
    let checked = 0;
    for (let index = 0; index < unresolved.length && !cancelled; index += 10) {
      ui.set(`Checking public LinkedIn links: ${checked} of ${unresolved.length} lead pages, one at a time.`);
      const batch = unresolved.slice(index,index+10);
      let result;
      try { result = await chrome.runtime.sendMessage({type:'RESOLVE_SALES_LEAD_LINKS',
        leads:batch.map(profile => ({url:profile.relationshipContext.salesNavigatorLeadUrl}))}); }
      catch { break; }
      if (!result?.ok) break;
      for (const profile of batch) {
        const publicUrl = result.data.links[profile.relationshipContext.salesNavigatorLeadUrl];
        const publicId = publicUrl && profileIdFromUrl(publicUrl);
        if (publicId) { profile.publicId = publicId; profile.sourceUrl = publicUrl; }
      }
      checked += batch.length;
      if (result.data.cancelled) break;
    }
    const publicCount = peopleProfiles.filter(profile => profile.sourceUrl.includes('/in/')).length;
    const notes = [
      resultCount
        ? `${peopleProfiles.length} of ${resultCount} search results read across ${pagesRead} of ${initialPage?.total || '?'} pages${stopped ? ' (stopped early)' : ''}.`
        : `${peopleProfiles.length} visible filtered leads read across ${pagesRead} page(s)${stopped ? ' (stopped early)' : ''}.`,
      `${publicCount} have a real public LinkedIn link. The others stay Sales Navigator leads until a public link is available.`,
    ];
    await globalThis.SkoutCaptureUi.review('sales', {sourceUrl:location.href,filters:appliedFilters(),pagesRead,resultCount,peopleProfiles,
      _salesCapture:{resultCount,pagesRead,totalPages:initialPage?.total,stopped}}, notes);
    ui.done(`${peopleProfiles.length} leads read across ${pagesRead} page(s). Review before saving.`);
  }
  return {start, MAX_PAGES, MAX_LEADS};
})();
