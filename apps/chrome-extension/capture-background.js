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
// LinkedIn shows 10 people per results page: 25 pages make one 250-person batch.
export const CAPTURE_CAPS = { MAX_PAGES: 25, MAX_LEADS: 250 };

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
  'capture/company-jobs.js',
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
// The last "capture is enabled" the API confirmed. The API enforces the kill switch and the daily
// limit on every save, so when one status check fails (a slow or restarting API) a recent
// confirmation lets the reader carry on: nothing is saved without the API answering.
const STATUS_FALLBACK_MS = 10 * 60 * 1000;
let lastConfirmedStatus = null;

/**
 * Why a capture may not read another page right now: `{ reason }`, with `transient: true` when
 * the cause is only that the status could not be confirmed (try again) rather than a decision
 * (a LinkedIn warning, the kill switch). Nothing blocks: `{}`.
 */
async function captureBlockDetail() {
  const halt = await getStored(CAPTURE_HALT_KEY);
  if (halt) return { reason: `Capture is stopped: ${halt.reason} Review the warning in the Skout side panel before continuing.` };
  try {
    const status = await deps.skoutFetch(`${API}/capture/status`);
    lastConfirmedStatus = status?.enabled ? { at: Date.now() } : null;
    if (!status?.enabled) return { reason: `Capture is disabled for this workspace${status?.disabledReason ? `: ${status.disabledReason}` : '.'}` };
  } catch (error) {
    if (lastConfirmedStatus && Date.now() - lastConfirmedStatus.at < STATUS_FALLBACK_MS) return {};
    return { reason: `Capture status could not be confirmed (${error?.message || 'request failed'}).`, transient: true };
  }
  return {};
}

async function captureBlock() {
  return (await captureBlockDetail()).reason;
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
// One reviewed batch is one capture run: the same 25-page / 250-lead cap the API enforces.
const COMPANY_PEOPLE_SESSION_PAGES = 25;
const COMPANY_PEOPLE_SESSION_LEADS = 250;
// 25 pages at ~10-15 seconds each (load, scroll every card into view, pause between pages).
const COMPANY_PEOPLE_SESSION_MS = 10 * 60 * 1000;
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
    // A paused batch that found nobody is not worth resuming: read those pages again instead of
    // handing the same empty batch back on every run.
    const draft = state.draft?.profiles?.length ? state.draft : undefined;
    const committed = state.committed?.complete && !draft ? undefined : state.committed;
    const token = draft?.token || `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const people = new Map((draft?.profiles || []).map(profile => [profile.publicId,profile]));
    let pagesRead = draft?.pagesRead || 0;
    let resumeUrl = draft?.resumeUrl || committed?.resumeUrl || url;
    let complete = !!draft?.complete;
    // Largest results page seen in this batch: the next page could add this many people.
    let pageSize = draft?.pageSize || 0;
    let batchFull = !!draft?.batchFull;
    if (draft?.resumeUrl && draft.resumeUrl === draft.lastReadUrl && !complete)
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
    let lastReadUrl = draft?.lastReadUrl;
    for (; pagesRead < maxPages && !task.cancelled;) {
      const block = await captureBlockDetail();
      if (block.reason) {
        // Only the status check failed: keep the pages already read as a batch instead of
        // throwing them away; the next run continues from here.
        if (block.transient && pagesRead > 0) { stopReason = 'the capture status could not be confirmed (it will continue next time)'; await saveDraft(); break; }
        throw new Error(block.reason);
      }
      const ready = await waitForCompanyPeoplePage(tab.id,searchKey,afterPage,task);
      if (!ready) return {ok:true,cancelled:true};
      const result = await chrome.tabs.sendMessage(tab.id,{type:'COLLECT_COMPANY_PEOPLE_PAGE'});
      if (!result?.ok) {
        // Pages already read are kept: the batch ends here and the next one re-reads this page.
        if (pagesRead > 0) { stopReason = `LinkedIn stopped showing results (${result?.error || 'unreadable page'})`; await saveDraft(); break; }
        throw new Error(result?.error || 'The results page could not be read.');
      }
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
      let next;
      try {
        const advance = await chrome.tabs.sendMessage(tab.id,{type:'ADVANCE_COMPANY_PEOPLE_PAGE'});
        if (!advance?.ok) throw new Error(advance?.error || 'LinkedIn results did not advance.');
        next = await waitForCompanyPeoplePage(tab.id,searchKey,afterPage,task);
      } catch (error) {
        // The people read so far are a good batch; the next batch starts at the page that did not open.
        stopReason = `LinkedIn did not open the next page (${error.message})`;
        await saveDraft();
        break;
      }
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

// ── Company job scans: an initial scan, an independent verification scan, then the details ───────
// A scan never relies on one read. Pass 1 reads the company's Jobs tab (scrolling and pressing
// "Show more" until nothing more loads). Pass 2 reads LinkedIn's job search for the same company,
// newest first, page by page, which is a different source and catches what the tab did not show.
// The two are merged without duplicates, and each pass says whether it reached the end of what
// LinkedIn shows. The server decides what that can be trusted for (see recordJobScan). A scan that
// failed, was restricted, or did not load is never reported as "no jobs".
const jobReads = new Map();
export const JOB_SCAN_LIMITS = { SEARCH_PAGES: 8, DETAIL_PAGES: 15, PAGE_GAP_MS: 2500 };
export const JOB_SCAN_RESULT_KEY = 'skoutJobScanResult';
export const JOB_SCAN_PENDING_KEY = 'skoutJobScanPending';

export function jobsTabUrl(companyId) {
  return COMPANY_ID.test(companyId || '') ? `https://www.linkedin.com/company/${companyId}/jobs/` : undefined;
}
/** LinkedIn's job search for one company, newest first. Only the company id and the page offset are ever set. */
export function jobsSearchUrl(memberId, start = 0) {
  if (!/^\d{1,20}$/.test(String(memberId || '')) || !Number.isInteger(start) || start < 0 || start > 1000) return undefined;
  return `https://www.linkedin.com/jobs/search/?f_C=${memberId}&sortBy=DD&start=${start}`;
}
export function jobViewUrl(jobId) {
  return /^\d{4,20}$/.test(String(jobId || '')) ? `https://www.linkedin.com/jobs/view/${jobId}/` : undefined;
}
/** The page LinkedIn showed is the one asked for (it may add tracking parameters or redirect). */
function sameJobsPage(expected, actual) {
  try {
    const a = new URL(expected), b = new URL(actual);
    if (a.pathname.replace(/\/$/, '') !== b.pathname.replace(/\/$/, '')) return false;
    for (const key of ['f_C', 'start']) if ((a.searchParams.get(key) ?? '0') !== (b.searchParams.get(key) ?? '0') && a.searchParams.has(key)) return false;
    return true;
  } catch { return false; }
}

/** Reads one jobs page in a temporary tab and closes it. Returns the reader's answer. */
async function readJobsPage(owner, task, url, message, timeoutMs = 90_000) {
  if (!url) throw new Error('That jobs address is not allowed.');
  const tab = await chrome.tabs.create({ url, active: true, openerTabId: owner });
  task.tabId = tab.id;
  try {
    let ready = false;
    for (let attempt = 0; attempt < 40 && !task.cancelled; attempt++) {
      try {
        const response = await chrome.tabs.sendMessage(tab.id, { type: 'JOBS_READER_READY' });
        if (response?.ok && sameJobsPage(url, response.url)) { ready = true; break; }
      } catch { /* the document is still loading */ }
      await companyReadDelay(500);
    }
    if (task.cancelled) return { ok: true, cancelled: true };
    if (!ready) return { ok: true, state: 'not_loaded', jobs: [], complete: false, notes: ['The page did not become readable.'] };
    let timer;
    try {
      return await Promise.race([
        chrome.tabs.sendMessage(tab.id, message),
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('The jobs page took too long to load.')), timeoutMs); }),
      ]);
    } finally { clearTimeout(timer); }
  } finally {
    task.tabId = null;
    await chrome.tabs.remove(tab.id).catch(() => {});
  }
}

/** Trims a scan to what the API accepts: bounded text, valid dates, known work modes, LinkedIn job URLs. */
export function sanitizeJobScan(scan) {
  const cut = (value, max) => (typeof value === 'string' && value.trim() ? value.trim().slice(0, max) : undefined);
  const iso = (value) => { const date = value ? new Date(value) : null; return date && !Number.isNaN(date.getTime()) ? date.toISOString() : undefined; };
  const jobs = [];
  const seen = new Set();
  for (const job of scan.jobs || []) {
    const title = cut(job?.title, 300);
    if (!title) continue;
    const jobId = /^\d{4,20}$/.test(String(job.jobId || '')) ? String(job.jobId) : undefined;
    const key = jobId ? `id:${jobId}` : `text:${title.toLowerCase()}|${(job.location || '').toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const entry = {
      jobId, jobUrl: jobId ? jobViewUrl(jobId) : undefined, title,
      companyName: cut(job.companyName, 300), department: cut(job.department, 200), location: cut(job.location, 300),
      country: cut(job.country, 120), employmentType: cut(job.employmentType, 80),
      workplaceType: ['remote', 'hybrid', 'on_site'].includes(job.workplaceType) ? job.workplaceType : undefined,
      description: cut(job.description, 30000), requirements: cut(job.requirements, 15000),
      postedAt: iso(job.postedAt), postedText: cut(job.postedText, 100), source: cut(job.source, 60),
    };
    jobs.push(Object.fromEntries(Object.entries(entry).filter(([, v]) => v !== undefined)));
    if (jobs.length >= 500) break;
  }
  return {
    clientScanId: scan.clientScanId,
    status: scan.status,
    ...(cut(scan.source, 60) ? { source: cut(scan.source, 60) } : {}),
    passes: (scan.passes || []).slice(0, 5).map((pass) => ({
      pass: pass.pass, ...(cut(pass.method, 80) ? { method: cut(pass.method, 80) } : {}),
      found: Math.max(0, Math.min(5000, Number(pass.found) || 0)), complete: pass.complete === true,
      ...(cut(pass.note, 300) ? { note: cut(pass.note, 300) } : {}),
    })),
    jobs,
    notes: (scan.notes || []).map((note) => cut(note, 300)).filter(Boolean).slice(0, 30),
    ...(cut(scan.error, 500) ? { error: cut(scan.error, 500) } : {}),
    ...(iso(scan.startedAt) ? { startedAt: iso(scan.startedAt) } : {}),
    ...(iso(scan.completedAt) ? { completedAt: iso(scan.completedAt) } : {}),
  };
}

const mergeJob = (a, b) => ({ ...a, ...Object.fromEntries(Object.entries(b).filter(([, value]) => value !== undefined && value !== '')) });

/**
 * Runs both scans and the detail reads for one company and returns the scan (not saved yet).
 * `owner` is the LinkedIn tab the user started it from: progress is shown for it and its stop
 * button cancels the scan.
 */
export async function collectJobScan({ owner, companyId, memberId, publicName }) {
  const task = { tabId: null, cancelled: false };
  jobReads.set(owner, task);
  const startedAt = new Date().toISOString();
  const jobs = new Map();
  const passes = [];
  const notes = [];
  let status = 'completed';
  let error;
  const progress = (text) => setProgress({ kind: 'jobs', tabId: owner, active: true, text });
  const add = (list) => {
    let added = 0;
    for (const job of list || []) {
      const key = job.jobId ? `id:${job.jobId}` : `text:${(job.title || '').toLowerCase()}|${(job.location || '').toLowerCase()}`;
      if (!jobs.has(key)) added++;
      jobs.set(key, mergeJob(jobs.get(key) || {}, job));
    }
    return added;
  };
  /** Stops reading when LinkedIn warns, the workspace switched capture off, or the user stopped it. */
  const blocked = async () => {
    if (task.cancelled) return 'Stopped.';
    const block = await captureBlockDetail();
    if (block.reason && !block.transient) { status = block.reason.includes('stopped') ? 'restricted' : 'failed'; error = block.reason; return block.reason; }
    return block.transient ? block.reason : undefined;
  };
  const record = (pass, method, found, complete, note) => passes.push({ pass, method, found, complete, ...(note ? { note } : {}) });

  try {
    // Pass 1: the company's Jobs tab.
    progress(`Job roles: initial scan of ${publicName || companyId}'s Jobs tab…`);
    const stopReason = await blocked();
    if (stopReason) {
      // Nothing was read yet: the scan did not run, and that is a failure with its reason, not "no jobs".
      if (status === 'completed') status = 'failed';
      error = error || stopReason;
      throw Object.assign(new Error(error), { handled: true });
    }
    const first = await readJobsPage(owner, task, jobsTabUrl(companyId), { type: 'COLLECT_JOBS_PAGE', options: { source: 'company-jobs-tab' } });
    if (first.cancelled) throw Object.assign(new Error('Stopped.'), { handled: true, stopped: true });
    if (!first.ok) throw new Error(first.error || 'The Jobs tab could not be read.');
    add(first.jobs);
    memberId = memberId || first.memberId;
    record(1, 'company-jobs-tab', (first.jobs || []).length, first.state === 'ok' || first.state === 'empty' ? first.complete === true : false, (first.notes || [])[0]);
    notes.push(...(first.notes || []));
    if (first.state === 'restricted') { status = 'restricted'; error = (first.notes || [])[0]; throw Object.assign(new Error(error || 'LinkedIn restricted this page.'), { handled: true }); }

    // Pass 2: verification by LinkedIn's job search for the same company (another source).
    await companyReadDelay(JOB_SCAN_LIMITS.PAGE_GAP_MS);
    progress('Job roles: verification scan…');
    let secondFound = 0;
    let secondComplete = false;
    let secondMethod = 'job-search';
    const before = jobs.size;
    if (memberId) {
      let start = 0;
      for (let page = 0; page < JOB_SCAN_LIMITS.SEARCH_PAGES; page++, start += 25) {
        const stop = await blocked();
        if (stop) { notes.push(`Verification stopped: ${stop}`); break; }
        progress(`Job roles: verification scan, results page ${page + 1} (${jobs.size} roles so far)…`);
        // A page that fails is an incomplete verification, not a failed scan: what pass 1 found is kept.
        const result = await readJobsPage(owner, task, jobsSearchUrl(memberId, start), { type: 'COLLECT_JOBS_PAGE', options: { source: 'job-search' } })
          .catch((failure) => ({ ok: false, error: failure?.message }));
        if (result.cancelled) throw Object.assign(new Error('Stopped.'), { handled: true, stopped: true });
        if (!result.ok) { notes.push(`Verification page ${page + 1}: ${result.error || 'could not be read'}`); break; }
        if (result.state === 'restricted') { status = 'restricted'; error = (result.notes || [])[0]; break; }
        if (result.state === 'not_loaded') { notes.push(`Verification page ${page + 1} did not load.`); break; }
        secondFound += (result.jobs || []).length;
        add(result.jobs);
        if (result.state === 'empty' || !result.hasNext) { secondComplete = result.complete !== false; break; }
        if (page === JOB_SCAN_LIMITS.SEARCH_PAGES - 1) notes.push(`Verification stopped after ${JOB_SCAN_LIMITS.SEARCH_PAGES} result pages (${secondFound} roles); more may exist.`);
        await companyReadDelay(JOB_SCAN_LIMITS.PAGE_GAP_MS);
      }
    } else {
      // LinkedIn's company id was not found, so job search cannot be filtered to this company.
      secondMethod = 'company-jobs-tab-deep';
      notes.push("LinkedIn's company id was not found on the page, so the verification pass re-read the Jobs tab with deeper loading.");
      const result = await readJobsPage(owner, task, jobsTabUrl(companyId), { type: 'COLLECT_JOBS_PAGE', options: { source: 'company-jobs-tab', maxPasses: 70, wait: 900 } })
        .catch((failure) => ({ ok: false, error: failure?.message }));
      if (result.cancelled) throw Object.assign(new Error('Stopped.'), { handled: true, stopped: true });
      if (result.ok && (result.state === 'ok' || result.state === 'empty')) { secondFound = (result.jobs || []).length; secondComplete = result.complete === true; add(result.jobs); }
      else if (result.state === 'restricted') { status = 'restricted'; error = (result.notes || [])[0]; }
      else notes.push('The deeper Jobs tab read did not load.');
    }
    record(2, secondMethod, secondFound, secondComplete);
    const missedByFirst = jobs.size - before;
    if (missedByFirst > 0) notes.push(`The verification scan found ${missedByFirst} role${missedByFirst === 1 ? '' : 's'} the first scan missed; they were merged in.`);
    else if (jobs.size && secondComplete) notes.push('The verification scan found nothing the first scan had missed.');
    if (!jobs.size && !(passes[0]?.complete && secondComplete)) notes.push('No jobs were found, but the scans could not confirm that there are none.');

    // Details: the description and requirements of roles the workspace does not have them for yet.
    if (jobs.size && status === 'completed') {
      let known = new Map();
      try {
        const body = await deps.skoutFetch(`${API}/companies/${encodeURIComponent(companyId)}/jobs/known`);
        known = new Map((body?.jobs || []).map((entry) => [String(entry.jobId), entry.detailsComplete === true]));
      } catch { /* every role without a description is read */ }
      const wanted = [...jobs.values()]
        .filter((job) => job.jobId && !job.description && !known.get(String(job.jobId)))
        .sort((a, b) => String(b.postedAt || '').localeCompare(String(a.postedAt || '')))
        .slice(0, JOB_SCAN_LIMITS.DETAIL_PAGES);
      let skipped = 0;
      for (const [index, job] of wanted.entries()) {
        if (await blocked()) break;
        progress(`Job roles: reading details ${index + 1} of ${wanted.length}…`);
        await companyReadDelay(JOB_SCAN_LIMITS.PAGE_GAP_MS);
        const result = await readJobsPage(owner, task, jobViewUrl(job.jobId), { type: 'COLLECT_JOB_DETAIL' }, 60_000).catch(() => undefined);
        if (result?.cancelled) throw Object.assign(new Error('Stopped.'), { handled: true, stopped: true });
        if (result?.state === 'restricted') { status = 'restricted'; error = result.note; break; }
        if (result?.ok && result.detail?.description) {
          const detail = result.detail;
          // The description and requirements come from the job's own page; card facts stay unless missing.
          const key = `id:${job.jobId}`;
          const current = jobs.get(key) || job;
          jobs.set(key, { ...mergeJob(detail, current), description: detail.description, requirements: detail.requirements ?? current.requirements, department: detail.department ?? current.department });
        } else skipped++;
      }
      const unread = jobs.size - [...jobs.values()].filter((job) => job.description).length;
      if (skipped) notes.push(`${skipped} job page${skipped === 1 ? '' : 's'} did not load, so those roles have no description yet.`);
      if (unread > 0 && !skipped) notes.push(`${unread} role${unread === 1 ? '' : 's'} have no description yet (details are read ${JOB_SCAN_LIMITS.DETAIL_PAGES} per scan; rescan to continue).`);
    }
  } catch (caught) {
    if (!caught?.handled) { status = status === 'restricted' ? status : 'failed'; error = caught?.message || 'The job scan failed.'; }
    else if (caught.stopped) { status = 'failed'; error = 'The job scan was stopped.'; }
    // A page the scan could not get to before stopping is an incomplete pass, not an empty one.
    if (!passes.length) record(1, 'company-jobs-tab', jobs.size, false, error);
  } finally {
    jobReads.delete(owner);
  }
  // A scan that read nothing because the pages never loaded is "not loaded", not "failed".
  if (status === 'completed' && !jobs.size && passes.length && passes.every((pass) => !pass.complete) && notes.some((note) => /did not (?:finish loading|load|become readable)/i.test(note))) status = 'not_loaded';
  return sanitizeJobScan({
    clientScanId: globalThis.crypto?.randomUUID?.() || `scan-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    status, source: 'company-jobs-tab+job-search', passes, jobs: [...jobs.values()], notes, error, startedAt, completedAt: new Date().toISOString(),
  });
}

/** What the side panel shows for a finished scan. */
export function jobScanSummary(scan, saved) {
  return {
    status: saved?.status || scan.status,
    jobsFound: scan.jobs.length,
    jobsNew: saved?.jobsNew,
    jobsUpdated: saved?.jobsUpdated,
    verified: saved?.verified === true,
    passes: scan.passes,
    notes: scan.notes,
    error: scan.error,
    at: Date.now(),
  };
}

async function saveJobScan(companyId, scan) {
  let last;
  for (let attempt = 1; attempt <= SAVE_ATTEMPTS; attempt++) {
    try {
      // The same scan id every time: a repeated request is recorded once.
      return await deps.skoutFetch(`${API}/companies/${encodeURIComponent(companyId)}/jobs/scan`, { method: 'POST', body: JSON.stringify(scan), timeoutMs: 60_000 });
    } catch (error) {
      last = error;
      if (!(error?.transient || error?.timedOut) || attempt >= SAVE_ATTEMPTS) break;
      await timing.delay(Math.min(15_000, 3_000 * attempt));
    }
  }
  throw last;
}

/**
 * A job scan started from the side panel (or a workspace request): scans, then saves it. A save that
 * cannot be confirmed keeps the scan so "Save again" is safe.
 */
async function runJobScan(message) {
  const companyId = String(message.companyId || '');
  if (!COMPANY_ID.test(companyId)) return { ok: false, error: 'Not a LinkedIn company.' };
  if (message.tabId == null) return { ok: false, error: 'Open the company on LinkedIn first.' };
  if (jobReads.has(message.tabId)) return { ok: false, error: 'A job scan is already running on this tab.' };
  const block = await captureBlockDetail();
  if (block.reason) return { ok: false, error: block.reason };
  const scanId = globalThis.crypto?.randomUUID?.() ?? `scan-${Date.now()}`;
  // Tell the workspace it started (best effort): it shows "In progress" and answers a rescan request.
  deps.skoutFetch(`${API}/companies/${encodeURIComponent(companyId)}/jobs/scan/start`, { method: 'POST', body: JSON.stringify({ clientScanId: scanId }) }).catch(() => {});
  const scan = await collectJobScan({ owner: message.tabId, companyId, publicName: message.name });
  scan.clientScanId = scanId;
  let result = { ok: true, scan: jobScanSummary(scan) };
  try {
    const saved = await saveJobScan(companyId, scan);
    await chrome.storage.local.remove(JOB_SCAN_PENDING_KEY);
    result = { ok: true, scan: jobScanSummary(scan, saved?.scan || saved) , saved: true };
    await chrome.storage.local.set({ [JOB_SCAN_RESULT_KEY]: { companyId, name: message.name, ...result.scan } });
    await setProgress({ kind: 'jobs', tabId: message.tabId, active: false, text: `Job roles saved: ${scan.jobs.length} found.` });
  } catch (error) {
    const unconfirmed = error?.transient || error?.timedOut;
    if (error?.body?.error === 'company_not_captured' || /capture this company first/i.test(error?.message || '')) {
      result = { ok: false, error: 'Capture this company first, then its job roles can be saved.', scan: jobScanSummary(scan) };
    } else if (unconfirmed) {
      await chrome.storage.local.set({ [JOB_SCAN_PENDING_KEY]: { companyId, name: message.name, scan } });
      result = { ok: false, pending: true, error: `The scan finished but Skout did not confirm the save (${error.message}). It is kept: choose Save again. It will not be saved twice.`, scan: jobScanSummary(scan) };
    } else {
      result = { ok: false, error: error?.message || 'The job scan could not be saved.', scan: jobScanSummary(scan) };
    }
    await chrome.storage.local.set({ [JOB_SCAN_RESULT_KEY]: { companyId, name: message.name, ...result.scan, saveError: result.error } });
    await setProgress({ kind: 'jobs', tabId: message.tabId, active: false, isError: true, text: result.error });
  }
  return result;
}

async function retryJobScanSave() {
  const pending = await getStored(JOB_SCAN_PENDING_KEY);
  if (!pending?.scan) return { ok: false, error: 'There is no job scan waiting to be saved.' };
  try {
    const saved = await saveJobScan(pending.companyId, pending.scan);
    await chrome.storage.local.remove(JOB_SCAN_PENDING_KEY);
    const summary = jobScanSummary(pending.scan, saved?.scan || saved);
    await chrome.storage.local.set({ [JOB_SCAN_RESULT_KEY]: { companyId: pending.companyId, name: pending.name, ...summary } });
    return { ok: true, scan: summary, saved: true };
  } catch (error) {
    return { ok: false, pending: true, error: error?.message || 'The job scan could not be saved.' };
  }
}

/** Companies the workspace asked to rescan, for the side panel. */
async function listRequestedJobScans() {
  try {
    const body = await deps.skoutFetch(`${API}/capture/job-scans/requested`);
    return { ok: true, scans: (body?.scans || []).filter((scan) => COMPANY_ID.test(scan.companyPublicId || '')) };
  } catch (error) {
    return { ok: false, error: error?.message || 'Requested job scans could not be loaded.' };
  }
}

// ── Drafts, progress, halt ────────────────────────────────────────────────────

const taskMaps = () => [salesLinkReads, companyReads, personReads, companyPeopleReads, jobReads];

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
    // Names this capture for idempotent saves (see sendCapture).
    clientRunId: globalThis.crypto?.randomUUID?.(),
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
  // A queued company whose batch came back empty never waits for a review of nothing.
  if (draft.kind === 'company' && (await runQueueEmptyBatch(draft))) return { ok: true };
  await chrome.storage.local.set({ [CAPTURE_DRAFT_KEY]: draft });
  if (draft.kind === 'company') {
    const autoSave = await runQueueInReview(draft.meta.companyId);
    if (autoSave) autoSaveBatch(draft.meta.companyId).catch(() => {});
  }
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
  const key = draft.clientRunId ? { clientRunId: draft.clientRunId } : {};
  if (draft.kind === 'sales') {
    return {
      sourceUrl: clean.sourceUrl,
      filters: clean.filters,
      pagesRead: Math.min(CAPTURE_CAPS.MAX_PAGES, Math.max(1, Number(clean.pagesRead) || 1)),
      resultCount: clean.resultCount,
      peopleProfiles: leads || [],
      capturedAt,
      ...key,
    };
  }
  if (draft.kind === 'company') {
    const payload = { ...clean, capturedAt, ...key };
    if (leads?.length) {
      payload.peopleProfiles = leads;
      payload.pagesRead = Math.min(CAPTURE_CAPS.MAX_PAGES, Number(draft.meta?.progress?.pagesThisBatch) || 0);
    } else {
      delete payload.peopleProfiles;
      delete payload.pagesRead;
    }
    return payload;
  }
  return { ...clean, capturedAt, ...key };
}

// A save that times out is sent again this many times in all before the user is asked to retry.
const SAVE_ATTEMPTS = 3;
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
    // The same capture carries the same clientRunId every time, so sending it again after a
    // timeout is safe: the API replays what it recorded instead of saving it twice.
    for (let attempt = 1; ; attempt++) {
      try {
        body = await deps.skoutFetch(`${API}/ingest/${path}`, { method: 'POST', body: JSON.stringify(payload), timeoutMs: 60_000 });
        break;
      } catch (error) {
        if (!(error?.transient || error?.timedOut) || attempt >= SAVE_ATTEMPTS) throw error;
        await timing.delay(Math.min(15_000, 3_000 * attempt));
      }
    }
  } catch (error) {
    if (error?.timedOut || error?.transient) {
      // A timeout does not mean the capture failed: it may be saved, or still saving. The reviewed
      // batch is kept, and Save again is safe (it is not saved twice).
      return {
        ok: false,
        pending: true,
        error: `Skout is taking longer than usual to confirm this save (${error.message}). Your reviewed capture is kept: choose Save again in a moment. It will not be saved twice.`,
        code: 'save_unconfirmed',
        run: null,
      };
    }
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
      checkpoint.queued = await reportCaptureQueue(draft.meta.companyId, draft.data?.name, commit.data, { created: body.created, merged: body.merged, rejected: body.rejected });
    }
  }
  await chrome.storage.local.remove(CAPTURE_DRAFT_KEY);
  let autoContinued = false;
  if (draft.kind === 'company') {
    autoContinued = await runQueueBatchSaved(draft.meta?.companyId, { created: body.created, merged: body.merged }, checkpoint, {
      autoContinue: message.autoContinue === true, autoSave: message.autoSave === true, name: draft.data?.name, tabId: draft.tabId,
    });
  }
  return {
    ok: true,
    autoContinued,
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
async function reportCaptureQueue(companyId, companyName, commit, counts) {
  try {
    await deps.skoutFetch(`${API}/capture/queue/${encodeURIComponent(companyId)}`, {
      method: 'PUT',
      body: JSON.stringify(captureQueueReport(companyName, commit, counts)),
    });
    return true;
  } catch {
    return false; // The local checkpoint still resumes; only the web list is out of date.
  }
}

/** The queue update for one committed batch. Exported for tests. */
export function captureQueueReport(companyName, commit, counts) {
  const report = {
    pagesRead: Math.max(0, Number(commit.pagesRead) || 0),
    peopleFound: Math.max(0, Number(commit.distinctCandidates) || 0),
    complete: commit.complete === true,
  };
  // What the saved batch did: people added, matched to people already saved (duplicates), refused.
  for (const key of ['created', 'merged', 'rejected']) {
    const value = Number(counts?.[key]);
    if (Number.isInteger(value) && value >= 0) report[key] = value;
  }
  if (typeof companyName === 'string' && companyName.trim()) report.companyName = companyName.trim().slice(0, 300);
  if (Number.isFinite(commit.expectedAssociatedMembers)) report.expectedPeople = commit.expectedAssociatedMembers;
  if (commit.stopReason) report.stopReason = String(commit.stopReason).slice(0, 300);
  return report;
}

const COMPANY_ID = /^[A-Za-z0-9%._~-]{1,200}$/;

/** This browser's saved people-capture position for a company: 'paused' | 'partial' | 'complete' | undefined. */
function localProgress(state) {
  if (!state) return undefined;
  if (state.draft?.profiles?.length) return 'paused';
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
// A company read "until finished" stops after this many saved batches (250 people each).
const MAX_BATCHES_PER_COMPANY = 40;
// A queue waits this many times (with growing pauses) for a status check that cannot be confirmed.
const MAX_STATUS_RETRIES = 6;

async function getRunQueue() {
  return (await getStored(RUN_QUEUE_KEY)) || null;
}
async function setRunQueue(queue) {
  await chrome.storage.local.set({ [RUN_QUEUE_KEY]: { ...queue, at: Date.now() } });
  reportRunQueue(queue);
}

/** The status the dashboard shows for a company in this browser's run queue. */
export function jobStatusFor(item, queueActive) {
  switch (item.status) {
    case 'running': return 'running';
    case 'review': return 'review';
    case 'failed': return 'failed';
    case 'skipped': return 'skipped';
    case 'done': return item.moreRemain ? 'paused' : 'completed';
    default: return queueActive ? 'queued' : 'paused';
  }
}

// Every change to the run queue is reported so the workspace's Capture queue page follows it.
// One request at a time; a change that arrives meanwhile is sent right after with the latest state.
let reporting = false;
let reportAgain = null;
function reportRunQueue(queue) {
  if (!queue?.items?.length) return;
  if (reporting) { reportAgain = queue; return; }
  reporting = true;
  const items = queue.items.slice(0, 200).map(item => {
    const status = jobStatusFor(item, queue.active === true);
    return {
      companyPublicId: item.companyPublicId,
      companyName: item.name,
      status,
      ...(status === 'failed' && item.error ? { error: String(item.error).slice(0, 500) } : {}),
    };
  });
  Promise.resolve()
    .then(() => deps.skoutFetch(`${API}/capture/queue/sync`, { method: 'POST', body: JSON.stringify({ items }) }))
    .then((body) => (Array.isArray(body?.cancelled) && body.cancelled.length ? dropCancelledJobs(body.cancelled) : undefined))
    .catch(() => { /* The local queue keeps working; the dashboard catches up on the next change. */ })
    .finally(() => {
      reporting = false;
      const next = reportAgain;
      reportAgain = null;
      if (next) reportRunQueue(next);
    });
}

/** Jobs cancelled in the workspace: drop them here, stop the one being read, and move on. */
async function dropCancelledJobs(ids) {
  const queue = await getRunQueue();
  if (!queue?.items?.length) return;
  const cancelled = new Set(ids);
  let stoppedRunning = false;
  for (const item of queue.items) {
    if (!cancelled.has(item.companyPublicId) || !['pending', 'running', 'review'].includes(item.status)) continue;
    if (item.status === 'running') stoppedRunning = true;
    item.status = 'skipped';
    item.error = 'Cancelled in the workspace.';
  }
  if (stoppedRunning && queue.tabId != null) {
    chrome.tabs.sendMessage(queue.tabId, { type: 'SKOUT_CAPTURE_STOP' }).catch(() => {});
    cancelTasksFor(queue.tabId);
  }
  // Written without reporting back: the server already holds these jobs as cancelled.
  await chrome.storage.local.set({ [RUN_QUEUE_KEY]: { ...queue, at: Date.now() } });
  if (queue.active) advanceSoon();
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
      const block = await captureBlockDetail();
      if (block.transient && (queue.statusRetries || 0) < MAX_STATUS_RETRIES) {
        // A slow or restarting API is not a reason to stop the queue: wait, then try again.
        const waitMs = Math.min(5 * 60_000, 20_000 * 2 ** (queue.statusRetries || 0));
        await setRunQueue({ ...queue, statusRetries: (queue.statusRetries || 0) + 1, note: `Waiting for Skout to answer (retry in ${Math.round(waitMs / 1000)} s).` });
        timing.delay(waitMs).then(advanceRunQueue).catch(() => {});
        return;
      }
      if (block.reason) return setRunQueue({ ...queue, active: false, note: block.reason });
      if (queue.statusRetries) queue.statusRetries = 0;
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

/** Jobs asked for from the workspace's Capture queue page that this browser is not reading yet. */
async function listRequestedJobs() {
  try {
    const body = await deps.skoutFetch(`${API}/capture/queue?status=queued`);
    const queue = await getRunQueue();
    const local = new Set((queue?.items || []).filter(entry => ['pending', 'running', 'review'].includes(entry.status)).map(entry => entry.companyPublicId));
    const jobs = (body?.items || [])
      .filter(item => COMPANY_ID.test(item.companyPublicId || '') && !local.has(item.companyPublicId))
      .map(item => ({ companyPublicId: item.companyPublicId, name: item.companyName || item.companyPublicId }));
    return { ok: true, jobs };
  } catch (error) {
    return { ok: false, error: error?.message || 'Requested jobs could not be loaded.' };
  }
}

async function startRunQueue(message) {
  const existing = await getRunQueue();
  // Companies still waiting in a running or paused queue are kept; new ones join them.
  const adding = Boolean(existing && (existing.active || existing.items.some(entry => ['pending', 'running', 'review'].includes(entry.status))));
  if (!adding && (await getStored(CAPTURE_DRAFT_KEY))) return { ok: false, error: 'Save or discard the capture waiting for review first.' };
  const seen = new Set();
  const items = [];
  for (const company of Array.isArray(message.companies) ? message.companies : []) {
    const id = String(company?.companyPublicId || '');
    if (!COMPANY_ID.test(id) || seen.has(id)) continue;
    seen.add(id);
    items.push({
      companyPublicId: id, name: String(company?.name || id).slice(0, 200), status: 'pending',
      ...(message.untilComplete === true ? { untilComplete: true } : {}),
    });
  }
  if (!items.length) return { ok: false, error: 'Select at least one company.' };
  if (adding) {
    // A company asked for while a queue runs joins it, unless it is already waiting or being read.
    const fresh = items.filter(item => !existing.items.some(entry => entry.companyPublicId === item.companyPublicId && ['pending', 'running', 'review'].includes(entry.status)));
    const kept = existing.items.filter(entry => !fresh.some(item => item.companyPublicId === entry.companyPublicId));
    if (kept.length + fresh.length > MAX_QUEUE_COMPANIES) return { ok: false, error: `A queue holds at most ${MAX_QUEUE_COMPANIES} companies.` };
    if (!fresh.length) return { ok: true, count: 0 };
    await setRunQueue({
      ...existing, active: true, note: undefined, items: [...kept, ...fresh],
      ...(typeof message.autoSave === 'boolean' ? { autoSave: message.autoSave } : {}),
    });
    advanceRunQueue().catch(() => {});
    return { ok: true, count: fresh.length, added: true };
  }
  if (items.length > MAX_QUEUE_COMPANIES) return { ok: false, error: `A queue holds at most ${MAX_QUEUE_COMPANIES} companies. Select fewer.` };
  await setRunQueue({ active: true, tabId: null, items, startedAt: Date.now(), autoSave: message.autoSave === true });
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
/** The company being read has a reviewable batch now. Returns true when the queue saves batches itself. */
async function runQueueInReview(companyId) {
  const queue = await getRunQueue();
  const item = queue?.items?.find(entry => entry.status === 'running' && (!companyId || entry.companyPublicId === companyId));
  if (!item) return false;
  item.status = 'review';
  await setRunQueue(queue);
  return queue.autoSave === true;
}

/**
 * A batch with no people for the company the queue is reading: tried once more from the same
 * page, then the company fails with the reason and the queue moves on. Returns true when handled.
 */
async function runQueueEmptyBatch(draft) {
  if ((draft.data?.peopleProfiles || []).length) return false;
  const queue = await getRunQueue();
  const item = queue?.items?.find(entry => entry.status === 'running' && entry.companyPublicId === draft.meta.companyId);
  if (!item) return false;
  // Everyone on those pages is already saved: move past them instead of calling the company empty.
  if (Number(draft.meta?.stats?.discovered) > 0 && draft.meta?.checkpointToken) {
    const commit = await commitCompanyPeopleCapture({ companyId: item.companyPublicId, token: draft.meta.checkpointToken });
    const moreRemain = commit.ok && commit.data.complete === false;
    if (commit.ok) await reportCaptureQueue(item.companyPublicId, item.name, commit.data);
    item.batches = (item.batches || 0) + 1;
    item.emptyTries = 0;
    item.status = moreRemain && item.untilComplete && item.batches < MAX_BATCHES_PER_COMPANY ? 'pending' : 'done';
    item.moreRemain = moreRemain && item.status === 'done';
    await setRunQueue(queue);
    if (queue.active) advanceSoon();
    return true;
  }
  // Forget the empty page cursor so the retry reads those pages again.
  const state = await getCompanyPeopleState(item.companyPublicId);
  if (state.draft) await setCompanyPeopleState(item.companyPublicId, { ...state, draft: undefined });
  item.emptyTries = (item.emptyTries || 0) + 1;
  if (item.emptyTries < 2) {
    item.status = 'pending';
  } else {
    item.status = 'failed';
    item.error = 'LinkedIn showed no people for this company (tried twice). Open its People page on LinkedIn to check, then retry.';
  }
  await setRunQueue(queue);
  if (queue.active) advanceSoon();
  return true;
}

/** Automatic mode: saves the batch without a review, as Save would. */
async function autoSaveBatch(companyId) {
  const result = await sendCapture({});
  if (result.ok) return;
  const queue = await getRunQueue();
  const item = queue?.items?.find(entry => entry.companyPublicId === companyId && entry.status === 'review');
  if (!item) return;
  if (/daily capture limit|capture is disabled/i.test(result.error || '')) {
    // The batch waits in the side panel; the queue stops until the limit resets or capture is back.
    await setRunQueue({ ...queue, active: false, note: `Stopped: ${result.error} The batch for ${item.name} is waiting to be saved.` });
    return;
  }
  item.status = 'failed';
  item.error = String(result.error || 'The batch could not be saved.').slice(0, 300);
  await chrome.storage.local.remove(CAPTURE_DRAFT_KEY);
  await setRunQueue(queue);
  if (queue.active) advanceSoon();
}

/** Discard: the batch is dropped, and so is its unsaved page cursor (the next run reads those pages again). */
async function discardDraft() {
  const draft = await getStored(CAPTURE_DRAFT_KEY);
  await chrome.storage.local.remove(CAPTURE_DRAFT_KEY);
  const companyId = draft?.kind === 'company' ? draft.meta?.companyId : undefined;
  if (companyId) {
    const state = await getCompanyPeopleState(companyId);
    if (state.draft) await setCompanyPeopleState(companyId, { ...state, draft: undefined });
  }
  await runQueueBatchDiscarded();
  return { ok: true };
}

/**
 * A reviewed batch was saved. For a company read "until finished" with people left, the company
 * goes back to waiting so the queue reads its next batch; otherwise it is done and the queue moves
 * on. A company captured outside the queue (Capture this company) joins a new one-company queue
 * when `autoContinue` is set and people remain.
 */
async function runQueueBatchSaved(companyId, counts, checkpoint, extra = {}) {
  const savedNow = (counts?.created || 0) + (counts?.merged || 0);
  const moreRemain = Boolean(checkpoint) && !checkpoint.error && checkpoint.complete === false;
  let queue = await getRunQueue();
  let item = queue?.items?.find(entry => entry.companyPublicId === companyId && ['running', 'review'].includes(entry.status));
  if (!item) {
    if (!(extra.autoContinue && moreRemain && savedNow > 0 && COMPANY_ID.test(companyId || '')) || queue?.active) return false;
    item = { companyPublicId: companyId, name: String(extra.name || companyId).slice(0, 200), status: 'running', untilComplete: true, batches: 0, saved: 0 };
    queue = { active: true, tabId: extra.tabId ?? null, items: [item], startedAt: Date.now(), autoSave: extra.autoSave === true };
  }
  item.batches = (item.batches || 0) + 1;
  item.saved = (item.saved || 0) + savedNow;
  // No new people in a batch means more reading would only repeat itself.
  const again = item.untilComplete === true && moreRemain && savedNow > 0 && item.batches < MAX_BATCHES_PER_COMPANY;
  item.status = again ? 'pending' : 'done';
  item.moreRemain = moreRemain && !again;
  await setRunQueue(queue);
  if (queue.active) advanceSoon();
  return again;
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


/** Whether this workspace can read people automatically on the server (Unipile). */
async function autoCaptureStatus() {
  try {
    return { ok: true, ...(await deps.skoutFetch(`${API}/capture/auto`)) };
  } catch (error) {
    return { ok: false, error: error?.message || 'Automatic capture status is unavailable.' };
  }
}

/** Queues server-side automatic people capture for these companies. */
async function startAutoCapture(message) {
  const ids = (Array.isArray(message.companyPublicIds) ? message.companyPublicIds : []).filter(id => COMPANY_ID.test(id || '')).slice(0, 200);
  if (!ids.length) return { ok: false, error: 'Select at least one company.' };
  try {
    const body = await deps.skoutFetch(`${API}/capture/auto`, { method: 'POST', body: JSON.stringify({ companyPublicIds: ids }) });
    return { ok: true, queued: body?.queued || [], skipped: body?.skipped || [] };
  } catch (error) {
    return { ok: false, error: error?.body?.message || error?.message || 'Automatic capture could not start.' };
  }
}

/** The company people search saved by an earlier run, for when LinkedIn hides the link on the page. */
async function savedPeopleSearch(companyId) {
  if (!COMPANY_ID.test(companyId || '')) return { ok: true, url: undefined };
  const state = await getCompanyPeopleState(companyId);
  return { ok: true, url: companyPeopleSearchUrl(state.searchUrl || '') };
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
      return fromExtensionPage(sender) ? discardDraft() : undefined;
    case 'capture-companies':
      return fromExtensionPage(sender) ? listCaptureCompanies(message) : undefined;
    case 'capture-auto-status':
      return fromExtensionPage(sender) ? autoCaptureStatus() : undefined;
    case 'capture-auto-start':
      return fromExtensionPage(sender) ? startAutoCapture(message) : undefined;
    case 'capture-jobs-scan':
      return fromExtensionPage(sender) ? runJobScan(message) : undefined;
    case 'capture-jobs-retry-save':
      return fromExtensionPage(sender) ? retryJobScanSave() : undefined;
    case 'capture-job-scans-requested':
      return fromExtensionPage(sender) ? listRequestedJobScans() : undefined;
    case 'SCAN_COMPANY_JOBS':
      // From the company capture on a LinkedIn tab: scan, and hand the scan to the review (saved with the company).
      return sender.tab?.id == null ? undefined : collectJobScan({ owner: sender.tab.id, companyId: String(message.companyId || ''), memberId: message.memberId, publicName: message.name }).then(scan => ({ ok: true, scan }));
    case 'capture-requested':
      return fromExtensionPage(sender) ? listRequestedJobs() : undefined;
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
    case 'GET_SAVED_PEOPLE_SEARCH':
      return savedPeopleSearch(message.companyId);
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

/** The dashboard's Resume / Retry button: read this company's people until it is finished. */
export function resumeJobFromWeb(companyId, name) {
  if (!COMPANY_ID.test(companyId || '')) return Promise.resolve({ ok: false, error: 'Not a LinkedIn company.' });
  return startRunQueue({ companies: [{ companyPublicId: companyId, name: String(name || companyId) }], untilComplete: true });
}

export const __test = { commitCompanyPeopleCapture, getCompanyPeopleState, captureBlock, captureBlockDetail, resetStatusCache: () => { lastConfirmedStatus = null; }, companyReadUrl, deps, listCaptureCompanies, getRunQueue, advanceRunQueue, readCompanyPeopleSearch };
