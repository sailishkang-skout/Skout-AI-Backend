/** Capture section of the side panel (ENR-02): start, stop/pause, review/edit, save. */

export const DRAFT_KEY = "skoutCaptureDraft";
export const PROGRESS_KEY = "skoutCaptureProgress";
export const HALT_KEY = "skoutCaptureHalt";
export const RUN_QUEUE_KEY = "skoutCaptureRunQueue";
export const JOB_SCAN_RESULT_KEY = "skoutJobScanResult";
export const JOB_SCAN_PENDING_KEY = "skoutJobScanPending";
const checkpointKey = (companyId) => `company-people-capture:${companyId}`;
/** Matches capture-background.js: a reader silent for this long is no longer running. */
const PROGRESS_STALE_MS = 3 * 60 * 1000;

export function isProgressActive(progress, now = Date.now()) {
  return progress?.active === true && now - (progress.at || 0) < PROGRESS_STALE_MS;
}

const KIND_LABELS = { person: "profile", company: "company", sales: "Sales Navigator results" };
const START_LABELS = {
  person: "Capture this profile",
  company: "Capture this company",
  sales: "Capture Sales Navigator results",
};

/** Which capture, if any, the given tab URL supports. */
export function captureKindForUrl(url) {
  let parsed;
  try {
    parsed = new URL(url || "");
  } catch {
    return null;
  }
  if (parsed.protocol !== "https:" || !["www.linkedin.com", "linkedin.com"].includes(parsed.hostname)) return null;
  if (/^\/in\/[^/]+/.test(parsed.pathname)) return "person";
  if (/^\/company\/[^/]+/.test(parsed.pathname)) return "company";
  if (/^\/sales\/search\/people/.test(parsed.pathname)) return "sales";
  return null;
}

export function companyIdForUrl(url) {
  try {
    return new URL(url).pathname.match(/^\/company\/([^/]+)/)?.[1];
  } catch {
    return undefined;
  }
}

const isPublicProfileUrl = (value) => /^https:\/\/(www\.)?linkedin\.com\/in\/[^/]+\/?$/.test(value || "");

/** The draft as it will be saved: the edited data minus the leads the reviewer unticked. */
export function reviewedData(data, excludedIds, options = {}) {
  let out = data;
  // The reviewer can leave the job roles out of what is saved with the company.
  if (options.skipJobs && out?.jobScan) { const { jobScan: _jobScan, ...rest } = out; out = rest; }
  if (!Array.isArray(out?.peopleProfiles) || !excludedIds?.size) return out;
  return { ...out, peopleProfiles: out.peopleProfiles.filter((profile) => !excludedIds.has(profile.publicId)) };
}

/** One-line counts of what a draft contains. */
export function draftSummary(kind, data) {
  const size = (value) => (Array.isArray(value) ? value.length : 0);
  const parts = [];
  if (kind === "person") {
    parts.push(`${size(data.currentCompanies)} current and ${size(data.previousCompanies)} past roles`);
    parts.push(`${size(data.educations)} education`);
    parts.push(`${size(data.skills)} skills`);
    if (data.email || data.phone) {
      parts.push("Contact details ready to save after review");
    }
    for (const [key, label] of [["certifications", "certifications"], ["languages", "languages"], ["recommendations", "recommendations"], ["volunteerExperiences", "volunteering"], ["honors", "honors"], ["publications", "publications"], ["patents", "patents"], ["courses", "courses"], ["organizations", "organizations"], ["projects", "projects"]]) {
      if (size(data[key])) parts.push(`${size(data[key])} ${label}`);
    }
  } else if (kind === "company") {
    parts.push(`${Object.keys(data.sectionCaptures || {}).length} company sections`);
    if (data.employeesOnLi != null) parts.push(`${data.employeesOnLi} members on LinkedIn`);
    for (const [key, label] of [["products", "products"], ["recentPosts", "posts"]]) {
      if (size(data[key])) parts.push(`${size(data[key])} ${label}`);
    }
    if (data.jobScan) parts.push(`${size(data.jobScan.jobs)} job roles (${jobScanStatusLabel(data.jobScan)})`);
    else if (size(data.openJobs)) parts.push(`${size(data.openJobs)} jobs`);
    parts.push(`${size(data.peopleProfiles)} people (discovery candidates)`);
  } else {
    const leads = data.peopleProfiles || [];
    const linked = leads.filter((profile) => isPublicProfileUrl(profile.sourceUrl)).length;
    parts.push(`${leads.length} leads from ${data.pagesRead || 1} page(s)`);
    parts.push(`${linked} with a public LinkedIn link, ${leads.length - linked} Sales Navigator only`);
  }
  return parts.join(" · ");
}

export function personReviewPreview(data) {
  const educations = (Array.isArray(data.educations) ? data.educations : []).map((education) =>
    [education.school, education.degree, education.dates, education.activities, education.description]
      .filter((value) => typeof value === "string" && value.trim())
      .join(" · ")
  );
  const skills = (Array.isArray(data.skills) ? data.skills : []).map((skill) => {
    const name = typeof skill?.name === "string" ? skill.name.trim() : "";
    if (!name) return "";
    return skill.endorsements ? `${name} (${skill.endorsements} endorsements)` : name;
  }).filter(Boolean);
  return { educations, skills };
}

const EDITABLE_FIELDS = {
  // [field, label, multiline, type] — type "count" is a whole number, "url" a website address.
  person: [["fullName", "Name"], ["headline", "Headline"], ["currentCompany", "Current company"], ["currentTitle", "Current title"], ["previousCompany", "Previous company"], ["previousTitle", "Previous title"], ["locationName", "Location"], ["locationCountry", "Country"], ["email", "Email", false, "email"], ["phone", "Phone", false, "phone"], ["website", "Website / portfolio", false, "url"], ["followersCount", "Followers", false, "count"], ["connectionsCount", "Connections", false, "count"], ["pronoun", "Pronouns"], ["summary", "About", true]],
  company: [["name", "Name"], ["tagline", "Tagline"], ["industry", "Industry"], ["headquarter", "Headquarters"], ["locationCountry", "Country"], ["size", "Company size"], ["employeesOnLi", "Members on LinkedIn", false, "count"], ["followers", "Followers", false, "count"], ["website", "Website", false, "url"], ["phone", "Phone", false, "phone"], ["foundedAt", "Founded"], ["overview", "About", true]],
  sales: [],
};

// Review fields that edit the most recent role rather than a top-level value.
const ROLE_FIELDS = {
  currentCompany: { list: "currentCompanies", key: "name" },
  currentTitle: { list: "currentCompanies", key: "title" },
  previousCompany: { list: "previousCompanies", key: "name" },
  previousTitle: { list: "previousCompanies", key: "title" },
};

const sameName = (a, b) => String(a || "").trim().toLowerCase() === String(b || "").trim().toLowerCase();

/**
 * Which role a review field shows. The previous company is the most recent past role at a
 * different employer: an earlier title at the current company is a promotion, not a move.
 */
export function roleIndex(data, { list }) {
  const roles = Array.isArray(data?.[list]) ? data[list] : [];
  if (list !== "previousCompanies") return 0;
  const current = data?.currentCompanies?.[0]?.name;
  const index = roles.findIndex((role) => role?.name && !sameName(role.name, current));
  return index >= 0 ? index : 0;
}

export function roleValue(data, role) {
  return data?.[role.list]?.[roleIndex(data, role)]?.[role.key];
}

export function setRoleField(data, role, value) {
  const { list, key } = role;
  const roles = Array.isArray(data[list]) ? data[list] : [];
  const index = roleIndex(data, role);
  if (!value) {
    if (roles[index]) delete roles[index][key];
    return;
  }
  data[list] = roles.length ? roles : [{}];
  data[list][index] = { ...data[list][index], [key]: value };
}

/** Fields the review shows for this kind of capture: [field, label][]. */
export function reviewFieldList(kind) {
  return (EDITABLE_FIELDS[kind] || []).map(([field, label]) => [field, label]);
}

/** A review field's current value ("" when LinkedIn did not show it). */
export function reviewFieldValue(data, field) {
  const role = ROLE_FIELDS[field];
  const value = role ? roleValue(data, role) : data?.[field];
  return value === undefined || value === null ? "" : String(value);
}

/** Which review fields were captured and which LinkedIn did not show. */
export function fieldCoverage(kind, data) {
  const fields = reviewFieldList(kind);
  const missing = fields.filter(([field]) => !reviewFieldValue(data, field).trim()).map(([, label]) => label);
  return { total: fields.length, found: fields.length - missing.length, missing };
}

/** One line about a captured company's people capture: what is saved and what is left. */
export function companyProgressText(company) {
  // People already in the workspace for this company, however they were captured.
  const saved = Math.max(Number(company?.peopleSaved) || 0, Number(company?.peopleFound) || 0);
  const total = Number.isFinite(company?.expectedPeople) ? ` of about ${company.expectedPeople.toLocaleString()}` : "";
  const people = `${saved.toLocaleString()}${total} people saved`;
  const auto = company?.mode === "unipile" && ["queued", "running"].includes(company?.status) ? " · reading automatically on the server" : "";
  if (company?.local === "paused") return `${people} · a batch is paused, it resumes where it stopped${auto}`;
  if (company?.complete === true) return `All people captured (${saved.toLocaleString()})`;
  if (saved > 0 || company?.local === "partial") return `${people} · more may remain${auto}`;
  return `No people captured yet${auto}`;
}

/** One line for a company in a running queue. */
export function runItemText(item) {
  switch (item?.status) {
    case "running": return item.batches ? `Reading batch ${item.batches + 1}…` : "Reading people…";
    case "review": return "Review and save the batch above";
    case "done": {
      const batches = item.batches > 1 ? ` in ${item.batches} batches` : "";
      return `Saved ${item.saved ?? 0} people${batches}${item.moreRemain ? " · more remain, pick it again to continue" : ""}`;
    }
    case "pending": return item.batches ? `Batch ${item.batches} saved (${item.saved ?? 0} people so far) · reading the next batch` : "Waiting";
    case "skipped": return "Skipped";
    case "failed": return `Could not read: ${item.error || "unknown error"}`;
    default: return "Waiting";
  }
}

const VERIFICATION_LABELS = {
  verified: "Completed & verified",
  missing_data: "Completed with missing data",
  verification_required: "Verification required",
  partial: "Partial capture",
  not_loaded: "Not loaded",
  restricted: "Restricted by LinkedIn",
  failed: "Failed",
};
const SECTION_WORDS = { complete: "matches what LinkedIn shows", incomplete: "short of what LinkedIn shows", none: "none on LinkedIn (confirmed)", not_loaded: "did not load", restricted: "restricted by LinkedIn", failed: "could not be read" };

/** The review lines for a capture's verification scan: the verdict, each section, and what was not found. */
export function verificationLines(verification) {
  if (!verification) return [];
  const lines = [`Verification: ${VERIFICATION_LABELS[verification.status] || "Unknown"} (${verification.passes} scan${verification.passes === 1 ? "" : "s"})`];
  for (const [key, section] of Object.entries(verification.sections || {})) {
    const name = key.charAt(0).toUpperCase() + key.slice(1);
    lines.push(`${name}: ${section.found}${section.expected !== undefined ? ` of ${section.expected}` : ""} · ${SECTION_WORDS[section.state] || section.state}${section.note ? ` (${section.note})` : ""}`);
  }
  if (verification.missing?.length) lines.push(`Not found on the profile: ${verification.missing.join(", ")}. Fill any you know below.`);
  lines.push(...(verification.notes || []).filter((note) => !/^(Skills|Education|Experience): captured/.test(note)));
  return lines;
}

/** How far a job scan can be trusted, in words (before and after the workspace has judged it). */
export function jobScanStatusLabel(scan) {
  const jobs = Array.isArray(scan?.jobs) ? scan.jobs.length : Number(scan?.jobsFound) || 0;
  const passes = Array.isArray(scan?.passes) ? scan.passes : [];
  switch (scan?.status) {
    case "completed_verified": return "Completed & verified";
    case "verification_required": return "Verification required";
    case "partial": return "Partial capture";
    case "not_found": return "Not found (confirmed by two scans)";
    case "restricted": return "Restricted by LinkedIn";
    case "not_loaded": return "Not loaded";
    case "failed": return "Failed";
    case "in_progress": return "In progress";
    case "requested": return "Requested";
    case "completed": {
      // A finished scan the workspace has not judged yet: the same rules apply.
      const twice = passes.length >= 2 && passes.every((pass) => pass.complete);
      if (twice) return jobs ? "Completed & verified" : "Not found (confirmed by two scans)";
      return passes.some((pass) => !pass.complete) && jobs ? "Partial capture" : "Verification required";
    }
    default: return "Unknown";
  }
}

export const NOT_FOUND_PLACEHOLDER = "NOT FOUND · type to add";

/** A lead's display name; falls back to the readable part of the profile link. */
export function leadName(profile) {
  const name = String(profile?.fullName || "").trim();
  if (name) return name;
  const slug = String(profile?.publicId || "").replace(/-[0-9a-f]{6,}$/i, "");
  const fromSlug = slug.split("-").filter(Boolean).map((part) => part[0].toUpperCase() + part.slice(1)).join(" ");
  return fromSlug || "Unknown person";
}

const MAX_COUNT = 2_000_000_000;

/** "2,300", "1.2K" or "3M followers" as a whole number: { empty } | { value } | { error }. */
export function parseCountInput(raw) {
  const input = String(raw ?? "").trim();
  if (!input) return { empty: true };
  const match = input.match(/^([\d,]+(?:\.\d+)?)\s*([kKmM])?\s*(?:followers?)?$/);
  const number = match ? Number(match[1].replace(/,/g, "")) * ({ k: 1e3, m: 1e6 }[match[2]?.toLowerCase()] ?? 1) : NaN;
  const value = Math.round(number);
  if (!Number.isFinite(value) || value < 0 || value > MAX_COUNT) return { error: "Enter a whole number, such as 2300 or 1.2K." };
  return { value };
}

/** An email typed in the review: { empty } | { value } | { error }. */
export function normalizeEmailInput(raw) {
  const input = String(raw ?? "").trim().replace(/^mailto:/i, "").toLowerCase();
  if (!input) return { empty: true };
  return /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,}$/.test(input) && input.length <= 320
    ? { value: input }
    : { error: "Enter a valid email address, such as name@example.com." };
}

/** A phone typed in the review: 7 to 15 digits, with optional +, spaces, dots, dashes, brackets. */
export function normalizePhoneInput(raw) {
  const input = String(raw ?? "").replace(/\s+/g, " ").trim();
  if (!input) return { empty: true };
  const digits = input.replace(/\D/g, "");
  return /^\+?[\d\s().-]+$/.test(input) && digits.length >= 7 && digits.length <= 15
    ? { value: input }
    : { error: "Enter a phone number with 7 to 15 digits, such as +1 415 555 0100." };
}

const PARSERS = { count: parseCountInput, url: normalizeWebsiteInput, email: normalizeEmailInput, phone: normalizePhoneInput };

/** A website address typed in the review: { empty } | { value } | { error }. Adds https:// when missing. */
export function normalizeWebsiteInput(raw) {
  const input = String(raw ?? "").trim();
  if (!input) return { empty: true };
  const error = { error: "Enter a valid website address, such as https://example.com." };
  try {
    const url = new URL(/^[a-z][a-z0-9+.-]*:/i.test(input) ? input : `https://${input}`);
    const host = url.hostname.toLowerCase();
    if (!/^https?:$/.test(url.protocol) || !host.includes(".") || /(^|\.)linkedin\.com$/.test(host)) return error;
    const value = /^[a-z][a-z0-9+.-]*:/i.test(input) ? input : `https://${input}`;
    return value.length > 2000 ? error : { value };
  } catch {
    return error;
  }
}

function send(type, payload = {}) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ type, ...payload }, (response) => {
      const error = chrome.runtime.lastError;
      resolve(error ? { ok: false, error: error.message } : response || { ok: false, error: "No response from the extension." });
    });
  });
}

export function initCapturePanel() {
  const $ = (id) => document.getElementById(id);
  const section = $("capture-section");
  if (!section) return;

  const limitsEl = $("capture-limits");
  const startBtn = $("capture-start");
  const companyOptionsEl = $("capture-company-options");
  const checkpointEl = $("capture-checkpoint");
  const progressEl = $("capture-progress");
  const progressTextEl = $("capture-progress-text");
  const pauseBtn = $("capture-pause");
  const stopBtn = $("capture-stop");
  const haltEl = $("capture-halt");
  const haltTextEl = $("capture-halt-text");
  const reviewEl = $("capture-review");
  const reviewTitleEl = $("capture-review-title");
  const reviewNotesEl = $("capture-review-notes");
  const personPreviewEl = $("capture-person-preview");
  const reviewFieldsEl = $("capture-review-fields");
  const reviewLeadsEl = $("capture-review-leads");
  const reviewJsonEl = $("capture-review-json");
  const reviewJsonErrorEl = $("capture-review-json-error");
  const sendBtn = $("capture-send");
  const discardBtn = $("capture-discard");
  const resultEl = $("capture-result");
  const continueBoxEl = $("capture-continue-box");
  const continueTextEl = $("capture-continue-text");
  const continueBtn = $("capture-continue");
  const companyListEl = $("capture-company-list");
  const companyStatusEl = $("capture-company-status");
  const companySearchEl = $("capture-company-search");
  const companyAllEl = $("capture-company-all");
  const companySelectedEl = $("capture-company-selected");
  const companyStartBtn = $("capture-company-start");
  const requestedEl = $("capture-requested");
  const requestedTextEl = $("capture-requested-text");
  const requestedStartBtn = $("capture-requested-start");
  const runEl = $("capture-run");
  const runNoteEl = $("capture-run-note");
  const runListEl = $("capture-run-list");
  const runPauseBtn = $("capture-run-pause");
  const runResumeBtn = $("capture-run-resume");
  const runClearBtn = $("capture-run-clear");

  const state = { status: null, statusError: "", tab: null, progress: null, halt: null, draft: null, data: null, excluded: new Set(), saving: false, invalid: new Map(), continueCompany: null, requested: [], companies: [], selected: new Set(), run: null, companiesError: "", skipJobs: false, jobScan: null, jobScanPending: false, requestedJobScans: [] };

  const show = (el, visible) => el?.classList.toggle("hidden", !visible);

  function setResult(message, tone) {
    resultEl.textContent = message || "";
    resultEl.className = `capture-result ${tone || ""}`.trim();
    show(resultEl, Boolean(message));
  }

  function renderStart() {
    const kind = state.tab?.kind;
    const status = state.status;
    const busy = isProgressActive(state.progress);
    let blocked = "";
    if (state.halt) blocked = "Capture is stopped until the LinkedIn warning above is reviewed.";
    else if (state.statusError) blocked = state.statusError;
    else if (!status) blocked = "Checking capture status…";
    else if (!status.enabled) blocked = `Capture is disabled for this workspace${status.disabledReason ? `: ${status.disabledReason}` : "."}`;
    else if (status.usage.remainingToday <= 0) blocked = `Daily capture limit of ${status.caps.dailyLeadLimit} leads reached.`;

    limitsEl.textContent =
      blocked ||
      `Each run reads at most ${status.caps.maxPagesPerRun} pages or ${status.caps.maxLeadsPerRun} leads. ${status.usage.remainingToday} of ${status.caps.dailyLeadLimit} leads left today.`;
    limitsEl.classList.toggle("capture-error", Boolean(blocked && status !== null) || Boolean(state.statusError));

    startBtn.textContent = kind ? START_LABELS[kind] : "Open a LinkedIn profile, company or Sales Navigator search";
    startBtn.disabled = Boolean(blocked) || !kind || busy || Boolean(state.draft) || state.saving;
    show(companyOptionsEl, kind === "company" && !busy && !state.draft);
    renderContinue();
  }

  async function renderCheckpoint() {
    const companyId = state.tab?.kind === "company" ? companyIdForUrl(state.tab.url) : undefined;
    if (!companyId) return show(checkpointEl, false);
    const key = checkpointKey(companyId);
    const saved = (await chrome.storage.local.get(key))[key];
    let message = "";
    if (saved?.draft) {
      message = `A paused batch is saved for this company: ${saved.draft.pagesRead || 0} result pages, ${(saved.draft.profiles || []).length} people. The capture resumes from there.`;
    } else if (saved?.committed?.complete) {
      message = `People discovery finished earlier (${(saved.committed.seenIds || []).length} candidates; ${saved.committed.stopReason}). A new capture starts again from the first page.`;
    } else if (saved?.committed) {
      message = `People discovery is saved through result page ${saved.committed.pagesRead}. The capture continues at the next page.`;
    }
    checkpointEl.textContent = message;
    show(checkpointEl, Boolean(message));
    // An unfinished company on the open tab can always be continued from here.
    if (saved?.committed && !saved.committed.complete && !saved.draft) {
      setContinue(companyId, `${(saved.committed.seenIds || []).length} people captured for this company so far. More result pages remain.`);
    } else if (state.continueCompany === companyId && saved?.committed?.complete) {
      setContinue(null);
    }
  }

  function setContinue(companyId, text) {
    state.continueCompany = companyId || null;
    continueTextEl.textContent = text || "";
    renderContinue();
  }

  function renderContinue() {
    const busy = isProgressActive(state.progress);
    show(continueBoxEl, Boolean(state.continueCompany) && !state.draft);
    const dailyLeft = state.status?.usage?.remainingToday;
    continueBtn.disabled = busy || state.saving || Boolean(state.halt) || dailyLeft === 0;
    continueBtn.title = dailyLeft === 0 ? "The daily capture limit is reached. Continue tomorrow." : "";
  }

  async function continueQueue(companyId) {
    if (!companyId) return;
    setResult("Opening the company and reading the next batch of people…");
    continueBtn.disabled = true;
    const response = await send("capture-continue", { companyId, tabId: state.tab?.id });
    if (!response.ok) setResult(`Could not continue: ${response.error}`, "capture-error");
    else setResult("Reading the next batch. Review it here when it is ready.");
    renderContinue();
  }

  const runActive = () => state.run?.active === true;

  function renderCompanies() {
    const locked = runActive();
    const companies = state.companies;
    companyListEl.replaceChildren(
      ...companies.map((company) => {
        const row = Object.assign(document.createElement("li"), { className: "capture-company-item" });
        const box = Object.assign(document.createElement("input"), {
          type: "checkbox",
          checked: state.selected.has(company.companyPublicId),
          disabled: locked,
        });
        box.setAttribute("aria-label", `Select ${company.name}`);
        box.addEventListener("change", () => {
          if (box.checked) state.selected.add(company.companyPublicId);
          else state.selected.delete(company.companyPublicId);
          renderCompanyControls();
        });
        const text = Object.assign(document.createElement("span"));
        text.append(
          Object.assign(document.createElement("span"), { className: "capture-company-name", textContent: company.name, title: company.name }),
          Object.assign(document.createElement("span"), { className: "capture-company-meta", textContent: companyProgressText(company) }),
        );
        row.append(box, text);
        return row;
      })
    );
    companyStatusEl.textContent = state.companiesError
      ? `Could not load your companies: ${state.companiesError}`
      : companies.length
        ? `${companies.length} captured companies.`
        : companySearchEl.value.trim()
          ? "No captured company matches that search."
          : "No captured companies yet. Capture a company first, then it appears here.";
    companyStatusEl.classList.toggle("capture-error", Boolean(state.companiesError));
    renderCompanyControls();
  }

  function renderCompanyControls() {
    const visible = state.companies.map((company) => company.companyPublicId);
    const selectedVisible = visible.filter((id) => state.selected.has(id)).length;
    companySelectedEl.textContent = String(state.selected.size);
    companyAllEl.disabled = runActive() || !visible.length;
    companyAllEl.checked = visible.length > 0 && selectedVisible === visible.length;
    companyAllEl.indeterminate = selectedVisible > 0 && selectedVisible < visible.length;
    companyStartBtn.textContent = state.selected.size ? `Start queue (${state.selected.size})` : "Start queue";
    companyStartBtn.disabled =
      !state.selected.size || runActive() || isProgressActive(state.progress) || Boolean(state.draft) || Boolean(state.halt) ||
      state.saving || state.status?.usage?.remainingToday === 0;
    companyStartBtn.title = state.status?.usage?.remainingToday === 0 ? "The daily capture limit is reached. Try again tomorrow." : "";
    const serverBtn = $("capture-company-server");
    if (serverBtn) {
      serverBtn.textContent = state.selected.size ? `Run on the server (${state.selected.size})` : "Run on the server";
      serverBtn.disabled = !state.serverAuto || !state.selected.size || state.status?.usage?.remainingToday === 0;
    }
  }

  function renderRun() {
    const run = state.run;
    show(runEl, Boolean(run));
    if (!run) return renderCompanies();
    const pending = run.items.some((item) => item.status === "pending");
    runNoteEl.textContent = run.note || (run.active ? "Queue running. Keep this window open." : "");
    runListEl.replaceChildren(
      ...run.items.map((item) => {
        const row = Object.assign(document.createElement("li"), { className: "capture-run-item" });
        row.dataset.status = item.status;
        row.append(
          Object.assign(document.createElement("span"), { className: "capture-company-name", textContent: item.name, title: item.name }),
          Object.assign(document.createElement("span"), { className: "capture-company-meta", textContent: runItemText(item) }),
        );
        return row;
      })
    );
    show(runPauseBtn, run.active === true);
    show(runResumeBtn, !run.active && pending);
    show(runClearBtn, !run.active);
    renderCompanies();
  }

  // Jobs asked for from the workspace's Capture queue page: shown here so the user starts them.
  async function refreshRequested() {
    const response = await send("capture-requested");
    state.requested = response.ok ? response.jobs || [] : [];
    const count = state.requested.length;
    show(requestedEl, count > 0 && !runActive());
    const names = state.requested.slice(0, 5).map((job) => job.name).join(", ");
    requestedTextEl.textContent = count ? `Requested from your workspace's Capture queue (${count}): ${names}${count > 5 ? ` and ${count - 5} more` : ""}.` : "";
    requestedStartBtn.disabled = state.saving || Boolean(state.draft) || Boolean(state.halt) || state.status?.usage?.remainingToday === 0;
  }
  requestedStartBtn.addEventListener("click", async () => {
    requestedStartBtn.disabled = true;
    const response = await send("capture-queue-start", { companies: state.requested, untilComplete: true });
    if (!response.ok) setResult(`Could not start: ${response.error}`, "capture-error");
    await refreshRequested();
  });

  let companyReload = 0;
  async function refreshCompanies() {
    const ticket = ++companyReload;
    const response = await send("capture-companies", { q: companySearchEl.value.trim() });
    if (ticket !== companyReload) return; // A newer search replaced this one.
    state.companies = response.ok ? response.companies || [] : [];
    state.companiesError = response.ok ? "" : response.error;
    renderCompanies();
    void refreshRequested();
  }

  let searchTimer;
  companySearchEl.addEventListener("input", () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => void refreshCompanies(), 300);
  });
  companyAllEl.addEventListener("change", () => {
    for (const company of state.companies) {
      if (companyAllEl.checked) state.selected.add(company.companyPublicId);
      else state.selected.delete(company.companyPublicId);
    }
    renderCompanies();
  });
  companyStartBtn.addEventListener("click", async () => {
    const companies = state.companies.filter((company) => state.selected.has(company.companyPublicId)).map(({ companyPublicId, name }) => ({ companyPublicId, name }));
    // Companies picked earlier but hidden by a later search are kept in the queue too.
    const hidden = [...state.selected].filter((id) => !companies.some((company) => company.companyPublicId === id)).map((companyPublicId) => ({ companyPublicId, name: companyPublicId }));
    companyStartBtn.disabled = true;
    setResult("");
    const response = await send("capture-queue-start", {
      companies: [...companies, ...hidden],
      untilComplete: $("capture-until-complete").checked,
      autoSave: $("capture-auto-save").checked,
    });
    if (!response.ok) setResult(`Queue did not start: ${response.error}`, "capture-error");
    else state.selected.clear();
    renderCompanies();
  });

  // Automatic on the server (Unipile): no browser tab, the workspace's LinkedIn account reads the people.
  const serverBtn = $("capture-company-server");
  const serverNoteEl = $("capture-server-note");
  async function refreshServerAuto() {
    const response = await send("capture-auto-status");
    state.serverAuto = response.ok && response.available === true;
    serverNoteEl.textContent = response.ok
      ? response.available
        ? `Runs on the server with ${response.accountName || "the workspace's LinkedIn account"}; you can close this browser.`
        : response.reason || ""
      : "";
    renderCompanyControls();
  }
  serverBtn.addEventListener("click", async () => {
    const ids = [...state.selected];
    serverBtn.disabled = true;
    setResult("");
    const response = await send("capture-auto-start", { companyPublicIds: ids });
    if (!response.ok) setResult(`Automatic capture did not start: ${response.error}`, "capture-error");
    else {
      const skipped = response.skipped?.length ? ` ${response.skipped.length} skipped: ${response.skipped.map((entry) => `${entry.companyPublicId} (${entry.reason})`).join("; ")}` : "";
      setResult(`${response.queued.length} companies are being read automatically on the server. Follow them under LinkedIn Enrichment → Capture queue.${skipped}`, "capture-success");
      state.selected.clear();
    }
    await refreshCompanies();
  });
  runPauseBtn.addEventListener("click", () => void send("capture-queue-stop"));
  runResumeBtn.addEventListener("click", async () => {
    const response = await send("capture-queue-resume");
    if (!response.ok) setResult(`Could not resume: ${response.error}`, "capture-error");
  });
  runClearBtn.addEventListener("click", async () => {
    const response = await send("capture-queue-clear");
    if (!response.ok) setResult(response.error, "capture-error");
  });

  function renderProgress() {
    const progress = state.progress;
    const active = isProgressActive(progress);
    const interrupted = progress?.active === true && !active;
    show(progressEl, Boolean(progress?.text));
    progressTextEl.textContent = interrupted
      ? "The last capture stopped reporting (the tab was reloaded or closed). Start it again to continue."
      : progress?.text || "";
    progressTextEl.classList.toggle("capture-error", progress?.isError === true || interrupted);
    show(pauseBtn, active && progress.kind === "company");
    show(stopBtn, active);
  }

  function renderHalt() {
    show(haltEl, Boolean(state.halt));
    if (!state.halt) return;
    const when = new Date(state.halt.at).toLocaleString();
    haltTextEl.textContent = `${state.halt.reason} Capture was stopped automatically (${when}). Check your LinkedIn account and this workflow before capturing again.`;
  }

  function currentData() {
    return reviewedData(state.data, state.excluded, { skipJobs: state.skipJobs });
  }

  function syncJson() {
    reviewJsonEl.value = JSON.stringify(currentData(), null, 2);
    reviewJsonErrorEl.textContent = "";
    // A field with a value that cannot be saved blocks Save until it is fixed.
    sendBtn.disabled = state.saving || state.invalid.size > 0;
  }

  function renderReview() {
    const draft = state.draft;
    show(reviewEl, Boolean(draft));
    if (!draft) return;
    const data = state.data;
    reviewTitleEl.textContent = `Review ${KIND_LABELS[draft.kind]} before saving: ${data.fullName || data.name || "search results"}`;

    reviewNotesEl.replaceChildren(
      ...[
        draftSummary(draft.kind, currentData()),
        ...verificationLines(data.verification),
        `Source: ${draft.sourceUrl || data.sourceUrl || "unknown"} · captured ${new Date(draft.capturedAt).toLocaleString()}`,
        ...(draft.kind === "sales" ? (data.filters || []).map((filter) => `Your filter: ${filter}`) : []),
        ...(draft.notes || []),
      ].map((note) => Object.assign(document.createElement("li"), { textContent: note }))
    );

    const personPreview = personReviewPreview(data);
    personPreviewEl.classList.toggle("hidden", draft.kind !== "person");
    personPreviewEl.replaceChildren();
    if (draft.kind === "person") {
      personPreviewEl.appendChild(Object.assign(document.createElement("p"), {
        className: "vision-desc",
        textContent: "Education and skills shown here are what will be saved to your workspace.",
      }));
      for (const [title, entries] of [["Education", personPreview.educations], ["Skills", personPreview.skills]]) {
        const section = document.createElement("section");
        const heading = document.createElement("h3");
        heading.textContent = `${title} (${entries.length})`;
        const list = document.createElement("ul");
        const visibleEntries = entries.length ? entries : [
          `No ${title.toLowerCase()} detected. Nothing from this section will be saved.`,
        ];
        if (!entries.length) list.classList.add("capture-empty");
        list.replaceChildren(...visibleEntries.map((entry) =>
          Object.assign(document.createElement("li"), { textContent: entry })
        ));
        section.append(heading, list);
        personPreviewEl.appendChild(section);
      }
    }

    state.invalid.clear();
    const coverageEl = Object.assign(document.createElement("p"), { className: "vision-desc capture-coverage" });
    const renderCoverage = () => {
      const { total, found, missing } = fieldCoverage(draft.kind, state.data);
      coverageEl.textContent = missing.length
        ? `Captured ${found} of ${total} fields. Not found on LinkedIn: ${missing.join(", ")}. Fill any you know before saving.`
        : `Captured all ${total} fields.`;
    };
    const fieldEls = (EDITABLE_FIELDS[draft.kind] || []).map(([field, label, multiline, type]) => {
      const wrapper = document.createElement("label");
      const caption = Object.assign(document.createElement("span"), { textContent: label });
      const tag = Object.assign(document.createElement("span"), { className: "capture-field-missing-tag", textContent: "Not found" });
      caption.append(tag);
      const input = document.createElement(multiline ? "textarea" : "input");
      if (!multiline) input.type = "text";
      if (type === "count") input.inputMode = "numeric";
      if (type === "email") input.inputMode = "email";
      if (type === "phone") input.inputMode = "tel";
      input.placeholder = NOT_FOUND_PLACEHOLDER;
      const problem = document.createElement("span");
      problem.className = "capture-field-error";
      problem.setAttribute("role", "alert");
      const role = ROLE_FIELDS[field];
      input.value = reviewFieldValue(data, field);
      const markMissing = () => {
        const missing = !input.value.trim();
        input.classList.toggle("capture-field-missing", missing);
        tag.hidden = !missing;
      };
      markMissing();
      input.addEventListener("input", () => {
        const parsed = PARSERS[type]?.(input.value) ?? null;
        if (parsed?.error) {
          state.invalid.set(field, parsed.error);
          if (role) setRoleField(state.data, role, "");
          else delete state.data[field];
        } else {
          state.invalid.delete(field);
          const value = parsed ? (parsed.empty ? "" : parsed.value) : input.value.trim();
          if (role) setRoleField(state.data, role, value);
          else if (value !== "") state.data[field] = parsed ? value : input.value;
          else delete state.data[field];
        }
        problem.textContent = state.invalid.get(field) || "";
        input.setAttribute("aria-invalid", String(state.invalid.has(field)));
        markMissing();
        renderCoverage();
        syncJson();
      });
      wrapper.append(caption, input, problem);
      return wrapper;
    });
    renderCoverage();
    reviewFieldsEl.replaceChildren(...(fieldEls.length ? [coverageEl, ...fieldEls] : []));

    if (draft.kind === "company" && data.jobScan) {
      const jobsBox = Object.assign(document.createElement("label"), { className: "checkbox-row" });
      const skip = Object.assign(document.createElement("input"), { type: "checkbox", checked: !state.skipJobs });
      skip.addEventListener("change", () => { state.skipJobs = !skip.checked; reviewNotesEl.firstChild.textContent = draftSummary(draft.kind, currentData()); syncJson(); });
      jobsBox.append(skip, document.createTextNode(` Save the ${data.jobScan.jobs.length} job roles with this company (${jobScanStatusLabel(data.jobScan)})`));
      reviewFieldsEl.append(jobsBox);
    }
    const leads = Array.isArray(data.peopleProfiles) ? data.peopleProfiles : [];
    show(reviewLeadsEl, leads.length > 0);
    reviewLeadsEl.replaceChildren(
      ...leads.map((profile) => {
        const row = document.createElement("label");
        row.className = "capture-lead";
        const checkbox = Object.assign(document.createElement("input"), { type: "checkbox", checked: !state.excluded.has(profile.publicId) });
        checkbox.addEventListener("change", () => {
          if (checkbox.checked) state.excluded.delete(profile.publicId);
          else state.excluded.add(profile.publicId);
          reviewNotesEl.firstChild.textContent = draftSummary(draft.kind, currentData());
          syncJson();
        });
        const text = Object.assign(document.createElement("span"), { className: "capture-lead-text" });
        const name = leadName(profile);
        const role = profile.headline || profile.currentCompanies?.[0]?.title || "";
        text.title = [name, role].filter(Boolean).join(" · ");
        text.append(Object.assign(document.createElement("span"), { className: "capture-lead-name", textContent: name }));
        if (role) text.append(Object.assign(document.createElement("span"), { className: "capture-lead-role", textContent: role }));
        const tag = Object.assign(document.createElement("span"), {
          className: "vision-chip",
          textContent: isPublicProfileUrl(profile.sourceUrl) ? "public link" : "Sales lead",
        });
        row.append(checkbox, text, tag);
        return row;
      })
    );
    syncJson();
  }

  function applyDraft(draft) {
    state.draft = draft || null;
    state.skipJobs = false;
    state.data = draft ? structuredClone(draft.data) : null;
    state.excluded = new Set();
    renderReview();
    renderStart();
  }

  reviewJsonEl.addEventListener("change", () => {
    try {
      const parsed = JSON.parse(reviewJsonEl.value);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Expected a JSON object.");
      state.data = parsed;
      state.excluded = new Set();
      renderReview();
    } catch (error) {
      reviewJsonErrorEl.textContent = `Invalid JSON, fix before saving: ${error.message}`;
      sendBtn.disabled = true;
    }
  });

  async function refreshStatus() {
    const response = await send("capture-status");
    state.status = response.ok ? response.status : null;
    state.statusError = response.ok ? "" : `Capture status is unavailable: ${response.error}`;
    // A sign-in failure here means the panel's "Connected to Skout." is stale; tell it.
    if (!response.ok && /not signed in|session expired|sign in/i.test(response.error || "")) {
      document.dispatchEvent(new CustomEvent("skout-auth-lost", { detail: response.error }));
    }
    renderStart();
  }

  async function refreshTab() {
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    const kind = captureKindForUrl(tab?.url);
    state.tab = tab?.id != null ? { id: tab.id, url: tab.url, title: tab.title, kind } : null;
    renderStart();
    renderJobs();
    await renderCheckpoint();
  }

  startBtn.addEventListener("click", async () => {
    if (!state.tab?.kind) return;
    setResult("");
    startBtn.disabled = true;
    const options =
      state.tab.kind === "company"
        ? {
            includeCompany: true,
            includePeople: $("capture-include-people").checked,
            includeJobs: $("capture-include-jobs").checked,
            focus: { departments: $("capture-departments").value.trim(), seniorities: $("capture-seniorities").value.trim() },
          }
        : undefined;
    const response = await send("capture-start", { tabId: state.tab.id, kind: state.tab.kind, options });
    if (!response.ok) setResult(`Capture did not start: ${response.error}`, "capture-error");
    await refreshStatus();
  });

  const stop = (discardCheckpoint) =>
    send("capture-stop", {
      tabId: state.progress?.tabId,
      discardCheckpoint,
      companyId: state.tab?.kind === "company" ? companyIdForUrl(state.tab.url) : undefined,
    });
  pauseBtn.addEventListener("click", () => stop(false));
  stopBtn.addEventListener("click", () => stop(true));

  $("capture-halt-ack").addEventListener("click", () => send("capture-ack-halt"));

  discardBtn.addEventListener("click", async () => {
    await send("capture-discard");
    setResult("Capture discarded. Nothing was saved.");
  });

  sendBtn.addEventListener("click", async () => {
    if (!state.draft || state.saving || state.invalid.size) return;
    state.saving = true;
    sendBtn.disabled = true;
    discardBtn.disabled = true;
    // Not a success message: the run is only reported once the API records its final status.
    setResult("Saving… waiting for the capture run to be recorded.");
    const response = await send("capture-send", { data: currentData(), autoContinue: Boolean($("capture-auto-continue")?.checked), autoSave: Boolean($("capture-auto-save")?.checked) });
    state.saving = false;
    discardBtn.disabled = false;
    if (response.ok) {
      const { created = 0, merged = 0, rejected = 0 } = response.counts || {};
      const checkpoint = response.checkpoint;
      const next = !checkpoint
        ? ""
        : checkpoint.error
          ? ` ${checkpoint.error}`
          : checkpoint.complete
            ? ` People discovery finished: ${checkpoint.stopReason}.`
            : response.autoContinued
              ? ` More people remain (${checkpoint.distinctCandidates} found so far). The next batch of up to 250 is being read now; review and save it when it appears.`
              : ` More people remain (${checkpoint.distinctCandidates} found so far). Choose Continue capturing queue to read the next batch, now or later.`;
      if (response.autoContinued) {
        setContinue(null);
      } else if (checkpoint && !checkpoint.error && !checkpoint.complete && checkpoint.companyId) {
        setContinue(checkpoint.companyId, `Batch saved. ${checkpoint.distinctCandidates} people found so far${Number.isFinite(checkpoint.expectedAssociatedMembers) ? ` of about ${checkpoint.expectedAssociatedMembers}` : ""}.${checkpoint.queued === false ? " The Skout queue could not be updated; this browser still remembers where to continue." : ""}`);
      } else if (checkpoint?.complete) {
        setContinue(null);
      }
      const dropped = response.rejectedFields?.length ? ` ${response.rejectedFields.length} non-profile items were left out.` : "";
      setResult(`Saved. Capture run ${response.run.status}: ${created} new, ${merged} merged, ${rejected} rejected.${dropped}${next}`, "capture-success");
    } else {
      const runState = response.run ? ` Capture run status: ${response.run.status}.` : "";
      // A save that could not be confirmed is not a failure: the batch is kept and Save is safe to repeat.
      setResult(response.pending ? response.error : `Not saved: ${response.error}${runState}`, "capture-error");
      sendBtn.disabled = false;
    }
    await refreshStatus();
    await renderCheckpoint();
    await refreshCompanies();
  });

  continueBtn.addEventListener("click", () => void continueQueue(state.continueCompany));

  // ── Job roles: scan a company's jobs twice, save them, retry a save, answer workspace requests ──
  const jobsBtn = $("capture-jobs-scan");
  const jobsResultEl = $("capture-jobs-result");
  const jobsStatusEl = $("capture-jobs-status");
  const jobsNotesEl = $("capture-jobs-notes");
  const jobsSaveBtn = $("capture-jobs-save");
  const jobsRequestedEl = $("capture-jobs-requested");
  const jobsRequestedListEl = $("capture-jobs-requested-list");

  const companyNameFromTab = () => (state.tab?.title || "").replace(/^\(\d+\)\s*/, "").replace(/\s*\|\s*LinkedIn.*$/i, "").trim();

  function renderJobs() {
    const busy = isProgressActive(state.progress);
    const onCompany = state.tab?.kind === "company";
    jobsBtn.disabled = !onCompany || busy || Boolean(state.draft) || Boolean(state.halt) || state.saving;
    jobsBtn.title = onCompany ? "" : "Open a company page on LinkedIn to scan its job roles.";
    const result = state.jobScan;
    show(jobsResultEl, Boolean(result));
    if (result) {
      const found = Number(result.jobsFound) || 0;
      const counts = result.jobsNew != null ? ` · ${result.jobsNew} new, ${result.jobsUpdated || 0} updated` : "";
      jobsStatusEl.textContent = `${result.name || result.companyId || "Company"}: ${jobScanStatusLabel(result)} · ${found} role${found === 1 ? "" : "s"} found${counts}`;
      const lines = [...(result.saveError ? [result.saveError] : []), ...(result.error ? [`Error: ${result.error}`] : []), ...(result.notes || [])];
      jobsNotesEl.replaceChildren(...lines.map((line) => Object.assign(document.createElement("li"), { textContent: line })));
    }
    show(jobsSaveBtn, state.jobScanPending);
    const requested = state.requestedJobScans;
    show(jobsRequestedEl, requested.length > 0);
    jobsRequestedListEl.replaceChildren(
      ...requested.map((entry) => {
        const row = Object.assign(document.createElement("li"), { className: "capture-queue-item" });
        const name = Object.assign(document.createElement("span"), { className: "capture-queue-name", textContent: entry.name || entry.companyPublicId, title: entry.name });
        const go = Object.assign(document.createElement("button"), { type: "button", className: "primary", textContent: "Scan" });
        go.disabled = busy || Boolean(state.draft) || state.tab?.id == null;
        go.addEventListener("click", () => void scanJobs(entry.companyPublicId, entry.name));
        row.append(name, go);
        return row;
      })
    );
  }

  async function scanJobs(companyId, name) {
    if (state.tab?.id == null) return setResult("Open a LinkedIn tab first.", "capture-error");
    setResult("");
    jobsBtn.disabled = true;
    const response = await send("capture-jobs-scan", { tabId: state.tab.id, companyId, name });
    if (response.scan) state.jobScan = { companyId, name, ...response.scan, ...(response.error ? { saveError: response.error } : {}) };
    state.jobScanPending = Boolean(response.pending);
    if (!response.ok && !response.scan) setResult(`Job scan did not start: ${response.error}`, "capture-error");
    await refreshJobScans();
    renderJobs();
  }

  async function refreshJobScans() {
    const stored = await chrome.storage.local.get([JOB_SCAN_RESULT_KEY, JOB_SCAN_PENDING_KEY]);
    state.jobScan = stored[JOB_SCAN_RESULT_KEY] || state.jobScan;
    state.jobScanPending = Boolean(stored[JOB_SCAN_PENDING_KEY]);
    const requested = await send("capture-job-scans-requested");
    state.requestedJobScans = requested.ok ? requested.scans || [] : [];
    renderJobs();
  }

  jobsBtn.addEventListener("click", () => {
    const companyId = companyIdForUrl(state.tab?.url);
    if (companyId) void scanJobs(companyId, companyNameFromTab());
  });
  jobsSaveBtn.addEventListener("click", async () => {
    jobsSaveBtn.disabled = true;
    const response = await send("capture-jobs-retry-save");
    if (response.scan) state.jobScan = { ...state.jobScan, ...response.scan, saveError: undefined };
    state.jobScanPending = Boolean(response.pending);
    if (!response.ok) setResult(response.error, "capture-error");
    jobsSaveBtn.disabled = false;
    renderJobs();
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    if (changes[JOB_SCAN_RESULT_KEY] || changes[JOB_SCAN_PENDING_KEY]) void refreshJobScans();
    if (changes[PROGRESS_KEY]) renderJobs();
    if (changes[PROGRESS_KEY]) {
      state.progress = changes[PROGRESS_KEY].newValue || null;
      renderProgress();
      renderStart();
      renderCompanyControls();
    }
    if (changes[RUN_QUEUE_KEY]) {
      state.run = changes[RUN_QUEUE_KEY].newValue || null;
      renderRun();
      renderStart();
      void refreshRequested();
    }
    if (changes[HALT_KEY]) {
      state.halt = changes[HALT_KEY].newValue || null;
      renderHalt();
      renderStart();
    }
    if (changes[DRAFT_KEY]) {
      applyDraft(changes[DRAFT_KEY].newValue);
      renderCompanyControls();
    }
    if (Object.keys(changes).some((key) => key.startsWith("company-people-capture:"))) {
      void renderCheckpoint();
      void refreshCompanies();
    }
  });
  chrome.tabs.onActivated.addListener(() => void refreshTab());
  chrome.tabs.onUpdated.addListener((_tabId, changeInfo, tab) => {
    if (tab.active && (changeInfo.url || changeInfo.status === "complete")) void refreshTab();
  });

  void (async () => {
    const stored = await chrome.storage.local.get([PROGRESS_KEY, HALT_KEY, DRAFT_KEY]);
    state.progress = stored[PROGRESS_KEY] || null;
    state.halt = stored[HALT_KEY] || null;
    renderProgress();
    renderHalt();
    applyDraft(stored[DRAFT_KEY]);
    state.run = (await chrome.storage.local.get(RUN_QUEUE_KEY))[RUN_QUEUE_KEY] || null;
    renderRun();
    await Promise.all([refreshStatus(), refreshTab(), refreshCompanies(), refreshServerAuto(), refreshJobScans()]);
  })();
}
