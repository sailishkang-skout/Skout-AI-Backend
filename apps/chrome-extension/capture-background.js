// ENR-02 capture coordinator for the MV3 service worker.
//
// Coordinates the temporary tabs a user-started capture reads, keeps the reviewed draft and
// company-discovery checkpoints in extension storage, and saves a reviewed draft to the
// Skout API. Ported from the EnrichmentTool prototype's background.js. It never calls a
// LinkedIn API, never sends a LinkedIn message, and never saves anything the user has not
// reviewed in the side panel.

export const CAPTURE_DRAFT_KEY = 'skoutCaptureDraft';
export const CAPTURE_PROGRESS_KEY = 'skoutCaptureProgress';
export const CAPTURE_HALT_KEY = 'skoutCaptureHalt';
export const CAPTURE_CAPS = { MAX_PAGES: 10, MAX_LEADS: 250 };

/** Content scripts a capture needs, in load order (also declared in manifest.json). */
export const CAPTURE_CONTENT_FILES = [
  'capture/extract-common.js',
  'capture/company-sections.js',
  'capture/page-extract.js',
  'capture/restriction-detect.js',
  'capture/capture-ui.js',
  'capture/company-capture.js',
  'capture/person-capture.js',
  'capture/sales-navigator-capture.js',
  'capture/sales-lead-link-reader.js',
  'capture/company-people-search.js',
  'capture/capture-content.js',
];

/** Replaceable in tests. */
export const timing = { delay: ms => new Promise(resolve => setTimeout(resolve, ms)) };
const deps = { skoutFetch: null };

const API = '/api/v1/enrichment';

async function getStored(key) {
  return (await chrome.storage.local.get(key))[key];
}

/**
 * Why a capture may not read another page right now, or undefined. Checked before every
 * page a capture opens, so a LinkedIn warning or the workspace kill switch stops a long
 * run at the next step. A status that cannot be confirmed also stops it.
 */
async function captureBlock() {
  const halt = await getStored(CAPTURE_HALT_KEY);
  if (halt) return `Capture is stopped: ${halt.reason} Review the warning in the Skout side panel before continuing.`;
  try {
    const status = await deps.skoutFetch(`${API}/capture/status`);
    if (!status?.enabled) return `Capture is disabled for this workspace${status?.disabledReason ? `: ${status.disabledReason}` : '.'}`;
  } catch (error) {
    return `Capture status could not be confirmed (${error?.message || 'request failed'}).`;
  }
  return undefined;
}

// ── Sales Navigator: public-link lookup, one lead page at a time ──────────────
const salesLinkReads = new Map();
const salesLinkDelay = ms => timing.delay(ms);
function salesLeadUrl(value) {
  try {
    const url = new URL(value);
    const parts = url.pathname.split('/').filter(Boolean);
    if (url.protocol !== 'https:' || url.hostname !== 'www.linkedin.com' ||
        parts[0] !== 'sales' || parts[1] !== 'lead' || !parts[2]) return undefined;
    return url.href;
  } catch { return undefined; }
}
async function resolveSalesLeadLinks(request, sender) {
  const owner = sender.tab?.id;
  if (owner == null || sender.frameId !== 0 || !/^https:\/\/www\.linkedin\.com\/sales\/search\/people(?:[/?]|$)/.test(sender.url || ''))
    return {ok:false,error:'Start this from a Sales Navigator people search.'};
  if (salesLinkReads.has(owner)) return {ok:false,error:'A Sales Navigator link lookup is already running.'};
  const blocked = await captureBlock();
  if (blocked) return {ok:false,error:blocked};
  const leads = Array.isArray(request.leads) ? request.leads.slice(0,10) : [];
  if (!leads.length || leads.some(item => !salesLeadUrl(item?.url))) return {ok:false,error:'No valid Sales Navigator leads were supplied.'};
  const task = {tabId:null,cancelled:false};
  salesLinkReads.set(owner,task);
  const links = {};
  let checked = 0;
  try {
    for (const lead of leads) {
      if (task.cancelled) break;
      const url = salesLeadUrl(lead.url);
      try {
        const tab = await chrome.tabs.create({url,active:false,openerTabId:owner});
        task.tabId = tab.id;
        let ready = false;
        for (let attempt = 0; attempt < 24 && !task.cancelled; attempt++) {
          try {
            const response = await chrome.tabs.sendMessage(tab.id,{type:'SALES_LEAD_READER_READY'});
            if (response?.ok && salesLeadUrl(response.url)?.split('?')[0] === url.split('?')[0]) { ready = true; break; }
          } catch {}
          await salesLinkDelay(350);
        }
        if (ready && !task.cancelled) {
          const result = await Promise.race([
            chrome.tabs.sendMessage(tab.id,{type:'READ_SALES_PUBLIC_LINK'}),
            new Promise(resolve => setTimeout(() => resolve({ok:false}),12000)),
          ]);
          const expectedId = new URL(url).pathname.split('/')[3].split(',')[0];
          if (result?.ok && result.leadId === expectedId && /^https:\/\/www\.linkedin\.com\/in\/[^/]+\/$/.test(result.publicUrl || ''))
            links[url.split('?')[0]] = result.publicUrl;
        }
      } catch { /* Keep unresolved leads as Sales Navigator records. */ }
      finally {
        checked++;
        await setProgress({kind:'sales',tabId:owner,active:true,text:`Checking lead pages for a public LinkedIn link: ${checked} of ${leads.length} in this batch, one at a time.`});
        if (task.tabId != null) await chrome.tabs.remove(task.tabId).catch(() => {});
        task.tabId = null;
      }
      if (!task.cancelled && checked < leads.length) await salesLinkDelay(1300);
    }
    return {ok:true,data:{links,checked,cancelled:task.cancelled,capped:request.leads.length > leads.length}};
  } finally { salesLinkReads.delete(owner); if (task.tabId != null) await chrome.tabs.remove(task.tabId).catch(() => {}); }
}

// ── Company pages ─────────────────────────────────────────────────────────────
// Read company tabs only after an explicit Capture company click. The original
// tab owns the run; temporary tabs are closed after each read or cancellation.
const companyReads = new Map();
const personReads = new Map();
const companyPeopleReads = new Map();
const companyReadDelay = ms => timing.delay(ms);
function companyReadUrl(value, companyId) {
  try {
    const u = new URL(value), parts = u.pathname.split('/').filter(Boolean);
    const section = parts[2] === 'home' ? '' : parts[2] || '';
    if (u.protocol !== 'https:' || u.hostname !== 'www.linkedin.com' || parts[0] !== 'company' || parts[1] !== companyId || parts.length > 3 || !['','about','posts','jobs','products','life','people','insights'].includes(section)) return undefined;
    return `${u.origin}/company/${companyId}/${section ? section + '/' : ''}`;
  } catch { return undefined; }
}
// LinkedIn's SPA can leave sender.url stale after client-side navigation.
async function currentSenderTabUrl(sender) {
  const tabId = sender.tab?.id;
  if (tabId == null) return undefined;
  try {
    const tab = await chrome.tabs.get(tabId);
    return tab.url || sender.url;
  } catch {
    return undefined;
  }
}
async function readCompanyPage(request, sender, collectMessage = 'COLLECT_COMPANY_PAGE') {
  const owner = sender.tab?.id;
  const url = companyReadUrl(request.url, request.companyId);
  const sourceUrl = await currentSenderTabUrl(sender);
  if (owner == null || sender.frameId !== 0 || !url || !companyReadUrl(sourceUrl, request.companyId)) return {ok:false,error:'Capture must start on this company’s LinkedIn page.'};
  if (companyReads.has(owner)) return {ok:false,error:'A company page is already being read.'};
  const blocked = await captureBlock();
  if (blocked) return {ok:false,error:blocked};
  const task = {tabId:null,cancelled:false};companyReads.set(owner,task);
  let keepAlive;
  try {
    const tab = await chrome.tabs.create({url,active:true,openerTabId:owner});task.tabId = tab.id;
    if(task.cancelled) return {ok:true,cancelled:true};
    keepAlive = setInterval(() => {chrome.tabs.get(owner).catch(() => {task.cancelled=true;chrome.tabs.remove(task.tabId).catch(() => {});});},10000);
    let ready = false;
    for (let attempt = 0; attempt < 30 && !task.cancelled; attempt++) {
      try {
        const response = await chrome.tabs.sendMessage(tab.id,{type:'COMPANY_READER_READY',companyId:request.companyId});
        if(response?.ok && response.url === url){ready=true;break;}
      } catch {}
      await companyReadDelay(500);
    }
    if(task.cancelled) return {ok:true,cancelled:true};
    if(!ready) return {ok:false,error:'Page did not become readable. It may require sign-in or additional access.'};
    let timeout;
    try {
      const result = await Promise.race([
        chrome.tabs.sendMessage(tab.id,{type:collectMessage,companyId:request.companyId,url}),
        new Promise((_,reject) => {timeout=setTimeout(() => reject(new Error('Page took too long to load.')),55000);}),
      ]);
      return task.cancelled ? {ok:true,cancelled:true} : result;
    } finally {clearTimeout(timeout);}
  } catch(error) {return task.cancelled ? {ok:true,cancelled:true} : {ok:false,error:error.message};}
  finally {
    clearInterval(keepAlive);companyReads.delete(owner);
    if(task.tabId != null) await chrome.tabs.remove(task.tabId).catch(() => {});
  }
}

// ── Company people discovery with resumable checkpoints ───────────────────────
function companyPeopleSearchUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.hostname === 'www.linkedin.com' && url.pathname.replace(/\/$/, '') === '/search/results/people' && url.searchParams.get('currentCompany') ? url.href : undefined;
  } catch { return undefined; }
}
const COMPANY_PEOPLE_MAX_TOTAL_PAGES = 1000;
// One reviewed batch is one capture run: the same 10-page / 250-lead cap the API enforces.
const COMPANY_PEOPLE_SESSION_PAGES = 10;
const COMPANY_PEOPLE_SESSION_LEADS = 250;
const COMPANY_PEOPLE_SESSION_MS = 210000;
const COMPANY_PEOPLE_MAX_PASSES = 3;
const companyPeopleStateKey = companyId => `company-people-capture:${companyId}`;
async function getCompanyPeopleState(companyId) {
  const key = companyPeopleStateKey(companyId);
  return (await chrome.storage.local.get(key))[key] || {};
}
async function setCompanyPeopleState(companyId,state) {
  await chrome.storage.local.set({[companyPeopleStateKey(companyId)]:state});
}
async function commitCompanyPeopleCapture(request) {
  const state = await getCompanyPeopleState(request.companyId);
  if (!state.draft || state.draft.token !== request.token) return {ok:false,error:'No matching reviewed capture batch exists.'};
  const previous = state.committed || {};
  const seen = new Set(previous.seenIds || []);
  for (const profile of state.draft.profiles || []) if (profile?.publicId) seen.add(profile.publicId);
  const pagesRead = (previous.pagesRead || 0) + state.draft.pagesRead;
  const pass = previous.pass || 1;
  const passGrowth = seen.size - (previous.passStartSeenCount || 0);
  const expected = state.draft.expectedAssociatedMembers;
  const hasGap = Number.isFinite(expected) && expected > seen.size;
  const safetyLimitReached = !state.draft.complete && pagesRead >= COMPANY_PEOPLE_MAX_TOTAL_PAGES;
  const retryScheduled = state.draft.complete && hasGap && passGrowth > 0 && pass < COMPANY_PEOPLE_MAX_PASSES && !safetyLimitReached;
  const complete = (state.draft.complete && !retryScheduled) || safetyLimitReached;
  const stopReason = safetyLimitReached ? '1,000-page safety ceiling reached'
    : !complete ? retryScheduled ? 'retrying remaining gap' : 'more pages available'
    : hasGap && passGrowth === 0 ? 'no new profiles in the repeat pass'
    : hasGap && pass >= COMPANY_PEOPLE_MAX_PASSES ? 'repeat-pass limit reached'
    : 'last visible page reached';
  await setCompanyPeopleState(request.companyId,{
    searchKey:state.searchKey,searchUrl:state.searchUrl,
    committed:{resumeUrl:retryScheduled ? state.searchUrl : state.draft.resumeUrl,complete,
      pagesRead,seenIds:[...seen],pass:retryScheduled ? pass + 1 : pass,
      passStartSeenCount:retryScheduled ? seen.size : previous.passStartSeenCount || 0,
      stopReason},
  });
  return {ok:true,data:{complete,retryScheduled,stopReason,resumeUrl:retryScheduled ? state.searchUrl : state.draft.resumeUrl,
    pagesRead,distinctCandidates:seen.size,expectedAssociatedMembers:expected}};
}
async function waitForCompanyPeoplePage(tabId, searchKey, afterPage, task) {
  for (let attempt = 0; attempt < 60 && !task.cancelled; attempt++) {
    try {
      const ready = await chrome.tabs.sendMessage(tabId,{type:'COMPANY_PEOPLE_READER_READY'});
      if (ready?.ok && new URL(ready.url).searchParams.get('currentCompany') === searchKey &&
          (afterPage == null || ready.page > afterPage)) return ready;
    } catch { /* The next document is still loading. */ }
    await companyReadDelay(500);
  }
  if (task.cancelled) return undefined;
  throw new Error(`LinkedIn did not load results page ${afterPage == null ? 1 : afterPage + 1}.`);
}
async function readCompanyPeopleSearch(request, sender) {
  const owner = sender.tab?.id;
  const url = companyPeopleSearchUrl(request.url);
  const sourceUrl = await currentSenderTabUrl(sender);
  if (owner == null || sender.frameId !== 0 || !url || !companyReadUrl(sourceUrl, request.companyId)) return {ok:false,error:'Associated people must be read from the company capture.'};
  if (companyPeopleReads.has(owner)) return {ok:false,error:'Associated people are already being read.'};
  const task = {tabId:null,cancelled:false}; companyPeopleReads.set(owner,task);
  try {
    const searchKey = new URL(url).searchParams.get('currentCompany');
    const state = await getCompanyPeopleState(request.companyId);
    if (state.searchKey && state.searchKey !== searchKey) throw new Error('The LinkedIn company search identity changed; the saved capture cursor needs review.');
    // A fresh user-triggered capture may discover new employees after an
    // earlier search was complete. Start from page one again in that case.
    const committed = state.committed?.complete && !state.draft ? undefined : state.committed;
    const token = state.draft?.token || `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const people = new Map((state.draft?.profiles || []).map(profile => [profile.publicId,profile]));
    let pagesRead = state.draft?.pagesRead || 0;
    let resumeUrl = state.draft?.resumeUrl || committed?.resumeUrl || url;
    let complete = !!state.draft?.complete;
    // Largest results page seen in this batch: the next page could add this many people.
    let pageSize = state.draft?.pageSize || 0;
    let batchFull = !!state.draft?.batchFull;
    if (state.draft?.resumeUrl && state.draft.resumeUrl === state.draft.lastReadUrl && !complete)
      pagesRead = Math.max(0,pagesRead - 1); // Re-read the last page after an interrupted advance.
    // The aggregate member count is not a dependable paginator length.
    // Follow the visible Next control instead, within both hard bounds.
    const remainingPages = Math.max(0,COMPANY_PEOPLE_MAX_TOTAL_PAGES - (committed?.pagesRead || 0));
    const maxPages = Math.min(COMPANY_PEOPLE_SESSION_PAGES,remainingPages);
    if (!maxPages) return {ok:true,peopleProfiles:[],warnings:['The 1,000-page safety ceiling has been reached for this company.']};
    const startedAt = Date.now();
    let stopReason = complete ? 'LinkedIn showed no next page' : 'session page limit';
    const saveDraft = async () => setCompanyPeopleState(request.companyId,{
      searchKey,searchUrl:url,committed,
      draft:{token,profiles:[...people.values()],pagesRead,resumeUrl,complete,lastReadUrl,pageSize,batchFull,
        expectedAssociatedMembers:Number(request.expectedAssociatedMembers) || undefined},
    });
    // A batch that already reached its page or people limit is returned as it is, never grown past it.
    if (complete || batchFull || pagesRead >= maxPages || (pageSize && people.size + pageSize > COMPANY_PEOPLE_SESSION_LEADS)) return {ok:true,peopleProfiles:[...people.values()],checkpointToken:token,complete,
      progress:{pagesThisBatch:pagesRead,pagesPreviouslySaved:committed?.pagesRead || 0},
      warnings:[`Resumed ${pagesRead} locally saved pages. Review and save this batch before reading more.`]};
    // LinkedIn often defers search-card hydration in an inactive tab. Keep
    // this one user-triggered, temporary reader active while it pages results.
    const tab = await chrome.tabs.create({url:resumeUrl,active:true,openerTabId:owner}); task.tabId = tab.id;
    let afterPage;
    let lastReadUrl = state.draft?.lastReadUrl;
    for (; pagesRead < maxPages && !task.cancelled;) {
      const blocked = await captureBlock();
      if (blocked) throw new Error(blocked);
      const ready = await waitForCompanyPeoplePage(tab.id,searchKey,afterPage,task);
      if (!ready) return {ok:true,cancelled:true};
      const result = await chrome.tabs.sendMessage(tab.id,{type:'COLLECT_COMPANY_PEOPLE_PAGE'});
      if (!result?.ok) throw new Error(result?.error || 'The results page could not be read.');
      if (new URL(result.url).searchParams.get('currentCompany') !== searchKey || result.page !== ready.page)
        throw new Error('LinkedIn changed the company search during capture.');
      for (const profile of result.peopleProfiles || []) if (profile?.publicId) people.set(profile.publicId,profile);
      pageSize = Math.max(pageSize, (result.peopleProfiles || []).length);
      pagesRead++;
      await setProgress({kind:'company',tabId:owner,active:true,text:`Reading people results: page ${pagesRead} of up to ${maxPages} in this batch, ${people.size} candidates so far.`});
      resumeUrl = result.url; // Re-reading this page after an interruption is safe.
      lastReadUrl = result.url;
      if (!result.hasNext) {
        complete = true;resumeUrl = undefined;stopReason = 'LinkedIn showed no next page';
        await saveDraft();break;
      }
      await saveDraft();
      afterPage = result.page;
      const advance = await chrome.tabs.sendMessage(tab.id,{type:'ADVANCE_COMPANY_PEOPLE_PAGE'});
      if (!advance?.ok) throw new Error(advance?.error || 'LinkedIn results did not advance.');
      const next = await waitForCompanyPeoplePage(tab.id,searchKey,afterPage,task);
      if (!next) return {ok:true,cancelled:true};
      resumeUrl = next.url;
      await saveDraft();
      afterPage = undefined;
      // Stop before a page that could push this reviewed batch past the per-run lead cap.
      const leadLimitReached = people.size + pageSize > COMPANY_PEOPLE_SESSION_LEADS;
      if (pagesRead >= maxPages || leadLimitReached || Date.now() - startedAt >= COMPANY_PEOPLE_SESSION_MS) {
        stopReason = pagesRead >= maxPages ? 'session page limit' : leadLimitReached ? 'session lead limit' : 'session time limit';
        batchFull = pagesRead >= maxPages || leadLimitReached;
        await saveDraft();
        break;
      }
      await companyReadDelay(2500);
    }
    if (task.cancelled) return {ok:true,cancelled:true};
    return {ok:true,peopleProfiles:[...people.values()],checkpointToken:token,complete,
      progress:{pagesThisBatch:pagesRead,pagesPreviouslySaved:committed?.pagesRead || 0},
      warnings:[`Read ${pagesRead} visible results pages in this batch; found ${people.size} distinct candidates. Stopped because: ${stopReason}. ${complete ? 'This search is complete.' : 'Save this reviewed batch, then resume the company capture to continue at the next page.'}`]};
  } catch(error) { return task.cancelled ? {ok:true,cancelled:true} : {ok:false,error:error.message}; }
  finally { companyPeopleReads.delete(owner); if(task.tabId != null) await chrome.tabs.remove(task.tabId).catch(() => {}); }
}

// ── Person profile detail pages ───────────────────────────────────────────────
export function personReadUrl(value, personId) {
  try {
    const u = new URL(value), parts = u.pathname.split('/').filter(Boolean);
    const allowed = new Set(['','details','recent-activity','overlay']);
    if (u.protocol !== 'https:' || u.hostname !== 'www.linkedin.com' || parts[0] !== 'in' || parts[1] !== personId || parts.length > 4) return undefined;
    if (parts[2] === 'details' && !['experience','education','skills','certifications','languages','volunteering-experiences','honors','publications','patents','courses','projects','organizations'].includes(parts[3])) return undefined;
    // The only overlay read is this person's own Contact info.
    if (parts[2] === 'overlay' && parts[3] !== 'contact-info') return undefined;
    if (parts[2] && !allowed.has(parts[2])) return undefined;
    return `${u.origin}/in/${personId}/${parts.slice(2).join('/')}${parts[2] ? '/' : ''}`;
  } catch { return undefined; }
}
async function readPersonPage(request, sender) {
  const owner = sender.tab?.id, url = personReadUrl(request.url, request.personId);
  if (owner == null || sender.frameId !== 0 || !url || !personReadUrl(sender.url, request.personId)) return {ok:false,error:'Capture must start on this person’s LinkedIn profile.'};
  if (personReads.has(owner)) return {ok:false,error:'A person profile is already being read.'};
  const blocked = await captureBlock();
  if (blocked) return {ok:false,error:blocked};
  const task = {tabId:null,cancelled:false}; personReads.set(owner,task); let keepAlive;
  try {
    // LinkedIn renders the Contact info dialog only in a visible tab; every other page reads in the background.
    const active = url.endsWith('/overlay/contact-info/');
    const tab = await chrome.tabs.create({url,active,openerTabId:owner}); task.tabId = tab.id;
    keepAlive = setInterval(() => { chrome.tabs.get(owner).catch(() => { task.cancelled=true; chrome.tabs.remove(task.tabId).catch(() => {}); }); },10000);
    let ready = false;
    for (let attempt=0; attempt<30 && !task.cancelled; attempt++) { try { const response=await chrome.tabs.sendMessage(tab.id,{type:'PERSON_READER_READY',personId:request.personId}); if(response?.ok && (response.url===url || (url.endsWith('/overlay/contact-info/') && response.url===url.replace(/overlay\/contact-info\/$/,'')))){ready=true;break;} } catch {} await companyReadDelay(500); }
    if(task.cancelled) return {ok:true,cancelled:true}; if(!ready) return {ok:false,error:'Profile page did not become readable.'};
    let timeout;
    // Skills detail pages can load several bounded "Show more" batches.
    // Keep this user-triggered, same-profile reader alive long enough to
    // finish them; it still closes its temporary tab immediately afterward.
    try { return await Promise.race([chrome.tabs.sendMessage(tab.id,{type:'COLLECT_PERSON_PAGE',personId:request.personId,url}),new Promise((_,reject)=>{timeout=setTimeout(()=>reject(new Error('Profile page took too long to load.')),45000);})]); }
    finally { clearTimeout(timeout); }
  } catch(error) { return task.cancelled ? {ok:true,cancelled:true} : {ok:false,error:error.message}; }
  finally {
    clearInterval(keepAlive); personReads.delete(owner);
    if(task.tabId != null) await chrome.tabs.remove(task.tabId).catch(() => {});
    if (url.endsWith('/overlay/contact-info/')) await chrome.tabs.update(owner,{active:true}).catch(() => {});
  }
}

// ── Drafts, progress, halt ────────────────────────────────────────────────────

const taskMaps = () => [salesLinkReads, companyReads, personReads, companyPeopleReads];

function cancelTask(task) {
  task.cancelled = true;
  if (task.tabId != null) chrome.tabs.remove(task.tabId).catch(() => {});
}

function cancelAllTasks() {
  for (const map of taskMaps()) for (const task of map.values()) cancelTask(task);
}

function cancelTasksFor(tabId) {
  for (const map of taskMaps()) {
    for (const [owner, task] of map) if (tabId === owner || tabId === task.tabId) cancelTask(task);
  }
}

async function setProgress(progress) {
  await chrome.storage.local.set({ [CAPTURE_PROGRESS_KEY]: { ...progress, at: Date.now() } });
}

/** A reader that has not reported for this long (reloaded tab, restarted worker) is not running. */
export const CAPTURE_PROGRESS_STALE_MS = 3 * 60 * 1000;

export function isProgressActive(progress, now = Date.now()) {
  return progress?.active === true && now - (progress.at || 0) < CAPTURE_PROGRESS_STALE_MS;
}

async function hasActiveCapture() {
  if (taskMaps().some(map => map.size > 0)) return true;
  return isProgressActive(await getStored(CAPTURE_PROGRESS_KEY));
}

/** Auto-stop: LinkedIn rendered a warning, verification or restriction during a capture. */
async function haltCapture(reason, url) {
  if (!(await hasActiveCapture())) return { ok: true, halted: false };
  const progress = await getStored(CAPTURE_PROGRESS_KEY);
  cancelAllTasks();
  await chrome.storage.local.set({ [CAPTURE_HALT_KEY]: { reason, url, at: Date.now() } });
  if (progress?.tabId != null) chrome.tabs.sendMessage(progress.tabId, { type: 'SKOUT_CAPTURE_STOP' }).catch(() => {});
  await setProgress({ kind: progress?.kind, tabId: progress?.tabId, active: false, isError: true, text: `Capture stopped: ${reason}` });
  return { ok: true, halted: true };
}

function withoutInternal(value) {
  return Object.fromEntries(Object.entries(value || {}).filter(([key, item]) =>
    !key.startsWith('_') && item !== undefined && item !== null && item !== ''));
}

export function reviewDraftData(data) {
  const reviewed = withoutInternal(data);
  if (data?._contactInfo && typeof data._contactInfo === "object") {
    reviewed._contactInfo = data._contactInfo;
  }
  return reviewed;
}

async function storeDraft(message, sender) {
  const data = message.data || {};
  const draft = {
    kind: message.kind,
    data: reviewDraftData(data),
    notes: Array.isArray(message.notes) ? message.notes.filter(Boolean).map(String) : [],
    sourceUrl: message.sourceUrl,
    capturedAt: message.capturedAt || new Date().toISOString(),
    tabId: sender.tab?.id,
    meta: {
      companyId: message.kind === 'company' ? data.publicId : undefined,
      checkpointToken: data._captureCheckpointToken,
      progress: data._captureProgress,
      stats: data._captureStats,
      sales: data._salesCapture,
    },
  };
  if (draft.data._contactInfo && (draft.data._contactInfo.email || draft.data._contactInfo.phone)) {
    draft.notes.push("Contact details came from the already-open Contact Info dialog. They are saved only after your review and remain unverified.");
  }
  if (message.kind === "person" && draft.data._contactInfo?.website) {
    draft.notes.push("The website came from the already-open Contact Info dialog. Check it before saving.");
  }
  await chrome.storage.local.set({ [CAPTURE_DRAFT_KEY]: draft });
  if (draft.kind === 'company') await runQueueInReview(draft.meta.companyId);
  return { ok: true };
}

/** The request body for a reviewed draft. Exported for tests. */
export function buildCapturePayload(draft, data) {
  const clean = withoutInternal(data);
  const leads = Array.isArray(clean.peopleProfiles) ? clean.peopleProfiles.map(withoutInternal) : undefined;
  if (leads && leads.length > CAPTURE_CAPS.MAX_LEADS) {
    throw new Error(`A capture run saves at most ${CAPTURE_CAPS.MAX_LEADS} leads. Remove ${leads.length - CAPTURE_CAPS.MAX_LEADS} before saving.`);
  }
  const capturedAt = draft.capturedAt;
  if (draft.kind === 'sales') {
    return {
      sourceUrl: clean.sourceUrl,
      filters: clean.filters,
      pagesRead: Math.min(CAPTURE_CAPS.MAX_PAGES, Math.max(1, Number(clean.pagesRead) || 1)),
      resultCount: clean.resultCount,
      peopleProfiles: leads || [],
      capturedAt,
    };
  }
  if (draft.kind === 'company') {
    const payload = { ...clean, capturedAt };
    if (leads?.length) {
      payload.peopleProfiles = leads;
      payload.pagesRead = Math.min(CAPTURE_CAPS.MAX_PAGES, Number(draft.meta?.progress?.pagesThisBatch) || 0);
    } else {
      delete payload.peopleProfiles;
      delete payload.pagesRead;
    }
    return payload;
  }
  return { ...clean, capturedAt };
}

const INGEST_PATHS = { person: 'person', company: 'company', sales: 'sales-search' };

/**
 * Saves a reviewed draft. Reports success only once the API has recorded the capture run
 * with the terminal status `completed`; anything else is returned as a visible failure.
 */
async function sendCapture(message) {
  const draft = await getStored(CAPTURE_DRAFT_KEY);
  if (!draft) return { ok: false, error: 'There is no reviewed capture to save.' };
  const path = INGEST_PATHS[draft.kind];
  if (!path) return { ok: false, error: 'Unknown capture type.' };
  let body;
  try {
    const payload = buildCapturePayload(draft, message.data || draft.data);
    body = await deps.skoutFetch(`${API}/ingest/${path}`, { method: 'POST', body: JSON.stringify(payload), timeoutMs: 60_000 });
  } catch (error) {
    // The API lists the fields that failed validation under details.fields.
    const issues = (error?.body?.details?.fields || []).slice(0, 5).map(issue => `${issue.path}: ${issue.message}`);
    return {
      ok: false,
      error: [error?.message || 'The capture could not be saved.', ...issues].join(' · '),
      code: error?.body?.code || (typeof error?.body?.error === 'string' ? error.body.error : undefined),
      run: error?.body?.run || null,
    };
  }
  const run = body?.run;
  if (!run?.terminal || run.status !== 'completed') {
    return { ok: false, error: `The capture was not recorded as completed (status: ${run?.status || 'unknown'}).`, run: run || null };
  }
  let checkpoint;
  if (draft.kind === 'company' && draft.meta?.checkpointToken) {
    const commit = await commitCompanyPeopleCapture({ companyId: draft.meta.companyId, token: draft.meta.checkpointToken });
    checkpoint = commit.ok ? commit.data : { error: 'The page checkpoint could not be finalized. Resuming may revisit this batch safely.' };
    if (commit.ok) {
      checkpoint.companyId = draft.meta.companyId;
      checkpoint.queued = await reportCaptureQueue(draft.meta.companyId, draft.data?.name, commit.data);
    }
  }
  await chrome.storage.local.remove(CAPTURE_DRAFT_KEY);
  if (draft.kind === 'company') await runQueueBatchSaved(draft.meta?.companyId, { created: body.created, merged: body.merged }, checkpoint);
  return {
    ok: true,
    run,
    counts: { received: body.received, created: body.created, merged: body.merged, rejected: body.rejected },
    rejectedFields: body.rejectedFields || [],
    checkpoint,
  };
}

async function sendToCaptureTab(tabId, request) {
  try {
    return await chrome.tabs.sendMessage(tabId, request);
  } catch {
    // The tab was open before the extension loaded or reloaded: load the readers, then retry.
    await chrome.scripting.executeScript({ target: { tabId }, files: CAPTURE_CONTENT_FILES });
    return chrome.tabs.sendMessage(tabId, request);
  }
}

async function startCapture(message) {
  if (message.tabId == null) return { ok: false, error: 'Open a LinkedIn tab first.' };
  const blocked = await captureBlock();
  if (blocked) return { ok: false, error: blocked };
  const status = await deps.skoutFetch(`${API}/capture/status`);
  if (status.usage?.remainingToday <= 0) {
    return { ok: false, error: `Daily capture limit of ${status.caps?.dailyLeadLimit} leads reached. Try again tomorrow.` };
  }
  if ((await getStored(CAPTURE_DRAFT_KEY)) && !message.replaceDraft) {
    return { ok: false, error: 'Save or discard the capture waiting for review first.' };
  }
  await chrome.storage.local.remove(CAPTURE_DRAFT_KEY);
  // Written before the page is asked to start, so the reader's own updates always come after it.
  await setProgress({ kind: message.kind, tabId: message.tabId, active: true, text: 'Starting…' });
  const failed = async (error) => {
    await setProgress({ kind: message.kind, tabId: message.tabId, active: false, isError: true, text: error });
    return { ok: false, error };
  };
  let started;
  try {
    started = await sendToCaptureTab(message.tabId, { type: 'SKOUT_CAPTURE_START', kind: message.kind, options: message.options });
  } catch (error) {
    return failed(`The LinkedIn page could not be reached (${error?.message || 'no response'}). Reload the tab and try again.`);
  }
  if (!started?.ok) return failed(started?.error || 'The capture could not start on this page.');
  return { ok: true, kind: started.kind };
}

async function stopCapture(message) {
  const progress = await getStored(CAPTURE_PROGRESS_KEY);
  const tabId = message.tabId ?? progress?.tabId;
  if (tabId != null) {
    chrome.tabs.sendMessage(tabId, { type: 'SKOUT_CAPTURE_STOP' }).catch(() => {});
    cancelTasksFor(tabId);
  }
  // "Stop" also drops the unsaved batch; "Pause" keeps it so the capture resumes from there.
  if (message.discardCheckpoint && message.companyId) {
    const state = await getCompanyPeopleState(message.companyId);
    if (state.draft) await setCompanyPeopleState(message.companyId, { ...state, draft: undefined });
  }
  if (progress?.active) await setProgress({ ...progress, active: false, text: message.discardCheckpoint ? 'Stopped.' : 'Paused.' });
  return { ok: true };
}

async function pageKind(message) {
  if (message.tabId == null) return { ok: true, kind: null };
  try {
    return await sendToCaptureTab(message.tabId, { type: 'SKOUT_CAPTURE_PAGE_KIND' });
  } catch {
    return { ok: true, kind: null };
  }
}

// ── Capture queue: companies whose people discovery has result pages left ─────

/** Tells Skout where a company's people discovery stands, for LinkedIn Enrichment → Capture queue. */
async function reportCaptureQueue(companyId, companyName, commit) {
  try {
    await deps.skoutFetch(`${API}/capture/queue/${encodeURIComponent(companyId)}`, {
      method: 'PUT',
      body: JSON.stringify(captureQueueReport(companyName, commit)),
    });
    return true;
  } catch {
    return false; // The local checkpoint still resumes; only the web list is out of date.
  }
}

/** The queue update for one committed batch. Exported for tests. */
export function captureQueueReport(companyName, commit) {
  const report = {
    pagesRead: Math.max(0, Number(commit.pagesRead) || 0),
    peopleFound: Math.max(0, Number(commit.distinctCandidates) || 0),
    complete: commit.complete === true,
  };
  if (typeof companyName === 'string' && companyName.trim()) report.companyName = companyName.trim().slice(0, 300);
  if (Number.isFinite(commit.expectedAssociatedMembers)) report.expectedPeople = commit.expectedAssociatedMembers;
  if (commit.stopReason) report.stopReason = String(commit.stopReason).slice(0, 300);
  return report;
}

const COMPANY_ID = /^[A-Za-z0-9%._~-]{1,200}$/;

/** This browser's saved people-capture position for a company: 'paused' | 'partial' | 'complete' | undefined. */
function localProgress(state) {
  if (!state) return undefined;
  if (state.draft) return 'paused';
  if (state.committed) return state.committed.complete ? 'complete' : 'partial';
  return undefined;
}

/** Companies captured in this workspace, with how far each one's people capture got. */
async function listCaptureCompanies(message) {
  const q = String(message.q || '').trim().slice(0, 100);
  try {
    const body = await deps.skoutFetch(`${API}/capture/companies${q ? `?q=${encodeURIComponent(q)}` : ''}`);
    const local = await chrome.storage.local.get(null);
    const companies = (body?.companies || []).map(company => ({
      ...company,
      local: localProgress(local[companyPeopleStateKey(company.companyPublicId)]),
    }));
    return { ok: true, companies };
  } catch (error) {
    return { ok: false, error: error?.message || 'The company list could not be loaded.' };
  }
}

async function waitForTabUrl(tabId, matches, timeoutMs = 25000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const tab = await chrome.tabs.get(tabId).catch(() => undefined);
    if (!tab) return false;
    if (tab.status === 'complete' && matches(tab.url || '')) return true;
    await timing.delay(400);
  }
  return false;
}

/**
 * Reads the next batch of a queued company: opens (or reuses) a tab on its LinkedIn page and
 * starts a people-only capture that resumes from the saved result page. Only ever runs after
 * the user clicks Continue in the side panel or on the Skout Capture queue page.
 */
async function continueCaptureQueue(message) {
  const companyId = String(message.companyId || '');
  if (!COMPANY_ID.test(companyId)) return { ok: false, error: 'Not a LinkedIn company.' };
  const companyUrl = `https://www.linkedin.com/company/${companyId}/`;
  const onCompany = url => companyReadUrl(url, companyId) !== undefined;
  let tabId = message.tabId;
  const current = tabId != null ? await chrome.tabs.get(tabId).catch(() => undefined) : undefined;
  if (!current) {
    const tab = await chrome.tabs.create({ url: companyUrl, active: true });
    tabId = tab.id;
  } else if (!onCompany(current.url || '')) {
    await chrome.tabs.update(tabId, { url: companyUrl, active: true });
  }
  if (!(await waitForTabUrl(tabId, onCompany))) return { ok: false, error: 'The LinkedIn company page did not load. Open it and try again.' };
  await timing.delay(1500); // Let LinkedIn hydrate the company top card before reading it.
  const started = await startCapture({
    tabId,
    kind: 'company',
    replaceDraft: message.replaceDraft === true,
    options: { includeCompany: false, includePeople: true, resume: true },
  });
  return started.ok ? { ...started, tabId } : started;
}

// ── Company queue: read the people of several companies, one at a time ───────
// The user picks companies in the side panel. Each company is opened in turn and its next batch
// of up to 250 people is read; the queue then waits for the user to review and save (or discard)
// that batch before it opens the next company. Nothing is saved without the user's review.

export const RUN_QUEUE_KEY = 'skoutCaptureRunQueue';
const MAX_QUEUE_COMPANIES = 200;
const RUN_QUEUE_GAP_MS = 3000;

async function getRunQueue() {
  return (await getStored(RUN_QUEUE_KEY)) || null;
}
async function setRunQueue(queue) {
  await chrome.storage.local.set({ [RUN_QUEUE_KEY]: { ...queue, at: Date.now() } });
}

let advancing = false;
async function advanceRunQueue() {
  if (advancing) return;
  advancing = true;
  try {
    for (;;) {
      const queue = await getRunQueue();
      if (!queue?.active) return;
      // One company at a time: wait while one is being read or reviewed.
      if (queue.items.some(entry => ['running', 'review'].includes(entry.status))) return;
      const next = queue.items.find(entry => entry.status === 'pending');
      if (!next) return setRunQueue({ ...queue, active: false, note: 'Every selected company has been read.', finishedAt: Date.now() });
      const blocked = await captureBlock();
      if (blocked) return setRunQueue({ ...queue, active: false, note: blocked });
      next.status = 'running';
      await setRunQueue(queue);
      const result = await continueCaptureQueue({ companyId: next.companyPublicId, tabId: queue.tabId });
      const latest = (await getRunQueue()) || queue;
      const current = latest.items.find(entry => entry.companyPublicId === next.companyPublicId);
      if (result.ok) {
        // The capture is now running in the tab; the review or progress events move the queue on.
        await setRunQueue({ ...latest, tabId: result.tabId });
        return;
      }
      if (current && /daily capture limit/i.test(result.error || '')) {
        current.status = 'pending';
        return setRunQueue({ ...latest, active: false, note: result.error });
      }
      if (current) {
        current.status = 'failed';
        current.error = String(result.error || 'The company could not be read.').slice(0, 300);
      }
      await setRunQueue(latest);
      await timing.delay(1500);
    }
  } finally {
    advancing = false;
  }
}

const advanceSoon = () => void timing.delay(RUN_QUEUE_GAP_MS).then(advanceRunQueue).catch(() => {});

async function startRunQueue(message) {
  const existing = await getRunQueue();
  if (existing?.active) return { ok: false, error: 'A company queue is already running.' };
  if (await getStored(CAPTURE_DRAFT_KEY)) return { ok: false, error: 'Save or discard the capture waiting for review first.' };
  const seen = new Set();
  const items = [];
  for (const company of Array.isArray(message.companies) ? message.companies : []) {
    const id = String(company?.companyPublicId || '');
    if (!COMPANY_ID.test(id) || seen.has(id)) continue;
    seen.add(id);
    items.push({ companyPublicId: id, name: String(company?.name || id).slice(0, 200), status: 'pending' });
  }
  if (!items.length) return { ok: false, error: 'Select at least one company.' };
  if (items.length > MAX_QUEUE_COMPANIES) return { ok: false, error: `A queue holds at most ${MAX_QUEUE_COMPANIES} companies. Select fewer.` };
  await setRunQueue({ active: true, tabId: null, items, startedAt: Date.now() });
  advanceRunQueue().catch(() => {});
  return { ok: true, count: items.length };
}

/** Pauses the queue; the company being read goes back to waiting so it resumes from the same page. */
async function stopRunQueue() {
  const queue = await getRunQueue();
  if (!queue) return { ok: true };
  const running = queue.items.find(entry => entry.status === 'running');
  if (running) running.status = 'pending';
  await setRunQueue({ ...queue, active: false, note: 'Queue paused. Choose Resume to continue.' });
  const progress = await getStored(CAPTURE_PROGRESS_KEY);
  const tabId = queue.tabId ?? progress?.tabId;
  if (tabId != null) {
    chrome.tabs.sendMessage(tabId, { type: 'SKOUT_CAPTURE_STOP' }).catch(() => {});
    cancelTasksFor(tabId);
  }
  if (progress?.active) await setProgress({ ...progress, active: false, text: 'Paused.' });
  return { ok: true };
}

async function resumeRunQueue() {
  const queue = await getRunQueue();
  if (!queue || !queue.items.some(entry => entry.status === 'pending')) return { ok: false, error: 'No companies are waiting.' };
  if (await getStored(CAPTURE_DRAFT_KEY)) return { ok: false, error: 'Save or discard the capture waiting for review first.' };
  await setRunQueue({ ...queue, active: true, note: undefined });
  advanceRunQueue().catch(() => {});
  return { ok: true };
}

async function clearRunQueue() {
  const queue = await getRunQueue();
  if (queue?.active) return { ok: false, error: 'Pause the queue first.' };
  await chrome.storage.local.remove(RUN_QUEUE_KEY);
  return { ok: true };
}

/** The company being read has a reviewable batch now. */
async function runQueueInReview(companyId) {
  const queue = await getRunQueue();
  const item = queue?.items?.find(entry => entry.status === 'running' && (!companyId || entry.companyPublicId === companyId));
  if (!item) return;
  item.status = 'review';
  await setRunQueue(queue);
}

/** A reviewed batch was saved for the company the queue is on: record it and move to the next. */
async function runQueueBatchSaved(companyId, counts, checkpoint) {
  const queue = await getRunQueue();
  const item = queue?.items?.find(entry => entry.companyPublicId === companyId && ['running', 'review'].includes(entry.status));
  if (!item) return;
  item.status = 'done';
  item.saved = (counts?.created || 0) + (counts?.merged || 0);
  item.moreRemain = Boolean(checkpoint) && !checkpoint.error && checkpoint.complete === false;
  await setRunQueue(queue);
  if (queue.active) advanceSoon();
}

/** The reviewed batch was discarded: skip that company and move on. */
async function runQueueBatchDiscarded() {
  const queue = await getRunQueue();
  const item = queue?.items?.find(entry => entry.status === 'review');
  if (!item) return;
  item.status = 'skipped';
  await setRunQueue(queue);
  if (queue.active) advanceSoon();
}

/** A reader ended without producing a review (an error, or the user stopped it): move on. */
async function runQueueReadEnded(message) {
  const queue = await getRunQueue();
  const item = queue?.items?.find(entry => entry.status === 'running');
  if (!item || !queue.active) return;
  if (message.isError) {
    item.status = 'failed';
    item.error = String(message.text || 'The company could not be read.').slice(0, 300);
  } else {
    item.status = 'skipped';
  }
  await setRunQueue(queue);
  advanceSoon();
}


async function capturedCompanyProfileIds(companyId) {
  try {
    const body = await deps.skoutFetch(`${API}/ingest/company/${encodeURIComponent(companyId)}/captured-profile-ids`);
    return { ok: true, data: { publicIds: Array.isArray(body?.publicIds) ? body.publicIds : [] } };
  } catch (error) {
    return { ok: false, error: error?.message || 'Unable to check previously captured profiles.' };
  }
}

const fromExtensionPage = sender => !sender.tab;

/** Returns a promise for capture messages, or undefined for anything else. */
export function handleCaptureMessage(message, sender) {
  switch (message?.type) {
    // Side panel.
    case 'capture-status':
      return fromExtensionPage(sender)
        ? deps.skoutFetch(`${API}/capture/status`).then(status => ({ ok: true, status }), error => ({ ok: false, error: error?.message || 'Capture status is unavailable.' }))
        : undefined;
    case 'capture-page-kind':
      return fromExtensionPage(sender) ? pageKind(message) : undefined;
    case 'capture-start':
      return fromExtensionPage(sender) ? startCapture(message) : undefined;
    case 'capture-stop':
      return fromExtensionPage(sender) ? stopCapture(message) : undefined;
    case 'capture-send':
      return fromExtensionPage(sender) ? sendCapture(message) : undefined;
    case 'capture-discard':
      return fromExtensionPage(sender)
        ? chrome.storage.local.remove(CAPTURE_DRAFT_KEY).then(runQueueBatchDiscarded).then(() => ({ ok: true }))
        : undefined;
    case 'capture-companies':
      return fromExtensionPage(sender) ? listCaptureCompanies(message) : undefined;
    case 'capture-queue-start':
      return fromExtensionPage(sender) ? startRunQueue(message) : undefined;
    case 'capture-queue-stop':
      return fromExtensionPage(sender) ? stopRunQueue() : undefined;
    case 'capture-queue-resume':
      return fromExtensionPage(sender) ? resumeRunQueue() : undefined;
    case 'capture-queue-clear':
      return fromExtensionPage(sender) ? clearRunQueue() : undefined;
    case 'capture-continue':
      return fromExtensionPage(sender) ? continueCaptureQueue(message) : undefined;
    case 'capture-ack-halt':
      return fromExtensionPage(sender) ? chrome.storage.local.remove(CAPTURE_HALT_KEY).then(() => ({ ok: true })) : undefined;
    // LinkedIn tabs running the capture readers.
    case 'SKOUT_CAPTURE_PROGRESS':
      return setProgress({ kind: message.kind, tabId: sender.tab?.id, active: message.active === true, isError: message.isError === true, text: String(message.text || '') })
        .then(() => (message.active === true ? undefined : runQueueReadEnded(message)))
        .then(() => ({ ok: true }));
    case 'SKOUT_CAPTURE_REVIEW':
      return storeDraft(message, sender);
    case 'SKOUT_CAPTURE_RESTRICTION':
      return haltCapture(String(message.reason || 'LinkedIn showed a warning.'), message.url);
    case 'READ_PERSON_PAGE':
      return readPersonPage(message, sender);
    case 'READ_COMPANY_PAGE':
      return readCompanyPage(message, sender);
    case 'READ_COMPANY_PEOPLE_DIRECTORY':
      return readCompanyPage(message, sender, 'COLLECT_COMPANY_PEOPLE_DIRECTORY');
    case 'READ_COMPANY_PEOPLE_SEARCH':
      return readCompanyPeopleSearch(message, sender);
    case 'RESOLVE_SALES_LEAD_LINKS':
      return resolveSalesLeadLinks(message, sender);
    case 'GET_CAPTURED_COMPANY_PROFILE_IDS':
      return capturedCompanyProfileIds(message.companyId);
    case 'CANCEL_PERSON_READ':
    case 'CANCEL_COMPANY_READ':
    case 'CANCEL_SALES_LEAD_LINKS':
      cancelTasksFor(sender.tab?.id);
      return Promise.resolve({ ok: true });
    default:
      return undefined;
  }
}

/** Wires the capture coordinator into the service worker. `skoutFetch` is the Bearer-token client. */
export function registerCaptureBackground({ skoutFetch }) {
  deps.skoutFetch = skoutFetch;
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (sender.id !== chrome.runtime.id) return false;
    const result = handleCaptureMessage(message, sender);
    if (!result) return false;
    result.then(sendResponse, error => sendResponse({ ok: false, error: error?.message || 'Capture failed.' }));
    return true;
  });
  chrome.tabs.onRemoved.addListener(async tabId => {
    cancelTasksFor(tabId);
    const queue = await getRunQueue();
    if (queue?.tabId === tabId) {
      await stopRunQueue();
      await setRunQueue({ ...(await getRunQueue()), tabId: null, note: 'The LinkedIn tab was closed. Choose Resume to continue.' });
    }
    const progress = await getStored(CAPTURE_PROGRESS_KEY);
    if (progress?.active && progress.tabId === tabId) {
      await setProgress({ ...progress, active: false, isError: true, text: 'The LinkedIn tab was closed before the capture finished.' });
    }
  });
}

export const __test = { commitCompanyPeopleCapture, getCompanyPeopleState, captureBlock, companyReadUrl, deps, listCaptureCompanies, getRunQueue, advanceRunQueue, readCompanyPeopleSearch };
