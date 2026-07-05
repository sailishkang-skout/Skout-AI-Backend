/** LinkedIn sidebar UI — panel init is once per page; bridge handles read-profile. */
(function initSkoutLinkedInPanel() {
  if (globalThis.__SKOUT_LINKEDIN_PANEL__) return;
  globalThis.__SKOUT_LINKEDIN_PANEL__ = true;

  function isProfilePage() {
    return /linkedin\.com\/in\//i.test(location.href) || /linkedin\.com\/pub\//i.test(location.href);
  }

  function isSearchResultsPage() {
    if (typeof globalThis.__SKOUT_IS_LINKEDIN_SEARCH__ === "function") {
      return globalThis.__SKOUT_IS_LINKEDIN_SEARCH__();
    }
    return (
      /linkedin\.com\/search\/results\/people/i.test(location.href) ||
      /linkedin\.com\/sales\/search\/people/i.test(location.href)
    );
  }

  function readSearchResults() {
    if (typeof globalThis.__SKOUT_SCRAPE_LINKEDIN_SEARCH__ === "function") {
      return globalThis.__SKOUT_SCRAPE_LINKEDIN_SEARCH__();
    }
    return { results: [], count: 0 };
  }

  function readProfileFromLinkedIn() {
    if (typeof globalThis.__SKOUT_SCRAPE_LINKEDIN__ === "function") {
      return globalThis.__SKOUT_SCRAPE_LINKEDIN__();
    }
    const linkedinUrl = location.href.split("?")[0];
    if (!isProfilePage()) return { error: "not_a_profile", linkedinUrl };
    return { fullName: "", title: "", companyName: "", linkedinUrl };
  }

  function setPanelStatus(panel, message, isError = false) {
    const status = panel.querySelector("#skout-ai-status");
    if (!status) return;
    status.textContent = message;
    status.style.color = isError ? "#fca5a5" : "#94a3b8";
  }

  function populateLists(select, lists, selectedId) {
    if (!select) return;
    select.innerHTML =
      lists.length > 0
        ? lists
            .map(
              (list) =>
                `<option value="${list.id}"${list.id === selectedId ? " selected" : ""}>${list.name}</option>`
            )
            .join("")
        : `<option value="">No lists — create in Skout</option>`;
  }

  function friendlyRuntimeError(message) {
    const m = String(message || "").toLowerCase();
    if (m.includes("frame") && m.includes("error page")) {
      return "LinkedIn didn't load — refresh this page (Cmd+Shift+R) and try again.";
    }
    if (m.includes("invalidated") || m.includes("receiving end")) {
      return "Extension updated — refresh this page (Cmd+Shift+R).";
    }
    return message || "Something went wrong.";
  }

  function safeRuntimeSend(message, timeoutMs = 35_000) {
    const label = message?.type || "message";
    console.log(`[Skout Extension] ▶ send ${label}`);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        console.error(`[Skout Extension] ✗ ${label} timed out after ${timeoutMs}ms`);
        reject(
          new Error(
            "Extension timed out — reload Skout extension at chrome://extensions, keep Skout open and signed in, then refresh this page."
          )
        );
      }, timeoutMs);
      try {
        chrome.runtime.sendMessage(message, (response) => {
          clearTimeout(timer);
          const err = chrome.runtime.lastError;
          if (err) {
            console.error(`[Skout Extension] ✗ ${label}:`, err.message);
            reject(new Error(friendlyRuntimeError(err.message)));
            return;
          }
          console.log(`[Skout Extension] ✓ ${label}`, response?.ok === false ? response?.error : "ok");
          resolve(response);
        });
      } catch {
        clearTimeout(timer);
        reject(new Error("Extension updated — refresh this page (Cmd+Shift+R)."));
      }
    });
  }

  async function loadLists(panel) {
    const select = panel.querySelector("#skout-ai-list-select");
    try {
      const response = await safeRuntimeSend({ type: "get-lists" });
      populateLists(select, response?.lists || [], response?.lastListId || "");
    } catch {
      if (select) select.innerHTML = `<option value="">Sign in to Skout first</option>`;
    }
  }

  function createBulkPanel() {
    const panel = document.createElement("aside");
    panel.id = "skout-ai-bulk-panel";
    panel.innerHTML = `
      <style>
        #skout-ai-bulk-panel {
          position: fixed; top: 88px; right: 16px; z-index: 99999; width: 300px; max-height: 70vh;
          display: flex; flex-direction: column;
          background: #0f172a; color: #f8fafc; border: 1px solid #334155;
          border-radius: 12px; box-shadow: 0 12px 32px rgba(15, 23, 42, 0.35);
          font-family: Inter, system-ui, sans-serif; padding: 14px;
        }
        #skout-ai-bulk-panel h2 { margin: 0; font-size: 14px; font-weight: 600; }
        #skout-ai-bulk-header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 8px; }
        #skout-ai-bulk-close { background: transparent; border: 0; color: #94a3b8; cursor: pointer; font-size: 18px; }
        #skout-ai-bulk-summary { margin: 0 0 8px; font-size: 12px; color: #cbd5e1; }
        #skout-ai-bulk-panel label { display: block; font-size: 11px; color: #94a3b8; margin-bottom: 4px; }
        #skout-ai-bulk-list-select {
          width: 100%; box-sizing: border-box; margin-bottom: 8px; border-radius: 8px;
          border: 1px solid #334155; padding: 7px 8px; font-size: 12px; background: #1e293b; color: #f8fafc;
        }
        #skout-ai-bulk-toolbar { display: flex; gap: 6px; margin-bottom: 8px; font-size: 11px; }
        #skout-ai-bulk-toolbar button {
          flex: 1; border: 1px solid #334155; border-radius: 6px; background: #1e293b; color: #e2e8f0;
          padding: 4px 6px; cursor: pointer; font-size: 11px;
        }
        #skout-ai-bulk-rows {
          overflow-y: auto; flex: 1; min-height: 120px; max-height: 240px;
          border: 1px solid #334155; border-radius: 8px; padding: 6px; margin-bottom: 8px; background: #1e293b;
        }
        .skout-bulk-row { display: flex; gap: 8px; align-items: flex-start; padding: 4px 2px; font-size: 11px; }
        .skout-bulk-row label { margin: 0; flex: 1; cursor: pointer; color: #e2e8f0; line-height: 1.35; }
        .skout-bulk-row small { display: block; color: #94a3b8; font-size: 10px; margin-top: 2px; }
        #skout-ai-bulk-add {
          width: 100%; border: 0; border-radius: 8px; padding: 8px 10px; font-size: 12px; font-weight: 600;
          cursor: pointer; background: #2563eb; color: white;
        }
        #skout-ai-bulk-add:disabled { opacity: 0.6; cursor: wait; }
        #skout-ai-bulk-status { margin-top: 8px; font-size: 11px; color: #94a3b8; }
      </style>
      <div id="skout-ai-bulk-header">
        <h2>Bulk capture</h2>
        <button id="skout-ai-bulk-close" type="button" aria-label="Close">×</button>
      </div>
      <p id="skout-ai-bulk-summary">Scanning this page…</p>
      <label for="skout-ai-bulk-list-select">Target list</label>
      <select id="skout-ai-bulk-list-select"><option value="">Loading lists…</option></select>
      <div id="skout-ai-bulk-toolbar">
        <button id="skout-ai-bulk-select-all" type="button">Select all</button>
        <button id="skout-ai-bulk-clear" type="button">Clear</button>
        <button id="skout-ai-bulk-rescan" type="button">Rescan</button>
      </div>
      <div id="skout-ai-bulk-rows"></div>
      <button id="skout-ai-bulk-add" type="button">Add selected to list</button>
      <div id="skout-ai-bulk-status">Ready</div>
    `;

    panel.querySelector("#skout-ai-bulk-close")?.addEventListener("click", () => {
      panel.remove();
      sessionStorage.setItem("skout-ai-bulk-panel-hidden", "1");
    });
    panel.querySelector("#skout-ai-bulk-select-all")?.addEventListener("click", () => {
      panel.querySelectorAll('.skout-bulk-row input[type="checkbox"]').forEach((cb) => {
        cb.checked = true;
      });
      updateBulkSelectionSummary(panel);
    });
    panel.querySelector("#skout-ai-bulk-clear")?.addEventListener("click", () => {
      panel.querySelectorAll('.skout-bulk-row input[type="checkbox"]').forEach((cb) => {
        cb.checked = false;
      });
      updateBulkSelectionSummary(panel);
    });
    panel.querySelector("#skout-ai-bulk-rescan")?.addEventListener("click", () => renderBulkRows(panel));
    panel.querySelector("#skout-ai-bulk-add")?.addEventListener("click", () => void onBulkAdd(panel));
    panel.addEventListener("change", (event) => {
      if (event.target?.matches('.skout-bulk-row input[type="checkbox"]')) {
        updateBulkSelectionSummary(panel);
      }
    });

    document.body.appendChild(panel);
    void loadBulkLists(panel);
    renderBulkRows(panel);
    return panel;
  }

  function updateBulkSelectionSummary(panel) {
    const total = panel.querySelectorAll('.skout-bulk-row input[type="checkbox"]').length;
    const selected = panel.querySelectorAll('.skout-bulk-row input[type="checkbox"]:checked').length;
    const summary = panel.querySelector("#skout-ai-bulk-summary");
    if (summary) {
      summary.textContent =
        total > 0
          ? `${selected} of ${total} visible on this page selected`
          : "No profiles found on this page — scroll to load more, then Rescan.";
    }
    const addBtn = panel.querySelector("#skout-ai-bulk-add");
    if (addBtn) addBtn.textContent = selected ? `Add ${selected} to list` : "Add selected to list";
  }

  function renderBulkRows(panel) {
    const rowsEl = panel.querySelector("#skout-ai-bulk-rows");
    if (!rowsEl) return;
    const esc = (s) =>
      String(s || "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
    const { results } = readSearchResults();
    panel.__skoutBulkResults = results;
    if (!results.length) {
      rowsEl.innerHTML = `<p style="margin:0;font-size:11px;color:#94a3b8;">No profile cards detected. Open LinkedIn people search results and click Rescan.</p>`;
      updateBulkSelectionSummary(panel);
      return;
    }
    rowsEl.innerHTML = results
      .map((profile, index) => {
        const subtitle = [profile.title, profile.companyName].filter(Boolean).join(" @ ");
        return `
          <div class="skout-bulk-row">
            <input type="checkbox" id="skout-bulk-${index}" data-index="${index}" checked />
            <label for="skout-bulk-${index}">
              ${esc(profile.fullName)}
              ${subtitle ? `<small>${esc(subtitle)}</small>` : ""}
            </label>
          </div>`;
      })
      .join("");
    updateBulkSelectionSummary(panel);
  }

  async function loadBulkLists(panel) {
    const select = panel.querySelector("#skout-ai-bulk-list-select");
    try {
      const response = await safeRuntimeSend({ type: "get-lists" });
      populateLists(select, response?.lists || [], response?.lastListId || "");
    } catch {
      if (select) select.innerHTML = `<option value="">Sign in to Skout first</option>`;
    }
  }

  function getSelectedBulkProfiles(panel) {
    const results = panel.__skoutBulkResults || [];
    const selected = [];
    panel.querySelectorAll('.skout-bulk-row input[type="checkbox"]:checked').forEach((cb) => {
      const index = Number(cb.getAttribute("data-index"));
      if (results[index]) selected.push(results[index]);
    });
    return selected;
  }

  function setBulkStatus(panel, message, isError = false) {
    const status = panel.querySelector("#skout-ai-bulk-status");
    if (!status) return;
    status.textContent = message;
    status.style.color = isError ? "#fca5a5" : "#94a3b8";
  }

  async function onBulkAdd(panel) {
    const listId = panel.querySelector("#skout-ai-bulk-list-select")?.value;
    const addBtn = panel.querySelector("#skout-ai-bulk-add");
    if (!listId) {
      setBulkStatus(panel, "Pick a list first.", true);
      return;
    }
    const profiles = getSelectedBulkProfiles(panel);
    if (!profiles.length) {
      setBulkStatus(panel, "Select at least one profile.", true);
      return;
    }

    addBtn.disabled = true;
    setBulkStatus(panel, `Adding ${profiles.length}…`);

    try {
      await safeRuntimeSend({ type: "ping" }, 5_000).catch(() => undefined);
      const result = await safeRuntimeSend(
        { type: "bulk-add-to-list", listId, profiles },
        120_000
      );
      if (!result?.ok) throw new Error(result?.error || "Bulk add failed");
      setBulkStatus(
        panel,
        `Done — added ${result.added ?? 0}, skipped ${result.skipped ?? 0}${result.failed ? `, failed ${result.failed}` : ""}.`
      );
      safeRuntimeSend({ type: "save-last-list", listId }).catch(() => undefined);
    } catch (error) {
      setBulkStatus(panel, error instanceof Error ? error.message : "Bulk add failed", true);
    } finally {
      addBtn.disabled = false;
      updateBulkSelectionSummary(panel);
    }
  }

  function ensureBulkPanel() {
    let panel = document.getElementById("skout-ai-bulk-panel");
    if (!panel) panel = createBulkPanel();
    else renderBulkRows(panel);
    return panel;
  }

  function createPanel() {
    const panel = document.createElement("aside");
    panel.id = "skout-ai-panel";
    panel.innerHTML = `
      <style>
        #skout-ai-panel {
          position: fixed; top: 88px; right: 16px; z-index: 99999; width: 280px;
          background: #0f172a; color: #f8fafc; border: 1px solid #334155;
          border-radius: 12px; box-shadow: 0 12px 32px rgba(15, 23, 42, 0.35);
          font-family: Inter, system-ui, sans-serif; padding: 14px;
        }
        #skout-ai-panel-header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 8px; }
        #skout-ai-panel h2 { margin: 0; font-size: 14px; font-weight: 600; }
        #skout-ai-close { background: transparent; border: 0; color: #94a3b8; cursor: pointer; font-size: 18px; }
        #skout-ai-summary { margin: 0 0 10px; font-size: 12px; color: #cbd5e1; line-height: 1.4; }
        #skout-ai-panel label { display: block; font-size: 11px; color: #94a3b8; margin-bottom: 4px; }
        #skout-ai-list-select {
          width: 100%; box-sizing: border-box; margin-bottom: 8px; border-radius: 8px;
          border: 1px solid #334155; padding: 7px 8px; font-size: 12px; background: #1e293b; color: #f8fafc;
        }
        #skout-ai-panel button.action {
          width: 100%; margin-top: 6px; border: 0; border-radius: 8px;
          padding: 8px 10px; font-size: 12px; font-weight: 600; cursor: pointer;
        }
        #skout-ai-add { background: #2563eb; color: white; }
        #skout-ai-enrich { background: #1e293b; color: #f8fafc; border: 1px solid #334155; }
        #skout-ai-panel button:disabled { opacity: 0.6; cursor: wait; }
        #skout-ai-status { margin-top: 8px; font-size: 11px; color: #94a3b8; }
      </style>
      <div id="skout-ai-panel-header">
        <h2>Skout AI</h2>
        <button id="skout-ai-close" type="button" aria-label="Close">×</button>
      </div>
      <p id="skout-ai-summary">Reading profile…</p>
      <label for="skout-ai-list-select">Target list</label>
      <select id="skout-ai-list-select"><option value="">Loading lists…</option></select>
      <button id="skout-ai-add" type="button" class="action">Add to list</button>
      <button id="skout-ai-enrich" type="button" class="action">Enrich email</button>
      <div id="skout-ai-status">Ready</div>
    `;

    panel.querySelector("#skout-ai-close")?.addEventListener("click", () => {
      panel.remove();
      sessionStorage.setItem("skout-ai-panel-hidden", "1");
    });

    panel.querySelector("#skout-ai-add")?.addEventListener("click", () => void onAdd(panel));
    panel.querySelector("#skout-ai-enrich")?.addEventListener("click", () => void onEnrich(panel));

    document.body.appendChild(panel);
    void loadLists(panel);
    return panel;
  }

  function profileSummaryHtml(profile) {
    if (!profile.fullName) return "Loading profile…";
    const esc = (s) =>
      String(s || "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
    const lines = [`<strong style="color:#f8fafc">${esc(profile.fullName)}</strong>`];
    if (profile.title) lines.push(esc(profile.title));
    if (profile.companyName) lines.push(`@ ${esc(profile.companyName)}`);
    const meta = [];
    if (profile.location) meta.push(esc(profile.location));
    if (profile.connections) meta.push(`${esc(profile.connections)} connections`);
    if (profile.followers) meta.push(`${esc(profile.followers)} followers`);
    if (meta.length) lines.push(`<span style="color:#94a3b8">${meta.join(" · ")}</span>`);
    return lines.join("<br>");
  }

  function updatePanelProfile(panel) {
    const profile = readProfileFromLinkedIn();
    if (profile.error === "not_a_profile") {
      panel.remove();
      return;
    }
    panel.__skoutProfile = profile;
    const summary = panel.querySelector("#skout-ai-summary");
    if (summary) summary.innerHTML = profileSummaryHtml(profile);
  }

  function ensurePanel() {
    let panel = document.getElementById("skout-ai-panel");
    if (!panel) panel = createPanel();
    updatePanelProfile(panel);
    return panel;
  }

  function boot() {
    document.getElementById("skout-ai-panel")?.remove();
    document.getElementById("skout-ai-bulk-panel")?.remove();

    if (isSearchResultsPage()) {
      if (sessionStorage.getItem("skout-ai-bulk-panel-hidden") === "1") return;
      ensureBulkPanel();
      return;
    }

    if (sessionStorage.getItem("skout-ai-panel-hidden") === "1") return;
    if (!isProfilePage()) return;
    ensurePanel();
  }

  function nameFromUrlVanity() {
    const url = location.href.split("?")[0];
    const match = url.match(/linkedin\.com\/(?:in|pub)\/([^/?#]+)/i);
    if (!match) return "";
    const slug = decodeURIComponent(match[1]).replace(/\/$/, "");
    const word = slug.replace(/-[a-f0-9]{6,}$/i, "").replace(/-\d+$/, "");
    if (!word || word.includes("-")) return "";
    return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
  }

  function getProfile(panel) {
    let profile = panel.__skoutProfile || readProfileFromLinkedIn();
    if (!profile.fullName) {
      const retry = readProfileFromLinkedIn();
      if (retry.fullName) {
        panel.__skoutProfile = retry;
        return retry;
      }
      const vanity = nameFromUrlVanity();
      if (vanity) {
        profile = { ...profile, fullName: vanity };
        panel.__skoutProfile = profile;
        return profile;
      }
      throw new Error("Profile still loading — wait a few seconds and try again.");
    }
    return profile;
  }

  async function onAdd(panel) {
    const listId = panel.querySelector("#skout-ai-list-select")?.value;
    const addBtn = panel.querySelector("#skout-ai-add");
    const enrichBtn = panel.querySelector("#skout-ai-enrich");
    if (!listId) {
      setPanelStatus(panel, "Pick a list first.", true);
      return;
    }

    addBtn.disabled = true;
    enrichBtn.disabled = true;
    setPanelStatus(panel, "Adding…");

    try {
      const profile = getProfile(panel);
      await safeRuntimeSend({ type: "ping" }, 5_000).catch(() => undefined);
      const result = await safeRuntimeSend({ type: "add-to-list", listId, profile });
      if (!result?.ok) throw new Error(result?.error || "Add failed");
      setPanelStatus(panel, `Added ${result.fullName} ✓`);
      safeRuntimeSend({ type: "save-last-list", listId }).catch(() => undefined);
    } catch (error) {
      setPanelStatus(panel, error instanceof Error ? error.message : "Add failed", true);
    } finally {
      addBtn.disabled = false;
      enrichBtn.disabled = false;
    }
  }

  async function onEnrich(panel) {
    const enrichBtn = panel.querySelector("#skout-ai-enrich");
    const addBtn = panel.querySelector("#skout-ai-add");
    enrichBtn.disabled = true;
    addBtn.disabled = true;
    setPanelStatus(panel, "Enriching…");

    try {
      const profile = getProfile(panel);
      const result = await safeRuntimeSend({ type: "enrich-profile", profile });
      if (!result?.ok) throw new Error(result?.error || "Enrich failed");
      setPanelStatus(panel, `Enrichment started for ${result.fullName}`);
    } catch (error) {
      setPanelStatus(panel, error instanceof Error ? error.message : "Enrich failed", true);
    } finally {
      enrichBtn.disabled = false;
      addBtn.disabled = false;
    }
  }

  let lastUrl = location.href;
  function onRouteChange() {
    if (location.href === lastUrl) return;
    lastUrl = location.href;
    boot();
  }

  const originalPushState = history.pushState.bind(history);
  const originalReplaceState = history.replaceState.bind(history);
  history.pushState = (...args) => {
    originalPushState(...args);
    onRouteChange();
  };
  history.replaceState = (...args) => {
    originalReplaceState(...args);
    onRouteChange();
  };
  window.addEventListener("popstate", onRouteChange);

  let lastSummaryKey = "";
  setInterval(() => {
    if (isSearchResultsPage()) {
      const bulkPanel = document.getElementById("skout-ai-bulk-panel");
      if (bulkPanel && sessionStorage.getItem("skout-ai-bulk-panel-hidden") !== "1") {
        renderBulkRows(bulkPanel);
      }
      return;
    }
    if (sessionStorage.getItem("skout-ai-panel-hidden") === "1" || !isProfilePage()) return;
    const panel = document.getElementById("skout-ai-panel");
    if (!panel) return;
    const profile = readProfileFromLinkedIn();
    if (!profile.fullName) return;
    const key = [
      profile.fullName,
      profile.title,
      profile.companyName,
      profile.location,
      profile.connections,
      profile.followers,
    ].join("|");
    if (key === lastSummaryKey) return;
    lastSummaryKey = key;
    panel.__skoutProfile = profile;
    const el = panel.querySelector("#skout-ai-summary");
    if (el) el.innerHTML = profileSummaryHtml(profile);
  }, 3000);

  boot();
})();
