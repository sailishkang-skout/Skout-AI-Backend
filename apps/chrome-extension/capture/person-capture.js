// Controlled, user-triggered person capture. Reads only the profile's own
// allowlisted detail pages; never enumerates other people or uses private APIs.
globalThis.SkoutPersonCapture = globalThis.SkoutPersonCapture || (() => {
  const { publicIdFromUrl } = window.SkoutCaptureExtract;
  const { extractPerson } = globalThis.SkoutCapturePage;
  const allowed = new Set(['', 'details/experience', 'details/education', 'details/skills', 'details/certifications', 'details/languages', 'details/volunteering-experiences', 'details/honors', 'details/publications', 'details/patents', 'details/courses', 'details/projects', 'details/organizations', 'recent-activity', 'overlay/contact-info']);
  const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
  const pageUrl = (value, id) => {
    try {
      const u = new URL(value, location.origin), parts = u.pathname.split('/').filter(Boolean);
      if (u.protocol !== 'https:' || u.hostname !== 'www.linkedin.com' || parts[0] !== 'in' || parts[1] !== id) return undefined;
      const suffix = parts.slice(2).join('/');
      if (suffix && !allowed.has(suffix)) return undefined;
      return `${u.origin}/in/${id}/${suffix ? suffix + '/' : ''}`;
    } catch { return undefined; }
  };
  const links = id => [...new Set([...document.querySelectorAll('main a[href]')].map(a => pageUrl(a.getAttribute('href'), id)).filter(Boolean))];
  const merge = (a, b) => {
    const out = {...a};
    // Keep the most reliable location seen across pages (header > Contact info > job > bio).
    const rankA = a?._locationRank ?? (a?.locationName ? 1 : 99), rankB = b?._locationRank ?? 99;
    for (const [key, value] of Object.entries(b || {})) {
      if (key === '_locationRank') continue;
      // Keep the Contact info read (for the review note) from whichever page found details.
      if (key === '_contactInfo') {
        if (value && (value.email || value.phone || value.website || value.address)) out._contactInfo = { ...(out._contactInfo || {}), ...value };
        continue;
      }
      // Counts: keep the first real value; a later page that missed the header never clears it.
      if ((key === 'followersCount' || key === 'connectionsCount') && Number.isFinite(out[key])) continue;
      if (key === 'locationName' && rankB > rankA) continue;
      if (key.startsWith('_') || value === undefined || value === null || value === '') continue;
      if (Array.isArray(value)) out[key] = [...(out[key] || []), ...value];
      else out[key] = value;
    }
    for (const key of ['educations','skills','recommendations','certifications','languages','volunteerExperiences','honors','publications','patents','courses','organizations','projects','websites','currentCompanies','previousCompanies']) {
      if (Array.isArray(out[key])) {
        if (key === 'skills') {
          const byName = new Map();
          for (const skill of out.skills) {
            const name = String(skill?.name || '').trim();
            if (!name) continue;
            const normalized = name.toLowerCase();
            const previous = byName.get(normalized);
            byName.set(normalized, !previous || (skill.endorsements || 0) > (previous.endorsements || 0) ? skill : previous);
          }
          out.skills = [...byName.values()];
          continue;
        }
        const seen = new Set();
        out[key] = out[key].filter(item => { const sig = JSON.stringify(item); if (seen.has(sig)) return false; seen.add(sig); return true; });
      }
    }
    // Header-only entries are stand-ins until the real Education/Experience rows load.
    for (const key of ['educations', 'currentCompanies']) {
      if (Array.isArray(out[key]) && out[key].some((item) => item?.source !== 'topcard')) out[key] = out[key].filter((item) => item?.source !== 'topcard');
    }
    if (b?.locationName && rankB <= rankA) out._locationRank = rankB;
    else if (a?._locationRank !== undefined) out._locationRank = a._locationRank;
    return out;
  };
  const message = payload => new Promise((resolve, reject) => chrome.runtime.sendMessage(payload, response => {
    const error = chrome.runtime.lastError;
    if (error) reject(new Error(error.message));
    else if (!response?.ok) reject(new Error(response?.error || 'Profile page could not be read.'));
    else resolve(response);
  }));
  let running = false;
  async function start() {
    if (running) return;
    running = true;
    const id = publicIdFromUrl('person'), root = `https://www.linkedin.com/in/${id}/`;
    const ui = globalThis.SkoutCaptureUi.progress('person');
    ui.onStop(() => { message({type:'CANCEL_PERSON_READ'}).catch(() => {}); });
    // Queue the core detail pages explicitly because the profile preview may
    // show only a subset. They belong to the same profile and are read only
    // after the user starts a capture.
    const queue = [...new Set([
      root,
      `${root}details/experience/`,
      `${root}details/education/`,
      `${root}details/skills/`,
      `${root}overlay/contact-info/`,
      ...links(id),
    ])].slice(0, 16), seen = new Set(), errors = [], warnings = [];
    let data = extractPerson(), read = 0;
    try {
      while (queue.length && !ui.stopped) {
        if (publicIdFromUrl('person') !== id) { errors.push('The original tab moved to another profile.'); break; }
        const url = queue.shift(); if (seen.has(url)) continue; seen.add(url);
        ui.set(`Reading ${new URL(url).pathname.split('/').slice(2).join('/') || 'profile'} (${seen.size} of ${seen.size + queue.length}). No other people are opened.`);
        try {
          if (read > 0) await pause(1200);
          const result = await message({type:'READ_PERSON_PAGE',url,personId:id});
          if (result.cancelled) { ui.stop(); break; }
          data = merge(data, result.data); read++;
          warnings.push(...(result.warnings || []));
          for (const link of result.links || []) { const safe = pageUrl(link,id); if (safe && !seen.has(safe) && !queue.includes(safe) && seen.size + queue.length < 18) queue.push(safe); }
        } catch (error) { errors.push(`${new URL(url).pathname}: ${error.message}`); }
      }
      data.publicId = id; data.sourceUrl = root;
      const notes = [`${ui.stopped ? 'Stopped. ' : ''}Read ${read} profile pages. Only content already rendered on each page was captured.`,
        ...errors.map(error => `Could not read ${error}`), ...new Set(warnings)];
      await globalThis.SkoutCaptureUi.review('person', data, notes);
      ui.done(`Read ${read} profile pages. Review before saving.`, !read && errors.length > 0);
    } catch (error) { ui.done(error.message, true); }
    finally { running = false; }
  }
  let collecting = false;
  async function collectFullyRenderedSkills() {
    // LinkedIn virtualizes long Skills lists. Capture each rendered batch while
    // moving through the signed-in user's already-visible detail page, rather
    // than relying on the final DOM snapshot (which may contain only the last
    // few rows). This is bounded and runs only after an explicit Capture click.
    let combined = {}, stablePasses = 0, previousCount = 0;
    window.scrollTo(0, 0);
    await pause(500);
    for (let pass = 0; pass < 30; pass++) {
      combined = merge(combined, extractPerson());
      const count = Array.isArray(combined.skills) ? combined.skills.length : 0;
      // On some Skills pages LinkedIn uses a generic "Show more" label.
      // This reader runs only on the person's /details/skills/ page, so this
      // bounded click can only expand that page's skills collection.
      const showMore = Array.from(document.querySelectorAll('button')).find((button) => /^(show more|show all)(?:\s+skills)?$/i.test(button.textContent?.trim() || '') && !button.disabled);
      if (showMore && !showMore.disabled) { showMore.click(); await pause(750); }
      const atBottom = window.scrollY + window.innerHeight >= document.documentElement.scrollHeight - 8;
      stablePasses = count === previousCount ? stablePasses + 1 : 0;
      previousCount = count;
      if (atBottom && stablePasses >= 2 && !showMore && (count > 0 || pass >= 15)) break;
      window.scrollBy({top: Math.max(520, Math.floor(window.innerHeight * 0.8)), behavior: 'auto'});
      await pause(650);
    }
    combined = merge(combined, extractPerson());
    window.scrollTo(0, 0);
    return combined;
  }
  // Detail-page slug -> fields it fills, for the generic "Show all" pages.
  const DETAIL_FIELDS = {
    experience: ['currentCompanies', 'previousCompanies'], certifications: ['certifications'], languages: ['languages'],
    'volunteering-experiences': ['volunteerExperiences'], honors: ['honors'], publications: ['publications'],
    patents: ['patents'], courses: ['courses'], projects: ['projects'], organizations: ['organizations'],
  };
  const countFields = (data, fields) => fields.reduce((sum, key) => sum + (Array.isArray(data?.[key]) ? data[key].length : 0), 0);
  // Scroll a detail page so LinkedIn renders every row, reading as it goes.
  async function collectFullyRenderedSection(fields) {
    let combined = {}, stablePasses = 0, previousCount = 0;
    window.scrollTo(0, 0);
    await pause(500);
    for (let pass = 0; pass < 30; pass++) {
      combined = merge(combined, extractPerson());
      const count = countFields(combined, fields);
      const atBottom = window.scrollY + window.innerHeight >= document.documentElement.scrollHeight - 8;
      stablePasses = count === previousCount ? stablePasses + 1 : 0;
      previousCount = count;
      if (atBottom && stablePasses >= 2) break;
      window.scrollBy({top: Math.max(520, Math.floor(window.innerHeight * 0.8)), behavior: 'auto'});
      await pause(650);
    }
    combined = merge(combined, extractPerson());
    window.scrollTo(0, 0);
    return combined;
  }
  async function collectFullyRenderedEducation() {
    let combined = {}, stablePasses = 0, previousCount = 0;
    window.scrollTo(0, 0);
    await pause(500);
    for (let pass = 0; pass < 30; pass++) {
      combined = merge(combined, extractPerson());
      const count = Array.isArray(combined.educations) ? combined.educations.length : 0;
      const atBottom = window.scrollY + window.innerHeight >= document.documentElement.scrollHeight - 8;
      stablePasses = count === previousCount ? stablePasses + 1 : 0;
      previousCount = count;
      // Rows can render a few seconds after the title: keep waiting while none have shown.
      if (atBottom && stablePasses >= 2 && (count > 0 || pass >= 16)) break;
      window.scrollBy({top: Math.max(520, Math.floor(window.innerHeight * 0.8)), behavior: 'auto'});
      await pause(650);
    }
    combined = merge(combined, extractPerson());
    window.scrollTo(0, 0);
    return combined;
  }
  async function collect(id, expectedUrl) {
    if (collecting) throw new Error('This page is already being read.');
    collecting = true;
    try {
      const detailMatch = expectedUrl.match(/\/details\/(education|skills)\/$/);
      const detailName = detailMatch?.[1] === 'education' ? 'Education' : detailMatch?.[1] === 'skills' ? 'Skills' : undefined;
      const isSkillsPage = detailMatch?.[1] === 'skills';
      const hasRenderedSection = (name) =>
        !!document.querySelector(
          `[componentkey*="${name}TopLevelSection" i], [componentkey*="${name}DetailsSection" i], [componentkey*="${name === 'Skills' ? 'SkillDetails' : `${name}Details`}" i]`,
        ) ||
        Array.from(document.querySelectorAll('main h1, main h2, main h3, main [role="heading"]'))
          .some((heading) => new RegExp(`^${name}$`, 'i').test(heading.textContent?.trim() || ''));
      const hasDetailsPageTitle = (name) =>
        location.pathname.endsWith(`/details/${name.toLowerCase()}/`) &&
        Array.from(document.querySelectorAll('main p, main span, main div, main h4'))
          .some((node) => !Array.from(node.children).some((child) => child.textContent?.trim()) &&
            new RegExp(`^${name}$`, 'i').test(node.textContent?.trim() || ''));
      let data;
      let previousEducation = '';
      let stableEducationPasses = 0;
      let sectionFound = !detailName;
      const isContactPage = expectedUrl.endsWith('/overlay/contact-info/');
      let contactLinkOpened = false;
      let emptyContactPasses = 0;
      const otherDetail = Object.keys(DETAIL_FIELDS).find((slug) => expectedUrl.endsWith(`/details/${slug}/`));

      for (let attempt = 0; attempt < 40; attempt++) {
        // LinkedIn may show the Contact info overlay on the profile's own URL.
        const here = pageUrl(location.href, id);
        const sameContactPage = isContactPage && here === expectedUrl.replace(/overlay\/contact-info\/$/, '');
        if (here !== expectedUrl && !sameContactPage) throw new Error('Profile page changed during capture.');
        sectionFound ||= hasRenderedSection(detailName) || hasDetailsPageTitle(detailName);
        if (isSkillsPage && sectionFound) {
          data = await collectFullyRenderedSkills();
          break;
        }
        // Collect once Education rows exist (or after ~8s, for people with none listed).
        if (detailName === 'Education' && sectionFound && (extractPerson().educations?.some((e) => e.source !== 'topcard') || attempt >= 16)) {
          data = await collectFullyRenderedEducation();
          break;
        }

        data = extractPerson();
        if (detailName === 'Education' && sectionFound) {
          const currentEducation = JSON.stringify(data.educations || []);
          stableEducationPasses = currentEducation === previousEducation ? stableEducationPasses + 1 : 0;
          previousEducation = currentEducation;
          if (data.educations?.length && stableEducationPasses >= 3) break;
        } else if (otherDetail) {
          // Wait until the section's rows render (~6s at most), then read it all.
          if (countFields(data, DETAIL_FIELDS[otherDetail]) || attempt >= 12) {
            data = await collectFullyRenderedSection(DETAIL_FIELDS[otherDetail]);
            break;
          }
        } else if (isContactPage) {
          // Wait for the Contact info modal (~10s). If LinkedIn showed the plain
          // profile instead, open this person's own Contact info link once.
          // The dialog can appear before its entries do: wait for a value, or ~3s of an empty dialog.
          const contact = data._contactInfo;
          if (contact && (contact.email || contact.phone || contact.website || contact.address)) break;
          if (contact && ++emptyContactPasses >= 6) break;
          if (attempt >= 24) break;
          if (attempt >= 4 && !contactLinkOpened) {
            const contactInfoLink = document.querySelector(`main a[href*="/in/${id}/overlay/contact-info"]`);
            if (contactInfoLink) { contactLinkOpened = true; contactInfoLink.click(); }
          }
        } else if (!detailName) {
          const hasSection = ['currentCompanies','previousCompanies','projects','educations','skills','certifications','languages','volunteerExperiences','honors','publications','patents','courses','organizations']
            .some((key) => Array.isArray(data[key]) && data[key].length);
          // Experience and Education load as the page scrolls; scroll through once to read them.
          if (data.fullName || data.headline || hasSection || document.querySelector('main')) {
            data = merge(data, await collectFullyRenderedSection(['educations', 'currentCompanies', 'previousCompanies']));
            break;
          }
        }
        await pause(500);
      }

      data ||= extractPerson();
      const warnings = [];
      if (detailName && !sectionFound) {
        warnings.push(`LinkedIn's ${detailName} section did not finish loading. Capture again if the section is visible on the profile.`);
      }
      if (detailName === 'Education' && !data.educations?.length) {
        warnings.push("No education records were detected. If education is visible on LinkedIn, leave the profile open and capture again.");
      }
      if (detailName === 'Skills' && !data.skills?.length) {
        warnings.push("No skills were detected. If skills are visible on LinkedIn, leave the profile open and capture again.");
      }
      if (isSkillsPage) warnings.push(`Collected ${data.skills?.length || 0} skills from LinkedIn's Skills detail page.`);
      if (data.fullName || data.headline || document.querySelector('main') || sectionFound) {
        return {ok:true,data,links:links(id),warnings};
      }
      throw new Error('Profile content did not load. Check sign-in or access.');
    } finally { collecting = false; }
  }
  if (typeof chrome !== 'undefined' && chrome.runtime?.onMessage) chrome.runtime.onMessage.addListener((request, sender, respond) => {
    if (sender.id !== chrome.runtime.id) return;
    if (request.type === 'PERSON_READER_READY') { respond({ok:true,url:pageUrl(location.href,request.personId)}); return; }
    if (request.type === 'COLLECT_PERSON_PAGE') { collect(request.personId,request.url).then(respond).catch(error => respond({ok:false,error:error.message})); return true; }
  });
  return {start,merge,pageUrl,links};
})();
