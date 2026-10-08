// Controlled, user-triggered person capture. Reads only the profile's own
// allowlisted detail pages; never enumerates other people or uses private APIs.
globalThis.SkoutPersonCapture = globalThis.SkoutPersonCapture || (() => {
  const { publicIdFromUrl } = window.SkoutCaptureExtract;
  const { extractPerson } = globalThis.SkoutCapturePage;
  const allowed = new Set(['', 'details/experience', 'details/education', 'details/skills', 'details/certifications', 'details/languages', 'details/volunteering-experiences', 'details/honors', 'details/publications', 'details/patents', 'details/courses', 'details/projects', 'details/organizations', 'recent-activity']);
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
    for (const [key, value] of Object.entries(b || {})) {
      if (key.startsWith('_') || value === undefined || value === null || value === '') continue;
      if (Array.isArray(value)) out[key] = [...(out[key] || []), ...value];
      else out[key] = value;
    }
    for (const key of ['educations','skills','recommendations','certifications','languages','volunteerExperiences','honors','publications','patents','courses','organizations','projects','currentCompanies','previousCompanies']) {
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
    // Skills is explicit because the profile preview usually displays only a
    // subset. This is the same profile's allowlisted detail page and is read
    // only after the user starts a capture.
    const queue = [...new Set([root, `${root}details/skills/`, ...links(id)])].slice(0, 12), seen = new Set(), errors = [], warnings = [];
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
          for (const link of result.links || []) { const safe = pageUrl(link,id); if (safe && !seen.has(safe) && !queue.includes(safe) && seen.size + queue.length < 12) queue.push(safe); }
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
    for (let pass = 0; pass < 25; pass++) {
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
      if (atBottom && stablePasses >= 2 && !showMore) break;
      window.scrollBy({top: Math.max(520, Math.floor(window.innerHeight * 0.8)), behavior: 'auto'});
      await pause(650);
    }
    combined = merge(combined, extractPerson());
    window.scrollTo(0, 0);
    return combined;
  }
  async function collect(id, expectedUrl) {
    if (collecting) throw new Error('This page is already being read.'); collecting = true;
    try {
      for (let attempt = 0; attempt < 12; attempt++) { if (pageUrl(location.href,id) !== expectedUrl) throw new Error('Profile page changed during capture.'); const isSkillsPage = expectedUrl.includes('/details/skills/'); const data = isSkillsPage ? await collectFullyRenderedSkills() : extractPerson(); const hasSection = ['experience','educations','skills','certifications','languages','volunteerExperiences','honors','publications','patents','courses','organizations'].some(key => Array.isArray(data[key]) && data[key].length); if (data.fullName || data.headline || hasSection || document.querySelector('main')) return {ok:true,data,links:links(id),warnings:isSkillsPage ? [`Collected ${data.skills?.length || 0} skills from LinkedIn's Skills detail page.`] : []}; await pause(500); }
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
