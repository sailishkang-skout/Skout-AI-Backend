/** Capture section of the side panel (ENR-02): start, stop/pause, review/edit, save. */

export const DRAFT_KEY = "skoutCaptureDraft";
export const PROGRESS_KEY = "skoutCaptureProgress";
export const HALT_KEY = "skoutCaptureHalt";
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
export function reviewedData(data, excludedIds) {
  if (!Array.isArray(data?.peopleProfiles) || !excludedIds?.size) return data;
  return { ...data, peopleProfiles: data.peopleProfiles.filter((profile) => !excludedIds.has(profile.publicId)) };
}

/** One-line counts of what a draft contains. */
export function draftSummary(kind, data) {
  const size = (value) => (Array.isArray(value) ? value.length : 0);
  const parts = [];
  if (kind === "person") {
    parts.push(`${size(data.currentCompanies)} current and ${size(data.previousCompanies)} past roles`);
    parts.push(`${size(data.educations)} education`);
    parts.push(`${size(data.skills)} skills`);
    for (const [key, label] of [["certifications", "certifications"], ["languages", "languages"], ["recommendations", "recommendations"], ["volunteerExperiences", "volunteering"], ["honors", "honors"], ["publications", "publications"], ["patents", "patents"], ["courses", "courses"], ["organizations", "organizations"]]) {
      if (size(data[key])) parts.push(`${size(data[key])} ${label}`);
    }
  } else if (kind === "company") {
    parts.push(`${Object.keys(data.sectionCaptures || {}).length} company sections`);
    if (data.employeesOnLi != null) parts.push(`${data.employeesOnLi} members on LinkedIn`);
    for (const [key, label] of [["openJobs", "jobs"], ["products", "products"], ["recentPosts", "posts"]]) {
      if (size(data[key])) parts.push(`${size(data[key])} ${label}`);
    }
    parts.push(`${size(data.peopleProfiles)} people (discovery candidates)`);
  } else {
    const leads = data.peopleProfiles || [];
    const linked = leads.filter((profile) => isPublicProfileUrl(profile.sourceUrl)).length;
    parts.push(`${leads.length} leads from ${data.pagesRead || 1} page(s)`);
    parts.push(`${linked} with a public LinkedIn link, ${leads.length - linked} Sales Navigator only`);
  }
  return parts.join(" · ");
}

const EDITABLE_FIELDS = {
  person: [["fullName", "Name"], ["headline", "Headline"], ["locationName", "Location"], ["summary", "About", true]],
  company: [["name", "Name"], ["industry", "Industry"], ["headquarter", "Headquarters"], ["size", "Company size"], ["website", "Website"]],
  sales: [],
};

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
  const reviewFieldsEl = $("capture-review-fields");
  const reviewLeadsEl = $("capture-review-leads");
  const reviewJsonEl = $("capture-review-json");
  const reviewJsonErrorEl = $("capture-review-json-error");
  const sendBtn = $("capture-send");
  const discardBtn = $("capture-discard");
  const resultEl = $("capture-result");

  const state = { status: null, statusError: "", tab: null, progress: null, halt: null, draft: null, data: null, excluded: new Set(), saving: false };

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
  }

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
    return reviewedData(state.data, state.excluded);
  }

  function syncJson() {
    reviewJsonEl.value = JSON.stringify(currentData(), null, 2);
    reviewJsonErrorEl.textContent = "";
    sendBtn.disabled = state.saving;
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
        `Source: ${draft.sourceUrl || data.sourceUrl || "unknown"} · captured ${new Date(draft.capturedAt).toLocaleString()}`,
        ...(draft.kind === "sales" ? (data.filters || []).map((filter) => `Your filter: ${filter}`) : []),
        ...(draft.notes || []),
      ].map((note) => Object.assign(document.createElement("li"), { textContent: note }))
    );

    reviewFieldsEl.replaceChildren(
      ...EDITABLE_FIELDS[draft.kind].map(([field, label, multiline]) => {
        const wrapper = document.createElement("label");
        wrapper.textContent = label;
        const input = document.createElement(multiline ? "textarea" : "input");
        if (!multiline) input.type = "text";
        input.value = data[field] ?? "";
        input.addEventListener("input", () => {
          if (input.value.trim()) state.data[field] = input.value;
          else delete state.data[field];
          syncJson();
        });
        wrapper.appendChild(input);
        return wrapper;
      })
    );

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
        const text = document.createElement("span");
        const role = profile.headline || profile.currentCompanies?.[0]?.title || "";
        text.textContent = [profile.fullName || "Unknown person", role].filter(Boolean).join(" · ");
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
    renderStart();
  }

  async function refreshTab() {
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    const kind = captureKindForUrl(tab?.url);
    state.tab = tab?.id != null ? { id: tab.id, url: tab.url, kind } : null;
    renderStart();
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
    if (!state.draft || state.saving) return;
    state.saving = true;
    sendBtn.disabled = true;
    discardBtn.disabled = true;
    // Not a success message: the run is only reported once the API records its final status.
    setResult("Saving… waiting for the capture run to be recorded.");
    const response = await send("capture-send", { data: currentData() });
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
            : ` More result pages remain. Start the capture again to continue from page ${checkpoint.pagesRead + 1}.`;
      const dropped = response.rejectedFields?.length ? ` ${response.rejectedFields.length} non-profile items were left out.` : "";
      setResult(`Saved. Capture run ${response.run.status}: ${created} new, ${merged} merged, ${rejected} rejected.${dropped}${next}`, "capture-success");
    } else {
      const runState = response.run ? ` Capture run status: ${response.run.status}.` : "";
      setResult(`Not saved: ${response.error}${runState}`, "capture-error");
      sendBtn.disabled = false;
    }
    await refreshStatus();
    await renderCheckpoint();
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    if (changes[PROGRESS_KEY]) {
      state.progress = changes[PROGRESS_KEY].newValue || null;
      renderProgress();
      renderStart();
    }
    if (changes[HALT_KEY]) {
      state.halt = changes[HALT_KEY].newValue || null;
      renderHalt();
      renderStart();
    }
    if (changes[DRAFT_KEY]) applyDraft(changes[DRAFT_KEY].newValue);
    if (Object.keys(changes).some((key) => key.startsWith("company-people-capture:"))) void renderCheckpoint();
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
    await Promise.all([refreshStatus(), refreshTab()]);
  })();
}
