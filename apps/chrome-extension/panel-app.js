/** Shared UI for side panel (stays open — unlike toolbar popup). */
import { clearAuthToken, getStoredAuth, isAuthFresh, ensureSession } from "./auth.js";
import { getConfig } from "./api.js";
import { getLastListId, saveLastListId } from "./lists-cache.js";
import { friendlyTabError, findLinkedInProfileTabId } from "./tab-utils.js";
import { ensureSkoutHostPermissions, normalizeSkoutBase, normalizeApiUrl, skoutSignInHint, DEFAULT_API_URL, DEFAULT_WEB_URL } from "./skout-urls.js";
import { withTimeout } from "./debug.js";

const BACKGROUND_TIMEOUT_MS = 35_000;

function runInBackground(type, payload = {}) {
  console.log(`[Skout Extension] ▶ panel send ${type}`);
  return withTimeout(
    new Promise((resolve, reject) => {
      chrome.runtime.sendMessage({ type, ...payload }, (response) => {
        const err = chrome.runtime.lastError;
        if (err) {
          reject(new Error(friendlyTabError(err.message)));
          return;
        }
        if (response?.ok) resolve(response);
        else reject(new Error(friendlyTabError(response?.error || "Request failed")));
      });
    }),
    BACKGROUND_TIMEOUT_MS,
    `${type} timed out — reload the extension at chrome://extensions, refresh LinkedIn, then try again.`
  );
}

async function findLinkedInTabId() {
  return findLinkedInProfileTabId();
}

export function initPanel() {
  const statusEl = document.getElementById("status");
  const authStatusEl = document.getElementById("auth-status");
  const connectBtn = document.getElementById("connect-skout");
  const reconnectBtn = document.getElementById("reconnect-skout");
  const apiUrlEl = document.getElementById("api-url");
  const webUrlEl = document.getElementById("web-url");
  const stubEmailEl = document.getElementById("stub-email");
  const useStubAuthEl = document.getElementById("use-stub-auth");
  const listSelectEl = document.getElementById("list-select");
  const sequenceSelectEl = document.getElementById("sequence-select");
  const hitlWarningEl = document.getElementById("hitl-warning");
  const duplicateWarningEl = document.getElementById("duplicate-warning");
  const enrollBtn = document.getElementById("enroll-sequence");
  const enrollConfirmEl = document.getElementById("enroll-confirm");
  const enrollConfirmLinkEl = document.getElementById("enroll-confirm-link");

  // Tracks the HITL state from the most recent ICP score so enroll can gate on it.
  let lastRequiresHitl = false;
  let hitlConfirmed = false;

  // Tracks duplicate-risk state per list selection so "Add to list" can gate on it —
  // reset whenever the target list changes, since a duplicate in one list says nothing
  // about another.
  let duplicateConfirmedForListId = null;

  function setStatus(message, isError = false) {
    if (!statusEl) return;
    statusEl.textContent = message;
    statusEl.className = isError ? "status-error" : "status-ok";
    updateVisionSystemState(message, isError);
  }

  const visionPolicyChip = document.getElementById("vision-policy-chip");
  const visionFreshnessChip = document.getElementById("vision-freshness-chip");
  const visionConfidenceChip = document.getElementById("vision-confidence-chip");
  const visionSideEffects = document.getElementById("vision-side-effects");
  const visionSystemState = document.getElementById("vision-system-state");

  function setVisionChip(el, text, tone) {
    if (!el) return;
    el.textContent = text;
    el.classList.remove("warning", "danger");
    if (tone) el.classList.add(tone);
  }

  function updateVisionIntelligence({ policy = "Ask", confidence, hitl = false } = {}) {
    setVisionChip(visionPolicyChip, `Policy · ${policy}`, hitl ? "warning" : undefined);
    setVisionChip(visionFreshnessChip, "Context · Live");
    if (confidence != null) {
      setVisionChip(
        visionConfidenceChip,
        `Confidence · ${Math.round(confidence)}%`,
        confidence < 60 ? "danger" : confidence < 80 ? "warning" : undefined
      );
    }
  }

  function updateVisionSideEffects(effects) {
    if (!visionSideEffects) return;
    visionSideEffects.textContent =
      effects.length > 0 ? `Side effects: ${effects.join(" · ")}` : "No blocking side effects detected.";
  }

  function updateVisionSystemState(message, isError = false) {
    if (!visionSystemState) return;
    visionSystemState.textContent = isError ? `Blocked — ${message}` : message || "Ready.";
  }

  updateVisionIntelligence();
  updateVisionSideEffects(["List write", "Audit event on enroll"]);

  function setAuthStatus(message, connected = false) {
    if (!authStatusEl) return;
    authStatusEl.textContent = message;
    authStatusEl.className = connected ? "auth-status connected" : "auth-status";
  }

  function setConnectedUi(connected) {
    connectBtn?.classList.toggle("hidden", false);
    if (connected) {
      connectBtn.textContent = "Reconnect Skout account";
    } else {
      connectBtn.textContent = "Connect Skout account";
    }
  }

  function setBusy(button, busy, label) {
    if (!button) return;
    button.disabled = busy;
    if (label) button.textContent = label;
  }

  async function isSignedIn() {
    const config = await getConfig();
    if (config.useStubAuth) return true;
    const auth = await getStoredAuth();
    return isAuthFresh(auth);
  }

  async function ensurePanelSignedIn() {
    const config = await getConfig();
    if (config.useStubAuth) return true;

    if (!(await isSignedIn())) {
      setStatus("Connecting to Skout…");
      await runInBackground("connect-skout", { focus: false });
      await loadConfig();
    }

    if (!(await isSignedIn())) {
      setStatus(
        `Open Skout (${normalizeSkoutBase(config.webUrl)}), sign in, then click Connect Skout account.`,
        true
      );
      return false;
    }
    return true;
  }

  async function loadConfig() {
    const config = await getConfig();
    if (apiUrlEl) apiUrlEl.value = config.apiUrl;
    if (webUrlEl) webUrlEl.value = config.webUrl;
    if (stubEmailEl) stubEmailEl.value = config.stubEmail;
    if (useStubAuthEl) useStubAuthEl.checked = config.useStubAuth;

    if (config.useStubAuth) {
      setAuthStatus(`Stub mode · ${config.stubEmail}`, true);
      setConnectedUi(true);
      return;
    }

    const auth = await getStoredAuth();
    if (isAuthFresh(auth)) {
      setAuthStatus(auth.authEmail ? `Signed in as ${auth.authEmail}` : "Signed in to Skout", true);
      setConnectedUi(true);
    } else if (auth.authToken && auth.authEmail) {
      setAuthStatus(`Session expired — open Skout (${auth.authEmail})`);
      setConnectedUi(false);
    } else {
      setAuthStatus("Sign in to Skout in this browser.");
      setConnectedUi(false);
    }
  }

  async function refreshLists({ quiet = false } = {}) {
    if (!listSelectEl) return;

    if (!quiet) {
      listSelectEl.innerHTML = `<option value="">Loading lists…</option>`;
      setStatus("Loading lists…");
    }

    try {
      const config = await getConfig();
      if (!config.useStubAuth && !(await isSignedIn())) {
        await runInBackground("connect-skout", { focus: false });
        await loadConfig();
      }

      if (!(await isSignedIn())) {
        listSelectEl.innerHTML = `<option value="">Sign in to Skout first</option>`;
        if (!quiet) {
          setStatus(`Open Skout (${normalizeSkoutBase(config.webUrl)}), sign in, then click Connect Skout account.`, true);
        }
        return;
      }

      const result = await runInBackground("get-lists");
      const lists = result.lists || [];
      const lastId = await getLastListId();
      listSelectEl.innerHTML =
        lists.length > 0
          ? lists
              .map(
                (list) =>
                  `<option value="${list.id}"${list.id === lastId ? " selected" : ""}>${list.name}</option>`
              )
              .join("")
          : `<option value="">No lists yet — create one in Skout</option>`;

      if (!quiet) {
        setStatus(lists.length > 0 ? `${lists.length} list(s) ready.` : "Create a list in Skout.");
      }
    } catch (error) {
      const message = friendlyTabError(error instanceof Error ? error.message : "Failed to load lists");
      const config = await getConfig();
      listSelectEl.innerHTML = `<option value="">Could not load lists</option>`;
      if (!quiet) {
        setStatus(
          message.includes("signed in") || message.includes("Connect")
            ? message
            : `${message} Try Connect Skout account, or ${skoutSignInHint(config.webUrl)}.`,
          true
        );
      }
    }
  }

  listSelectEl?.addEventListener("change", () => {
    void saveLastListId(listSelectEl.value);
  });

  async function connectSkout() {
    setBusy(connectBtn, true, "Connecting…");
    setBusy(reconnectBtn, true, "Connecting…");
    setStatus("Connecting…");
    try {
      const result = await runInBackground("connect-skout", { focus: true });
      setAuthStatus(result.email ? `Signed in as ${result.email}` : "Signed in to Skout", true);
      setConnectedUi(true);
      await chrome.storage.sync.set({ onboardingComplete: true });
      await refreshLists();
    } catch (error) {
      setAuthStatus("Sign in to Skout in this browser.");
      setConnectedUi(false);
      setStatus(error instanceof Error ? error.message : "Connect failed", true);
    } finally {
      setBusy(connectBtn, false, "Connect Skout account");
      setBusy(reconnectBtn, false, "Reconnect Skout account");
    }
  }

  connectBtn?.addEventListener("click", () => void connectSkout());
  reconnectBtn?.addEventListener("click", () => void connectSkout());

  document.getElementById("save-config")?.addEventListener("click", async () => {
    const useStub = Boolean(useStubAuthEl?.checked);
    const apiUrl = normalizeApiUrl(apiUrlEl?.value?.trim() || DEFAULT_API_URL);
    const webUrl = webUrlEl?.value?.trim() || DEFAULT_WEB_URL;

    if (!useStub) {
      const granted = await ensureSkoutHostPermissions(webUrl, apiUrl);
      if (!granted) {
        setStatus("Host permission denied — extension needs access to your Skout URL.", true);
        return;
      }
    }

    await chrome.storage.sync.set({
      apiUrl,
      webUrl,
      stubEmail: stubEmailEl?.value?.trim() || "extension@example.com",
      useStubAuth: useStub,
    });
    if (useStub) await clearAuthToken();
    setStatus("Saved settings.");
    await loadConfig();
    await refreshLists();
  });

  document.getElementById("refresh-lists")?.addEventListener("click", () => refreshLists());

  listSelectEl?.addEventListener("change", () => {
    duplicateConfirmedForListId = null;
    duplicateWarningEl?.classList.add("hidden");
  });

  document.getElementById("add-to-list")?.addEventListener("click", async (event) => {
    const button = event.currentTarget;
    const listId = listSelectEl?.value;
    if (!listId) {
      setStatus("Pick a list first.", true);
      return;
    }

    const confirmDuplicate = duplicateConfirmedForListId === listId;
    setBusy(button, true, "Adding…");
    try {
      if (!(await ensurePanelSignedIn())) return;
      await saveLastListId(listId);
      const tabId = await findLinkedInTabId();
      // Profile read happens in the background — avoids hanging here if the tab bridge isn't ready.
      await runInBackground("ping").catch(() => undefined);
      const result = await runInBackground("add-to-list", { listId, tabId, confirmDuplicate });

      if (result.duplicate && !confirmDuplicate) {
        // First time seeing this — warn and require a second click before writing, same
        // pattern as the HITL enroll gate above.
        duplicateConfirmedForListId = listId;
        duplicateWarningEl?.classList.remove("hidden");
        setStatus(`${result.fullName} is already in this list — click Add again to add anyway.`, true);
        return;
      }

      duplicateConfirmedForListId = null;
      duplicateWarningEl?.classList.add("hidden");
      setStatus(`Added ${result.fullName} to the list.`);
    } catch (error) {
      setStatus(
        error instanceof Error
          ? error.message
          : "Add failed — refresh LinkedIn (Cmd+Shift+R) and try again.",
        true
      );
    } finally {
      setBusy(button, false, "Add current profile to list");
    }
  });

  const enrichResultsEl = document.getElementById("enrich-results");
  const enrichCreditsHintEl = document.getElementById("enrich-credits-hint");
  const enrichTopupLinkEl = document.getElementById("enrich-topup-link");

  const FIELD_LABELS = { company: "Company", email: "Email", phone: "Phone", validation: "Validation" };
  const RESULT_FIELD_MAP = { company: "company", email: "email", phone: "phone", validation: "email_status" };

  function showEnrichRows(fields) {
    if (!enrichResultsEl) return;
    enrichResultsEl.style.display = "block";
    enrichResultsEl.innerHTML = fields
      .map(
        (f) => `
        <div class="enrich-result-row" data-field="${f}">
          <span class="enrich-result-label">${FIELD_LABELS[f] || f}</span>
          <span class="enrich-result-value" style="color:#475569">⏳</span>
          <span class="enrich-result-icon"></span>
        </div>`
      )
      .join("");
  }

  function applyEnrichResults(results) {
    if (!enrichResultsEl) return;
    for (const row of enrichResultsEl.querySelectorAll(".enrich-result-row")) {
      const field = row.getAttribute("data-field");
      const apiField = RESULT_FIELD_MAP[field] || field;
      const match = results.find(
        (r) => r.field === apiField && (r.isPrimary !== false || apiField === "email_status")
      );
      const valueEl = row.querySelector(".enrich-result-value");
      const iconEl = row.querySelector(".enrich-result-icon");
      if (!match || !match.value || match.status === "not_found") {
        if (valueEl) { valueEl.textContent = "Not found"; valueEl.style.color = "#475569"; }
        if (iconEl) { iconEl.textContent = "—"; iconEl.style.color = "#475569"; }
      } else {
        if (valueEl) { valueEl.textContent = match.value; valueEl.style.color = "#e2e8f0"; }
        if (iconEl) { iconEl.textContent = "✓"; iconEl.style.color = "#86efac"; }
      }
    }
  }

  // Updates only rows that have a result — rows still in-flight stay ⏳.
  function applyPartialResults(results) {
    if (!enrichResultsEl || !results?.length) return;
    for (const row of enrichResultsEl.querySelectorAll(".enrich-result-row")) {
      const field = row.getAttribute("data-field");
      const apiField = RESULT_FIELD_MAP[field] || field;
      const match = results.find(
        (r) => r.field === apiField && (r.isPrimary !== false || apiField === "email_status")
      );
      if (!match) continue;
      const valueEl = row.querySelector(".enrich-result-value");
      const iconEl = row.querySelector(".enrich-result-icon");
      if (!match.value || match.status === "not_found") {
        if (valueEl) { valueEl.textContent = "Not found"; valueEl.style.color = "#475569"; }
        if (iconEl) { iconEl.textContent = "—"; iconEl.style.color = "#475569"; }
      } else {
        if (valueEl) { valueEl.textContent = match.value; valueEl.style.color = "#e2e8f0"; }
        if (iconEl) { iconEl.textContent = "✓"; iconEl.style.color = "#86efac"; }
      }
    }
  }

  function clearEnrichUI() {
    if (enrichResultsEl) { enrichResultsEl.style.display = "none"; enrichResultsEl.innerHTML = ""; }
    if (enrichCreditsHintEl) enrichCreditsHintEl.classList.add("hidden");
  }

  // Show credit warning when phone is checked (pre-flight gate).
  document.querySelector('input[name="enrich-field"][value="phone"]')?.addEventListener("change", (e) => {
    const noteEl = document.getElementById("phone-credit-note");
    if (noteEl) noteEl.classList.toggle("hidden", !e.target.checked);
  });

  document.getElementById("enrich-profile")?.addEventListener("click", async (event) => {
    const button = event.currentTarget;
    const POLL_MAX = 40;
    const POLL_INTERVAL_MS = 1_500;

    const fields = Array.from(
      document.querySelectorAll('input[name="enrich-field"]:checked')
    ).map((cb) => cb.value);

    if (!fields.length) {
      setStatus("Select at least one field.", true);
      return;
    }

    clearEnrichUI();
    showEnrichRows(fields);
    setBusy(button, true, "Enriching…");

    try {
      if (!(await ensurePanelSignedIn())) return;
      const tabId = await findLinkedInTabId();
      await runInBackground("ping").catch(() => undefined);

      // Start enrichment — background responds immediately with jobId.
      const started = await runInBackground("enrich-profile", { tabId, fields });

      let lastResults = started.results || [];

      if (started.jobId && started.status !== "completed") {
        // Poll job and update each field row as its step completes.
        for (let i = 0; i < POLL_MAX; i++) {
          await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
          const job = await runInBackground("poll-enrich-job", { jobId: started.jobId }).catch(() => null);
          if (job?.results?.length) {
            applyPartialResults(job.results);
            lastResults = job.results;
          }
          if (job?.status === "completed" || job?.status === "failed") break;
        }
      }

      applyEnrichResults(lastResults);
      setStatus(`Enriched ${started.fullName}.`);
    } catch (error) {
      enrichResultsEl?.querySelectorAll(".enrich-result-value").forEach((el) => {
        if (el.textContent === "⏳") { el.textContent = "—"; el.style.color = "#475569"; }
      });
      const msg = error instanceof Error ? error.message : "Enrich failed";
      const isCreditsError =
        msg.includes("credit") || msg.includes("Credit") || msg.includes("402") || msg.includes("insufficient");
      if (isCreditsError && enrichCreditsHintEl) {
        enrichCreditsHintEl.classList.remove("hidden");
        const config = await getConfig();
        if (enrichTopupLinkEl && config.webUrl) {
          enrichTopupLinkEl.href = `${config.webUrl.replace(/\/$/, "")}/billing`;
        }
        setStatus("Insufficient credits.", true);
      } else {
        setStatus(msg, true);
      }
    } finally {
      setBusy(button, false, "Enrich contact");
    }
  });

  document.getElementById("score-profile")?.addEventListener("click", async (event) => {
    const button = event.currentTarget;
    setBusy(button, true, "Scoring…");
    try {
      if (!(await ensurePanelSignedIn())) return;
      const tabId = await findLinkedInTabId();
      await runInBackground("ping").catch(() => undefined);
      const result = await runInBackground("score-profile", { tabId });
      // Store HITL state so the enroll handler can gate on it.
      lastRequiresHitl = Boolean(result.requiresHitl);
      hitlConfirmed = false;
      if (hitlWarningEl) hitlWarningEl.classList.toggle("hidden", !lastRequiresHitl);
      if (enrollConfirmEl) enrollConfirmEl.classList.add("hidden");
      const hitlNote = result.requiresHitl
        ? " — low confidence, flagged for review"
        : "";
      updateVisionIntelligence({
        policy: result.requiresHitl ? "Approve" : "Ask",
        confidence: typeof result.score === "number" ? result.score : undefined,
        hitl: Boolean(result.requiresHitl),
      });
      setStatus((result.message || `Scored ${result.fullName}.`) + hitlNote);
    } catch (error) {
      setStatus(
        error instanceof Error ? error.message : "Score failed — connect Skout and configure ICP.",
        true
      );
    } finally {
      setBusy(button, false, "Score ICP");
    }
  });

  async function refreshSequences({ quiet = false } = {}) {
    if (!sequenceSelectEl) return;
    if (!quiet) {
      sequenceSelectEl.innerHTML = `<option value="">Loading sequences…</option>`;
      setStatus("Loading sequences…");
    }
    try {
      const config = await getConfig();
      if (!config.useStubAuth && !(await isSignedIn())) {
        await runInBackground("connect-skout", { focus: false });
        await loadConfig();
      }
      if (!(await isSignedIn())) {
        sequenceSelectEl.innerHTML = `<option value="">Sign in to Skout first</option>`;
        return;
      }
      const result = await runInBackground("get-sequences");
      const sequences = result.sequences || [];
      sequenceSelectEl.innerHTML =
        sequences.length > 0
          ? sequences
              .map((s) => `<option value="${s.id}">${s.name}</option>`)
              .join("")
          : `<option value="">No active sequences — create one in Skout</option>`;
      if (!quiet) {
        setStatus(sequences.length > 0 ? `${sequences.length} sequence(s) ready.` : "Create a sequence in Skout.");
      }
    } catch (error) {
      const message = friendlyTabError(error instanceof Error ? error.message : "Failed to load sequences");
      sequenceSelectEl.innerHTML = `<option value="">Could not load sequences</option>`;
      if (!quiet) setStatus(message, true);
    }
  }

  document.getElementById("refresh-sequences")?.addEventListener("click", () => refreshSequences());

  enrollBtn?.addEventListener("click", async (event) => {
    const button = event.currentTarget;
    const sequenceId = sequenceSelectEl?.value;
    if (!sequenceId) {
      setStatus("Pick a sequence first.", true);
      return;
    }

    // HITL gate: if the last ICP score was low-confidence and not yet confirmed, require a second click.
    if (lastRequiresHitl && !hitlConfirmed) {
      hitlWarningEl?.classList.remove("hidden");
      hitlConfirmed = true;
      setStatus("Low-confidence score — click Enroll again to confirm enrollment.", true);
      return;
    }

    hitlWarningEl?.classList.add("hidden");
    hitlConfirmed = false;
    if (enrollConfirmEl) enrollConfirmEl.classList.add("hidden");
    updateVisionSideEffects(["Sequence enroll", "Consent check", "Audit log entry"]);
    updateVisionIntelligence({ policy: lastRequiresHitl ? "Approve" : "Ask", hitl: lastRequiresHitl });
    setBusy(button, true, "Enrolling…");
    try {
      if (!(await ensurePanelSignedIn())) return;
      const tabId = await findLinkedInTabId();
      await runInBackground("ping").catch(() => undefined);
      const result = await runInBackground("enroll-sequence", { sequenceId, tabId });
      const config = await getConfig();
      const sequenceUrl = `${config.webUrl.replace(/\/$/, "")}/sequences/${sequenceId}`;
      if (enrollConfirmLinkEl) enrollConfirmLinkEl.href = sequenceUrl;
      if (enrollConfirmEl) enrollConfirmEl.classList.remove("hidden");
      setStatus(`Enrolled ${result.fullName} in sequence.`);
    } catch (error) {
      setStatus(
        error instanceof Error
          ? error.message
          : "Enroll failed — connect Skout and try again.",
        true
      );
    } finally {
      setBusy(button, false, "Enroll in sequence");
    }
  });

  void (async () => {
    await loadConfig();
    const { onboardingComplete } = await chrome.storage.sync.get(["onboardingComplete"]);
    if (!onboardingComplete) {
      setStatus("Welcome — open Skout, sign in, then click Connect Skout account.");
    }
    if (!(await isSignedIn())) {
      try {
        await runInBackground("connect-skout", { focus: false });
        await loadConfig();
      } catch {
        // User can click Connect.
      }
    }
    await refreshLists({ quiet: true });
    await refreshSequences({ quiet: true });
  })();

  chrome.storage.onChanged.addListener((changes, area) => {
    // Auth JWTs live in chrome.storage.local (sync was cleared after hardening).
    if ((area !== "local" && area !== "sync") || !changes.authToken) return;
    void (async () => {
      await loadConfig();
      if (!(await isAuthFresh(await getStoredAuth()))) return;
      await refreshLists({ quiet: true });
      await refreshSequences({ quiet: true });
      setStatus("Connected to Skout.");
    })();
  });
}
