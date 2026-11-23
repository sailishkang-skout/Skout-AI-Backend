// One user-triggered company run. Company tabs only; never employee profiles.
globalThis.SkoutCompanyCapture = globalThis.SkoutCompanyCapture || (() => {
  const { publicIdFromUrl } = window.SkoutCaptureExtract;
  const { extractCompany } = globalThis.SkoutCapturePage;
  const sections = new Set(['', 'about', 'jobs', 'products', 'life', 'people', 'insights', 'posts']);
  const cleanObject = value => Object.fromEntries(Object.entries(value || {}).filter(([key, v]) => !key.startsWith('_') && v !== undefined && v !== null && v !== '' && (!Array.isArray(v) || v.length)));
  function pageUrl(value, companyId) {
    try {
      const url = new URL(value, location.origin);
      const parts = url.pathname.split('/').filter(Boolean);
      const section = parts[2] === 'home' ? '' : parts[2] || '';
      if (url.protocol !== 'https:' || url.hostname !== 'www.linkedin.com' || parts[0] !== 'company' || parts[1] !== companyId || parts.length > 3 || !sections.has(section)) return undefined;
      return `${url.origin}/company/${companyId}/${section ? section + '/' : ''}`;
    } catch { return undefined; }
  }
  function links(companyId) {
    return [...new Set([...document.querySelectorAll('main a[href]')].map(a => pageUrl(a.getAttribute('href'), companyId)).filter(Boolean))];
  }
  function merge(previous, next) {
    const result = {...previous, ...cleanObject(next)};
    for (const [field, id] of Object.entries({openJobs:'jobId',products:'slug',recentPosts:'activityId'})) {
      if (!previous[field]?.length && !next[field]?.length) continue;
      const items = new Map();
      for (const item of [...(previous[field] || []), ...(next[field] || [])]) {
        const key = item[id] || item.postUrl || item.productUrl || JSON.stringify([item.title, item.location]);
        items.set(key, {...items.get(key), ...cleanObject(item)});
      }
      result[field] = [...items.values()];
      if (field === 'recentPosts') result[field] = result[field].slice(0, 6);
    }
    if (previous.life || next.life) result.life = [...new Set([...(previous.life || []), ...(next.life || [])])];
    if (previous.peopleStats || next.peopleStats) result.peopleStats = {...previous.peopleStats,...next.peopleStats,breakdowns:{...previous.peopleStats?.breakdowns,...next.peopleStats?.breakdowns}};
    result.sectionCaptures = {...previous.sectionCaptures};
    for (const [key, capture] of Object.entries(next.sectionCaptures || {})) {
      const old = result.sectionCaptures[key];
      const isHome = value => /\/company\/[^/]+\/$/.test(value || '');
      if (old && !isHome(old.sourceUrl) && isHome(capture.sourceUrl)) continue;
      result.sectionCaptures[key] = capture;
    }
    // About values are more precise than the abbreviated topcard on other tabs.
    if (/\/about\/$/.test(previous.sourceUrl || '') && !/\/about\/$/.test(next.sourceUrl || '')) {
      for (const field of ['industry','headquarter','locationCountry','locationCountrySource','size','website','domain','phone','employeesOnLi','foundedAt','specialties','overview']) if (previous[field] !== undefined) result[field] = previous[field];
    }
    return result;
  }
  const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
  /** One line for the review: what the job scan found and how far it can be trusted. */
  function jobScanNote(scan) {
    const count = (scan.jobs || []).length;
    const verified = (scan.passes || []).length >= 2 && scan.passes.every(pass => pass.complete);
    if (scan.status === 'restricted') return `Job roles: LinkedIn restricted the page (${scan.error || 'a warning was shown'}). ${count} roles were read before it stopped.`;
    if (scan.status === 'not_loaded') return 'Job roles: the pages did not finish loading, so nothing can be said about open roles. Scan again.';
    if (scan.status === 'failed') return `Job roles: the scan failed (${scan.error || 'unknown error'}). ${count} roles were read before it stopped.`;
    return `Job roles: ${count} found by ${(scan.passes || []).length} scans${verified ? ', verified' : ', not fully verified'}.`;
  }
  // One reviewed batch saves at most this many people (the API's per-run cap).
  const BATCH_LEAD_LIMIT = 250;
  /**
   * Keeps a batch within the per-run cap. People from the resumable search come first: the saved
   * checkpoint advances past their pages. Extra People-page cards are left out and are found
   * again by the search in a later batch.
   */
  function limitBatch(profiles, searchIds, limit = BATCH_LEAD_LIMIT) {
    if (!Array.isArray(profiles) || profiles.length <= limit) return { profiles, deferred: 0 };
    const fromSearch = profiles.filter(profile => searchIds.has(profile.publicId));
    const others = profiles.filter(profile => !searchIds.has(profile.publicId));
    const kept = [...fromSearch, ...others].slice(0, limit);
    return { profiles: kept, deferred: profiles.length - kept.length };
  }
  const associatedMemberCount = value => {
    const match = String(value || '').match(/([\d,]+)\s+associated members/i);
    return match ? Number(match[1].replace(/,/g, '')) || undefined : undefined;
  };
  const focusTerms = value => String(value || '').split(',').map(term => term.trim().toLowerCase()).filter(Boolean).slice(0, 20);
  function selectedProfileFocus(override) {
    return {
      departments: focusTerms(override?.departments),
      seniorities: focusTerms(override?.seniorities),
    };
  }
  function matchesProfileFocus(profile, focus) {
    const title = String(profile?.headline || profile?.title || '').toLowerCase();
    const hasDepartments = !focus.departments.length || focus.departments.some(term => title.includes(term));
    const hasSeniorities = !focus.seniorities.length || focus.seniorities.some(term => title.includes(term));
    return hasDepartments && hasSeniorities;
  }
  const message = payload => new Promise((resolve, reject) => chrome.runtime.sendMessage(payload, response => {
    const error = chrome.runtime.lastError;
    if (error) reject(new Error(error.message));
    else if (!response?.ok) reject(new Error(response?.error || 'Capture did not return data.'));
    else resolve(response);
  }));
  /**
   * What the capture's verification scans concluded, per source: the people (and whether each way of
   * finding them was read), the job roles, and the About details. A source that failed or never
   * loaded is not an empty one.
   */
  function companyVerification({data, options, peopleTrace, aboutMissing, aboutVerified, errors}) {
    const verify = globalThis.SkoutCaptureVerify;
    const sections = {};
    const notes = [];
    if (options.includeCompany) sections.about = {found: 5 - aboutMissing.length, expected: 5, state: aboutVerified ? 'complete' : 'not_loaded'};
    if (options.includeCompany && !aboutVerified) notes.push('The About page could not be read.');
    if (options.includePeople && peopleTrace.search !== 'skipped') {
      const found = (data.peopleProfiles || []).length;
      let state;
      if (found) state = 'complete';
      else if (peopleTrace.restricted) state = 'restricted';
      else if (peopleTrace.directory === 'error' && ['error', 'unavailable'].includes(peopleTrace.search)) state = 'failed';
      // Zero people is confirmed only when the People page and the people search were both read.
      else if (peopleTrace.directory === 'none' && peopleTrace.search === 'none') state = 'none';
      else if (peopleTrace.search === 'none' && peopleTrace.directory === 'skipped') state = 'none';
      else state = 'not_loaded';
      sections.people = {found, state};
      const via = [peopleTrace.directory === 'cards' ? 'the People page' : '', ['results'].includes(peopleTrace.search) ? 'the company people search' : ''].filter(Boolean).join(' and ');
      if (found) notes.push(`People: ${found} found through ${via || 'LinkedIn'} in this batch.`);
      else if (state === 'none') notes.push('People: none found by the People page or the company people search, after a second scan.');
      else if (state === 'not_loaded') notes.push(`People: none found, but ${peopleTrace.search === 'unavailable' ? 'LinkedIn did not give a people search link' : 'a source did not load'}, so this is not confirmed.`);
      else if (peopleTrace.error) notes.push(`People: ${peopleTrace.error}`);
    }
    if (data.jobScan) {
      const scan = data.jobScan;
      const twice = (scan.passes || []).length >= 2 && scan.passes.every(pass => pass.complete);
      const count = (scan.jobs || []).length;
      const state = scan.status === 'restricted' ? 'restricted' : scan.status === 'not_loaded' ? 'not_loaded' : scan.status === 'failed' ? 'failed'
        : twice ? (count ? 'complete' : 'none') : (count ? 'incomplete' : 'not_loaded');
      sections.jobs = {found: count, state};
    }
    return verify.verdictFor(sections, {
      missing: aboutMissing,
      passes: 2,
      restricted: peopleTrace.restricted,
      notes: [...notes, ...errors.filter(error => /^Verification/.test(error)).slice(0, 3)],
    });
  }
  let running = false;
  async function initialCompanyData(options) {
    let data = extractCompany();
    // Dashboard-triggered remaining-profile runs land directly on /people/.
    // LinkedIn hydrates its associated-member link after the top card, so an
    // immediate read loses the only rendered route to the member results.
    if (!options.includePeople) return data;
    for (let attempt = 0; attempt < 24; attempt++) {
      data = extractCompany();
      if (data._peopleSearchUrl || data.peopleProfiles?.length || /associated members/i.test(data.peopleStats?.totalEmployeesText || '')) return data;
      await pause(500);
    }
    return data;
  }
  async function start(options = {includeCompany:true, includePeople:true}) {
    if (running) return;
    running = true;
    const companyId = publicIdFromUrl('company');
    const ui = globalThis.SkoutCaptureUi.progress('company');
    const status = {set textContent(value) { ui.set(value); }};
    let stopped = false;
    ui.onStop(() => {stopped = true; message({type:'CANCEL_COMPANY_READ'}).catch(() => {});});
    const root = `https://www.linkedin.com/company/${companyId}/`;
    const queue = options.includeCompany
      ? [...new Set([root, root + 'people/', root + 'about/', ...links(companyId)])].slice(0, 8)
      : [root, root + 'people/'];
    const seen = new Set();
    const errors = [];
    const warnings = [];
    status.textContent = 'Waiting for the company page to finish loading…';
    const loaded = await window.SkoutCaptureExtract.waitForPageReady({
      ready: () => Boolean(document.querySelector('main h1, h1')?.textContent?.trim()) && (document.querySelector('main')?.innerText || '').length > 150,
      onWait: () => { status.textContent = 'Waiting for the company page to finish loading…'; },
    });
    if (loaded.unavailable) { ui.done(loaded.reason, true); running = false; return; }
    if (loaded.timedOut) warnings.push('The open company page had not finished loading, so its details were read again from a fresh copy of the page.');
    status.textContent = options.includePeople ? 'Waiting for LinkedIn People results…' : 'Reading company details…';
    let data = await initialCompanyData(options);
    let about;
    let peopleSearchUrl = data._peopleSearchUrl;
    let directoryRead = false;
    let searchIds = new Set();
    let read = 0;
    try {
      while (queue.length && !stopped) {
        if (publicIdFromUrl('company') !== companyId) {stopped = true; errors.push('The original tab moved to another company.');break;}
        const url = queue.shift();
        if (seen.has(url)) continue;
        seen.add(url);
        const label = new URL(url).pathname.split('/')[3] || 'home';
        status.textContent = `Reading ${label} (${seen.size} of ${seen.size + queue.length})…`;
        try {
          if (read > 0) await pause(1200);
          const result = await message({type:'READ_COMPANY_PAGE',url,companyId});
          if (result.cancelled) {stopped = true;break;}
          data = merge(data, result.data);
          if (result.data._peopleSearchUrl) peopleSearchUrl = result.data._peopleSearchUrl;
          if (/\/about\/$/.test(url)) about = result.data;
          read++;
          warnings.push(...(result.warnings || []).map(w => `${label}: ${w}`));
          for (const link of options.includeCompany ? (result.links || []) : []) {
            const safe = pageUrl(link, companyId);
            if (safe && !seen.has(safe) && !queue.includes(safe) && seen.size + queue.length < 8) queue.push(safe);
          }
        } catch (error) {errors.push(`${label}: ${error.message}`);}
      }
      // Reapply the detailed About payload last when available, regardless of traversal order.
      if (about) data = merge(data, about);
      // Verification of the company's own details: a field the pages did not show gets one more look
      // at the About page (scrolled further), then is named as not found.
      const ABOUT_FIELDS = [['industry','Industry'],['headquarter','Headquarters'],['size','Company size'],['website','Website'],['overview','About']];
      const aboutMissing = () => ABOUT_FIELDS.filter(([key]) => !data[key]).map(([, label]) => label);
      let aboutVerified = Boolean(about);
      if (!stopped && options.includeCompany && aboutMissing().length) {
        status.textContent = 'Verifying company details: second look at the About page…';
        try {
          const again = await message({type:'READ_COMPANY_PAGE',url:root + 'about/',companyId,deep:true});
          if (!again.cancelled) { data = merge(data, again.data); about = again.data; aboutVerified = true; }
        } catch (error) { warnings.push(`Verification of the About page: ${error.message}`); }
      }
      // Capture the individual cards that LinkedIn actually renders on the
      // Company People page. Its "Page 1 of N" control changes aggregate
      // analytics, not the member-card list, so it must not be treated as an
      // employee-directory paginator.
      // LinkedIn sometimes hides the "associated members" link. Use the search an earlier run
      // saved, or build it from the company's LinkedIn id.
      if (!stopped && options.includePeople && !peopleSearchUrl) {
        try {
          const saved = await message({type:'GET_SAVED_PEOPLE_SEARCH', companyId});
          peopleSearchUrl = saved.url;
        } catch { /* none saved */ }
        if (!peopleSearchUrl && /^\d{1,20}$/.test(data.memberId || '')) {
          peopleSearchUrl = `https://www.linkedin.com/search/results/people/?currentCompany=${encodeURIComponent(JSON.stringify([data.memberId]))}`;
        }
      }
      // Where the people came from, and whether each source was read: a source that failed is not
      // an empty one, so a failed fallback is never reported as "no people".
      const peopleTrace = {directory:'skipped', search: options.includePeople ? (peopleSearchUrl ? 'pending' : 'unavailable') : 'skipped', error: undefined, restricted: false};
      const noteFailure = (error) => { peopleTrace.error = error.message; if (/restricted|warning|verify it/i.test(error.message)) peopleTrace.restricted = true; };
      const readDirectory = async (deep) => {
        try {
          const directoryResult = await message({type:'READ_COMPANY_PEOPLE_DIRECTORY',url:root + 'people/',companyId,deep});
          if (directoryResult.cancelled) return;
          directoryRead = true;
          if (Array.isArray(directoryResult.peopleProfiles) && directoryResult.peopleProfiles.length) {
            peopleTrace.directory = 'cards';
            data.peopleProfiles = directoryResult.peopleProfiles;
            warnings.push(...(directoryResult.warnings || []));
          } else {
            peopleTrace.directory = 'none';
          }
        } catch (error) { peopleTrace.directory = 'error'; noteFailure(error); warnings.push(`Company People page: ${error.message}`); }
      };
      const readSearch = async () => {
        try {
          const expectedAssociatedMembers = associatedMemberCount(data.peopleStats?.totalEmployeesText);
          const peopleResult = await message({type:'READ_COMPANY_PEOPLE_SEARCH',url:peopleSearchUrl,companyId,expectedAssociatedMembers});
          if (peopleResult.cancelled) return;
          if (!Array.isArray(peopleResult.peopleProfiles)) return;
          peopleTrace.search = peopleResult.peopleProfiles.length ? 'results' : 'none';
          searchIds = new Set(peopleResult.peopleProfiles.map(profile => profile.publicId));
          if (peopleResult.progress) data._captureProgress = {...peopleResult.progress,complete:peopleResult.complete};
          if (peopleResult.checkpointToken) data._captureCheckpointToken = peopleResult.checkpointToken;
          const merged = new Map((data.peopleProfiles || []).map(profile => [profile.publicId, profile]));
          for (const profile of peopleResult.peopleProfiles) {
            const directCard = merged.get(profile.publicId);
            // A direct card from the company People page is stronger
            // evidence than a broad search result; do not downgrade it.
            merged.set(profile.publicId, directCard?.associationSource === 'company-people-page'
              ? {...profile, ...directCard}
              : {...directCard, ...profile});
          }
          data.peopleProfiles = [...merged.values()];
          warnings.push(...(peopleResult.warnings || []));
        } catch (error) { peopleTrace.search = 'error'; noteFailure(error); errors.push(`associated people: ${error.message}`); }
      };
      // A continued queue batch already has the People page cards from its first batch, unless
      // there is no people search to continue: then the People page is the only source.
      if (!stopped && options.includePeople && (!options.resume || !peopleSearchUrl)) {
        status.textContent = 'Reading visible company people pages…';
        await readDirectory(false);
        if (peopleTrace.directory === 'none') warnings.push('The Company People page showed no employee cards (LinkedIn may show only suggestions there). Reading the company-filtered people search instead.');
      }
      if (!stopped && options.includePeople && peopleSearchUrl) {
        status.textContent = 'Reading additional visible associated people…';
        await readSearch();
      }
      // Second scan: nothing was found yet. Look again before concluding there are no people: the
      // search once more (it may have been slow to render), then the People page, scrolled further.
      if (!stopped && options.includePeople && !options.resume && !(data.peopleProfiles || []).length && !peopleTrace.restricted) {
        status.textContent = 'No people found yet: second scan…';
        await pause(2500);
        if (peopleSearchUrl) await readSearch();
        if (!(data.peopleProfiles || []).length && !stopped) await readDirectory(true);
        peopleTrace.secondScan = true;
      }
      if (!stopped && options.includePeople && !peopleSearchUrl) {
        warnings.push('LinkedIn did not render an associated-members results link for this company, so no profile search was started.');
      }
      // Job roles: an initial scan and an independent verification scan (see collectJobScan).
      if (!stopped && options.includeCompany && options.includeJobs !== false) {
        status.textContent = 'Scanning job roles: initial scan, then a verification scan…';
        try {
          const scanned = await message({type:'SCAN_COMPANY_JOBS', companyId, memberId: data.memberId, name: data.name});
          if (scanned.scan) { data.jobScan = scanned.scan; warnings.push(jobScanNote(scanned.scan)); }
        } catch (error) { errors.push(`job roles: ${error.message}`); }
      }
      const focus = selectedProfileFocus(options.focus);
      if (!options.includePeople) delete data.peopleProfiles;
      const discovered = data.peopleProfiles?.length || 0;
      if (!stopped && options.includePeople && data.peopleProfiles?.length && (focus.departments.length || focus.seniorities.length)) {
        const before = data.peopleProfiles.length;
        data.peopleProfiles = data.peopleProfiles.filter(profile => matchesProfileFocus(profile, focus));
        warnings.push(`Company capture focus kept ${data.peopleProfiles.length} of ${before} visible profiles (${focus.departments.length ? `departments: ${focus.departments.join(', ')}` : 'all departments'}; ${focus.seniorities.length ? `seniority/title: ${focus.seniorities.join(', ')}` : 'all seniority levels'}).`);
      }
      const limited = limitBatch(data.peopleProfiles, searchIds);
      if (limited.deferred) {
        data.peopleProfiles = limited.profiles;
        warnings.push(`This batch keeps ${BATCH_LEAD_LIMIT} people, the most one save allows. ${limited.deferred} more will be read in the next batch: save this one, then choose Continue capturing queue.`);
      }
      if (options.includePeople) data._captureStats = {discovered, matched: data.peopleProfiles?.length || 0, alreadyCaptured: 0, readyToCapture: data.peopleProfiles?.length || 0};
      // Ask the dashboard which directly associated profiles already exist
      // before presenting review. This keeps a later "capture remaining"
      // run from reopening and re-enriching the same public profile IDs.
      if (!stopped && options.includePeople && data.peopleProfiles?.length) {
        try {
          const known = await message({type:'GET_CAPTURED_COMPANY_PROFILE_IDS', companyId});
          const knownIds = new Set(known.data?.publicIds || []);
          const beforeDedup = data.peopleProfiles.length;
          data.peopleProfiles = data.peopleProfiles.filter(profile => !knownIds.has(profile.publicId));
          data._captureStats.alreadyCaptured = beforeDedup - data.peopleProfiles.length;
          data._captureStats.readyToCapture = data.peopleProfiles.length;
          if (data._captureStats.alreadyCaptured) warnings.push(`Skipped ${data._captureStats.alreadyCaptured} profiles already captured for this company.`);
        } catch (error) {
          data._captureStats.readyToCapture = data.peopleProfiles.length;
          warnings.push(`Could not check existing profiles; server-side duplicate protection will still apply (${error.message}).`);
        }
      }
      data.sourceUrl = root;
      data.verification = companyVerification({data, options, peopleTrace, aboutMissing: aboutMissing(), aboutVerified, errors});
      const notes = [`${stopped ? 'Stopped. ' : ''}Read ${read} company pages. All collected details are saved together.`,
        ...errors.map(error => `Could not read ${error}`), ...new Set(warnings),
        'Includes accessible company tabs and loaded cards. Restricted pages, external job-search results, and older posts may be absent.'];
      await globalThis.SkoutCaptureUi.review('company', data, notes);
      ui.done(`Read ${read} company pages${data.peopleProfiles?.length ? ` and ${data.peopleProfiles.length} visible people` : ''}. Review before saving.`);
    } catch (error) {ui.done(error.message, true);}
    finally {running = false;}
  }
  let collecting = false;
  async function collectPeopleDirectory(companyId, expectedUrl, deep = false) {
    if (collecting) throw new Error('This page is already being read.');
    collecting = true;
    try {
      if (publicIdFromUrl('company') !== companyId || pageUrl(location.href, companyId) !== expectedUrl) throw new Error('Company People page changed during capture.');
      // The company-page shell and the aggregate graph render before the
      // member cards. Waiting only for <main> made a temporary tab report an
      // empty directory and fall back to a truncated search result.
      let visibleProfiles = [];
      for (let attempt = 0; attempt < 30; attempt++) {
        // extractCompany().peopleProfiles supports both the legacy company
        // card and LinkedIn's current compact People-card layout. Waiting on
        // the legacy selector here was preventing the new layout from ever
        // reaching the discovery save step.
        visibleProfiles = extractCompany().peopleProfiles || [];
        if (visibleProfiles.length) break;
        // Cards below the fold render only as the page scrolls; the second scan scrolls further.
        window.scrollBy({top: Math.max(400, Math.floor(window.innerHeight * 0.7)), behavior: 'auto'});
        if (document.querySelector('main')?.textContent?.includes('People you may know') && extractCompany().peopleStats?.totalEmployeesText) break;
        await pause(500);
      }
      if (!visibleProfiles.length) return {ok:true,peopleProfiles:[],warnings:['The Company People page showed recommendations, not direct employee cards. The company-filtered search will be used for candidates.']};
      const people = new Map();
      for (const profile of visibleProfiles) if (profile.publicId) people.set(profile.publicId, {...profile, associationSource:'company-people-page'});
      return {ok:true,peopleProfiles:[...people.values()],warnings:[`Collected ${people.size} profiles from LinkedIn's visible company People pages.`]};
    } finally { collecting = false; }
  }
  async function collect(companyId, expectedUrl, deep = false) {
    if (collecting) throw new Error('This page is already being read.');
    collecting = true;
    const banner = document.createElement('div');
    banner.style.cssText = 'position:fixed;top:0;left:0;right:0;padding:14px;background:#0a66c2;color:white;z-index:2147483647;font:14px system-ui';
    banner.textContent = 'Skout capture: collecting company details. Keep this temporary tab open. ';
    const cancel = document.createElement('button');cancel.textContent = 'Stop capture';
    cancel.onclick = () => message({type:'CANCEL_COMPANY_READ'}).catch(() => {});banner.appendChild(cancel);document.body.appendChild(banner);
    try {
      let ready;
      for (let attempt = 0; attempt < 12; attempt++) {
        if (publicIdFromUrl('company') !== companyId || pageUrl(location.href, companyId) !== expectedUrl) throw new Error('LinkedIn redirected this page; it was not captured.');
        ready = extractCompany();
        if (ready.name && document.querySelector('main')) break;
        await pause(500);
      }
      if (!ready?.name) throw new Error('Company content did not load. Check sign-in or access.');
      if (/\/people\/$/.test(expectedUrl)) {
        for (let attempt = 0; attempt < 20; attempt++) {
          ready = extractCompany();
          if (ready.peopleStats?.totalEmployeesText || ready.peopleProfiles?.length) break;
          await pause(500);
        }
      }
      // The verification scan reads further: scroll the page so lazily rendered details load.
      if (deep) {
        for (let pass = 0; pass < 14; pass++) { window.scrollBy({top: Math.max(500, Math.floor(window.innerHeight * 0.8)), behavior: 'auto'}); await pause(700); }
        window.scrollTo(0, 0);
        await pause(400);
      }
      const result = extractCompany();
      const warnings = ['Details the page did not render were not captured. The verification scan looks again, and anything still missing is listed in the review.'];
      return {ok:true,data:result,links:links(companyId),warnings};
    } finally {collecting = false;banner.remove();}
  }
  if (typeof chrome !== 'undefined' && chrome.runtime?.onMessage) chrome.runtime.onMessage.addListener((request, sender, respond) => {
    if (sender.id !== chrome.runtime.id) return;
    if (request.type === 'COMPANY_READER_READY') {respond({ok:true,url:pageUrl(location.href, request.companyId)});return;}
    if (request.type === 'COLLECT_COMPANY_PAGE') {
      collect(request.companyId,request.url,request.deep === true).then(respond).catch(error => respond({ok:false,error:error.message}));return true;
    }
    if (request.type === 'COLLECT_COMPANY_PEOPLE_DIRECTORY') {
      collectPeopleDirectory(request.companyId,request.url,request.deep === true).then(respond).catch(error => respond({ok:false,error:error.message}));return true;
    }
  });
  return {start,merge,pageUrl,links,limitBatch};
})();
