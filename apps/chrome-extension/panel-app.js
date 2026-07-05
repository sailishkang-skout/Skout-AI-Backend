/** Shared UI for side panel (stays open — unlike toolbar popup). */
import { clearAuthToken, getStoredAuth, isAuthFresh, ensureSession } from "./auth.js";
import { getConfig } from "./api.js";
import { getLastListId, saveLastListId } from "./lists-cache.js";
import { friendlyTabError, findLinkedInProfileTabId } from "./tab-utils.js";
import { ensureSkoutHostPermissions, normalizeSkoutBase, skoutSignInHint } from "./skout-urls.js";
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

  function setStatus(message, isError = false) {
    if (!statusEl) return;
    statusEl.textContent = message;
    statusEl.className = isError ? "status-error" : "status-ok";
  }

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
    const apiUrl = apiUrlEl?.value?.trim() || "http://localhost:3001";
    const webUrl = webUrlEl?.value?.trim() || "http://localhost:3000";

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

  document.getElementById("add-to-list")?.addEventListener("click", async (event) => {
    const button = event.currentTarget;
    const listId = listSelectEl?.value;
    if (!listId) {
      setStatus("Pick a list first.", true);
      return;
    }

    setBusy(button, true, "Adding…");
    try {
      await saveLastListId(listId);
      const tabId = await findLinkedInTabId();
      // Profile read happens in the background — avoids hanging here if the tab bridge isn't ready.
      await runInBackground("ping").catch(() => undefined);
      const result = await runInBackground("add-to-list", { listId, tabId });
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

  document.getElementById("enrich-profile")?.addEventListener("click", async (event) => {
    const button = event.currentTarget;
    setBusy(button, true, "Enriching…");
    try {
      const tabId = await findLinkedInTabId();
      await runInBackground("ping").catch(() => undefined);
      const result = await runInBackground("enrich-profile", { tabId });
      setStatus(result.message || `Enrichment started for ${result.fullName}.`);
    } catch (error) {
      setStatus(
        error instanceof Error
          ? error.message
          : "Enrich failed — refresh LinkedIn (Cmd+Shift+R) and try again.",
        true
      );
    } finally {
      setBusy(button, false, "Enrich contact");
    }
  });

  document.getElementById("score-profile")?.addEventListener("click", async (event) => {
    const button = event.currentTarget;
    setBusy(button, true, "Scoring…");
    try {
      const tabId = await findLinkedInTabId();
      await runInBackground("ping").catch(() => undefined);
      const result = await runInBackground("score-profile", { tabId });
      setStatus(result.message || `Scored ${result.fullName}.`);
    } catch (error) {
      setStatus(
        error instanceof Error ? error.message : "Score failed — connect Skout and configure ICP.",
        true
      );
    } finally {
      setBusy(button, false, "Score ICP");
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
  })();

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "sync" || !changes.authToken) return;
    void (async () => {
      await loadConfig();
      await refreshLists({ quiet: true });
      setStatus("Connected to Skout.");
    })();
  });
}
