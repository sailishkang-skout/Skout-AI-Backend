// Reads job listings from pages the user's capture opened: a company's Jobs tab, LinkedIn's job
// search filtered to that company, and one job's own page. It reads only what the page renders,
// after scrolling and expanding it like a person would. It never applies for a job, sets filters
// or sends anything. The background worker owns which page is opened and when.
(() => {
  if (globalThis.__SKOUT_COMPANY_JOBS_READER__) return;
  globalThis.__SKOUT_COMPANY_JOBS_READER__ = true;
  const { countryFromPlace } = window.SkoutCaptureExtract || {};
  const compact = (node) => node?.textContent?.replace(/\s+/g, ' ').trim() || undefined;
  const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  /** LinkedIn lists 25 jobs per results page. */
  const SEARCH_PAGE_SIZE = 25;
  const JOB_LINK = 'a[href*="/jobs/view/"], a[href*="currentJobId="]';
  const CARD_SELECTOR = '[data-job-id], [data-occludable-job-id], li.jobs-search-results__list-item, li.scaffold-layout__list-item, .job-card-container, .job-card-square, .org-view-entity-card, li';
  const EMPLOYMENT = /\b(full[- ]time|part[- ]time|contract|temporary|internship|volunteer|apprenticeship|freelance|self[- ]employed)\b/i;
  const POSTED = /\b(just now|(?:\d+|an?)\s+(?:minute|hour|day|week|month)s?\s+ago)\b/i;

  /** The page's address without the part LinkedIn changes while you scroll. */
  function pageUrl() {
    const url = new URL(location.href);
    url.hash = '';
    return url.href;
  }

  function jobIdFromHref(href) {
    try {
      const url = new URL(href, location.origin);
      if (!['www.linkedin.com', 'linkedin.com'].includes(url.hostname)) return undefined;
      const direct = url.pathname.match(/^\/jobs\/view\/(?:[^/]*-)?(\d{4,20})\/?$/)?.[1];
      if (direct) return direct;
      const current = url.searchParams.get('currentJobId');
      return /^\d{4,20}$/.test(current || '') ? current : undefined;
    } catch { return undefined; }
  }

  const BLOCK = /^(?:p|div|li|ul|ol|br|h[1-6]|section|article|header|footer|tr|table|dl|dt|dd)$/i;

  /** The node's text with a space between neighbouring elements ("3 days ago" + "Full-time"), without the hidden twins. */
  function spacedText(node) {
    const clone = node.cloneNode(true);
    clone.querySelectorAll('.visually-hidden, .sr-only, svg, script, style').forEach((n) => n.remove());
    const parts = [];
    const walk = (current) => {
      for (const child of current.childNodes) {
        if (child.nodeType === 3) parts.push(child.nodeValue);
        else if (child.nodeType === 1) { parts.push(' '); walk(child); parts.push(' '); }
      }
    };
    walk(clone);
    return parts.join('').replace(/\s+/g, ' ').trim();
  }

  /** Text with its paragraph and list breaks kept as new lines (a job description's structure). */
  function blockText(node) {
    const lines = [];
    let line = '';
    const flush = () => { const value = line.replace(/\s+/g, ' ').trim(); if (value) lines.push(value); line = ''; };
    const walk = (current) => {
      for (const child of current.childNodes) {
        if (child.nodeType === 3) { line += child.nodeValue; continue; }
        if (child.nodeType !== 1 || /^(?:script|style|svg)$/i.test(child.nodeName) || child.classList?.contains('visually-hidden')) continue;
        const block = BLOCK.test(child.nodeName);
        if (block) flush(); else line += ' ';
        walk(child);
        if (block) flush(); else line += ' ';
      }
    };
    walk(node);
    flush();
    return lines.join('\n');
  }

  /** Visible text only: LinkedIn repeats each title in a visually hidden twin, which doubles it. */
  function visibleText(node) {
    if (!node) return undefined;
    const value = spacedText(node) || undefined;
    if (!value) return undefined;
    // "Engineer Engineer" (a title and its twin) is "Engineer".
    const half = Math.floor(value.length / 2);
    if (value.length % 2 === 1 && value.slice(0, half) === value.slice(half + 1)) return value.slice(0, half).trim();
    return value;
  }

  function workplaceFrom(value) {
    const match = (value || '').match(/\b(remote|hybrid|on[- ]?site)\b/i)?.[1]?.toLowerCase().replace(/[- ]/g, '');
    return match === 'remote' ? 'remote' : match === 'hybrid' ? 'hybrid' : match === 'onsite' ? 'on_site' : undefined;
  }

  const isoDate = (value) => {
    if (!value) return undefined;
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
  };

  /**
   * Every job card the page shows. A job is found by its link (the LinkedIn job id); the card is
   * the smallest block around that link, so one job's text never spills into another's. Fields the
   * card does not show stay absent.
   */
  function extractJobCards(root = document, source = 'company-jobs-tab') {
    const scope = root.querySelector?.('main') || root;
    const jobs = new Map();
    for (const link of scope.querySelectorAll(JOB_LINK)) {
      if (link.closest('aside, footer, nav, [role="dialog"]')) continue;
      const card = link.closest(CARD_SELECTOR) || link.parentElement;
      const jobId = jobIdFromHref(link.getAttribute('href')) || card?.getAttribute?.('data-job-id') || card?.getAttribute?.('data-occludable-job-id') || undefined;
      if (!jobId || !/^\d{4,20}$/.test(jobId)) continue;
      const titleNode = card?.querySelector('.job-card-list__title, .job-card-container__link strong, .job-card-square__title, .artdeco-entity-lockup__title') || link;
      const title = (link.getAttribute('aria-label') || '').replace(/\s+with verification$/i, '').trim() || visibleText(titleNode.querySelector?.('strong') || titleNode);
      if (!title || title.length > 300 || /^(apply|easy apply|save|show all|see all)/i.test(title)) continue;
      const companyName = visibleText(card?.querySelector('.job-card-container__primary-description, .artdeco-entity-lockup__subtitle, [class*="company-name"], .job-card-container__company-name'));
      // The place is the first metadata item; some layouts have only the wrapper around it.
      const place = visibleText(card?.querySelector('.job-card-container__metadata-wrapper li, .job-card-container__metadata-item, .artdeco-entity-lockup__caption, .org-view-entity-card__subtitle') ||
        card?.querySelector('.job-card-container__metadata-wrapper'));
      const cardText = visibleText(card) || '';
      const location = place ? place.replace(/\s*\((?:remote|hybrid|on[- ]?site)\)\s*$/i, '').trim() || undefined : undefined;
      const time = card?.querySelector('time');
      const job = {
        jobId,
        jobUrl: `https://www.linkedin.com/jobs/view/${jobId}/`,
        title,
        companyName,
        location,
        country: countryFromPlace ? countryFromPlace(location) : undefined,
        workplaceType: workplaceFrom(place) || workplaceFrom(cardText),
        employmentType: cardText.match(EMPLOYMENT)?.[1],
        postedAt: isoDate(time?.getAttribute('datetime')),
        postedText: (compact(time) || cardText.match(POSTED)?.[0])?.slice(0, 100),
        source,
      };
      const previous = jobs.get(jobId) || {};
      jobs.set(jobId, { ...previous, ...Object.fromEntries(Object.entries(job).filter(([, value]) => value !== undefined && value !== '')) });
    }
    return [...jobs.values()];
  }

  /** LinkedIn's own count ("1,234 results", "18 open jobs"), when the page shows one. */
  function expectedTotal(root = document) {
    const label = Array.from(root.querySelectorAll('main small, main h1, main h2, main p, main span, main div'))
      .filter((node) => !node.children.length)
      .map((node) => compact(node) || '')
      .find((value) => /^[\d,]+\+?\s+(?:results?|(?:open\s+)?jobs?)$/i.test(value));
    const number = label?.match(/^([\d,]+)/)?.[1]?.replace(/,/g, '');
    return number ? Number(number) : undefined;
  }

  /** LinkedIn's id for this company, from the "all jobs" link, which carries it as f_C. */
  function memberIdFromPage(root = document) {
    for (const link of root.querySelectorAll('a[href*="/jobs/search"]')) {
      try {
        const id = new URL(link.getAttribute('href'), location.origin).searchParams.get('f_C');
        const first = (id || '').split(',')[0];
        if (/^\d{1,20}$/.test(first)) return first;
      } catch { /* next link */ }
    }
    return undefined;
  }

  function showMoreButton(root = document) {
    return Array.from(root.querySelectorAll('main button, main a[role="button"]')).find((button) => {
      const label = (button.getAttribute('aria-label') || compact(button) || '').trim();
      return /^(?:show|see)\s+more(?:\s+jobs)?$/i.test(label) && !button.disabled && button.getAttribute('aria-disabled') !== 'true';
    });
  }

  /** The scrollable job list (job search keeps its own scroll area next to the page). */
  function listContainer(root = document) {
    return root.querySelector('.jobs-search-results-list, .scaffold-layout__list, [class*="jobs-search-results-list"]');
  }

  /**
   * Loads every card the page will show: scrolls the page and the list, and presses "Show more".
   * Stops when the count stops growing, and says whether it reached the end of what LinkedIn
   * shows (complete) or was cut short.
   */
  async function loadAllCards({ maxPasses = 40, wait = 700, root = document, source = 'company-jobs-tab' } = {}) {
    let previous = -1;
    let stable = 0;
    let expanded = 0;
    let reachedEnd = false;
    for (let pass = 0; pass < maxPasses; pass++) {
      const count = extractJobCards(root, source).length;
      stable = count === previous ? stable + 1 : 0;
      previous = count;
      const more = showMoreButton(root);
      if (more) {
        more.click();
        expanded++;
        stable = 0;
      } else if (stable >= 3) {
        reachedEnd = true;
        break;
      }
      const list = listContainer(root);
      if (list) list.scrollTop = list.scrollHeight;
      const last = Array.from(root.querySelectorAll(JOB_LINK)).at(-1);
      last?.scrollIntoView?.({ block: 'end' });
      window.scrollBy?.({ top: Math.max(500, Math.floor(window.innerHeight * 0.8)), behavior: 'auto' });
      await pause(wait);
    }
    return { cards: extractJobCards(root, source), complete: reachedEnd && !showMoreButton(root), expanded };
  }

  /** The page's own state: rendered cards, a real "no jobs" message, a LinkedIn warning, or not loaded. */
  function pageState(root = document) {
    const warning = globalThis.SkoutCaptureRestriction?.detect?.();
    if (warning) return { state: 'restricted', note: warning };
    const main = root.querySelector('main');
    if (!main) return { state: 'not_loaded', note: 'LinkedIn did not render the page.' };
    const mainText = compact(main) || '';
    if (/something went wrong|try refreshing the page/i.test(root.body?.innerText || mainText) && !extractJobCards(root).length) {
      return { state: 'not_loaded', note: 'LinkedIn reported an error loading the jobs.' };
    }
    if (extractJobCards(root).length) return { state: 'ok' };
    if (/no (?:matching )?jobs? (?:found|available|posted)|no (?:open )?jobs|no results found|isn['’]t hiring|does not have any (?:open )?jobs/i.test(mainText)) {
      return { state: 'empty' };
    }
    return { state: 'pending' };
  }

  /** One page of jobs: waits for LinkedIn to render, loads everything, reports what it could and could not see. */
  async function collectJobsPage({ source = 'company-jobs-tab', maxPasses = 40, wait = 700, readyAttempts = 40 } = {}) {
    let status = { state: 'pending' };
    for (let attempt = 0; attempt < readyAttempts; attempt++) {
      status = pageState();
      if (status.state !== 'pending') break;
      await pause(500);
    }
    if (status.state === 'restricted') return { ok: true, state: 'restricted', jobs: [], complete: false, notes: [status.note] };
    if (status.state === 'pending' || status.state === 'not_loaded') {
      return { ok: true, state: 'not_loaded', jobs: [], complete: false, notes: [status.note || 'The jobs did not finish loading.'] };
    }
    if (status.state === 'empty') {
      return { ok: true, state: 'empty', jobs: [], complete: true, notes: [], memberId: memberIdFromPage(), expectedTotal: 0 };
    }
    const loaded = await loadAllCards({ maxPasses, wait, source });
    const start = Number(new URL(location.href).searchParams.get('start')) || 0;
    const total = expectedTotal();
    const notes = [];
    // Another results page follows when this one is full and LinkedIn counts more than this page and the pages before it.
    const hasNext = source === 'job-search' && (total ? start + loaded.cards.length < total : loaded.cards.length >= SEARCH_PAGE_SIZE);
    if (!loaded.complete) notes.push(`Stopped loading after ${loaded.cards.length} roles (the page kept growing or was cut short).`);
    return {
      ok: true,
      state: 'ok',
      jobs: loaded.cards,
      complete: loaded.complete,
      hasNext,
      expectedTotal: total,
      memberId: memberIdFromPage(),
      notes,
    };
  }

  const REQUIREMENT_HEADING = /^(?:requirements?|qualifications?|minimum qualifications|basic qualifications|preferred qualifications|what you['’]ll need|what we['’]re looking for|what you bring|must[- ]haves?|your profile|skills? (?:and|&) experience)\s*:?$/i;
  // Headings that end a requirements list. A bullet such as "Experience with PostgreSQL" is not one.
  const SECTION_HEADING = /^(?:benefits?|perks(?: (?:and|&) benefits)?|what we offer|about (?:us|the (?:company|team|role|job))|responsibilities|key responsibilities|what you['’]ll do|the role|how to apply|compensation(?: (?:and|&) benefits)?|salary|pay range|equal opportunity.*|our (?:culture|values|mission)|why (?:join|work).*|who we are|nice to haves?|bonus points|preferred.*|working at .*|about .{1,40})\s*:?$/i;

  /** The lines that follow a "Requirements"-style heading, until the next heading. Nothing guessed. */
  function requirementsFrom(description) {
    if (!description) return undefined;
    const lines = description.split(/\n+/).map((line) => line.trim()).filter(Boolean);
    const start = lines.findIndex((line) => REQUIREMENT_HEADING.test(line));
    if (start < 0) return undefined;
    const body = [];
    for (const line of lines.slice(start + 1)) {
      if (body.length >= 1 && (SECTION_HEADING.test(line) || (/:$/.test(line) && line.length <= 60))) break;
      body.push(line);
      if (body.join('\n').length > 6000) break;
    }
    const joined = body.join('\n').trim();
    return joined.length >= 10 ? joined.slice(0, 15000) : undefined;
  }

  /** One job's own page: the description and the facts around it. */
  function parseJobDetail(root = document) {
    const area = root.querySelector('#job-details, .jobs-description__content, .jobs-box__html-content, [class*="jobs-description"], [data-view-name*="job-details"], article');
    const raw = area ? blockText(area) : undefined;
    const description = raw ? raw.replace(/\n{3,}/g, '\n\n').replace(/^\s*about the job\s*/i, '').trim().slice(0, 30000) : undefined;
    const top = root.querySelector('.job-details-jobs-unified-top-card__container--two-pane, .jobs-unified-top-card, [class*="job-details-jobs-unified-top-card"], main') || root;
    const topText = visibleText(top) || '';
    const insights = Array.from(top.querySelectorAll('[class*="job-insight"], [class*="workplace-type"], .ui-label'))
      .map((node) => visibleText(node) || '').join(' ');
    // "Job function" appears as a labelled row on the job page (older layout) or in the insights.
    let department;
    for (const node of root.querySelectorAll('h3, dt, span, p')) {
      if (/^job function$/i.test(compact(node) || '')) {
        const value = visibleText(node.nextElementSibling) || visibleText(node.parentElement?.querySelector('span:last-child'));
        if (value && value.length <= 200) { department = value; break; }
      }
    }
    const time = root.querySelector('time');
    const placeNode = top.querySelector('[class*="primary-description"] span, [class*="top-card__primary-description"] span');
    const location = visibleText(placeNode)?.split('·')[0]?.trim();
    return {
      description: description && description.length >= 40 ? description : undefined,
      requirements: requirementsFrom(description),
      department,
      employmentType: (insights || topText).match(EMPLOYMENT)?.[1],
      workplaceType: workplaceFrom(insights) || workplaceFrom(topText.slice(0, 400)),
      location: location && location.length <= 300 ? location : undefined,
      postedAt: isoDate(time?.getAttribute('datetime')),
      postedText: (compact(time) || topText.match(POSTED)?.[0])?.slice(0, 100),
    };
  }

  /** A job's page: opens its description ("See more"), then reads it. */
  async function collectJobDetail({ readyAttempts = 30 } = {}) {
    for (let attempt = 0; attempt < readyAttempts; attempt++) {
      const warning = globalThis.SkoutCaptureRestriction?.detect?.();
      if (warning) return { ok: true, state: 'restricted', note: warning };
      if (parseJobDetail().description) break;
      await pause(500);
    }
    // One bounded click: the description's own "See more" on this job's page.
    const expand = Array.from(document.querySelectorAll('main button')).find((button) => /^(?:see|show)\s+more$/i.test((button.getAttribute('aria-label') || compact(button) || '').trim()) && button.closest('#job-details, [class*="jobs-description"], article'));
    if (expand) { expand.click(); await pause(600); }
    const detail = parseJobDetail();
    return { ok: true, state: detail.description ? 'ok' : 'not_loaded', detail };
  }

  if (typeof chrome !== 'undefined' && chrome.runtime?.onMessage) {
    chrome.runtime.onMessage.addListener((request, sender, respond) => {
      if (sender.id !== chrome.runtime.id) return;
      if (request.type === 'JOBS_READER_READY') { respond({ ok: true, url: pageUrl() }); return; }
      if (request.type === 'COLLECT_JOBS_PAGE') {
        collectJobsPage(request.options || {}).then(respond).catch((error) => respond({ ok: false, error: error.message }));
        return true;
      }
      if (request.type === 'COLLECT_JOB_DETAIL') {
        collectJobDetail().then(respond).catch((error) => respond({ ok: false, error: error.message }));
        return true;
      }
    });
  }
  globalThis.SkoutCompanyJobs = { extractJobCards, expectedTotal, memberIdFromPage, loadAllCards, pageState, collectJobsPage, parseJobDetail, requirementsFrom, collectJobDetail, jobIdFromHref, SEARCH_PAGE_SIZE };
})();
