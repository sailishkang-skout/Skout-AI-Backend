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
      if (url.protocol !== 'https:' || url.hostname !== 'www.linkedin.com' || parts[0] !== 'company' || parts[1] !== companyId || parts.length > 3 || !sections.has(parts[2] || '')) return undefined;
      return `${url.origin}/company/${companyId}/${parts[2] ? parts[2] + '/' : ''}`;
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
      for (const field of ['industry','headquarter','size','website','domain','phone','employeesOnLi','foundedAt','specialties','overview']) if (previous[field] !== undefined) result[field] = previous[field];
    }
    return result;
  }
  const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
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
    status.textContent = options.includePeople ? 'Waiting for LinkedIn People results…' : 'Reading company details…';
    let data = await initialCompanyData(options);
    let about;
    let peopleSearchUrl = data._peopleSearchUrl;
    let directoryRead = false;
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
      // Capture the individual cards that LinkedIn actually renders on the
      // Company People page. Its "Page 1 of N" control changes aggregate
      // analytics, not the member-card list, so it must not be treated as an
      // employee-directory paginator.
      if (!stopped && options.includePeople) {
        status.textContent = 'Reading visible company people pages…';
        try {
          const directoryResult = await message({type:'READ_COMPANY_PEOPLE_DIRECTORY',url:root + 'people/',companyId});
          if (!directoryResult.cancelled) {
            directoryRead = true;
            if (Array.isArray(directoryResult.peopleProfiles) && directoryResult.peopleProfiles.length) {
              data.peopleProfiles = directoryResult.peopleProfiles;
              warnings.push(...(directoryResult.warnings || []));
            } else {
              warnings.push('The Company People page had no direct employee cards; checking LinkedIn’s company-filtered people search.');
            }
          }
        } catch (error) { warnings.push(`Company People page: ${error.message}`); }
      }
      if (!stopped && options.includePeople && peopleSearchUrl) {
        status.textContent = 'Reading additional visible associated people…';
        try {
          const expectedAssociatedMembers = associatedMemberCount(data.peopleStats?.totalEmployeesText);
          const peopleResult = await message({type:'READ_COMPANY_PEOPLE_SEARCH',url:peopleSearchUrl,companyId,expectedAssociatedMembers});
          if (!peopleResult.cancelled && Array.isArray(peopleResult.peopleProfiles)) {
            if (peopleResult.checkpointToken) data._captureCheckpointToken = peopleResult.checkpointToken;
            if (peopleResult.progress) data._captureProgress = {...peopleResult.progress,complete:peopleResult.complete};
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
          }
          warnings.push(...(peopleResult.warnings || []));
        } catch (error) { errors.push(`associated people: ${error.message}`); }
      }
      if (!stopped && options.includePeople && !peopleSearchUrl) {
        warnings.push('LinkedIn did not render an associated-members results link for this company, so no profile search was started.');
      }
      const focus = selectedProfileFocus(options.focus);
      if (!options.includePeople) delete data.peopleProfiles;
      const discovered = data.peopleProfiles?.length || 0;
      if (!stopped && options.includePeople && data.peopleProfiles?.length && (focus.departments.length || focus.seniorities.length)) {
        const before = data.peopleProfiles.length;
        data.peopleProfiles = data.peopleProfiles.filter(profile => matchesProfileFocus(profile, focus));
        warnings.push(`Company capture focus kept ${data.peopleProfiles.length} of ${before} visible profiles (${focus.departments.length ? `departments: ${focus.departments.join(', ')}` : 'all departments'}; ${focus.seniorities.length ? `seniority/title: ${focus.seniorities.join(', ')}` : 'all seniority levels'}).`);
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
      const notes = [`${stopped ? 'Stopped. ' : ''}Read ${read} company pages. All collected details are saved together.`,
        ...errors.map(error => `Could not read ${error}`), ...new Set(warnings),
        'Includes accessible company tabs and loaded cards. Restricted pages, external job-search results, and older posts may be absent.'];
      await globalThis.SkoutCaptureUi.review('company', data, notes);
      ui.done(`Read ${read} company pages${data.peopleProfiles?.length ? ` and ${data.peopleProfiles.length} visible people` : ''}. Review before saving.`);
    } catch (error) {ui.done(error.message, true);}
    finally {running = false;}
  }
  let collecting = false;
  async function collectPeopleDirectory(companyId, expectedUrl) {
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
        if (document.querySelector('main')?.textContent?.includes('People you may know') && extractCompany().peopleStats?.totalEmployeesText) break;
        await pause(500);
      }
      if (!visibleProfiles.length) return {ok:true,peopleProfiles:[],warnings:['The Company People page showed recommendations, not direct employee cards. The company-filtered search will be used for candidates.']};
      const people = new Map();
      for (const profile of visibleProfiles) if (profile.publicId) people.set(profile.publicId, {...profile, associationSource:'company-people-page'});
      return {ok:true,peopleProfiles:[...people.values()],warnings:[`Collected ${people.size} profiles from LinkedIn's visible company People pages.`]};
    } finally { collecting = false; }
  }
  async function collect(companyId, expectedUrl) {
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
      const result = extractCompany();
      const warnings = ['Only content already rendered on this page was captured. Scroll or open carousel cards yourself, then capture again to add more.'];
      return {ok:true,data:result,links:links(companyId),warnings};
    } finally {collecting = false;banner.remove();}
  }
  if (typeof chrome !== 'undefined' && chrome.runtime?.onMessage) chrome.runtime.onMessage.addListener((request, sender, respond) => {
    if (sender.id !== chrome.runtime.id) return;
    if (request.type === 'COMPANY_READER_READY') {respond({ok:true,url:pageUrl(location.href, request.companyId)});return;}
    if (request.type === 'COLLECT_COMPANY_PAGE') {
      collect(request.companyId,request.url).then(respond).catch(error => respond({ok:false,error:error.message}));return true;
    }
    if (request.type === 'COLLECT_COMPANY_PEOPLE_DIRECTORY') {
      collectPeopleDirectory(request.companyId,request.url).then(respond).catch(error => respond({ok:false,error:error.message}));return true;
    }
  });
  return {start,merge,pageUrl,links};
})();
